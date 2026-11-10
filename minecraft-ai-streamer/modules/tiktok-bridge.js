'use strict'
/**
 * tiktok-bridge.js – Dual-Engine-TikTok-Live-Connector mit 24/7-Auto-Live-Watchdog.
 *
 *  Engine A: tiktok-live-connector (WebcastPushConnection) mit optimierten Client-Parametern.
 *  Engine B: lokales Relay (TikFinity-kompatibel, ws://localhost:21213/), falls TikTok Engine A
 *            mit Signatur-/Rate-Limit-Fehlern blockt.
 *
 *  Watchdog: Ist der Stream noch offline, wird NICHT abgebrochen – alle 8 s wird neu geprüft.
 *            Bricht die Verbindung mitten im Stream ab, folgt nach 2 s der Reconnect.
 *            Der genaue Grund jedes Fehlschlags steht in state.diagnostic (Tooltip oben links).
 *
 *  Events:  'gift' { viewer, gift:{id,name,coins,icon}, count, delta, streakEnd }
 *           'chat' { viewer, text } · 'follow' · 'share' · 'like' { viewer, count }
 *           'live' { username, engine }  (genau einmal pro erfolgreichem Verbindungsaufbau)
 *           'state' (jede Änderung) · 'gift_icons' (Name -> Bild-URL)
 *
 *  Es läuft höchstens EIN Timer (setTimeout-Kette), kein Intervall.
 */
const EventEmitter = require('events')
const WebSocket = require('ws')

const RETRY_OFFLINE_MS = 8000
const RETRY_DROP_MS = 2000
const RELAY_URL = process.env.TIKTOK_RELAY_URL || 'ws://127.0.0.1:21213/'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** "@Name", " Name ", "https://www.tiktok.com/@Name/live?x=1" -> "Name" */
function sanitizeUsername (input) {
  let s = String(input || '').trim()
  const m = /tiktok\.com\/@([^/?#\s]+)/i.exec(s)
  if (m) s = m[1]
  s = s.replace(/^https?:\/\/\S*?\/@?/i, '').replace(/[/?#].*$/, '').replace(/^@+/, '').replace(/\s+/g, '')
  try { s = decodeURIComponent(s) } catch (_) {}
  return s.replace(/[^\p{L}\p{N}_.]/gu, '').slice(0, 30)
}

function pic (u) {
  if (!u) return null
  if (typeof u.profilePictureUrl === 'string') return u.profilePictureUrl
  const p = u.profilePicture || u.avatarThumb
  if (typeof p === 'string') return p
  const urls = p && (p.urls || p.url || p.urlList || p.url_list)
  return Array.isArray(urls) ? urls[0] || null : null
}

function normViewer (d) {
  const u = d.user || d
  return {
    uniqueId: u.uniqueId || d.uniqueId || u.displayId || 'anonym',
    nickname: u.nickname || d.nickname || u.uniqueId || d.uniqueId || 'Anonym',
    avatar: pic(u) || pic(d)
  }
}

function classify (err) {
  const name = (err && err.constructor && err.constructor.name) || ''
  const msg = String((err && (err.info || err.message)) || err || '')
  if (/UserOffline/i.test(name) || /offline|not (currently )?live|isn'?t online|LIVE has ended|not online/i.test(msg)) return { kind: 'offline', text: 'Stream ist noch nicht live' }
  if (/InvalidUniqueId/i.test(name) || /user_not_found|invalid.*unique|not.*exist|Failed to extract/i.test(msg)) return { kind: 'user', text: 'Benutzername nicht gefunden – Schreibweise prüfen' }
  if (/Sign|RateLimit|Premium/i.test(name) || /sign|rate.?limit|403|429|captcha|blocked|euler/i.test(msg)) return { kind: 'sign', text: 'TikTok blockt die Signatur/Rate-Limit (' + msg.slice(0, 90) + ')' }
  if (/Timeout/i.test(name) || /timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|network/i.test(msg)) return { kind: 'network', text: 'Netzwerkfehler (' + msg.slice(0, 70) + ')' }
  return { kind: 'other', text: msg.slice(0, 120) || name || 'Unbekannter Fehler' }
}

class TikTokBridge extends EventEmitter {
  constructor () {
    super()
    this.conn = null
    this.relay = null
    this.probe = null
    this.timer = null
    this.wanted = false
    this.attempts = 0
    this.streaks = new Map()
    this.giftIcons = {}
    this.state = { phase: 'idle', connected: false, connecting: false, username: null, engine: null, viewers: 0, diagnostic: null, error: null, attempts: 0, nextRetryAt: 0, badge: '⚪ Nicht verbunden' }
  }

  _set (patch) {
    Object.assign(this.state, patch)
    const s = this.state
    s.connected = s.phase === 'live'
    s.connecting = s.phase === 'connecting' || s.phase === 'reconnecting'
    s.error = s.diagnostic
    s.badge = s.phase === 'live'
      ? `🟢 LIVE VERBUNDEN (@${s.username} | Zuschauer: ${s.viewers})`
      : s.phase === 'waiting' ? `🟡 Warte auf Live-Start von @${s.username} (Prüfe alle 8s)...`
        : s.phase === 'connecting' ? `🟡 Verbinde mit @${s.username} ...`
          : s.phase === 'reconnecting' ? `🟠 Verbindung verloren – Reconnect zu @${s.username} ...`
            : '⚪ Nicht verbunden'
    this.emit('state', { ...s })
  }

  /** Startet den Watchdog. Bricht nie ab, solange nicht stop() gerufen wird. */
  start (input) {
    const username = sanitizeUsername(input)
    if (!username) { this._set({ phase: 'idle', diagnostic: 'Kein TikTok-Benutzername angegeben' }); return null }
    this._teardown()
    this.wanted = true
    this.attempts = 0
    this.probe = null
    this._set({ phase: 'connecting', username, engine: null, viewers: 0, diagnostic: null, attempts: 0 })
    this._attempt()
    return username
  }

  connect (input) { return this.start(input) }

  async stop () {
    this.wanted = false
    this._teardown()
    this._set({ phase: 'idle', engine: null, diagnostic: null, nextRetryAt: 0 })
  }

  disconnect () { return this.stop() }

  _teardown () {
    clearTimeout(this.timer); this.timer = null
    const c = this.conn; this.conn = null
    if (c) { try { c.removeAllListeners() } catch (_) {} try { Promise.resolve(c.disconnect()).catch(() => {}) } catch (_) {} }
    const r = this.relay; this.relay = null
    if (r) { try { r.removeAllListeners(); r.on('error', () => {}); r.close() } catch (_) {} }
    this.streaks.clear()
  }

  _retry (ms, phase, diagnostic) {
    if (!this.wanted) return
    clearTimeout(this.timer)
    this._set({ phase, diagnostic, attempts: this.attempts, nextRetryAt: Date.now() + ms })
    this.timer = setTimeout(() => { this.timer = null; this._attempt() }, ms)
  }

  _lib () {
    if (this._libCache) return this._libCache
    const main = require('tiktok-live-connector')
    let legacy = null
    try { legacy = require('tiktok-live-connector/legacy') } catch (_) {}
    this._libCache = { main, legacy }
    return this._libCache
  }

  /** Billige Live-Prüfung ohne Signatur-Anfrage (schont das Rate-Limit beim 8-s-Polling). */
  async _isLive (username) {
    try {
      const { main } = this._lib()
      if (!this.probe || this.probe._user !== username) { this.probe = new main.TikTokLiveConnection(username); this.probe._user = username }
      if (typeof this.probe.fetchIsLive !== 'function') return null
      return await this.probe.fetchIsLive()
    } catch (_) { return null }
  }

  async _attempt () {
    if (!this.wanted) return
    const username = this.state.username
    this.attempts++
    // 1) Ist der Stream überhaupt live? (jeder 6. Versuch verbindet trotzdem direkt – falls die Prüfung selbst klemmt)
    if (this.state.phase !== 'reconnecting') {
      const live = await this._isLive(username)
      if (!this.wanted || this.state.username !== username) return
      if (live === false && this.attempts % 6 !== 0) return this._retry(RETRY_OFFLINE_MS, 'waiting', 'Stream ist noch nicht live')
    }
    // 2) Engine A
    let reasonA
    try {
      await this._engineA(username)
      return
    } catch (e) {
      if (!this.wanted || this.state.username !== username) return
      reasonA = classify(e)
      if (reasonA.kind === 'offline') return this._retry(RETRY_OFFLINE_MS, 'waiting', reasonA.text)
    }
    // 3) Engine B (lokales Relay) – bei Signatur-/Netz-/sonstigen Fehlern
    try {
      await this._engineB(username)
      this._set({ diagnostic: `Engine A blockiert: ${reasonA.text} → Engine B (lokales Relay) aktiv` })
    } catch (e) {
      if (!this.wanted || this.state.username !== username) return
      const hint = reasonA.kind === 'sign'
        ? ' Tipp: kostenlosen EulerStream-Schlüssel als EULERSTREAM_API_KEY setzen oder TikFinity starten.'
        : ''
      this._retry(RETRY_OFFLINE_MS, 'waiting', `Engine A: ${reasonA.text} | Engine B: Relay ${RELAY_URL} nicht erreichbar.${hint}`)
    }
  }

  // ---------------------------------------------------------------- Engine A
  async _engineA (username) {
    const { main, legacy } = this._lib()
    const key = process.env.EULERSTREAM_API_KEY || undefined
    if (key && main.SignConfig) main.SignConfig.apiKey = key
    const EV = main.WebcastEvent || {}
    const CE = main.ControlEvent || {}
    let conn
    const v1opts = {
      processInitialData: false,
      enableExtendedGiftInfo: true,
      enableWebsocketUpgrade: true,
      requestPollingIntervalMs: 1000,
      signApiKey: key,
      clientParams: { app_language: 'de-DE', device_platform: 'web_pc' },
      requestHeaders: { 'User-Agent': UA }
    }
    try {
      if (!legacy || !legacy.WebcastPushConnection) throw new Error('legacy fehlt')
      conn = new legacy.WebcastPushConnection(username, v1opts)
    } catch (_) {
      conn = new main.TikTokLiveConnection(username, {
        processInitialData: false,
        enableExtendedGiftInfo: true,
        signApiKey: key,
        webClientParams: { app_language: 'de-DE', device_platform: 'web_pc' },
        webClientHeaders: { 'User-Agent': UA }
      })
    }
    this.conn = conn
    this._bind(conn, EV, CE)
    try {
      await conn.connect()
    } catch (e) {
      if (this.conn === conn) this.conn = null
      try { conn.removeAllListeners() } catch (_) {}
      throw e
    }
    if (this.conn !== conn) { try { conn.disconnect() } catch (_) {} return }
    this._onLive('A')
    this._loadGiftIcons(conn)
  }

  _bind (conn, EV, CE) {
    const on = (names, fn) => { for (const n of new Set(names.filter(Boolean))) conn.on(n, d => { try { fn(d || {}) } catch (e) { this.emit('warn', 'Event-Fehler: ' + e.message) } }) }
    on([EV.GIFT, 'gift'], d => this._onGift(d))
    on([EV.CHAT, 'chat'], d => this._onChat(d))
    on([EV.FOLLOW, 'follow'], d => this.emit('follow', { viewer: normViewer(d) }))
    on([EV.SHARE, 'share'], d => this.emit('share', { viewer: normViewer(d) }))
    on([EV.LIKE, 'like'], d => this.emit('like', { viewer: normViewer(d), count: d.likeCount || d.count || 1, total: d.totalLikeCount || 0 }))
    on([EV.ROOM_USER, 'roomUser'], d => this._viewers(d.viewerCount ?? d.totalUser))
    on([EV.STREAM_END, 'streamEnd'], () => this._dropped('Stream wurde beendet', RETRY_OFFLINE_MS, 'waiting'))
    on([CE.DISCONNECTED, 'disconnected'], () => { if (this.conn === conn) this._dropped('Verbindung getrennt', RETRY_DROP_MS, 'reconnecting') })
    on([CE.ERROR, 'error'], e => { this.state.diagnostic = classify(e.exception || e).text })
  }

  _dropped (why, ms, phase) {
    if (!this.wanted) return
    const c = this.conn; this.conn = null
    if (c) { try { c.removeAllListeners() } catch (_) {} try { Promise.resolve(c.disconnect()).catch(() => {}) } catch (_) {} }
    const r = this.relay; this.relay = null
    if (r) { try { r.removeAllListeners(); r.on('error', () => {}); r.close() } catch (_) {} }
    this._retry(ms, phase, why)
  }

  _onLive (engine) {
    this.attempts = 0
    this._set({ phase: 'live', engine, diagnostic: null, nextRetryAt: 0, attempts: 0 })
    this.emit('live', { username: this.state.username, engine })
  }

  _viewers (n) {
    if (typeof n !== 'number' || n === this.state.viewers) return
    this._set({ viewers: n })
  }

  async _loadGiftIcons (conn) {
    try {
      const fn = conn.fetchAvailableGifts || conn.getAvailableGifts
      if (!fn) return
      const res = await fn.call(conn)
      const gifts = Array.isArray(res) ? res : (res && (res.gifts || res.giftList)) || []
      for (const g of gifts) {
        const img = g.image || g.icon || g.giftImage
        const url = (img && ((img.url_list || img.urlList || img.urls || [])[0] || img.giftPictureUrl)) || g.giftPictureUrl
        if (g.name && url) this.giftIcons[String(g.name).toLowerCase()] = url
      }
      this.emit('gift_icons', this.giftIcons)
    } catch (_) {}
  }

  // ---------------------------------------------------------------- Engine B (lokales Relay)
  _engineB (username) {
    return new Promise((resolve, reject) => {
      let settled = false
      let ws
      try { ws = new WebSocket(RELAY_URL, { handshakeTimeout: 2500 }) } catch (e) { return reject(e) }
      const fail = e => { if (!settled) { settled = true; try { ws.removeAllListeners(); ws.on('error', () => {}); ws.close() } catch (_) {} reject(e || new Error('Relay nicht erreichbar')) } }
      const to = setTimeout(() => fail(new Error('Relay-Timeout')), 3000)
      ws.on('error', fail)
      ws.on('open', () => {
        clearTimeout(to)
        if (settled) return
        settled = true
        if (!this.wanted || this.state.username !== username) { ws.close(); return resolve() }
        this.relay = ws
        ws.on('message', raw => {
          let m
          try { m = JSON.parse(raw.toString()) } catch (_) { return }
          const d = m.data || {}
          switch (m.event) {
            case 'gift': this._onGift(d); break
            case 'chat': this._onChat(d); break
            case 'follow': this.emit('follow', { viewer: normViewer(d) }); break
            case 'share': this.emit('share', { viewer: normViewer(d) }); break
            case 'like': this.emit('like', { viewer: normViewer(d), count: d.likeCount || 1, total: d.totalLikeCount || 0 }); break
            case 'roomUser': this._viewers(d.viewerCount); break
            case 'streamEnd': this._dropped('Stream wurde beendet', RETRY_OFFLINE_MS, 'waiting'); break
          }
        })
        ws.on('close', () => { if (this.relay === ws) this._dropped('Relay-Verbindung getrennt', RETRY_DROP_MS, 'reconnecting') })
        this._onLive('B')
        resolve()
      })
    })
  }

  // ---------------------------------------------------------------- Normalisierung
  _onChat (d) {
    const text = d.comment || (d.content && d.content.text) || ''
    if (text) this.emit('chat', { viewer: normViewer(d), text: String(text).slice(0, 300) })
  }

  _onGift (d) {
    const det = d.giftDetails || d.gift || d.extendedGiftInfo || {}
    const giftId = d.giftId ?? det.id ?? det.giftId
    const name = det.giftName || d.giftName || det.name || `Gift ${giftId}`
    const coins = det.diamondCount || d.diamondCount || det.diamond_count || 0
    const type = det.giftType ?? d.giftType ?? det.type
    const img = det.giftImage || det.icon || det.image
    const icon = d.giftPictureUrl || (img && (img.giftPictureUrl || (img.urls || img.url_list || img.urlList || [])[0])) || this.giftIcons[String(name).toLowerCase()] || null
    if (icon && !this.giftIcons[String(name).toLowerCase()]) this.giftIcons[String(name).toLowerCase()] = icon
    const viewer = normViewer(d)
    const total = Math.max(1, Number(d.repeatCount) || 1)
    const end = Number(type) === 1 ? !!d.repeatEnd : true
    const key = `${viewer.uniqueId}:${giftId}:${d.groupId || ''}`
    const seen = this.streaks.get(key) || 0
    const delta = Math.max(0, total - seen)
    if (end) this.streaks.delete(key); else this.streaks.set(key, total)
    if (this.streaks.size > 300) this.streaks.delete(this.streaks.keys().next().value)
    if (delta === 0) return
    this.emit('gift', { viewer, gift: { id: String(giftId), name, coins, icon }, count: total, delta, streakEnd: end })
  }
}

module.exports = { TikTokBridge, sanitizeUsername, classify, RETRY_OFFLINE_MS, RETRY_DROP_MS }
