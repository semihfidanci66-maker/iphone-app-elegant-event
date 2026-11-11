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
const pending = [] // asynchrone Tests werden am Ende abgewartet
const t = (name, fn) => { const r = fn(); const ok = () => { n++; console.log('PASS ', name) }; if (r && typeof r.then === 'function') pending.push(r.then(ok)); else ok() }

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
  assert.strictEqual(g.publicConfig().length, 8)
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
t('Gift-Bibliothek: Deutschland-Liste ist eingebaut, jede Startregel hat Originalbild und echten Preis', () => {
  const list = require('../modules/tiktok-gifts-de.json')
  assert(list.length > 700, 'Liste unvollständig: ' + list.length)
  for (const [name, coins, icon] of list) assert(name && coins >= 1 && /^https:\/\/p\d+-webcast\.tiktokcdn\.com\//.test(icon), name)
  const { g } = mkGifts()
  assert.deepStrictEqual(g.rules.filter(r => !r.icon).map(r => r.giftName), [])
  const real = new Map(list.map(x => [x[0].toLowerCase(), x[1]]))
  for (const r of g.rules) assert(r.match.some(m => real.has(m)), 'kein echtes Gift: ' + r.giftName)
  assert.strictEqual(g.rules.find(r => r.id === 'galaxy').coins, 1000); assert.strictEqual(g.rules.find(r => r.id === 'rosa').coins, 10)
  const lib = g.libraryList(); assert(lib.length > 700); assert(lib.every(x => x.icon))
  assert.strictEqual(g.librarySnapshot().gifts.length, 0, 'mitgelieferte Gifts werden nicht doppelt gespeichert')
})
t('Gift-Bibliothek: echte TikTok-Liste liefert Bild und Preis, Auswahl legt eine Regel an', () => {
  const { g } = mkGifts()
  const before = g.libraryList().length
  assert(g.learnLibrary([{ id: 5655, name: 'Rose', coins: 1, icon: 'https://p16-webcast.tiktokcdn.com/img/rose.png' }, { id: 5487, name: 'Finger Heart', coins: 5, icon: 'https://p16-webcast.tiktokcdn.com/img/fh.png' }, { id: 9001, name: 'Drachenflamme', coins: 26999, icon: 'javascript:alert(1)' }]))
  assert.strictEqual(g.rules.find(r => r.id === 'rose').icon, 'https://p16-webcast.tiktokcdn.com/img/rose.png')
  assert.strictEqual(g.rules.find(r => r.id === 'finger_heart').icon, 'https://p16-webcast.tiktokcdn.com/img/fh.png', 'englischer Name trifft den deutschen Katalog-Eintrag')
  const lib = g.libraryList()
  assert.strictEqual(lib.length, before + 1); assert(lib.some(x => x.name === 'Drachenflamme' && x.icon === null && x.ruleId === null))
  const r = g.addFromLibrary('drachenflamme'); assert.strictEqual(r.coins, 26999); assert.strictEqual(r.action, 'boss_warden'); assert(r.inLegend)
  assert.strictEqual(g.libraryList().find(x => x.name === 'Drachenflamme').ruleId, r.id)
  assert.strictEqual(g.learnLibrary([{ name: 'Rose', coins: 1, icon: 'https://p16-webcast.tiktokcdn.com/img/rose.png' }]), false, 'nichts Neues -> keine Änderung')
  const g2 = mkGifts().g; g2.loadLibrary(g.librarySnapshot()); assert.strictEqual(g2.rules.find(r => r.id === 'rose').icon, 'https://p16-webcast.tiktokcdn.com/img/rose.png')
  assert(g.publicConfig().length <= 24)
})

// ---------- Like-Ziel & Combo-Ansage ----------
t('Like-Ziel: wer die Schwelle knackt, bekommt die Aktion; jede Runde eins mehr', () => {
  const { LikeGoal, sanitizeLikes } = require('../modules/like-goal')
  const g = new LikeGoal({ every: 100 })
  const max = { uniqueId: 'max', nickname: 'Max' }; const lukas = { uniqueId: 'lukas', nickname: 'Lukas' }
  assert.deepStrictEqual(g.add(max, 60), []); assert.deepStrictEqual(g.add(lukas, 30), []); assert.deepStrictEqual(g.add(max, 9), [])
  const hit = g.add(lukas, 5) // 104 -> Lukas knackt die 100
  assert.strictEqual(hit.length, 1); assert.strictEqual(hit[0].winner.name, 'Lukas'); assert.strictEqual(hit[0].amount, 1); assert.strictEqual(hit[0].nextAmount, 2); assert.deepStrictEqual(hit[0].helpers, ['Max'])
  assert.strictEqual(g.state().progress, 4); assert.strictEqual(g.state().level, 1); assert.strictEqual(g.state().last, 'Lukas')
  const second = g.add(max, 96); assert.strictEqual(second[0].winner.name, 'Max'); assert.strictEqual(second[0].amount, 2); assert.deepStrictEqual(second[0].helpers, ['Lukas'])
  assert.strictEqual(g.add(max, 500).length, 3, 'ein Paket löst höchstens drei Ziele aus'); assert(g.state().progress < 100)
  for (let i = 0; i < 20; i++) g.add(max, 100); assert.strictEqual(g.amountFor(g.level), 5, 'Steigerung ist gedeckelt')
  g.setConfig({ enabled: false }); assert.deepStrictEqual(g.add(max, 500), [])
  assert.deepStrictEqual(sanitizeLikes({ every: 3, action: 'hack', amount: 99, mob: 7 }, ACTIONS), { enabled: true, every: 10, action: 'zombie_fast', mob: 'zombie', amount: 10, escalate: true })
})
t('Persona: Combo wird am Stück angesagt, Like-Ziel nennt den Gewinner', () => {
  const { b, q } = mkBrain(calm)
  b.onGift({ uniqueId: 'max', nickname: 'Max' }, { id: 'rose', name: 'Rose', coins: 1 }, { kind: 'mob', tier: 1, spawnText: 'einen Zombie', mob: 'zombie' }, 10)
  assert(/Max/.test(q()[0]) && /(zehn|10) Rosen/.test(q()[0]), q()[0])
  const m = mkBrain(calm)
  m.b.onLikeGoal({ uniqueId: 'lukas', nickname: 'Lukas' }, { every: 100, level: 1, spawnText: 'einen Zombie', amount: 1, nextAmount: 2, helpers: ['Max'] })
  assert(/Lukas/.test(m.q()[0]) && /100/.test(m.q()[0]) && /Max/.test(m.q()[0]) && /(mehr|weiter)/i.test(m.q()[0]), m.q()[0])
})

// ---------- Lernen ----------
t('Wissen: Kampf-Zeiten, Gegner-Taktiken und Auswege', () => {
  const K = require('../modules/mc-knowledge')
  assert.strictEqual(K.cooldownFor('iron_sword'), 625); assert.strictEqual(K.cooldownFor('stone_axe'), 1250); assert.strictEqual(K.cooldownFor('diamond_axe'), 1000); assert.strictEqual(K.cooldownFor(''), 250)
  assert.strictEqual(K.threatInfo('creeper').blast, 3); assert(K.creeperSafe(3.5) && !K.creeperSafe(2.5)); assert.strictEqual(K.threatInfo('unbekannt').danger, 2)
  assert.strictEqual(K.fallDamage(3), 0); assert.strictEqual(K.fallDamage(10), 7)
  for (const list of Object.values(K.REMEDIES)) for (const s of list) assert(K.STRATEGIES[s], 'Ausweg ohne Beschreibung: ' + s)
  assert(K.remediesFor('gibt_es_nicht').includes('relocate'))
})
t('Lernen: Tode werden zu Lehren, Lehren ändern das Verhalten', () => {
  const { AILearning } = require('../modules/ai-learning')
  let saves = 0
  const L1 = new AILearning(null, { onChange: () => saves++ })
  assert.strictEqual(L1.policy().retreatHp, 12); assert.strictEqual(L1.policy().creeperCaution, 0)
  const r = L1.recordDeath({ killer: 'creeper', explosion: true, mobs: ['creeper'], threats: 1, underground: true, tunnel: true, pickTier: 2 })
  assert.strictEqual(r.mistake.sig, 'death:creeper:tunnel'); assert(/Creeper/.test(r.mistake.text) && /engen Gang/.test(r.mistake.text))
  assert.deepStrictEqual(r.lessons.map(l => l.id).sort(), ['cave_iron', 'creeper_1', 'creeper_tunnel'])
  assert.strictEqual(L1.policy().creeperCaution, 2); assert(L1.policy().caveNeedsIron)
  assert.deepStrictEqual(L1.extraPreconditions('MineDiamonds'), ['ironKit']); assert.deepStrictEqual(L1.extraPreconditions('GatherWood'), [])
  assert.strictEqual(L1.recordDeath({ killer: 'creeper', explosion: true, underground: true, tunnel: true, pickTier: 2 }).lessons.map(l => l.id).join(), 'creeper_2', 'gleicher Fehler -> nur die nächste Stufe, keine Wiederholung')
  // Zombies: Vorsicht steigt, Rückzug früher – aber nur wenn Zombies dabei sind
  const L2 = new AILearning(null)
  L2.recordDeath({ killer: 'zombie', mobs: ['zombie', 'zombie', 'zombie'], threats: 4, night: true, pickTier: 3 })
  assert.strictEqual(L2.retreatHpFor(['zombie']), 13); assert.strictEqual(L2.retreatHpFor(['spider']), 12); assert.strictEqual(L2.policy().funnelAt, 3); assert(L2.policy().nightShelter)
  assert.deepStrictEqual(L2.progression(['woodKit', 'stoneKit', 'food', 'bed', 'ironKit']), ['woodKit', 'bed', 'stoneKit', 'food', 'ironKit'])
  // Wärter: natürlichem ausweichen, Gift-Wärter nicht
  const L3 = new AILearning(null); L3.recordDeath({ killer: 'warden', threats: 1, giftMob: true }); assert.deepStrictEqual(L3.policy().avoid, [])
  L3.recordDeath({ killer: 'warden', threats: 1 }); assert.deepStrictEqual(L3.policy().avoid, ['warden'])
  const L4 = new AILearning(null); L4.recordDeath({ inLava: true, underground: true, pickTier: 3 }); L4.recordDeath({ fell: true }); L4.recordDeath({ starving: true })
  const p = L4.policy(); assert(p.caveNeedsWater); assert.strictEqual(p.maxDrop, 2); assert.strictEqual(p.eatAt, 17); assert.strictEqual(p.foodReserve, 10)
  // Speichern und wieder laden
  const again = new AILearning(JSON.parse(JSON.stringify(L1.toJSON())))
  assert.strictEqual(again.policy().creeperCaution, 2); assert.strictEqual(again.summary().deaths, 2); assert(saves > 0)
  again.reset(); assert.strictEqual(again.policy().creeperCaution, 0)
})
t('Lernen: nach drei Fehlschlägen neuer Ausweg, bewährte Auswege werden bevorzugt', () => {
  const { AILearning } = require('../modules/ai-learning')
  const L1 = new AILearning(null, { random: () => 0.9 })
  assert.strictEqual(L1.taskResult('MineIron', false).rethink, false); assert.strictEqual(L1.taskResult('MineIron', false).rethink, false)
  assert.strictEqual(L1.taskResult('MineIron', false).rethink, true, 'dritter Fehlschlag')
  const first = L1.chooseStrategy('MineIron', 'mine'); assert.strictEqual(first.name, 'relocate', 'unversuchte zuerst, in der Reihenfolge der Wissensbasis')
  L1.taskResult('MineIron', false) // relocate hat nicht geholfen
  const second = L1.chooseStrategy('MineIron', 'mine', n => n !== 'surface_first'); assert.strictEqual(second.name, 'better_tools')
  L1.taskResult('MineIron', true) // better_tools hat geholfen
  assert.strictEqual(L1.strategies['MineIron|better_tools'].wins, 1); assert.strictEqual(L1.strategies['MineIron|relocate'].wins, 0)
  for (const s of ['surface_first', 'more_food']) { L1.chooseStrategy('MineIron', 'mine', n => n === s); L1.taskResult('MineIron', false) }
  assert.strictEqual(L1.chooseStrategy('MineIron', 'mine').name, 'better_tools', 'alle versucht -> der mit der besten Quote')
  assert(L1.costPenalty('MineIron') >= 8, 'oft gescheitert -> für den Planer teurer'); assert.strictEqual(L1.costPenalty('GatherWood'), 0)
  assert.strictEqual(L1.taskResult('MineIron', true).streak, 0)
})
t('Chat-Tipps: erkennen, merken, anwenden – und nichts Schädliches annehmen', () => {
  const { ChatWisdom, matchRule, looksLikeAdvice } = require('../modules/chat-wisdom')
  const { AILearning } = require('../modules/ai-learning')
  const cases = { 'Pack Wasser in die Off-Hand': 'water_bucket', 'Schlag den Warden nicht, schleich lieber!': 'avoid_warden', 'Nutz Goldrüstung im Nether': 'gold_nether', 'beim creeper musst du abstand halten': 'creeper_distance', 'bau dich hoch wenn zu viele kommen': 'pillar_up', 'lauf weg wenn du wenig leben hast': 'retreat_early', 'erst eisen rüstung dann in die höhle': 'iron_first', 'nie gerade nach unten graben': 'no_dig_down' }
  for (const [text, id] of Object.entries(cases)) assert.strictEqual((matchRule(text) || {}).id, id, text)
  for (const text of ['Bau ein Haus', 'Geh schlafen', 'Was machst du gerade?', 'Hol deinen Loot', 'Geh in den Nether', 'bist du eine ki', 'kämpf ohne rüstung gegen den warden du noob', 'spring in die lava']) assert.strictEqual(matchRule(text), null, text)
  assert(looksLikeAdvice('du solltest einen bogen craften gegen die skelette')); assert(!looksLikeAdvice('hallo wie gehts'))
  let t = 1000
  const w = new ChatWisdom(null, { now: () => t })
  const a = w.consider('Mia', 'Nutz Goldrüstung im Nether'); assert.strictEqual(a.kind, 'new'); assert.strictEqual(a.rule.id, 'gold_nether')
  const b = w.consider('Tom', 'im nether brauchst du gold stiefel'); assert.strictEqual(b.kind, 'known'); assert.strictEqual(b.first, 'Mia')
  assert.strictEqual(w.consider('Ben', 'nie gerade nach unten graben').kind, 'already')
  assert.strictEqual(w.consider('Ben', 'du solltest einen bogen craften gegen die skelette').kind, 'unknown'); assert.strictEqual(w.consider('Ben', 'lol'), null)
  w.consider('Lea', 'Schlag den Warden nicht, schleich lieber!'); w.consider('Lea', 'iss mal früher was')
  // Tipps wirken über die Policy
  const L1 = new AILearning(null); L1.setTips(w.active())
  assert.deepStrictEqual(L1.policy().avoid, ['warden']); assert.strictEqual(L1.policy().eatAt, 17); assert(/Lea/.test(L1.policy().reasons.avoid))
  assert(!('no_dig_down' in w.active()), 'schon befolgte Tipps ändern nichts')
  // Anwenden im passenden Moment, höchstens alle 10 Minuten
  assert.deepStrictEqual(w.recall('nether').map(x => x.by), ['Mia']); assert.deepStrictEqual(w.recall('nether'), []); t += 601000; assert.strictEqual(w.recall('nether').length, 1)
  assert.strictEqual(w.summary().tips.find(x => x.id === 'gold_nether').applied, 2)
  w.setEnabled('avoid_warden', false); L1.setTips(w.active()); assert.deepStrictEqual(L1.policy().avoid, [])
  const again = new ChatWisdom(JSON.parse(JSON.stringify(w.toJSON()))); assert.strictEqual(again.summary().tips.length, 4); assert.strictEqual(again.learn('gibt_es_nicht', 'x', 'y'), null)
})
t('Persona: Tipps und Lehren werden angesagt', () => {
  const { RULES } = require('../modules/chat-wisdom')
  const rule = RULES.find(r => r.id === 'avoid_warden')
  const { b, q } = mkBrain(calm)
  b.onTip({ uniqueId: 'm', nickname: 'Mia' }, { kind: 'new', rule }); assert(/Mia/.test(q()[0]) && /schleichen/.test(q()[0]), q()[0])
  b.queue = []; b.onTipRecall('Mia', rule); assert(/Mia/.test(b.queue[0].text) && /Wärter/.test(b.queue[0].text))
  b.queue = []; b.onBotEvent('lesson', { id: 'creeper_1', text: 'Creeper: mehr Abstand halten.' }); assert(/Creeper: mehr Abstand/.test(b.queue[0].text))
  b.queue = []; b.onBotEvent('rethink', { label: 'Eisen suchen', say: 'Hier wird das nichts.', wins: 0 }); assert(/Hier wird das nichts/.test(b.queue[0].text))
})
t('Planer: gelernte Vorbedingungen und Kosten fließen in den Plan ein', () => {
  const { AILearning } = require('../modules/ai-learning')
  const p = P(); const learn = new AILearning(null); p.ctx.learn = learn
  const facts = { ...none(), woodKit: true, woodPick: true, wood: true, cobble: true, stoneKit: true, ironKit: true, rawIron: true, ironIngots: true }
  assert.deepStrictEqual(p.planFor(['diamonds'], facts).steps.map(s => s.name), ['MineDiamonds'])
  learn.recordDeath({ inLava: true, underground: true, pickTier: 3 }) // -> tief unten nur noch mit Wassereimer
  assert.deepStrictEqual(p.planFor(['diamonds'], facts).steps.map(s => s.name), ['FillBucket', 'MineDiamonds'])
  const before = p.planFor(['diamonds'], facts).cost
  for (let i = 0; i < 4; i++) learn.taskResult('MineDiamonds', false)
  assert(p.planFor(['diamonds'], facts).cost > before, 'gescheiterte Aktion wird teurer')
})

t('Selbstständigkeit: Lag-Erkennung, Haltbarkeit, Todes-Lage, mögliche Auswege', () => {
  const { Vec3 } = require('vec3')
  const { Autonomy } = require('../modules/bot/autonomy')
  const realNow = Date.now; let now = 1e6; Date.now = () => now
  try {
    const bot = { time: { age: 0 }, food: 20, oxygenLevel: 20, game: { dimension: 'overworld' }, entity: { position: new Vec3(0, 64, 0), onGround: true, isInWater: false, isInLava: false }, blockAt: () => ({ name: 'air' }) }
    const tools = { pickaxe: { name: 'iron_pickaxe', slot: 36, maxDurability: 250, durabilityUsed: 230 }, sword: { name: 'iron_sword', slot: 37, maxDurability: 250, durabilityUsed: 10 } }
    const ctx = {
      bot,
      actions: { bestTool: k => tools[k] || null, pickTier: () => 3, feet: () => new Vec3(0, 64, 0), isSolid: b => !!b && b.name !== 'air', count: n => (n === 'dirt' ? 12 : 0), findFirst: () => null },
      combat: { scan: () => [], hasShield: () => false }, liquid: { inLava: () => false }, building: { isNight: () => true, hasBedAvailable: () => false },
      food: { cookedCount: () => 2 }, crafting: { woodValue: () => 40 }
    }
    const au = new Autonomy(ctx, { isUnderground: () => false, activity: { key: 'wood' } })
    // 20 Ticks pro Sekunde -> kein Lag; dann 5 Ticks pro Sekunde -> nach rund 5 s Lag; danach Erholung
    let ev = []
    for (let i = 0; i < 8; i++) { now += 1000; bot.time.age += 20; ev.push(au.onServerTime()) }
    assert(ev.every(x => x === null)); assert.strictEqual(au.tps.value, 20)
    ev = []; for (let i = 0; i < 14; i++) { now += 1000; bot.time.age += 5; ev.push(au.onServerTime()) }
    assert.strictEqual(ev.filter(x => x === 'lag').length, 1); assert(au.tps.value < 10)
    ev = []; for (let i = 0; i < 10; i++) { now += 1000; bot.time.age += 20; ev.push(au.onServerTime()) }
    assert.strictEqual(ev.filter(x => x === 'ok').length, 1)
    // Haltbarkeit: 8 % übrig -> einmal melden
    assert.strictEqual(Autonomy.durabilityLeft(tools.pickaxe), 0.08000000000000007 > 0 ? Autonomy.durabilityLeft(tools.pickaxe) : 0); assert(Autonomy.durabilityLeft(tools.pickaxe) < 0.1); assert.strictEqual(Autonomy.durabilityLeft({ name: 'dirt' }), null)
    now += 20000; const worn = au.checkWear(); assert.deepStrictEqual(worn.map(w => w.item), ['iron_pickaxe']); now += 20000; assert.deepStrictEqual(au.checkWear(), [])
    // Todes-Lage: Sturz ohne Gegner
    bot.entity.onGround = false; bot.entity.position = new Vec3(0, 90, 0); au.tick(); bot.entity.position = new Vec3(0, 70, 0); au.tick()
    const c = au.deathContext(); assert(c.fell && !c.killer && c.night && !c.underground); assert.strictEqual(c.pickTier, 3)
    // Auswege: tagsüber kein "auf den Tag warten", an der Oberfläche kein "erst hoch"
    assert(au.strategyPossible('wait_for_day') && !au.strategyPossible('surface_first') && au.strategyPossible('more_food') && !au.strategyPossible('more_wood') && !au.strategyPossible('better_tools'))
    assert.strictEqual(au.blocksAvailable(), 12)
  } finally { Date.now = realNow }
})

// ---------- Sprachmodell ----------
t('Sprachmodell: Antwort wird gesäubert, Kosten gezählt, Budget und Fehler führen zum Textbaustein', async () => {
  const { LlmBrain, cleanReply, sanitizeLlm } = require('../modules/llm-brain')
  assert.strictEqual(cleanReply('**Max** fragt… "Ja!" 😂 #noob\nKlar bin ich das.'), 'Max fragt… Ja! noob Klar bin ich das.')
  assert.strictEqual(cleanReply('schau auf www.spam.de vorbei'), null); assert.strictEqual(cleanReply('ok'), null)
  assert(cleanReply('Wort '.repeat(200)).length <= 321)
  assert.deepStrictEqual(sanitizeLlm({ enabled: 1, model: 'gpt', budgetUsd: 999, maxPerHour: 1 }), { enabled: true, model: 'claude-haiku-5-5', budgetUsd: 50, maxPerHour: 20, monologues: true })
  const calls = []
  let next = { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Max fragt, ob ich eine KI bin... Ja. Und besser als du.' }], usage: { input_tokens: 200, cache_read_input_tokens: 600, output_tokens: 40 } }
  const client = { messages: { create: async req => { calls.push(req); if (next instanceof Error) throw next; return next } } }
  const llm = new LlmBrain({ enabled: true, budgetUsd: 0.05 }, { client })
  const out = await llm.ask(llm.chatTask({ name: 'Max', msg: 'Bist du eine KI', state: 'Holz hacken', viewer: '1. Nachricht' }))
  assert.strictEqual(out, 'Max fragt, ob ich eine KI bin... Ja. Und besser als du.')
  const req = calls[0]
  assert.strictEqual(req.model, 'claude-haiku-5-5'); assert.strictEqual(req.system[0].cache_control.type, 'ephemeral'); assert(/NACHRICHT: Bist du eine KI/.test(req.messages[0].content))
  assert(!('temperature' in req) && !('top_p' in req), 'keine Sampling-Parameter (würden abgelehnt)')
  assert(Math.abs(llm.stats.costUsd - (200 * 0.10 + 600 * 0.01 + 40 * 0.50) / 1e6) < 1e-12)
  await llm.ask('x'); assert(/letzten Sätze|LETZTEN SÄTZE/.test(calls[1].messages[0].content), 'letzte Sätze gegen Wiederholung')
  next = { stop_reason: 'refusal', content: [], usage: { input_tokens: 10, output_tokens: 0 } }
  assert.strictEqual(await llm.ask('x'), null)
  next = new Error('Netz weg'); assert.strictEqual(await llm.ask('x'), null); assert.strictEqual(llm.stats.lastError, 'Netz weg')
  llm.stats.costUsd = 0.06; assert.strictEqual(llm.ready(), false); assert.strictEqual(await llm.ask('x'), null); assert(llm.stats.budgetHit)
  assert.strictEqual(new LlmBrain({ enabled: true }, {}).ready(), !!process.env.ANTHROPIC_API_KEY, 'ohne Schlüssel bleibt es aus')
  assert(!JSON.stringify(llm.publicState()).includes('apiKey'))
})
t('Persona: mit Sprachmodell kommt dessen Antwort, sonst der Textbaustein', async () => {
  const mk = (answer) => { const x = mkBrain(calm); x.b.deps.llm = { config: { monologues: true }, ready: () => true, chatTask: o => o, idleTask: o => o, ask: async () => answer }; return x }
  const a = mk('Ben schreibt Pizza... Schön für dich, ich zocke.')
  const r = a.b.onChat({ uniqueId: 'v', nickname: 'Ben' }, 'ich mag pizza'); assert(r.llm)
  await new Promise(resolve => setImmediate(resolve)); assert.strictEqual(a.q()[0], 'Ben schreibt Pizza... Schön für dich, ich zocke.')
  const f = mk(null); f.b.onChat({ uniqueId: 'v', nickname: 'Ben' }, 'bist du eine ki?')
  await new Promise(resolve => setImmediate(resolve)); assert(/Ben fragt, ob ich eine KI bin/.test(f.q()[0]), f.q()[0])
  const g = mk('egal'); g.b.onChat({ uniqueId: 'v', nickname: 'Ben' }, 'Bau ein Haus'); assert(!/egal/.test(g.q()[0] || ''), 'Spielwünsche bleiben beim schnellen Baustein')
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
Promise.all(pending).then(() => console.log(`\n${n} Tests bestanden`), e => { console.error(e); process.exit(1) })
