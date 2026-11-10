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
const { TikTokBridge } = require('./modules/tiktok-bridge')
const { GiftEngine, ACTIONS, DEFAULT_RULES } = require('./modules/gift-engine')
const { Tunnel } = require('./modules/tunnel')

const ROOT = __dirname
const PORT = Number(process.env.PORT || 3000)
const LOCAL_CFG = path.join(ROOT, 'config.local.json')

// ------------------------------------------------------------------ Konfiguration
function loadConfig () {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
  let local = {}
  try { local = JSON.parse(fs.readFileSync(LOCAL_CFG, 'utf8')) } catch (_) {}
  const cfg = { ...base, ...local, minecraft: { ...base.minecraft, ...(local.minecraft || {}) } }
  if (!cfg.remoteKey) cfg.remoteKey = crypto.randomBytes(9).toString('base64url')
  if (!Array.isArray(cfg.giftRules) || !cfg.giftRules.length) cfg.giftRules = DEFAULT_RULES
  return cfg
}
const config = loadConfig()
let saveTimer = null
function saveConfig () {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const out = { minecraft: config.minecraft, tiktokUsername: config.tiktokUsername, voice: config.voice, remoteKey: config.remoteKey, giftRules: gifts.rules, autoStartBot: config.autoStartBot }
    fs.writeFile(LOCAL_CFG, JSON.stringify(out, null, 2), () => {})
  }, 300)
}

// ------------------------------------------------------------------ Module
const bot = new MinecraftAIBot(config.minecraft)
const tts = new TTSEngine({ voice: config.voice })
const tiktok = new TikTokBridge()
const gifts = new GiftEngine({
  runCommands: cmds => bot.runCommands(cmds),
  spawnPoint: () => bot.spawnPoint(),
  botPos: () => { const s = bot.status(); return s.connected ? s.pos : null }
}, config.giftRules)
const tunnel = new Tunnel(PORT, () => broadcastState())
const logs = []

const brain = new StreamerBrain({
  getStatus: () => bot.status(),
  pushGoal: (id, by) => bot.pushGoal(id, by),
  onAddress: () => bot.expressiveLook(),
  speak: async (line) => {
    const r = await tts.synthesize(line.text, line.emotion)
    broadcast({ type: 'TTS', id: line.id, text: line.text, emotion: line.emotion, kind: line.kind, words: r.words, durationMs: r.durationMs, mime: r.mime, audio: r.audio ? r.audio.toString('base64') : null })
    if (r.error) log('warn', 'TTS: ' + r.error)
    return r.durationMs
  }
})

// ------------------------------------------------------------------ HTTP + WebSocket
const app = express()
app.disable('x-powered-by')
app.use('/vendor', express.static(path.join(ROOT, 'node_modules', 'skinview3d', 'bundles'), { maxAge: '1d' }))
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }))
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
    config: { minecraft: config.minecraft, tiktokUsername: config.tiktokUsername || '', voice: tts.voice, voices: MALE_VOICES },
    rules: gifts.rules,
    actions: Object.entries(ACTIONS).map(([id, a]) => ({ id, label: a.label, kind: a.kind })),
    goals: Object.entries(VIEWER_GOALS).map(([id, g]) => ({ id, label: g.label })),
    tts: { backend: tts.backend, error: tts.lastError },
    viewers: brain.memorySnapshot(),
    logs: logs.slice(-40)
  }
}
function broadcastState () { broadcast(fullState(), isControl) }
function syncGiftConfig () { broadcast({ type: 'GIFT_CONFIG_SYNC', gifts: gifts.publicConfig() }) }

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x')
  const local = isLocal(req)
  const keyOk = url.searchParams.get('k') === config.remoteKey
  ws.role = url.searchParams.get('role') === 'overlay' ? 'overlay' : (url.searchParams.get('role') || 'dashboard')
  // Steuerung von außerhalb (Tunnel) nur mit Schlüssel; das Overlay empfängt nur
  ws.canControl = ws.role !== 'overlay' && (local || keyOk)
  if (!local && !keyOk) { send(ws, { type: 'DENIED', reason: 'Schlüssel fehlt oder ist falsch' }); ws.close(); return }
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
  ws.on('error', () => clients.delete(ws))
  send(ws, { type: 'GIFT_CONFIG_SYNC', gifts: gifts.publicConfig() })
  if (ws.role === 'overlay') send(ws, { type: 'STATUS', status: bot.status() })
  else send(ws, fullState())
  ws.on('message', raw => {
    let m
    try { m = JSON.parse(raw.toString()) } catch (_) { return }
    if (!m || typeof m.type !== 'string' || !ws.canControl) return
    try { handle(m) } catch (e) { log('error', `Befehl ${m.type}: ${e.message}`) }
  })
})

// ------------------------------------------------------------------ Befehle (Dashboard / Handy)
function handle (m) {
  switch (m.type) {
    case 'TIKTOK_CONNECT':
      config.tiktokUsername = String(m.username || '').trim().replace(/^@/, '').slice(0, 40)
      saveConfig()
      tiktok.connect(config.tiktokUsername)
      break
    case 'TIKTOK_DISCONNECT': tiktok.disconnect(); break
    case 'GIFT_RULES_SET':
      gifts.setRules(m.rules)
      saveConfig()
      syncGiftConfig() // Overlay-Legende aktualisiert sich in derselben Millisekunde
      broadcastState()
      break
    case 'GIFT_RULES_RESET': gifts.setRules(DEFAULT_RULES); saveConfig(); syncGiftConfig(); broadcastState(); break
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
      saveConfig()
      broadcastState()
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
        case 'goal': { const r = bot.pushGoal(String(m.goal || ''), 'Regie'); log('info', `Ziel ${m.goal}: ${JSON.stringify(r)}`); break }
        case 'clear_goals': bot.clearGoals(); break
        case 'chat': bot.say(m.text); break
      }
      setTimeout(broadcastState, 150)
      break
  }
}

// ------------------------------------------------------------------ Verdrahtung
function onGift ({ viewer, gift, count, delta }) {
  const res = gifts.trigger(gift, viewer, delta)
  const rule = res.rule
  const effect = res.effect || { kind: 'none', tier: 0, spawnText: '', label: '' }
  broadcast({
    type: 'GIFT_ALERT',
    user: viewer.nickname || viewer.uniqueId,
    uniqueId: viewer.uniqueId,
    avatar: viewer.avatar || null,
    gift: { name: rule ? rule.giftName : gift.name, emoji: rule ? rule.emoji : '🎁', icon: gift.icon || (rule && gifts.iconFor(rule)) || null, coins: gift.coins },
    count,
    legend: rule ? rule.legend : '',
    kind: effect.kind,
    tier: effect.tier
  })
  if (rule) brain.onGift(viewer, { id: rule.id, name: rule.giftName, coins: gift.coins || rule.coins }, effect, delta)
  if (!res.ok && res.reason === 'bot_offline') log('warn', `Gift ${gift.name} von ${viewer.uniqueId}: Bot ist nicht in der Welt`)
  else log('info', `🎁 ${viewer.uniqueId}: ${gift.name} x${count} -> ${effect.label || 'keine Regel'}`)
}

function onChat ({ viewer, text }) {
  const r = brain.onChat(viewer, text)
  broadcast({ type: 'CHAT', user: viewer.nickname || viewer.uniqueId, text, intent: r.intent, goal: r.goal || null }, isControl)
}

tiktok.on('gift', onGift)
tiktok.on('chat', onChat)
tiktok.on('follow', e => brain.onFollow(e.viewer))
tiktok.on('share', e => brain.onShare(e.viewer))
tiktok.on('like', e => brain.onLike(e.viewer, e.count))
tiktok.on('state', s => { if (s.error) log('warn', 'TikTok: ' + s.error); broadcastState() })
tiktok.on('gift_icons', icons => { gifts.icons = icons; syncGiftConfig() })

const OVERLAY_EVENTS = new Set(['swing', 'hurt', 'shield', 'death', 'combat_start', 'combat_end', 'kill', 'low_hp', 'critical_hp', 'lava', 'enchanted', 'respawn', 'ate', 'build_done', 'portal_lit'])
bot.on('event', e => {
  brain.onBotEvent(e.type, e.data)
  if (OVERLAY_EVENTS.has(e.type)) broadcast({ type: 'BOT_EVENT', event: e.type, data: e.data })
  else if (e.type !== 'hotbar') broadcast({ type: 'BOT_EVENT', event: e.type, data: e.data }, isControl)
  if (e.type === 'log') log('info', e.data.message)
  else if (e.type === 'warn' || e.type === 'bot_error' || e.type === 'bot_kicked') log('warn', e.data.message || e.data.reason || e.type)
  else if (['bot_spawned', 'bot_disconnected', 'plan', 'death', 'goal_pushed', 'goal_done', 'goal_failed', 'action_cooldown', 'build_done', 'enchanted', 'portal_lit'].includes(e.type)) {
    log('info', `${e.type} ${JSON.stringify(e.data).slice(0, 200)}`)
    broadcastState()
  }
})
bot.on('status', status => broadcast({ type: 'STATUS', status }))

server.listen(PORT, () => {
  console.log('')
  console.log('  Minecraft-KI-Streamer läuft')
  console.log(`  Dashboard:       http://localhost:${PORT}/`)
  console.log(`  Studio-Overlay:  http://localhost:${PORT}/studio-overlay.html   (OBS-Browserquelle, 1920x1080)`)
  console.log(`  Handy:           Tunnel im Dashboard starten und QR-Code scannen`)
  console.log('')
  if (config.autoStartBot) bot.start()
  if (process.env.OPEN_BROWSER === '1') {
    const cmd = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    require('child_process').exec(`${cmd} http://localhost:${PORT}/`)
  }
})

function shutdown () {
  try { bot.stop() } catch (_) {}
  try { tunnel.stop() } catch (_) {}
  try { gifts.dispose() } catch (_) {}
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('unhandledRejection', e => log('error', 'Unbehandelt: ' + ((e && e.message) || e)))
