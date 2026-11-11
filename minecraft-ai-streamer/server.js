'use strict'
/**
 * server.js – verbindet alles: Bot-Hirn, Streamer-Persona, TTS, TikTok, Gift-Engine, Overlay,
 * Dashboard und Handy-Fernbedienung.
 *
 *   http://localhost:3000/                      Dashboard
 *   http://localhost:3000/studio-overlay.html   EIN 1920x1080-Overlay für OBS / TikTok Live Studio
 *   http://localhost:3000/mobile.html           Handy-Fernbedienung (über Tunnel mit Schlüssel)
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const express = require('express')
const { WebSocketServer } = require('ws')

const { MinecraftAIBot, VIEWER_GOALS } = require('./modules/mc-ai-bot')
const { StreamerBrain } = require('./modules/ai-streamer-brain')
const { TTSEngine, MALE_VOICES } = require('./modules/tts-engine')
const { TikTokBridge, sanitizeUsername } = require('./modules/tiktok-bridge')
const { GiftEngine, ACTIONS, MOBS } = require('./modules/gift-engine')
const { Tunnel } = require('./modules/tunnel')
const { McServer } = require('./modules/mc-server')
const { worldCommands, sanitizeWorld, cleanCommand, RULES } = require('./modules/world-control')
const { lanAddresses } = require('./modules/lan')
const QRCode = require('qrcode')

const ROOT = __dirname
const PORT = Number(process.env.PORT || 3000)
const CFG_DIR = path.join(ROOT, 'config')
const SETTINGS_FILE = path.join(CFG_DIR, 'settings.json')
const LAYOUT_FILE = path.join(CFG_DIR, 'overlay-layout.json')

// ------------------------------------------------------------------ Konfiguration (/config/settings.json)
function readJson (file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (_) { return fallback } }
function loadConfig () {
  const base = readJson(path.join(ROOT, 'config.json'), {})
  const local = readJson(SETTINGS_FILE, {})
  const cfg = { ...base, ...local, minecraft: { ...base.minecraft, ...(local.minecraft || {}) } }
  if (!cfg.remoteKey) cfg.remoteKey = crypto.randomBytes(9).toString('base64url')
  cfg.tiktokUsername = sanitizeUsername(cfg.tiktokUsername)
  cfg.world = sanitizeWorld(cfg.world)
  return cfg
}
const config = loadConfig()
let layout = readJson(LAYOUT_FILE, null)
const pending = new Map()
/** Gebündeltes, atomares Schreiben (tmp + rename) – ein Timer pro Datei, nie parallele Schreibzugriffe. */
function writeLater (file, getData, delay = 250) {
  clearTimeout(pending.get(file))
  pending.set(file, setTimeout(() => {
    pending.delete(file)
    try {
      fs.mkdirSync(CFG_DIR, { recursive: true })
      fs.writeFileSync(file + '.tmp', JSON.stringify(getData(), null, 2))
      fs.renameSync(file + '.tmp', file)
    } catch (e) { console.log('[warn] Speichern fehlgeschlagen: ' + e.message) }
  }, delay))
}
function saveConfig () {
  writeLater(SETTINGS_FILE, () => ({ minecraft: config.minecraft, tiktokUsername: config.tiktokUsername, voice: config.voice, remoteKey: config.remoteKey, autoStartBot: config.autoStartBot, cameraPlayer: bot.camera.player, cameraMode: bot.camera.mode, giftRules: gifts.rules, world: config.world, mcRamGb: mc.ramGb }))
}
function sanitizeLayout (l) {
  if (!l || typeof l !== 'object') return null
  const out = { format: ['16:9', '9:16', 'custom'].includes(l.format) ? l.format : '16:9', formats: {} }
  for (const f of ['16:9', '9:16', 'custom']) {
    const src = (l.formats && l.formats[f]) || {}
    const dst = out.formats[f] = {}
    for (const id of ['cam', 'subs', 'legend', 'alerts', 'hud']) {
      const w = src[id]
      if (!w) continue
      const num = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d }
      dst[id] = { x: num(w.x, -400, 2200, 0), y: num(w.y, -400, 2200, 0), s: num(w.s, 0.5, 2, 1), h: !!w.h }
    }
  }
  return out
}

// ------------------------------------------------------------------ Module
const bot = new MinecraftAIBot(config.minecraft)
const tts = new TTSEngine({ voice: config.voice })
const tiktok = new TikTokBridge()
bot.camera.setPlayer(config.cameraPlayer || '')
bot.camera.setMode(config.cameraMode || 'auto')
const gifts = new GiftEngine({
  runCommands: cmds => bot.runCommands(cmds),
  spawnPoint: () => bot.spawnPoint(),
  botPos: () => { const s = bot.status(); return s.connected ? s.pos : null },
  onChange: () => { saveConfig(); syncGiftConfig(); broadcastState() }
}, config.giftRules)
const tunnel = new Tunnel(PORT, () => broadcastState())
const mc = new McServer({ dir: path.join(ROOT, 'mc-server'), port: config.minecraft.port, ramGb: config.mcRamGb })
bot.noSleep = config.world.timeLock === 'night'
mc.on('state', () => broadcastState())
mc.on('line', l => { if (l.important) log(/ERROR|FAILED/.test(l.text) ? 'warn' : 'info', '[MC] ' + l.text) })

// ---- Handy im selben WLAN: feste Adresse + QR-Code, ganz ohne Tunnel
const lan = { urls: [], qr: null }
async function refreshLan () {
  const urls = lanAddresses().map(a => `http://${a}:${PORT}/mobile.html?k=${encodeURIComponent(config.remoteKey)}`)
  if (urls.join() === lan.urls.join()) return
  lan.urls = urls
  lan.qr = urls[0] ? await QRCode.toDataURL(urls[0], { margin: 1, width: 360, color: { dark: '#0b0f14', light: '#ffffff' } }).catch(() => null) : null
  broadcastState()
}
setInterval(refreshLan, 30000).unref()

/** Server-Befehle: über die Konsole, wenn das Programm den Server selbst gestartet hat, sonst über den Bot (OP). */
function serverCommands (cmds) {
  if (mc.own && mc.state.phase === 'running') { for (const c of cmds) mc.command(c); return true }
  if (bot.connected) return bot.runCommands(cmds)
  return false
}
const logs = []
const feed = [] // Live-Feed (Chat + Gifts) für das Dashboard, hart begrenzt
let ttsWarnAt = 0
// Zentrale Ticker statt eigener Timer: Streamer-Hirn alle 250 ms, Bossbars alle 1,5 s
setImmediate(() => { bot.addTicker(() => brain.tick()); bot.addTicker(() => gifts.tick(), 6) })

const brain = new StreamerBrain({
  getStatus: () => bot.status(),
  pushGoal: (id, by) => bot.pushGoal(id, by),
  onAddress: () => bot.expressiveLook(),
  getSupportGift: kinds => gifts.supportGift(kinds),
  speak: async (line) => {
    const r = await tts.synthesize(line.text, line.emotion)
    broadcast({ type: 'TTS', id: line.id, text: line.text, emotion: line.emotion, kind: line.kind, words: r.words, durationMs: r.durationMs, mime: r.mime, audio: r.audio ? r.audio.toString('base64') : null })
    if (r.error && ttsWarnAt < Date.now()) { ttsWarnAt = Date.now() + 60000; log('warn', 'TTS: ' + r.error) }
    return r.durationMs
  }
})

// ------------------------------------------------------------------ HTTP + WebSocket
const app = express()
app.disable('x-powered-by')
app.use('/vendor', express.static(path.join(ROOT, 'node_modules', 'skinview3d', 'bundles'), { maxAge: '1d' }))
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }))
app.get('/skin.png', (req, res) => res.status(204).end()) // kein eigener Skin hinterlegt -> prozeduraler Standard-Skin
app.get('/dashboard.html', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')))
app.get('/health', (req, res) => res.json({ ok: true }))
const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 })
const clients = new Set()

function isLocal (req) {
  const fwd = req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['x-real-ip']
  if (fwd) return false
  const a = req.socket.remoteAddress || ''
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

function safeEqual (a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest()
  const y = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(x, y)
}

function send (ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)) }
function broadcast (msg, filter) {
  const s = JSON.stringify(msg)
  for (const c of clients) if (c.readyState === 1 && (!filter || filter(c))) c.send(s)
}
const isControl = c => c.role !== 'overlay'

function log (level, message) {
  const entry = { at: Date.now(), level, message: String(message).slice(0, 400) }
  logs.push(entry)
  if (logs.length > 200) logs.shift()
  broadcast({ type: 'LOG', entry }, isControl)
  if (level !== 'info') console.log(`[${level}] ${entry.message}`)
}

function fullState () {
  return {
    type: 'STATE',
    status: bot.status(),
    botRunning: bot.running,
    tiktok: tiktok.state,
    tunnel: tunnel.state,
    lan,
    mc: mc.state,
    world: config.world,
    worldRules: Object.entries(RULES).map(([id, r]) => ({ id, label: r.label })),
    config: { minecraft: config.minecraft, tiktokUsername: config.tiktokUsername || '', voice: tts.voice, voices: MALE_VOICES, cameraPlayer: bot.camera.player, cameraMode: bot.camera.mode },
    mobs: Object.keys(MOBS),
    layout,
    designer: designerOn,
    feed: feed.slice(-40),
    rules: gifts.rules,
    actions: Object.entries(ACTIONS).map(([id, a]) => ({ id, label: a.label, kind: a.kind })),
    goals: Object.entries(VIEWER_GOALS).map(([id, g]) => ({ id, label: g.label })),
    tts: { backend: tts.backend, error: tts.lastError },
    viewers: brain.memorySnapshot(),
    logs: logs.slice(-40)
  }
}
let designerOn = false
function pushFeed (item) { item.at = Date.now(); feed.push(item); if (feed.length > 80) feed.shift(); broadcast({ type: 'FEED', item }, isControl) }
function broadcastState () { broadcast(fullState(), isControl) }
function syncGiftConfig () { broadcast({ type: 'GIFT_CONFIG_SYNC', gifts: gifts.publicConfig() }) }

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x')
  const local = isLocal(req)
  const keyOk = safeEqual(url.searchParams.get('k') || '', config.remoteKey)
  ws.role = url.searchParams.get('role') === 'overlay' ? 'overlay' : (url.searchParams.get('role') || 'dashboard')
  // Steuerung von außerhalb (Tunnel) nur mit Schlüssel; das Overlay empfängt nur
  ws.canControl = ws.role !== 'overlay' && (local || keyOk)
  ws.canLayout = local || keyOk
  if (!local && !keyOk) { send(ws, { type: 'DENIED', reason: 'Schlüssel fehlt oder ist falsch' }); ws.close(); return }
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
  ws.on('error', () => clients.delete(ws))
  send(ws, { type: 'GIFT_CONFIG_SYNC', gifts: gifts.publicConfig() })
  if (ws.role === 'overlay') { send(ws, { type: 'STATUS', status: bot.status() }); send(ws, { type: 'LAYOUT', layout }); send(ws, { type: 'DESIGNER', on: designerOn }) }
  else send(ws, fullState())
  ws.on('message', raw => {
    let m
    try { m = JSON.parse(raw.toString()) } catch (_) { return }
    if (!m || typeof m.type !== 'string') return
    if (m.type === 'LAYOUT_SET' && ws.canLayout) { const l = sanitizeLayout(m.layout); if (l) { layout = l; writeLater(LAYOUT_FILE, () => layout); broadcast({ type: 'LAYOUT', layout }, c => c !== ws) } return }
    if (!ws.canControl) return
    try { handle(m) } catch (e) { log('error', `Befehl ${m.type}: ${e.message}`) }
  })
})

// ------------------------------------------------------------------ Befehle (Dashboard / Handy)
function handle (m) {
  switch (m.type) {
    case 'TIKTOK_CONNECT': {
      // Eingabe säubern (@, Leerzeichen, komplette URLs), dauerhaft speichern, Watchdog starten
      const name = sanitizeUsername(m.username)
      config.tiktokUsername = name
      saveConfig()
      if (name) tiktok.start(name); else tiktok.stop()
      broadcastState()
      break
    }
    case 'TIKTOK_DISCONNECT': tiktok.stop(); break
    case 'GIFT_RULES_SET': gifts.setRules(m.rules); saveConfig(); syncGiftConfig(); broadcastState(); break
    case 'GIFT_UPSERT': { const r = gifts.upsertRule(m.rule || {}); if (r) { log('info', `Gift gespeichert: ${r.giftName} (${r.coins}) -> ${r.legend}`); saveConfig(); syncGiftConfig(); broadcastState() } break }
    case 'GIFT_REMOVE': if (gifts.removeRule(String(m.id))) { saveConfig(); syncGiftConfig(); broadcastState() } break
    case 'GIFT_RULES_RESET': gifts.resetRules(); saveConfig(); syncGiftConfig(); broadcastState(); break
    case 'DESIGNER': designerOn = !!m.on; broadcast({ type: 'DESIGNER', on: designerOn }); broadcastState(); break
    case 'LAYOUT_FORMAT': if (['16:9', '9:16', 'custom'].includes(m.format)) { layout = sanitizeLayout({ ...(layout || {}), format: m.format }); writeLater(LAYOUT_FILE, () => layout); broadcast({ type: 'LAYOUT', layout }); broadcastState() } break
    case 'LAYOUT_RESET': layout = null; try { fs.unlinkSync(LAYOUT_FILE) } catch (_) {} broadcast({ type: 'LAYOUT', layout: null, reset: true }); broadcastState(); break
    case 'MODE': { const mode = bot.setMode(String(m.mode)); if (mode === 'cave') bot._emit('cave_start', { auto: false }); log('info', 'Bot-Modus: ' + mode); broadcastState(); break }
    case 'CAMERA': bot.camera.setMode(String(m.mode)); saveConfig(); broadcastState(); break
    case 'SIM_GIFT': {
      const rule = gifts.rules.find(r => r.id === m.ruleId)
      if (!rule) break
      const viewer = { uniqueId: String(m.user || 'TestUser').slice(0, 24), nickname: String(m.user || 'TestUser').slice(0, 24), avatar: null }
      onGift({ viewer, gift: { id: rule.id, ruleId: rule.id, name: rule.giftName, coins: rule.coins, icon: null }, count: Math.max(1, Math.min(99, m.count | 0 || 1)), delta: Math.max(1, Math.min(99, m.count | 0 || 1)), streakEnd: true })
      break
    }
    case 'SIM_CHAT': onChat({ viewer: { uniqueId: String(m.user || 'TestUser').slice(0, 24), nickname: String(m.user || 'TestUser').slice(0, 24) }, text: String(m.text || '').slice(0, 300) }); break
    case 'SAY': brain.sayCustom(m.text, ['chill', 'hype', 'panic'].includes(m.emotion) ? m.emotion : 'chill'); break
    case 'VOICE_ENABLED': brain.enabled = !!m.enabled; break
    case 'CONFIG_SET':
      if (m.minecraft) {
        const mc = m.minecraft
        config.minecraft = {
          host: String(mc.host || '127.0.0.1').slice(0, 100),
          port: Math.max(1, Math.min(65535, Number(mc.port) || 25565)),
          username: String(mc.username || 'KI_Streamer').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'KI_Streamer',
          version: String(mc.version || '1.21.1').slice(0, 12),
          auth: mc.auth === 'microsoft' ? 'microsoft' : 'offline'
        }
        Object.assign(bot.config, config.minecraft)
      }
      if (m.voice) config.voice = tts.setVoice(m.voice)
      if (typeof m.cameraPlayer === 'string') bot.camera.setPlayer(m.cameraPlayer)
      saveConfig()
      broadcastState()
      break
    case 'WORLD': {
      if (m.op === 'clear_mobs') {
        // Alle Monster verschwinden lassen: kurz auf Friedlich, dann zurück auf die alte Schwierigkeit
        const back = ['easy', 'normal', 'hard'].includes(bot.status().world && bot.status().world.difficulty) ? bot.status().world.difficulty : 'normal'
        if (!serverCommands(['difficulty peaceful'])) { log('warn', 'Welt-Steuerung: Server ist nicht erreichbar'); break }
        setTimeout(() => serverCommands([`difficulty ${back}`]), 1500)
        log('info', 'Welt: alle Monster entfernt')
        break
      }
      const r = worldCommands(m, config.world)
      if (!r) break
      if (!serverCommands(r.cmds)) { log('warn', 'Welt-Steuerung: Server ist nicht erreichbar (Bot offline?)'); break }
      bot.noSleep = config.world.timeLock === 'night'
      log('info', 'Welt: ' + r.label)
      saveConfig()
      broadcastState()
      setTimeout(broadcastState, 600)
      break
    }
    case 'MC_COMMAND': {
      const cmd = cleanCommand(m.text)
      if (!cmd) break
      log(serverCommands([cmd]) ? 'info' : 'warn', (bot.connected || mc.own ? 'Server-Befehl: /' : 'Server nicht erreichbar, Befehl verworfen: /') + cmd)
      break
    }
    case 'MC_SERVER':
      switch (m.cmd) {
        case 'start': mc.start().then(r => { if (r.ok) { log('info', 'Minecraft-Server startet …'); if (!bot.running) bot.start() } else log('warn', 'Minecraft-Server: ' + r.reason) }); break
        case 'stop': stopMc(); break
        case 'restart': stopMc().then(ok => { if (ok) setTimeout(() => mc.start(), 1500); else log('warn', 'Neustart geht nur, wenn der Server über das Dashboard gestartet wurde.') }); break
        case 'ram': mc.ramGb = Math.max(1, Math.min(32, Number(m.gb) || 4)); saveConfig(); break
      }
      break
    case 'TUNNEL_START': tunnel.start(config.remoteKey); break
    case 'TUNNEL_STOP': tunnel.stop(); break
    case 'BOT':
      switch (m.cmd) {
        case 'start': bot.start(); break
        case 'stop': bot.stop(); break
        case 'pause': bot.setPaused(true); break
        case 'resume': bot.setPaused(false); break
        case 'unstuck': bot.unstuck().catch(() => {}); break
        case 'respawn': bot.respawn(); break
        case 'give': bot.give(String(m.item || ''), Number(m.count) || 1); break
        case 'corpse': bot.forceCorpseRun(); break
        case 'rescue': bot.rescue(); break
        case 'abort_cave': bot.abortCave(); break
        case 'goal': { const r = bot.pushGoal(String(m.goal || ''), 'Regie'); log('info', `Ziel ${m.goal}: ${JSON.stringify(r)}`); break }
        case 'clear_goals': bot.clearGoals(); break
        case 'chat': bot.say(m.text); break
      }
      setTimeout(broadcastState, 150)
      break
  }
}

/** Minecraft-Server sauber stoppen. true = eigener Prozess wurde beendet. */
async function stopMc () {
  if (mc.own) { log('info', 'Minecraft-Server wird gestoppt (Welt wird gespeichert) …'); return mc.stop() }
  if (bot.connected && bot.runCommands(['stop'])) { log('info', 'Stop-Befehl an den Minecraft-Server geschickt'); mc.markStopping() } else log('warn', 'Minecraft-Server ist nicht erreichbar')
  return false
}

// ------------------------------------------------------------------ Verdrahtung
function onGift ({ viewer, gift, count, delta }) {
  const res = gifts.trigger(gift, viewer, delta)
  const rule = res.rule
  const effect = res.effect
  const coins = gift.coins || rule.coins
  broadcast({
    type: 'GIFT_ALERT',
    user: viewer.nickname || viewer.uniqueId,
    uniqueId: viewer.uniqueId,
    avatar: viewer.avatar || null,
    gift: { name: rule.giftName, emoji: rule.emoji, icon: gift.icon || rule.icon || null, coins },
    count,
    legend: rule.legend,
    kind: effect.kind,
    tier: effect.tier
  })
  pushFeed({ kind: 'gift', user: viewer.nickname || viewer.uniqueId, avatar: viewer.avatar || null, text: `${rule.giftName} x${count} (${coins} Coins) → ${rule.legend}`, emoji: rule.emoji })
  // Das Streamer-Hirn bekommt Name, Coins und Wirkung dynamisch – auch für neue und eigene Gifts
  if (res.discovered) brain.onGiftDiscovered(viewer, { name: rule.giftName })
  if (effect.kind !== 'none') brain.onGift(viewer, { id: rule.id, name: rule.giftName, coins }, effect, delta)
  if (!res.ok && res.reason === 'bot_offline') log('warn', `Gift ${rule.giftName} von ${viewer.uniqueId}: Bot ist nicht in der Welt`)
}

function onChat ({ viewer, text }) {
  const r = brain.onChat(viewer, text)
  pushFeed({ kind: 'chat', user: viewer.nickname || viewer.uniqueId, avatar: viewer.avatar || null, text, goal: r.goal || null })
}

tiktok.on('gift', onGift)
tiktok.on('chat', onChat)
tiktok.on('follow', e => brain.onFollow(e.viewer))
tiktok.on('share', e => brain.onShare(e.viewer))
tiktok.on('like', e => brain.onLike(e.viewer, e.count))
let lastDiag = null
tiktok.on('state', s => { if (s.diagnostic && s.diagnostic !== lastDiag) log('warn', 'TikTok: ' + s.diagnostic); lastDiag = s.diagnostic; broadcastState() })
tiktok.on('gift_icons', icons => { if (gifts.learnIcons(icons)) { saveConfig(); syncGiftConfig(); broadcastState() } })
tiktok.on('live', e => {
  log('info', `TikTok LIVE verbunden: @${e.username} (Engine ${e.engine})`)
  broadcast({ type: 'CHIME', kind: 'live' })
  brain.onLiveConnected()
})
tiktok.on('follow', e => pushFeed({ kind: 'follow', user: e.viewer.nickname, text: 'folgt jetzt', emoji: '➕' }))

const OVERLAY_EVENTS = new Set(['liquid_escape', 'liquid_rescue', 'camera', 'corpse_run_start', 'corpse_run_done', 'swing', 'hurt', 'shield', 'death', 'combat_start', 'combat_end', 'kill', 'low_hp', 'critical_hp', 'lava', 'enchanted', 'respawn', 'ate', 'build_done', 'portal_lit'])
bot.on('event', e => {
  brain.onBotEvent(e.type, e.data)
  if (OVERLAY_EVENTS.has(e.type)) broadcast({ type: 'BOT_EVENT', event: e.type, data: e.data })
  else if (e.type !== 'hotbar') broadcast({ type: 'BOT_EVENT', event: e.type, data: e.data }, isControl)
  if (e.type === 'log') log('info', e.data.message)
  else if (e.type === 'warn' || e.type === 'bot_error' || e.type === 'bot_kicked') log('warn', e.data.message || e.data.reason || e.type)
  else if (['bot_spawned', 'bot_disconnected', 'plan', 'death', 'goal_pushed', 'goal_done', 'goal_failed', 'action_cooldown', 'build_done', 'enchanted', 'portal_lit', 'mode', 'cave_done', 'cave_aborted', 'liquid_rescue'].includes(e.type)) {
    log('info', `${e.type} ${JSON.stringify(e.data).slice(0, 200)}`)
    broadcastState()
  }
})
bot.on('status', status => broadcast({ type: 'STATUS', status }))
bot.on('pose', pose => broadcast({ type: 'POSE', pose }, c => c.role === 'overlay'))

server.listen(PORT, () => {
  console.log('')
  console.log('  Minecraft-KI-Streamer läuft')
  console.log(`  Dashboard:       http://localhost:${PORT}/`)
  console.log(`  Studio-Overlay:  http://localhost:${PORT}/studio-overlay.html   (OBS-Browserquelle, 1920x1080)`)
  console.log('  Handy:           QR-Code im Dashboard scannen (gleiches WLAN) oder Tunnel für unterwegs starten')
  console.log('')
  refreshLan()
  if (config.autoStartBot) bot.start()
  // Gespeicherter TikTok-Name: Watchdog startet ohne einen einzigen Klick
  if (config.tiktokUsername) tiktok.start(config.tiktokUsername)
  if (process.env.OPEN_BROWSER === '1') {
    const cmd = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    require('child_process').exec(`${cmd} http://localhost:${PORT}/`)
  }
})

let closing = false
async function shutdown () {
  if (closing) return
  closing = true
  try { tiktok.stop() } catch (_) {}
  try { bot.dispose() } catch (_) {}
  try { tunnel.stop() } catch (_) {}
  // Selbst gestarteten Minecraft-Server sauber beenden, damit die Welt gespeichert wird
  if (mc.own) { console.log('  Minecraft-Server wird gestoppt …'); await Promise.race([mc.stop(), new Promise(resolve => setTimeout(resolve, 20000))]) }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('unhandledRejection', e => log('error', 'Unbehandelt: ' + ((e && e.message) || e)))
