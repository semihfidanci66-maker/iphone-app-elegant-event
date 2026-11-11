'use strict'
// Offline-Logiktests (ohne Minecraft-Server): node test/unit.js
const assert = require('assert')
const { Planner } = require('../modules/bot/planner')
const { StreamerBrain } = require('../modules/ai-streamer-brain')
const { GiftEngine, ACTIONS } = require('../modules/gift-engine')
const { buildDefaultRules, CATALOG_SIZE } = require('../modules/gifts-catalog')
const { sanitizeUsername, classify, TikTokBridge } = require('../modules/tiktok-bridge')
const DEFAULT_RULES = buildDefaultRules()
const { TTSEngine } = require('../modules/tts-engine')
const { cooldownFor } = require('../modules/bot/combat')
let n = 0
const t = (name, fn) => { fn(); n++; console.log('PASS ', name) }

// ---------- GOAP ----------
const fakeCtx = () => ({ actions: {}, emit () {}, memory: {}, mcData: {}, bot: {}, caveAllowed: () => false })
const P = () => { const p = new Planner(fakeCtx()); return p }
const none = () => Object.fromEntries(['bed', 'wood', 'woodPick', 'woodKit', 'cobble', 'stoneKit', 'rawFood', 'food', 'rawIron', 'ironIngots', 'ironKit', 'waterBucket', 'buildMats', 'base', 'diamonds', 'diamondPick', 'lapis', 'obsidian4', 'enchantTable', 'enchanted', 'gold', 'flintSteel', 'obsidian10', 'portal', 'blazeRods'].map(k => [k, false]))
t('GOAP: frischer Spawn -> Holz hacken zuerst', () => {
  const plan = P().planFor(['woodKit'], none())
  assert.deepStrictEqual(plan.steps.map(s => s.name), ['GatherWood', 'CraftWoodTools'])
})
t('GOAP: Nether-Kette ist vollständig und geordnet', () => {
  const names = P().planFor(['blazeRods'], none()).steps.map(s => s.name)
  const idx = x => names.indexOf(x)
  for (const a of ['GatherWood', 'CraftWoodTools', 'MineStone', 'CraftStoneKit', 'MineIron', 'SmeltIron', 'CraftIronKit', 'MineDiamonds', 'CraftDiamondKit', 'FillBucket', 'MineObsidian10', 'GetFlintSteel', 'BuildPortal', 'GetGold', 'Hunt', 'CookFood', 'NetherExpedition']) assert(idx(a) >= 0, 'fehlt: ' + a)
  assert(idx('CraftIronKit') < idx('MineDiamonds') && idx('CraftDiamondKit') < idx('MineObsidian10') && idx('BuildPortal') < idx('NetherExpedition'))
  assert.strictEqual(names[names.length - 1], 'NetherExpedition')
  assert.strictEqual(new Set(names).size, names.length, 'keine doppelten Schritte')
})
t('GOAP: erfüllte Fakten werden übersprungen', () => {
  const f = none(); Object.assign(f, { wood: true, woodPick: true, woodKit: true, cobble: true, stoneKit: true, rawIron: true, ironIngots: true, ironKit: true })
  assert.deepStrictEqual(P().planFor(['diamondPick'], f).steps.map(s => s.name), ['MineDiamonds', 'CraftDiamondKit'])
})
t('GOAP: Zuschauerziel schlägt Progression', () => {
  const p = P(); p.facts = () => none()
  p.pushGoal({ id: 'house', label: 'Haus bauen', facts: ['base'], by: 'Lukas' })
  const step = p.next()
  assert.strictEqual(step.goal.id, 'house'); assert.strictEqual(step.action.name, 'GatherWood')
  assert.strictEqual(step.plan[step.plan.length - 1], 'Haus bauen')
})
t('GOAP: zweimal gescheitert -> Cooldown, nächstes Ziel rückt vor', () => {
  const p = P(); const f = none(); Object.assign(f, { wood: true, woodPick: true, woodKit: true, cobble: true, stoneKit: true }); p.facts = () => f
  const s1 = p.next(); assert.strictEqual(s1.action.name, 'Hunt')
  p.report(s1.action, s1.goal, false); p.report(s1.action, s1.goal, false)
  assert.strictEqual(p.next().action.name, 'GetBed')
})

t('Höhle: Oberflächen-Modus sperrt Untertage-Aktionen, erlaubt genau einen Automatik-Trip', () => {
  const p = P(); const f = none(); Object.assign(f, { wood: true, woodPick: true, woodKit: true, cobble: true, stoneKit: true, bed: true }); p.facts = () => f
  // ohne gebratenes Essen: kein Höhlen-Trip -> Jagd zuerst
  assert.strictEqual(p.next().action.name, 'Hunt')
  f.rawFood = true; f.food = true
  const s1 = p.next(); assert.strictEqual(s1.action.name, 'MineIron'); assert.strictEqual(s1.autoCaveTrip, true)
  p.ctx.memory.autoCaveTripUsed = true
  const s2 = p.next(); assert.strictEqual(s2.action.name, 'GatherBuildMaterials')
  // Zuschauerziel, das unter Tage führt, wird abgelehnt
  const failed = []; p.ctx.emit = (t, d) => { if (t === 'goal_failed') failed.push(d.reason) }
  p.pushGoal({ id: 'diamonds', label: 'Diamanten', facts: ['diamondPick'], by: 'Ben' }); p.next()
  assert.deepStrictEqual(failed, ['cave_locked'])
  // mit Freigabe (Höhlen-Button) geht es wieder
  p.ctx.caveAllowed = () => true
  assert.strictEqual(p.next().action.name, 'MineIron')
})

// ---------- PvP-Rhythmus ----------
t('PvP: Cooldowns 625 ms Schwert / 1000 ms Axt', () => {
  assert.strictEqual(cooldownFor({ name: 'diamond_sword' }), 625); assert.strictEqual(cooldownFor({ name: 'diamond_axe' }), 1000); assert.strictEqual(cooldownFor({ name: 'stone_axe' }), 1250)
})

// ---------- Gift-Engine ----------
const mkGifts = () => { const sent = []; const g = new GiftEngine({ runCommands: c => { sent.push(...c); return true }, spawnPoint: () => ({ x: 10.5, y: 64, z: -3.5 }), botPos: () => ({ x: 8, y: 64, z: -3 }) }); return { g, sent } }
t('Gifts: Katalog mit 45+ echten TikTok-Gifts, alle mit Aktion', () => {
  assert(CATALOG_SIZE >= 45, 'nur ' + CATALOG_SIZE)
  const { g } = mkGifts()
  assert.strictEqual(g.rules.length, CATALOG_SIZE)
  for (const r of g.rules) assert(ACTIONS[r.action] && r.action !== 'none' && r.coins >= 1, r.id)
  for (const [n, c] of [['Rose', 1], ['Donut', 30], ['Galaxie', 1000], ['Money Gun', 500], ['TikTok Universe', 44999], ['Löwe', 29999]]) assert.strictEqual(g.findRule({ name: n }).coins, c, n)
  assert.strictEqual(g.publicConfig().length, 7)
})
t('Gifts: alle Befehle < 256 Zeichen, native Entities, Helm + Namensschild', () => {
  const { g } = mkGifts()
  for (const r of g.rules) {
    const { cmds } = g.build(r, 'Lukas_der_Allergrößte_99!!', 8, { x: 10.5, y: 64, z: -3.5 }, { x: 8, y: 64, z: -3 })
    assert(cmds.length > 0, r.id)
    for (const c of cmds) { assert(c.length < 256, `${r.id}: ${c.length} Zeichen`); assert(!/armor_stand|setblock/.test(c), 'kein Platzhalter') }
  }
  const z = g.build(g.findRule({ name: 'Rose' }), 'Lukas', 1, { x: 1, y: 64, z: 1 }).cmds.join('\n')
  assert(/summon zombie/.test(z) && /NoAI:0b/.test(z) && /armor\.head with iron_helmet/.test(z))
  assert(z.includes(`CustomName:'{"text":"⚡ @Lukas","color":"red","bold":true}',CustomNameVisible:1b`))
  assert(/bossbar add/.test(g.build(g.findRule({ name: 'Galaxie' }), 'Mia', 1, { x: 1, y: 64, z: 1 }).cmds.join('\n')))
})
t('Gifts: Custom Gift Builder (Menge + HP-Multiplikator) und Englisch-Alias', () => {
  const { g } = mkGifts()
  const r = g.upsertRule({ giftName: 'Mein Drache', coins: 250, emoji: '🐉', action: 'spawn_mob', mob: 'blaze', amount: 4, hpMult: 3, legend: 'Lohen-Schwarm', inLegend: true })
  assert(r.custom && r.id === 'custom_mein_drache')
  const cmds = g.build(r, 'Tom', 1, { x: 1, y: 64, z: 1 }).cmds
  assert.strictEqual(cmds.filter(c => /^summon blaze/.test(c)).length, 4)
  assert(cmds.some(c => /max_health base set 60/.test(c)))
  assert(g.publicConfig().some(x => x.name === 'Mein Drache'))
  assert.strictEqual(g.findRule({ name: 'Doughnut' }).id, 'donut')
  assert(g.removeRule(r.id) && !g.findRule({ name: 'Mein Drache' }))
})
t('Gifts: Live-Auto-Discovery nimmt unbekannte Gifts in den Katalog auf', () => {
  const { g, sent } = mkGifts()
  const res = g.trigger({ id: '9999', name: 'Space Dog', coins: 450, icon: 'https://example.com/dog.png' }, { uniqueId: 'kai' }, 1)
  assert(res.ok && res.discovered && res.rule.discovered && res.rule.icon)
  assert.strictEqual(res.rule.action, 'hit_squad_vindicator'); assert(sent.length > 0)
  assert.strictEqual(g.trigger({ id: '9999', name: 'Space Dog', coins: 450 }, { uniqueId: 'kai' }, 1).discovered, false)
  assert.strictEqual(g.supportGift(['heal']).coins, 1)
})

// ---------- TikTok-Connector ----------
t('TikTok: Eingabe-Sanitizer (@, Leerzeichen, URLs)', () => {
  for (const x of ['@MyUsername', ' MyUsername ', 'https://www.tiktok.com/@MyUsername/live', 'tiktok.com/@MyUsername?lang=de', '@@My Username', 'https://vm.tiktok.com/@MyUsername/']) assert.strictEqual(sanitizeUsername(x), 'MyUsername', x)
  assert.strictEqual(sanitizeUsername('semih.fid_66'), 'semih.fid_66'); assert.strictEqual(sanitizeUsername('   '), '')
})
t('TikTok: Fehlerdiagnose (offline / Signatur / Benutzer)', () => {
  class UserOfflineError extends Error {}
  class SignatureRateLimitError extends Error {}
  assert.strictEqual(classify(new UserOfflineError('x')).kind, 'offline')
  assert.strictEqual(classify(new Error("The requested user isn't online :(")).kind, 'offline')
  assert.strictEqual(classify(new SignatureRateLimitError('too many')).kind, 'sign')
  assert.strictEqual(classify(new Error('Request failed with status 403')).kind, 'sign')
  assert.strictEqual(classify(new Error('user_not_found')).kind, 'user')
})
t('TikTok: Watchdog bricht bei Offline-Stream nicht ab (8 s) und reconnectet nach Abbruch (2 s)', () => {
  const b = new TikTokBridge(); const states = []
  b.on('state', s => states.push(s.phase + '|' + s.badge))
  b.wanted = true; b.state.username = 'MyUsername'
  b._retry(8000, 'waiting', 'Stream ist noch nicht live')
  assert.strictEqual(states.pop(), 'waiting|🟡 Warte automatisch auf deinen Live-Start (@MyUsername)...'); assert(b.timer)
  let live = 0; b.on('live', () => live++)
  b._onLive('A'); b._viewers(42)
  assert.strictEqual(b.state.badge, '🟢 LIVE VERBUNDEN! (@MyUsername | Zuschauer: 42)'); assert.strictEqual(live, 1)
  b.conn = { removeAllListeners () {}, disconnect () {} }
  b._dropped('Verbindung getrennt', 2000, 'reconnecting')
  assert.strictEqual(b.state.phase, 'reconnecting'); assert(b.state.nextRetryAt - Date.now() <= 2000)
  b.stop(); assert.strictEqual(b.state.phase, 'idle'); assert.strictEqual(b.timer, null)
})
t('TikTok: Streak-Combos werden inkrementell gemeldet', () => {
  const b = new TikTokBridge(); const got = []
  b.on('gift', g => got.push([g.count, g.delta, g.streakEnd, g.gift.coins, g.gift.name]))
  const ev = (n, end) => b._onGift({ uniqueId: 'lukas', nickname: 'Lukas', profilePictureUrl: 'https://x/a.jpg', giftId: 5655, giftName: 'Rose', diamondCount: 1, giftType: 1, repeatCount: n, repeatEnd: end, giftPictureUrl: 'https://x/rose.png' })
  ev(1, false); ev(3, false); ev(3, false); ev(5, true)
  assert.deepStrictEqual(got, [[1, 1, false, 1, 'Rose'], [3, 2, false, 1, 'Rose'], [5, 2, true, 1, 'Rose']])
  assert.strictEqual(b.giftIcons.rose, 'https://x/rose.png')
})

// ---------- Streamer-Hirn ----------
const mkBrain = (status) => {
  const said = []; const goals = []
  const b = new StreamerBrain({ getStatus: () => status, pushGoal: (id, by) => { goals.push([id, by]); return { ok: true, label: id } }, speak: async l => { said.push(l); return 10 } })
  clearInterval(b.timer)
  return { b, said, goals, q: () => b.queue.map(i => i.text) }
}
const calm = { connected: true, activity: 'mine', pos: { x: 10, y: -54, z: 3 }, health: 20, food: 20, threats: 0, fighting: false, inv: { pickTier: 3 }, shield: true }
t('Persona: Zuschauergedächtnis – 1. Rose vs. 5. Rose', () => {
  const { b, q } = mkBrain({ ...calm, activity: 'build' })
  const eff = { kind: 'mob', tier: 1, spawnText: 'einen Zombie', mob: 'zombie' }
  b.onGift({ uniqueId: 'lukas' }, { id: 'rose', name: 'Rose', coins: 1 }, eff, 1)
  assert(/Lukas/.test(q()[0]) && !/Nummer|schon wieder/.test(q()[0]), q()[0])
  b.cooldowns.clear(); b.queue = []
  for (let i = 0; i < 3; i++) { b.onGift({ uniqueId: 'lukas' }, { id: 'rose', name: 'Rose', coins: 1 }, eff, 1); b.cooldowns.clear() }
  b.queue = []
  b.onGift({ uniqueId: 'lukas' }, { id: 'rose', name: 'Rose', coins: 1 }, eff, 1)
  assert.strictEqual(b.viewerMemoryMap.get('lukas').gifts.rose, 5)
  assert(/Lukas/.test(q()[0]) && /(fünfte|Nummer 5|5)/.test(q()[0]), q()[0])
})
t('Persona: "Was machst du gerade?" beim Minen nennt die echte Ebene', () => {
  const { b, q } = mkBrain(calm)
  const r = b.onChat({ uniqueId: 'user1', nickname: 'Mia' }, 'Was machst du gerade?')
  assert.strictEqual(r.intent, 'what_doing'); assert(/Mia/.test(q()[0]) && /Minus 54/.test(q()[0]), q()[0])
})
t('Persona: "Wie geht\'s?" im Kampf -> Panik mit Mob-Anzahl', () => {
  const { b, q } = mkBrain({ ...calm, activity: 'combat', fighting: true, threats: 4, health: 9 })
  b.onChat({ uniqueId: 'u2', nickname: 'Tom' }, "wie geht's?")
  assert(/4/.test(q()[0]) && /Tom/.test(q()[0]), q()[0]); assert.strictEqual(b.queue[0].emotion, 'panic')
})
t('Persona: Chat-Wünsche werden zu Zielen', () => {
  const cases = { 'Geh mal Holz holen': 'wood', 'Bau ein Haus': 'house', 'Mach dir ein Eisenschwert': 'iron_sword', 'Geh in den Nether': 'nether', 'Iss mal was': 'eat', 'such mal diamanten': 'diamonds', 'geh mal in die mine': 'mine', 'geh schlafen': 'sleep' }
  for (const [text, goal] of Object.entries(cases)) {
    const { b, goals, q } = mkBrain(calm)
    const r = b.onChat({ uniqueId: 'v', nickname: 'Ben' }, text)
    assert.strictEqual(r.goal, goal, text); assert.deepStrictEqual(goals[0], [goal, 'Ben']); assert(/Ben/.test(q()[0]), q()[0])
  }
})
t('Persona: 25-s-Cooldown – "wenig Leben" nur einmal pro Kampf', () => {
  const { b, q } = mkBrain({ ...calm, fighting: true, health: 8 })
  b.onBotEvent('low_hp', { hp: 4 }); b.onBotEvent('low_hp', { hp: 3 }); b.onBotEvent('critical_hp', { hp: 2 })
  assert.strictEqual(q().length, 1)
})
t('Persona: Idle-Monolog erst nach 12 s Ruhe, nie im Kampf', () => {
  const { b, q } = mkBrain(calm)
  b.lastExternal = Date.now() - 5000; b._maybeMonologue(Date.now()); assert.strictEqual(q().length, 0)
  b.lastExternal = Date.now() - 13000; b.lastSpoke = Date.now() - 10000; b._maybeMonologue(Date.now()); assert.strictEqual(q().length, 1)
  const f = mkBrain({ ...calm, fighting: true }); f.b.lastExternal = 0; f.b._maybeMonologue(Date.now()); assert.strictEqual(f.q().length, 0)
})
t('Persona: viewerMemoryMap ist ein LRU-Cache mit 200 Einträgen', () => {
  const { b } = mkBrain(calm)
  for (let i = 0; i < 260; i++) b.viewer({ uniqueId: 'user' + i })
  b.viewer({ uniqueId: 'user70' }) // wieder aktiv -> bleibt
  for (let i = 260; i < 300; i++) b.viewer({ uniqueId: 'user' + i })
  assert.strictEqual(b.viewerMemoryMap.size, 200); assert(b.viewerMemoryMap.has('user70')); assert(!b.viewerMemoryMap.has('user99'))
})
t('Persona: taktischer Hilferuf nennt das echte Gift aus der Live-Konfiguration', () => {
  const st = { ...calm, activity: 'combat', fighting: true, threats: 4, threatNames: ['zombie'], health: 14, inv: { swordTier: 1, rawIronTotal: 0, food: 2 } }
  const said = []
  const b = new StreamerBrain({ getStatus: () => st, pushGoal: () => ({}), speak: async () => 10, getSupportGift: kinds => kinds.includes('drop_weapon') ? { name: 'Stern', coins: 99, gear: 'eine starke Waffe' } : null })
  b.tacticalCallout(); said.push(...b.queue.map(i => i.text))
  assert(/Zombies/.test(said[0]) && /Holzschwert/.test(said[0]) && /2 Eisen/.test(said[0]) && /Stern/.test(said[0]), said[0])
  b.tacticalCallout(); assert.strictEqual(b.queue.length, 1, 'Cooldown')
})
t('Persona: neue Chat-Befehle (Loot holen, schlafen, Diamanten farmen)', () => {
  for (const [text, goal] of Object.entries({ 'Hol deinen Loot': 'corpse', 'Geh schlafen': 'sleep', 'Geh Diamanten farmen': 'diamonds', 'hol deine sachen zurück': 'corpse' })) {
    const { b, goals } = mkBrain(calm); b.onChat({ uniqueId: 'v', nickname: 'Ben' }, text); assert.strictEqual(goals[0] && goals[0][0], goal, text)
  }
})
t('Persona: Höhlen-Abbruch, Rettung und gesperrte Höhle werden angesagt', () => {
  const { b, q } = mkBrain(calm)
  b.onBotEvent('cave_aborted', {}); assert.strictEqual(q()[0], 'Alles klar, Höhle abgebrochen! Wir sind wieder oben an der frischen Luft, Chat!')
  b.queue = []; b.onBotEvent('liquid_escape', { lava: true }); assert.strictEqual(b.queue[0].emotion, 'panic')
  const m = mkBrain(calm); m.b.deps.pushGoal = () => ({ ok: false, reason: 'cave_locked', label: 'Minen gehen' })
  m.b.onChat({ uniqueId: 'v', nickname: 'Ben' }, 'geh mal in die mine'); assert(/Ben/.test(m.q()[0]) && /(Regie|gesperrt)/.test(m.q()[0]), m.q()[0])
})
t('Persona: Namen werden aussprechbar', () => {
  const { b } = mkBrain(calm)
  assert.strictEqual(b.speakable('xX_Lukas_99'), 'Lukas'); assert.strictEqual(b.speakable('@mia.gaming'), 'Mia gaming')
})

// ---------- Stimme ----------
t('Stimme: nur männliche Neural-Stimmen, nie ein Browser-Fallback', () => {
  const e = new TTSEngine({ voice: 'de-DE-KatjaNeural' }); assert.strictEqual(e.voice, 'de-DE-ConradNeural')
  assert.strictEqual(e.setVoice('de-DE-KillianNeural'), 'de-DE-KillianNeural'); assert.strictEqual(e.setVoice('en-US-JennyNeural'), 'de-DE-ConradNeural')
  const fs = require('fs'); const path = require('path')
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(f => f.isDirectory() ? walk(path.join(d, f.name)) : [path.join(d, f.name)])
  const files = [...walk(path.join(__dirname, '..', 'public')), ...walk(path.join(__dirname, '..', 'modules')), path.join(__dirname, '..', 'server.js')]
  for (const f of files) if (/\.(js|html)$/.test(f)) assert(!/speechSynthesis\s*[.(]|SpeechSynthesisUtterance\s*\(/.test(fs.readFileSync(f, 'utf8')), 'speechSynthesis-Aufruf in ' + f)
})
// ---------- Welt-Steuerung & Handy im WLAN ----------
t('Welt: Tag/Nacht, Wetter und Regeln werden zu festen Server-Befehlen', () => {
  const { worldCommands, sanitizeWorld, cleanCommand, clock } = require('../modules/world-control')
  const w = sanitizeWorld(null)
  assert.deepStrictEqual(worldCommands({ op: 'time', value: 'night' }, w).cmds, ['time set 13000'])
  assert.deepStrictEqual(worldCommands({ op: 'timelock', value: 'night' }, w).cmds, ['time set 18000', 'gamerule doDaylightCycle false']); assert.strictEqual(w.timeLock, 'night')
  assert.deepStrictEqual(worldCommands({ op: 'timelock', value: 'off' }, w).cmds, ['gamerule doDaylightCycle true'])
  assert.deepStrictEqual(worldCommands({ op: 'weather', value: 'thunder' }, w).cmds, ['weather thunder'])
  assert.deepStrictEqual(worldCommands({ op: 'rule', name: 'keepInventory', value: true }, w).cmds, ['gamerule keepInventory true']); assert.strictEqual(w.rules.keepInventory, true)
  // freier Text darf nie in einem Befehl landen
  for (const bad of [{ op: 'time', value: '0\nop x' }, { op: 'weather', value: 'clear; stop' }, { op: 'rule', name: 'constructor', value: true }, { op: 'difficulty', value: 'toString' }, { op: 'nope' }, null]) assert.strictEqual(worldCommands(bad, w), null)
  assert.deepStrictEqual(sanitizeWorld({ timeLock: 'x', rules: { keepInventory: 'ja', mobSpawning: false, hack: true } }), { timeLock: 'off', rules: { mobSpawning: false } })
  assert.strictEqual(cleanCommand('/say hallo\nstop'), 'say hallo stop'); assert.strictEqual(cleanCommand('  '), null); assert.strictEqual(cleanCommand('x'.repeat(400)).length, 255)
  assert.strictEqual(clock(0), '06:00'); assert.strictEqual(clock(6000), '12:00'); assert.strictEqual(clock(18000), '00:00')
})
t('Handy im WLAN: nur private Adressen, WLAN vor virtuellen Adaptern', () => {
  const { lanAddresses } = require('../modules/lan')
  const got = lanAddresses({ lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }], 'vEthernet (WSL)': [{ address: '172.20.0.1', family: 'IPv4', internal: false }], WLAN: [{ address: '192.168.178.20', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }], Mobil: [{ address: '8.8.8.8', family: 'IPv4', internal: false }] })
  assert.deepStrictEqual(got, ['192.168.178.20', '172.20.0.1'])
})
console.log(`\n${n} Tests bestanden`)
