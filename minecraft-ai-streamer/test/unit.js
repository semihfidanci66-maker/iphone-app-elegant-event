'use strict'
// Offline-Logiktests (ohne Minecraft-Server): node test/unit.js
const assert = require('assert')
const { Planner } = require('../modules/bot/planner')
const { StreamerBrain } = require('../modules/ai-streamer-brain')
const { GiftEngine, DEFAULT_RULES, ACTIONS } = require('../modules/gift-engine')
const { TTSEngine } = require('../modules/tts-engine')
const { cooldownFor } = require('../modules/bot/combat')
let n = 0
const t = (name, fn) => { fn(); n++; console.log('PASS ', name) }

// ---------- GOAP ----------
const fakeCtx = () => ({ actions: {}, emit () {}, memory: {}, mcData: {}, bot: {} })
const P = () => { const p = new Planner(fakeCtx()); return p }
const none = () => Object.fromEntries(['wood', 'woodPick', 'woodKit', 'cobble', 'stoneKit', 'rawFood', 'food', 'rawIron', 'ironIngots', 'ironKit', 'waterBucket', 'buildMats', 'base', 'diamonds', 'diamondPick', 'lapis', 'obsidian4', 'enchantTable', 'enchanted', 'gold', 'flintSteel', 'obsidian10', 'portal', 'blazeRods'].map(k => [k, false]))
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
  assert.strictEqual(p.next().action.name, 'MineIron')
})

// ---------- PvP-Rhythmus ----------
t('PvP: Cooldowns 625 ms Schwert / 1000 ms Axt', () => {
  assert.strictEqual(cooldownFor({ name: 'diamond_sword' }), 625); assert.strictEqual(cooldownFor({ name: 'diamond_axe' }), 1000); assert.strictEqual(cooldownFor({ name: 'stone_axe' }), 1250)
})

// ---------- Gift-Engine ----------
t('Gifts: alle Befehle < 256 Zeichen, native Entities, Helm + Namensschild', () => {
  const g = new GiftEngine({ runCommands: () => true, spawnPoint: () => ({ x: 10.5, y: 64, z: -3.5 }), botPos: () => ({ x: 8, y: 64, z: -3 }) }, DEFAULT_RULES)
  g.trackBoss = () => {}
  for (const id of Object.keys(ACTIONS)) {
    const { cmds } = g.build(id, 'Lukas_der_Allergrößte_99!!', 8, { x: 10.5, y: 64, z: -3.5 }, { x: 8, y: 64, z: -3 })
    for (const c of cmds) { assert(c.length < 256, `${id}: ${c.length} Zeichen`); assert(!/armor_stand|setblock/.test(c), 'kein Platzhalter') }
  }
  const z = g.build('zombie_fast', 'Lukas', 1, { x: 1, y: 64, z: 1 }).cmds.join('\n')
  assert(/summon zombie/.test(z) && /armor\.head with iron_helmet/.test(z))
  assert(z.includes(`CustomName:'{"text":"⚡ @Lukas","color":"red","bold":true}',CustomNameVisible:1b`))
  assert(/bossbar add/.test(g.build('boss_ravager', 'Mia', 1, { x: 1, y: 64, z: 1 }).cmds.join('\n')))
})
t('Gifts: Regel-Zuordnung (Name, Alias, Fallback nach Coin-Wert)', () => {
  const g = new GiftEngine({ runCommands: () => true, spawnPoint: () => null, botPos: () => null }, DEFAULT_RULES)
  assert.strictEqual(g.findRule({ name: 'Rose', coins: 1 }).id, 'rose')
  assert.strictEqual(g.findRule({ name: 'Doughnut', coins: 30 }).id, 'donut')
  assert.strictEqual(g.findRule({ name: 'Ice Cream Cone', coins: 1 }).id, 'ice_cream')
  assert.strictEqual(g.findRule({ name: 'Unbekanntes Ding', coins: 120 }).id, 'hand_heart')
  assert.strictEqual(g.publicConfig().length, 8)
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
console.log(`\n${n} Tests bestanden`)
