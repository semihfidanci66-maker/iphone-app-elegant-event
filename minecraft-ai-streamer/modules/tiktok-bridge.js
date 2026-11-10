'use strict'
/**
 * tiktok-bridge.js – TikTok-Live-Anbindung (tiktok-live-connector v2) mit normalisierten Events:
 *   'gift'  { viewer, gift: {id, name, coins, icon}, count, delta, streakEnd }
 *   'chat'  { viewer, text }      'follow' / 'share' / 'like' { viewer, count }
 *   'state' { connected, username, error, viewers }
 * Combo-Streaks werden inkrementell gemeldet (delta), damit der Mob sofort spawnt und der
 * Combo-Zähler im Overlay live hochläuft.
 */
const EventEmitter = require('events')

function pic (u) {
  if (!u) return null
  if (typeof u === 'string') return u
  const p = u.profilePicture || u.avatarThumb || u.profilePictureUrl
  if (typeof p === 'string') return p
  const urls = p && (p.urls || p.url || p.urlList)
  return Array.isArray(urls) ? urls[0] || null : null
}

function normViewer (d) {
  const u = d.user || d
  return {
    uniqueId: u.uniqueId || d.uniqueId || u.displayId || 'anonym',
    nickname: u.nickname || d.nickname || u.uniqueId || d.uniqueId || 'Anonym',
    avatar: pic(u) || d.profilePictureUrl || null
  }
}

class TikTokBridge extends EventEmitter {
  constructor () {
    super()
    this.conn = null
    this.state = { connected: false, connecting: false, username: null, error: null, viewers: 0 }
    this.streaks = new Map()
    this.giftIcons = {}
  }

  _set (patch) { Object.assign(this.state, patch); this.emit('state', { ...this.state }) }

  async connect (username) {
    username = String(username || '').trim().replace(/^@/, '')
    if (!username) { this._set({ error: 'Kein TikTok-Benutzername angegeben' }); return false }
    await this.disconnect()
    this._set({ connecting: true, username, error: null })
    let lib
    try { lib = require('tiktok-live-connector') } catch (e) { this._set({ connecting: false, error: 'tiktok-live-connector fehlt: ' + e.message }); return false }
    const Conn = lib.TikTokLiveConnection || lib.WebcastPushConnection
    const EV = lib.WebcastEvent || {}
    const CE = lib.ControlEvent || {}
    const conn = new Conn(username, { enableExtendedGiftInfo: true, processInitialData: false })
    this.conn = conn
    conn.on(EV.GIFT || 'gift', d => this._onGift(d))
    conn.on(EV.CHAT || 'chat', d => { const text = d.comment || (d.content && d.content.text) || ''; if (text) this.emit('chat', { viewer: normViewer(d), text }) })
    conn.on(EV.FOLLOW || 'follow', d => this.emit('follow', { viewer: normViewer(d) }))
    conn.on(EV.SHARE || 'share', d => this.emit('share', { viewer: normViewer(d) }))
    conn.on(EV.LIKE || 'like', d => this.emit('like', { viewer: normViewer(d), count: d.likeCount || d.count || 1 }))
    conn.on(EV.ROOM_USER || 'roomUser', d => { this.state.viewers = d.viewerCount || d.totalUser || this.state.viewers })
    conn.on(EV.STREAM_END || 'streamEnd', () => this._set({ connected: false, error: 'Stream beendet' }))
    conn.on(CE.DISCONNECTED || 'disconnected', () => { if (this.conn === conn) this._set({ connected: false }) })
    conn.on(CE.ERROR || 'error', e => this._set({ error: (e && (e.info || e.message)) || 'Verbindungsfehler' }))
    try {
      await conn.connect()
      this._set({ connected: true, connecting: false, error: null })
      this._loadGiftIcons(conn)
      return true
    } catch (e) {
      this.conn = null
      this._set({ connected: false, connecting: false, error: (e && e.message) || String(e) })
      return false
    }
  }

  async _loadGiftIcons (conn) {
    try {
      const fn = conn.fetchAvailableGifts || conn.getAvailableGifts
      if (!fn) return
      const gifts = await fn.call(conn)
      for (const g of gifts || []) {
        const url = (g.image && (g.image.url_list || g.image.urlList || g.image.urls || [])[0]) || (g.icon && (g.icon.url_list || [])[0])
        if (g.name && url) this.giftIcons[String(g.name).toLowerCase()] = url
      }
      this.emit('gift_icons', this.giftIcons)
    } catch (_) {}
  }

  _onGift (d) {
    const det = d.giftDetails || d.gift || d.extendedGiftInfo || {}
    const name = det.giftName || d.giftName || det.name || `Gift ${d.giftId}`
    const coins = det.diamondCount || d.diamondCount || 0
    const type = det.giftType ?? d.giftType
    const img = det.giftImage || det.icon || det.image
    const icon = d.giftPictureUrl || (img && (img.giftPictureUrl || (img.urls || img.url_list || img.urlList || [])[0])) || this.giftIcons[String(name).toLowerCase()] || null
    if (icon) this.giftIcons[String(name).toLowerCase()] = icon
    const viewer = normViewer(d)
    const total = Math.max(1, d.repeatCount || 1)
    const end = type === 1 ? !!d.repeatEnd : true
    const key = `${viewer.uniqueId}:${d.giftId}:${d.groupId || ''}`
    const seen = this.streaks.get(key) || 0
    const delta = Math.max(0, total - seen)
    if (end) this.streaks.delete(key); else this.streaks.set(key, total)
    if (this.streaks.size > 500) this.streaks.clear()
    if (delta === 0) return
    this.emit('gift', { viewer, gift: { id: String(d.giftId), name, coins, icon }, count: total, delta, streakEnd: end })
  }

  async disconnect () {
    const c = this.conn
    this.conn = null
    if (c) { try { await c.disconnect() } catch (_) {} }
    this.streaks.clear()
    if (this.state.connected || this.state.connecting) this._set({ connected: false, connecting: false })
  }
}

module.exports = { TikTokBridge }
