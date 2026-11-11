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
const { LikeGoal, sanitizeLikes } = require('./modules/like-goal')
const { LlmBrain, sanitizeLlm } = require('./modules/llm-brain')
const { AILearning } = require('./modules/ai-learning')
const { GameModeManager } = require('./modules/game-mode')
const { ChatWisdom, RULES: TIP_RULES, matchRule: matchTip } = require('./modules/chat-wisdom')
const QRCode = require('qrcode')

const ROOT = __dirname
const PORT = Number(process.env.PORT || 3000)
const CFG_DIR = path.join(ROOT, 'config')
const SETTINGS_FILE = path.join(CFG_DIR, 'settings.json')
const LAYOUT_FILE = path.join(CFG_DIR, 'overlay-layout.json')
const LIBRARY_FILE = path.join(CFG_DIR, 'tiktok-gifts.json')
const MISTAKES_FILE = path.join(CFG_DIR, 'mistakes_memory.json')
const WISDOM_FILE = path.join(CFG_DIR, 'chat_wisdom.json')

// ------------------------------------------------------------------ Konfiguration (/config/settings.json)
function readJson (file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (_) { return fallback } }
function loadConfig () {
  const base = readJson(path.join(ROOT, 'config.json'), {})
  const local = readJson(SETTINGS_FILE, {})
  const cfg = { ...base, ...local, minecraft: { ...base.minecraft, ...(local.minecraft || {}) } }
  if (!cfg.remoteKey) cfg.remoteKey = crypto.randomBytes(9).toString('base64url')
  cfg.tiktokUsername = sanitizeUsername(cfg.tiktokUsername)
  cfg.world = sanitizeWorld(cfg.world)
  cfg.likes = sanitizeLikes(cfg.likes)
  cfg.llm = sanitizeLlm(cfg.llm)
  const r = cfg.remote && typeof cfg.remote === 'object' ? cfg.remote : {}
  cfg.remote = { autoTunnel: !!r.autoTunnel, notify: !!r.notify, notifyTopic: /^[A-Za-z0-9_-]{8,64}$/.test(r.notifyTopic || '') ? r.notifyTopic : 'ki-streamer-' + crypto.randomBytes(9).toString('base64url') }
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
  writeLater(SETTINGS_FILE, () => ({ minecraft: config.minecraft, tiktokUsername: config.tiktokUsername, voice: config.voice, remoteKey: config.remoteKey, autoStartBot: config.autoStartBot, cameraPlayer: bot.camera.player, cameraMode: bot.camera.mode, giftRules: gifts.rules, likes: likes.config, arena: gameMode.toJSON(), remote: config.remote, llm: llm.config, anthropicKey: config.anthropicKey || undefined, world: config.world, mcRamGb: mc.ramGb }))
}
function sanitizeLayout (l) {
  if (!l || typeof l !== 'object') return null
  const out = { format: ['16:9', '9:16', 'custom'].includes(l.format) ? l.format : '9:16', formats: {} }
  for (const f of ['16:9', '9:16', 'custom']) {
    const src = (l.formats && l.formats[f]) || {}
    const dst = out.formats[f] = {}
    for (const id of ['cam', 'subs', 'legend', 'alerts', 'hud', 'likes']) {
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
// ---- Lernen: Fehler-Gedächtnis und Chat-Tipps (überleben Neustarts)
let learnPush = null
const learnChanged = () => { if (!learnPush) learnPush = setTimeout(() => { learnPush = null; broadcastState() }, 1500) }
const learning = new AILearning(readJson(MISTAKES_FILE, null), { onChange: () => { writeLater(MISTAKES_FILE, () => learning.toJSON(), 2000); learnChanged() } })
const wisdom = new ChatWisdom(readJson(WISDOM_FILE, null), { onChange: () => { writeLater(WISDOM_FILE, () => wisdom.toJSON(), 2000); learning.setTips(wisdom.active()); learnChanged() } })
learning.setTips(wisdom.active())
bot.attachLearning(learning)
const tiktok = new TikTokBridge()
bot.camera.setPlayer(config.cameraPlayer || '')
bot.camera.setMode(config.cameraMode || 'auto')
const gifts = new GiftEngine({
  runCommands: cmds => bot.runCommands(cmds),
  spawnPoint: () => bot.spawnPoint(),
  botPos: () => { const s = bot.status(); return s.connected ? s.pos : null },
  onChange: () => { saveConfig(); syncGiftConfig(); broadcastState() }
}, config.giftRules)
gifts.loadLibrary(readJson(LIBRARY_FILE, null))
const likes = new LikeGoal(config.likes)
likes.setConfig({}, ACTIONS, MOBS)
// ---- Fernzugriff übers Internet: Tunnel startet auf Wunsch von selbst, läuft nach einem Abbruch wieder an
//      und schickt die neue Adresse per Push aufs Handy (ohne Zugangscode – den gibt man auf der Seite ein).
let tunnelWas = false
let tunnelStopped = false // von Hand gestoppt -> nicht von selbst wieder öffnen
let tunnelRetry = null
const tunnel = new Tunnel(PORT, st => {
  if (st.active && !tunnelWas) { log('info', `Fernzugriff aktiv: ${st.base}/  (über ${st.provider})`); notifyRemote(`KI-Streamer ist online. Dashboard: ${st.base}/  Handy: ${st.base}/mobile.html`) }
  if (!st.active && !st.starting && tunnelWas && config.remote.autoTunnel && !tunnelStopped && !closing) {
    log('warn', 'Fernzugriff unterbrochen – neuer Versuch in 15 Sekunden')
    clearTimeout(tunnelRetry); tunnelRetry = setTimeout(() => tunnel.start(config.remoteKey), 15000)
  }
  tunnelWas = st.active
  broadcastState()
})
/** Push-Nachricht über ntfy (nur wenn im Dashboard eingeschaltet). Enthält nie den Zugangscode. */
async function notifyRemote (text) {
  if (!config.remote.notify) return false
  try {
    const res = await fetch('https://ntfy.sh/' + config.remote.notifyTopic, { method: 'POST', headers: { Title: 'KI-Streamer', Tags: 'video_game' }, body: text, signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return true
  } catch (e) { log('warn', 'Push-Nachricht konnte nicht gesendet werden: ' + e.message); return false }
}
// Schutz gegen Durchprobieren des Zugangscodes von außen
const authFails = []
let authLockedUntil = 0
function authFailed () {
  const now = Date.now()
  authFails.push(now)
  while (authFails.length && now - authFails[0] > 600000) authFails.shift()
  if (authFails.length >= 8 && now > authLockedUntil) { authLockedUntil = now + 600000; authFails.length = 0; log('warn', 'Fernzugriff: zu viele falsche Zugangscodes – Anmeldung von außen für 10 Minuten gesperrt') }
}
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

// Sprachmodell für frei formulierte Chat-Antworten (optional; der Schlüssel bleibt lokal in config/settings.json)
const llm = new LlmBrain(config.llm, { apiKey: config.anthropicKey })
let llmWarn = ''
setInterval(() => {
  // Probleme einmal ins Protokoll schreiben, nicht bei jeder Anfrage
  const msg = llm.stats.budgetHit ? `Sprachmodell: Budget von ${llm.config.budgetUsd} $ erreicht – ab jetzt wieder feste Texte` : llm.stats.lastError ? 'Sprachmodell: ' + llm.stats.lastError : ''
  if (msg && msg !== llmWarn) log('warn', msg)
  llmWarn = msg
}, 5000).unref()

// ---- Spielmodus: SURVIVAL (bisherige Logik) oder ARENA. Ereignisse der Arena laufen über denselben Weg wie Bot-Ereignisse.
const gameMode = new GameModeManager(bot, {
  run: cmds => serverCommands(cmds),
  emit: (type, data) => bot._emit(type, data),
  saved: config.arena,
  onChange: () => { saveConfig(); broadcastState() },
  // Regeln, die die Arena umstellt, beim Verlassen so zurücksetzen, wie sie in der Welt-Steuerung stehen
  restoreRules: () => [`gamerule doDaylightCycle ${config.world.timeLock === 'off'}`, `gamerule keepInventory ${config.world.rules.keepInventory === true}`, `gamerule mobGriefing ${config.world.rules.mobGriefing !== false}`]
})

const brain = new StreamerBrain({
  llm,
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
    remote: { autoTunnel: config.remote.autoTunnel, notify: config.remote.notify, notifyTopic: config.remote.notifyTopic },
    lan,
    mc: mc.state,
    likes: { config: likes.config, ...likes.state(), legend: likeLegend() },
    llm: llm.publicState(),
    learning: learning.summary(),
    arena: gameMode.status(),
    wisdom: wisdom.summary(),
    world: config.world,
    worldRules: Object.entries(RULES).map(([id, r]) => ({ id, label: r.label })),
    config: { minecraft: config.minecraft, tiktokUsername: config.tiktokUsername || '', voice: tts.voice, voices: MALE_VOICES, cameraPlayer: bot.camera.player, cameraMode: bot.camera.mode },
    mobs: Object.keys(MOBS),
    mobNames: Object.fromEntries(Object.entries(MOBS).map(([id, m]) => [id, m[1]])),
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
function syncGiftConfig () { broadcast({ type: 'GIFT_CONFIG_SYNC', gifts: gameMode.mode === 'ARENA' ? ARENA_LEGEND : gifts.publicConfig() }) }
const libraryMsg = () => ({ type: 'GIFT_LIBRARY', at: gifts.libraryAt, gifts: gifts.libraryList() })
function syncLibrary () { broadcast(libraryMsg(), isControl) }

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x')
  const local = isLocal(req)
  const keyOk = safeEqual(url.searchParams.get('k') || '', config.remoteKey)
  ws.role = url.searchParams.get('role') === 'overlay' ? 'overlay' : (url.searchParams.get('role') || 'dashboard')
  // Steuerung von außerhalb (Tunnel) nur mit Schlüssel; das Overlay empfängt nur
  ws.canControl = ws.role !== 'overlay' && (local || keyOk)
  ws.canLayout = local || keyOk
  const locked = !local && Date.now() < authLockedUntil
  if (!local && (!keyOk || locked)) { if (!locked && url.searchParams.get('k')) authFailed(); send(ws, { type: 'DENIED', reason: locked ? 'Zu viele Fehlversuche. Bitte in 10 Minuten noch einmal.' : url.searchParams.get('k') ? 'Zugangscode ist falsch' : 'Zugangscode fehlt' }); ws.close(); return }
  ws.isLocal = local
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
  ws.on('error', () => clients.delete(ws))
  send(ws, { type: 'GIFT_CONFIG_SYNC', gifts: gameMode.mode === 'ARENA' ? ARENA_LEGEND : gifts.publicConfig() })
  send(ws, likesMsg())
  if (ws.role === 'overlay') { send(ws, { type: 'STATUS', status: bot.status() }); send(ws, { type: 'LAYOUT', layout }); send(ws, { type: 'DESIGNER', on: designerOn }) }
  else { send(ws, fullState()); send(ws, libraryMsg()) }
  ws.on('message', raw => {
    let m
    try { m = JSON.parse(raw.toString()) } catch (_) { return }
    if (!m || typeof m.type !== 'string') return
    if (m.type === 'LAYOUT_SET' && ws.canLayout) { const l = sanitizeLayout(m.layout); if (l) { layout = l; writeLater(LAYOUT_FILE, () => layout); broadcast({ type: 'LAYOUT', layout }, c => c !== ws) } return }
    if (!ws.canControl) return
    try { handle(m, ws) } catch (e) { log('error', `Befehl ${m.type}: ${e.message}`) }
  })
})

// ------------------------------------------------------------------ Befehle (Dashboard / Handy)
function handle (m, ws = { isLocal: true }) {
  switch (m.type) {
    case 'REMOTE_SET': {
      // Fernzugriff einstellen geht nur am PC selbst – von außen lässt sich der Zugang nicht umbauen
      if (!ws.isLocal) { log('warn', 'Fernzugriff-Einstellungen lassen sich nur am PC selbst ändern'); break }
      const p = m.remote || {}
      if (typeof p.autoTunnel === 'boolean') { config.remote.autoTunnel = p.autoTunnel; if (p.autoTunnel && !tunnel.state.active && !tunnel.state.starting) tunnel.start(config.remoteKey) }
      if (typeof p.notify === 'boolean') config.remote.notify = p.notify
      if (typeof p.password === 'string') {
        const pw = p.password.trim()
        if (pw.length < 8 || pw.length > 64) { log('warn', 'Zugangscode muss 8 bis 64 Zeichen lang sein'); break }
        config.remoteKey = pw
        log('info', 'Neuer Zugangscode gespeichert. Geräte von außen müssen sich neu anmelden.')
        for (const c of clients) if (!c.isLocal) c.close()
        lan.urls = []; refreshLan()
        if (tunnel.state.active) { tunnel.stop(); tunnel.start(config.remoteKey) }
      }
      saveConfig(); broadcastState()
      break
    }
    case 'REMOTE_TEST': if (ws.isLocal) notifyRemote(tunnel.state.active ? `Test: KI-Streamer ist erreichbar unter ${tunnel.state.base}/` : 'Test: Push funktioniert. Der Internet-Zugang ist gerade aus.').then(ok => log(ok ? 'info' : 'warn', ok ? 'Push-Test gesendet' : 'Push-Test fehlgeschlagen (ist Push eingeschaltet?)')); break
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
    case 'GIFT_REMOVE': if (gifts.removeRule(String(m.id))) { saveConfig(); syncGiftConfig(); syncLibrary(); broadcastState() } break
    case 'GIFT_ADD_LIBRARY': { const r = gifts.addFromLibrary(m.key); if (r) { log('info', `Gift hinzugefügt: ${r.giftName} (${r.coins} Coins) -> ${r.legend}`); saveConfig(); syncGiftConfig(); syncLibrary(); broadcastState() } break }
    case 'LLM_SET': {
      const p = m.llm || {}
      // Der Schlüssel wird nur gesetzt, nie zurückgeschickt. Leerer Text = Schlüssel löschen.
      if (typeof p.apiKey === 'string') { config.anthropicKey = p.apiKey.trim().slice(0, 300); llm.setKey(config.anthropicKey); log('info', config.anthropicKey ? 'Sprachmodell: API-Schlüssel gespeichert' : 'Sprachmodell: API-Schlüssel entfernt') }
      config.llm = llm.setConfig({ enabled: p.enabled, model: p.model, budgetUsd: p.budgetUsd, maxPerHour: p.maxPerHour, monologues: p.monologues })
      saveConfig(); broadcastState()
      break
    }
    case 'GAME_MODE': {
      const want = m.mode === 'ARENA' ? 'ARENA' : 'SURVIVAL'
      log('info', want === 'ARENA' ? 'Wechsel in den Arena-Modus …' : 'Zurück in den Survival-Modus …')
      gameMode.setMode(want).then(r => { log(r.ok ? 'info' : 'warn', r.ok ? `Spielmodus: ${r.mode}` : 'Moduswechsel nicht möglich: ' + r.reason); syncGiftConfig(); broadcastState() })
      break
    }
    case 'ARENA_BUILD': log('info', 'Arena wird gebaut (dauert rund 20 Sekunden) …'); gameMode.build().then(r => { log(r.ok ? 'info' : 'warn', r.ok ? `Arena steht (${r.commands} Befehle)` : 'Arena-Bau nicht möglich: ' + r.reason); broadcastState() }); break
    case 'ARENA_TEST': {
      if (gameMode.mode !== 'ARENA') { log('warn', 'Erst in den Arena-Modus schalten'); break }
      const user = String(m.user || 'TestUser').slice(0, 24)
      if (m.what === 'zombie') arenaGift({ uniqueId: user, nickname: user }, 1, 1)
      else if (m.what === 'wave') { gameMode.arena.requestSpawn(user, { count: 5 }); gameMode.arena.addScore(user, 50); arenaSay({ kind: 'batch', count: 5, names: [user] }) } else if (m.what === 'boss') arenaGift({ uniqueId: user, nickname: user }, 100, 1)
      else if (m.what === 'emeralds') gameMode.arena.emeralds += 25
      else if (m.what === 'unstuck') gameMode.arena.unstuck('Dashboard')
      else if (m.what === 'clear') gameMode.arena.clearMobs()
      broadcastArena()
      break
    }
    case 'LEARN_RESET': learning.reset(); log('info', 'Fehler-Gedächtnis gelöscht'); broadcastState(); break
    case 'WISDOM_TOGGLE': if (wisdom.setEnabled(String(m.id), !!m.enabled)) broadcastState(); break
    case 'WISDOM_REMOVE': if (wisdom.remove(String(m.id))) broadcastState(); break
    case 'WISDOM_RESET': wisdom.reset(); log('info', 'Chat-Tipps gelöscht'); broadcastState(); break
    case 'LLM_RESET': llm.resetStats(); broadcastState(); break
    case 'LLM_TEST':
      if (!llm.ready()) { log('warn', 'Sprachmodell-Test: ' + (!llm.hasKey ? 'kein API-Schlüssel hinterlegt' : !llm.config.enabled ? 'ist ausgeschaltet' : llm.stats.budgetHit ? 'Budget erreicht' : 'gerade beschäftigt')); break }
      llm.ask(llm.chatTask({ name: 'Max', msg: 'Bist du eine KI', state: brain.llmState(bot.status(), brain.stateVars()), viewer: 'Test aus dem Dashboard' })).then(t => {
        log(t ? 'info' : 'warn', t ? `Sprachmodell-Test (${llm.stats.avgMs} ms): ${t}` : 'Sprachmodell-Test fehlgeschlagen: ' + (llm.stats.lastError || 'keine brauchbare Antwort'))
        if (t) brain.sayCustom(t, 'chill')
        broadcastState()
      })
      break
    case 'LIKES_SET': likes.setConfig(m.likes || {}, ACTIONS, MOBS); config.likes = likes.config; saveConfig(); broadcast(likesMsg()); broadcastState(); break
    case 'LIKES_RESET': likes.reset(); broadcast(likesMsg()); broadcastState(); break
    case 'SIM_LIKE': onLike({ viewer: { uniqueId: String(m.user || 'TestUser').slice(0, 24), nickname: String(m.user || 'TestUser').slice(0, 24), avatar: null }, count: Math.max(1, Math.min(500, m.count | 0 || 1)) }); break
    case 'GIFT_RULES_RESET': gifts.resetRules(); gifts.learnLibrary(gifts.libraryList().map(g => ({ name: g.name, coins: g.coins, icon: g.icon })), false); saveConfig(); syncGiftConfig(); syncLibrary(); broadcastState(); break
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
    case 'TUNNEL_START': tunnelStopped = false; tunnel.start(config.remoteKey); break
    case 'TUNNEL_STOP': tunnelStopped = true; clearTimeout(tunnelRetry); tunnel.stop(); break
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
// ---- Arena-Modus: Gifts werden zu Supporter-Zombies, Ansagen werden gebündelt
const arenaBatch = { names: new Map(), count: 0, timer: null }
function arenaSay (e) {
  // Bosse und Wellen sofort; einzelne Zombies sammeln sich 3 Sekunden lang zu einer Ansage
  if (e.kind !== 'spawn') return brain.onArenaSpawn(e)
  arenaBatch.names.set(e.user, true); arenaBatch.count += e.count || 1
  if (arenaBatch.timer) return
  arenaBatch.timer = setTimeout(() => {
    const names = [...arenaBatch.names.keys()]; const count = arenaBatch.count
    arenaBatch.names.clear(); arenaBatch.count = 0; arenaBatch.timer = null
    if (count === 1) brain.onArenaSpawn({ kind: 'spawn', user: names[0] }); else brain.onArenaSpawn({ kind: 'batch', count, names })
  }, 3000)
}
/** Gift im Arena-Modus: klein = 1 Zombie, mittel = 3er-Welle, groß = Boss. */
function arenaGift (viewer, coins, count) {
  const a = gameMode.arena
  const name = viewer.nickname || viewer.uniqueId
  const n = Math.max(1, Math.min(30, count || 1))
  let legend
  if (coins >= 100) { for (let i = 0; i < Math.min(n, 5); i++) a.requestSpawn(name, { boss: true }); a.addScore(name, 150 * n); arenaSay({ kind: 'boss', user: name }); legend = 'Boss-Zombie' } else if (coins >= 10) { a.requestSpawn(name, { count: Math.min(20, 3 * n) }); a.addScore(name, 35 * n); arenaSay({ kind: 'wave', user: name }); legend = '3 Zombies' } else { a.requestSpawn(name, { count: n }); a.addScore(name, 10 * n); arenaSay({ kind: 'spawn', user: name, count: n }); legend = 'Zombie' }
  const st = a.status()
  if (st.queued > 0) arenaSay({ kind: 'queue', queued: st.queued })
  broadcastArena()
  return { legend, kind: 'mob', tier: coins >= 100 ? 5 : coins >= 10 ? 3 : 1 }
}
const ARENA_LEGEND = [
  { id: 'arena1', name: 'Rose & Co.', coins: '1–9', emoji: '🌹', legend: 'Zombie mit deinem Namen', kind: 'mob', tier: 1, icon: null },
  { id: 'arena2', name: 'Mittleres Gift', coins: '10–99', emoji: '🍩', legend: '3 Zombies', kind: 'mob', tier: 3, icon: null },
  { id: 'arena3', name: 'Großes Gift', coins: '100+', emoji: '👑', legend: 'Boss-Zombie', kind: 'mob', tier: 5, icon: null },
  { id: 'arena4', name: 'Likes', coins: '❤', emoji: '❤️', legend: 'Zombie für den Letzten', kind: 'mob', tier: 1, icon: null }
]
let arenaT = null
function broadcastArena () { if (!arenaT) arenaT = setTimeout(() => { arenaT = null; broadcast({ type: 'ARENA', arena: gameMode.status() }, isControl) }, 150) }
setInterval(() => { if (gameMode.mode === 'ARENA') broadcast({ type: 'ARENA', arena: gameMode.status() }, isControl) }, 500).unref()

// ---- Combo-Ansagen: die Mobs kommen sofort, vorgelesen wird erst, wenn die Combo fertig ist
const combos = new Map() // Zuschauer|Gift -> { viewer, gift, effect, count, timer }
const COMBO_WAIT_MS = 3500 // so lange ohne neues Gift, dann gilt eine offene Combo als beendet
const COMBO_SETTLE_MS = 900 // kurzes Sammelfenster nach dem Ende (schnelle Einzel-Gifts hintereinander)
function speakGift (key) {
  const c = combos.get(key)
  if (!c) return
  clearTimeout(c.timer); combos.delete(key)
  brain.onGift(c.viewer, c.gift, c.effect, c.count)
}

function onGift ({ viewer, gift, count, delta, streakEnd = true }) {
  if (gift.name && (gift.icon || gift.coins) && !gift.ruleId) learnGifts([{ id: gift.id, name: gift.name, coins: gift.coins, icon: gift.icon }])
  if (gameMode.mode === 'ARENA') {
    // Arena: jedes Gift wird nach seinem Coin-Wert zu Zombies – die Survival-Belegung bleibt unberührt
    const rule = gifts.findRule(gift)
    const coins = gift.coins || (rule ? rule.coins : 1)
    const fx = arenaGift(viewer, coins, delta)
    const giftName = rule ? rule.giftName : gift.name
    broadcast({ type: 'GIFT_ALERT', user: viewer.nickname || viewer.uniqueId, uniqueId: viewer.uniqueId, avatar: viewer.avatar || null, gift: { name: giftName, emoji: rule ? rule.emoji : '🎁', icon: gift.icon || (rule && rule.icon) || null, coins }, count, delta, legend: fx.legend, kind: fx.kind, tier: fx.tier })
    pushFeed({ kind: 'gift', user: viewer.nickname || viewer.uniqueId, avatar: viewer.avatar || null, text: `${giftName} x${delta} (${coins} Coins) → Arena: ${fx.legend}`, emoji: rule ? rule.emoji : '🎁' })
    return
  }
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
    delta,
    legend: rule.legend,
    kind: effect.kind,
    tier: effect.tier
  })
  if (res.discovered) brain.onGiftDiscovered(viewer, { name: rule.giftName })
  if (!res.ok && res.reason === 'bot_offline') log('warn', `Gift ${rule.giftName} von ${viewer.uniqueId}: Bot ist nicht in der Welt`)
  if (effect.kind === 'none') { pushFeed({ kind: 'gift', user: viewer.nickname || viewer.uniqueId, avatar: viewer.avatar || null, text: `${rule.giftName} x${count} (${coins} Coins)`, emoji: rule.emoji }); return }
  const key = `${viewer.uniqueId}|${rule.id}`
  let c = combos.get(key)
  if (!c) { c = { viewer, gift: { id: rule.id, name: rule.giftName, coins }, effect, count: 0, timer: null }; combos.set(key, c) }
  c.count += delta
  clearTimeout(c.timer)
  const done = () => {
    pushFeed({ kind: 'gift', user: viewer.nickname || viewer.uniqueId, avatar: viewer.avatar || null, text: `${rule.giftName} x${c.count} (${coins * c.count} Coins) → ${rule.legend}`, emoji: rule.emoji })
    speakGift(key)
  }
  // Bosse sofort ansagen; alles andere erst, wenn die Combo fertig ist
  if (effect.tier >= 5) done(); else c.timer = setTimeout(done, streakEnd ? COMBO_SETTLE_MS : COMBO_WAIT_MS)
  if (combos.size > 200) speakGift(combos.keys().next().value)
}

// ---- Likes: gemeinsamer Balken, wer das Ziel knackt, bekommt die Aktion
function likeLegend (amount = likes.amountFor(likes.level + 1)) {
  const c = likes.config
  if (c.action === 'spawn_mob') return `${amount > 1 ? amount + '× ' : ''}${(MOBS[c.mob] || MOBS.zombie)[1]}`
  const label = { zombie_fast: 'Zombie', skeleton_armored: 'Skelett-Schütze' }[c.action] || ACTIONS[c.action].label.replace(/^\d+x /, '').replace(/ \(.*\)$/, '').replace(/^Boss: /, '')
  return `${amount > 1 ? amount + '× ' : ''}${label}`
}
const likesMsg = () => ({ type: 'LIKES', ...likes.state(), legend: likeLegend(), kind: ACTIONS[likes.config.action].kind })
let likesT = null
function onLike ({ viewer, count }) {
  const hits = likes.add(viewer, count)
  if (!likes.config.enabled) brain.onLike(viewer, count)
  for (const h of hits) {
    const c = likes.config
    if (gameMode.mode === 'ARENA') {
      // Arena: das Like-Ziel schickt einen Zombie mit dem Namen des Gewinners
      gameMode.arena.requestSpawn(h.winner.name, { count: h.amount }); gameMode.arena.addScore(h.winner.name, 10)
      broadcast({ type: 'LIKE_GOAL', user: h.winner.name, avatar: h.winner.avatar, level: h.level, every: c.every, legend: h.amount > 1 ? `${h.amount}× Zombie` : 'Zombie', kind: 'mob', helpers: h.helpers })
      pushFeed({ kind: 'gift', user: h.winner.name, text: `knackt ${c.every} Likes → Arena-Zombie`, emoji: '❤️' })
      brain.onLikeGoal(h.winner, { every: c.every, level: h.level, spawnText: h.amount > 1 ? `${h.amount} Zombies in die Arena` : 'einen Zombie in die Arena', amount: h.amount, nextAmount: h.nextAmount, helpers: h.helpers })
      continue
    }
    const res = gifts.fire({ id: 'likes', giftName: 'Likes', action: c.action, mob: c.mob, amount: h.amount, hpMult: 1, legend: likeLegend(h.amount) }, h.winner)
    const legend = likeLegend(h.amount)
    broadcast({ type: 'LIKE_GOAL', user: h.winner.name, avatar: h.winner.avatar, level: h.level, every: c.every, legend, kind: res.effect.kind, helpers: h.helpers })
    pushFeed({ kind: 'gift', user: h.winner.name, text: `knackt ${c.every} Likes → ${legend}`, emoji: '❤️' })
    brain.onLikeGoal(h.winner, { every: c.every, level: h.level, spawnText: res.effect.spawnText || legend, amount: h.amount, nextAmount: h.nextAmount, helpers: h.helpers })
    if (!res.ok) log('warn', `Like-Ziel von ${h.winner.name}: Bot ist nicht in der Welt`)
  }
  // Balken im Overlay höchstens alle 250 ms aktualisieren (Likes kommen im Dauerfeuer)
  if (hits.length) { clearTimeout(likesT); likesT = null; broadcast(likesMsg()); broadcastState() } else if (!likesT) likesT = setTimeout(() => { likesT = null; broadcast(likesMsg()) }, 250)
}

function onChat ({ viewer, text }) {
  const name = viewer.nickname || viewer.uniqueId
  // Spiel-Tipp aus dem Chat? Ein erkannter Tipp ("Goldrüstung im Nether") geht vor; reine Spielwünsche
  // ("Geh in den Nether", "Bau ein Haus") laufen normal weiter.
  if (matchTip(text) || !brain.parseGoal(String(text).toLowerCase())) {
    const tip = wisdom.consider(name, text)
    if (tip && tip.kind !== 'unknown') {
      brain.onTip(viewer, tip)
      pushFeed({ kind: 'chat', user: name, avatar: viewer.avatar || null, text, goal: tip.kind === 'new' ? 'Tipp gemerkt: ' + tip.rule.label : null })
      if (tip.kind === 'new') log('info', `Chat-Tipp von ${name}: ${tip.rule.label} – ${tip.rule.effect}`)
      return
    }
    // Klingt wie ein Tipp, passt aber auf kein Muster: das Sprachmodell darf ihn einer festen Regel zuordnen
    if (tip && tip.kind === 'unknown' && llm.ready()) {
      llm.classifyTip(text, TIP_RULES.map(r => ({ id: r.id, label: `${r.label} (${r.effect})` }))).then(id => {
        const t = id ? wisdom.learn(id, name, text) : null
        if (t) { brain.onTip(viewer, t); if (t.kind === 'new') log('info', `Chat-Tipp von ${name} (vom Sprachmodell zugeordnet): ${t.rule.label}`) }
      })
    }
  }
  const r = brain.onChat(viewer, text)
  pushFeed({ kind: 'chat', user: name, avatar: viewer.avatar || null, text, goal: r.goal || null })
}

// Spielmomente, in denen ein gemerkter Tipp zum Einsatz kommt
const TIP_CONTEXT = { nether_enter: 'nether', night: 'night', night_shelter: 'night', kite: 'swarm', pillar_escape: 'swarm', low_hp: 'low_hp', critical_hp: 'low_hp', mine_start: 'deep', cave_start: 'cave', avoid: 'warden', wall_off: 'creeper', ate: 'hungry' }
function recallTips (type, data) {
  let ctxName = TIP_CONTEXT[type]
  if (type === 'combat_start' && data && Array.isArray(data.mobs)) ctxName = data.mobs.includes('creeper') ? 'creeper' : data.mobs.includes('warden') ? 'warden' : data.mobs.some(m => ['skeleton', 'stray', 'pillager', 'blaze'].includes(m)) ? 'ranged' : null
  if (type === 'avoid' && data && data.mob !== 'warden') ctxName = null
  if (!ctxName) return
  for (const t of wisdom.recall(ctxName)) brain.onTipRecall(t.by, t.rule)
}

tiktok.on('gift', onGift)
tiktok.on('chat', onChat)
tiktok.on('follow', e => brain.onFollow(e.viewer))
tiktok.on('share', e => brain.onShare(e.viewer))
tiktok.on('like', onLike)
let lastDiag = null
tiktok.on('state', s => { if (s.diagnostic && s.diagnostic !== lastDiag) log('warn', 'TikTok: ' + s.diagnostic); lastDiag = s.diagnostic; broadcastState() })
tiktok.on('gift_icons', icons => { if (gifts.learnIcons(icons)) { saveConfig(); syncGiftConfig(); broadcastState() } })
function learnGifts (list) {
  if (!gifts.learnLibrary(list)) return
  writeLater(LIBRARY_FILE, () => gifts.librarySnapshot(), 1500)
  saveConfig(); syncGiftConfig(); syncLibrary(); broadcastState()
}
tiktok.on('gift_list', list => { learnGifts(list); log('info', `TikTok-Gifts geladen: ${list.length} echte Gifts mit Bild und Coin-Preis`) })
tiktok.on('live', e => {
  likes.reset(); broadcast(likesMsg())
  llm.resetStats() // Budget gilt pro Stream
  log('info', `TikTok LIVE verbunden: @${e.username} (Engine ${e.engine})`)
  broadcast({ type: 'CHIME', kind: 'live' })
  brain.onLiveConnected()
})
tiktok.on('follow', e => pushFeed({ kind: 'follow', user: e.viewer.nickname, text: 'folgt jetzt', emoji: '➕' }))

const OVERLAY_EVENTS = new Set(['liquid_escape', 'liquid_rescue', 'camera', 'corpse_run_start', 'corpse_run_done', 'swing', 'hurt', 'shield', 'death', 'combat_start', 'combat_end', 'kill', 'low_hp', 'critical_hp', 'lava', 'enchanted', 'respawn', 'ate', 'build_done', 'portal_lit'])
bot.on('event', e => {
  brain.onBotEvent(e.type, e.data)
  recallTips(e.type, e.data)
  if (e.type === 'bot_spawned') gameMode.onBotBack(); else if (e.type === 'bot_disconnected' || e.type === 'bot_stopped') gameMode.onBotGone()
  if (OVERLAY_EVENTS.has(e.type)) broadcast({ type: 'BOT_EVENT', event: e.type, data: e.data })
  else if (e.type !== 'hotbar') broadcast({ type: 'BOT_EVENT', event: e.type, data: e.data }, isControl)
  if (e.type === 'log') log('info', e.data.message)
  else if (e.type === 'warn' || e.type === 'bot_error' || e.type === 'bot_kicked') log('warn', e.data.message || e.data.reason || e.type)
  else if (['bot_spawned', 'bot_disconnected', 'plan', 'death', 'goal_pushed', 'goal_done', 'goal_failed', 'action_cooldown', 'build_done', 'enchanted', 'portal_lit', 'mode', 'cave_done', 'cave_aborted', 'liquid_rescue', 'lesson', 'death_analysis', 'rethink', 'tool_worn', 'lag_pause', 'lag_resume', 'bunker', 'avoid', 'night_shelter', 'arena_build', 'arena_built', 'arena_enter', 'arena_exit', 'arena_upgrade', 'arena_death', 'arena_stuck'].includes(e.type)) {
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
  console.log(`  Studio-Overlay:  http://localhost:${PORT}/studio-overlay.html   (OBS-Browserquelle: 1080x1920 hochkant für TikTok)`)
  console.log('  Handy:           QR-Code im Dashboard scannen (gleiches WLAN) oder Tunnel für unterwegs starten')
  console.log('')
  refreshLan()
  if (config.remote.autoTunnel) tunnel.start(config.remoteKey)
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
