'use strict'
/**
 * Prüft jeden Server-Befehl, den das Programm erzeugt, gegen die Befehls-Syntax und die
 * Register (Gegner, Gegenstände, Attribute, Effekte) von Minecraft Java 1.21.1.
 *
 *   node test/commands.js
 *
 * Die Vergleichsdaten in test/fixtures/ stammen aus dem Projekt minecraft-skills
 * (https://github.com/sya-ri/minecraft-skills, MIT-Lizenz), dort erzeugt aus Mojangs Server-Reports.
 * Geprüft wird die Schreibweise – nicht, ob der Server den Befehl zur Laufzeit ausführt
 * (Rechte, Zielauswahl und NBT-Inhalt bleiben ungeprüft).
 */
const fs = require('fs')
const path = require('path')
const assert = require('assert')

const FIX = path.join(__dirname, 'fixtures')
const PATHS = fs.readFileSync(path.join(FIX, 'command-paths-1.21.1.txt'), 'utf8').split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(' '))
const REG = {}
for (const line of fs.readFileSync(path.join(FIX, 'registries-1.21.1.tsv'), 'utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue
  const [reg, id] = line.split('\t')
  ;(REG[reg] || (REG[reg] = new Set())).add(id.replace(/^minecraft:/, ''))
}

/** Befehl in Wörter zerlegen; {…}, […] und "…" bleiben jeweils ein Wort. */
function tokenize (cmd) {
  const out = []
  let cur = ''; let depth = 0; let quote = null
  for (const ch of cmd) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
    if (ch === '{' || ch === '[') depth++
    if (ch === '}' || ch === ']') depth--
    if (ch === ' ' && depth === 0) { if (cur) out.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}
// Wie viele Wörter ein Argument-Typ verbraucht (-1 = der ganze Rest)
const WIDTH = { 'minecraft:vec3': 3, 'minecraft:block_pos': 3, 'minecraft:vec2': 2, 'minecraft:column_pos': 2, 'minecraft:rotation': 2, 'minecraft:message': -1, 'minecraft:component': 1, 'minecraft:nbt_compound_tag': 1 }
const NUM = /^-?\d+(\.\d+)?$/
const COORD = /^[~^]?-?\d*(\.\d+)?$/

function matchPath (tokens, p) {
  let i = 0
  const checks = []
  for (const part of p) {
    const m = /^<([^:>]+):(.+)>$/.exec(part)
    if (!m) { if (tokens[i] !== part) return null; i++; continue }
    const type = m[2]
    const w = WIDTH[type] ?? 1
    if (w === -1) { if (i >= tokens.length) return null; i = tokens.length; continue }
    if (i + w > tokens.length) return null
    const got = tokens.slice(i, i + w)
    if (/brigadier:(integer|double|float)/.test(type) && !NUM.test(got[0])) return null
    if (type === 'brigadier:bool' && !/^(true|false)$/.test(got[0])) return null
    if (/vec3|block_pos|vec2|column_pos|rotation/.test(type) && !got.every(g => COORD.test(g))) return null
    checks.push({ name: m[1], type, value: got.join(' ') })
    i += w
  }
  return i === tokens.length ? checks : null
}

const idOf = v => v.replace(/^minecraft:/, '').replace(/[{[].*$/, '')
/** Inhalt der Argumente gegen die Register prüfen. */
function checkRegistries (checks, cmd, problems) {
  const head = cmd.split(' ')[0]
  for (const c of checks) {
    const id = idOf(c.value)
    if (c.type === 'minecraft:item_stack' && !REG['minecraft:item'].has(id)) problems.push(`unbekannter Gegenstand "${id}"`)
    if (c.type === 'minecraft:resource' && head === 'attribute' && c.name === 'attribute' && !REG['minecraft:attribute'].has(id)) problems.push(`unbekanntes Attribut "${id}"`)
    if (c.type === 'minecraft:resource' && head === 'effect' && c.name === 'effect' && !REG['minecraft:mob_effect'].has(id)) problems.push(`unbekannter Effekt "${id}"`)
    if (c.type === 'minecraft:resource' && head === 'summon' && !REG['minecraft:entity_type'].has(id)) problems.push(`unbekanntes Wesen "${id}"`)
    if ((c.type === 'minecraft:block_state' || c.type === 'minecraft:block_predicate') && !REG['minecraft:block'].has(id)) problems.push(`unbekannter Block "${id}"`)
    if (c.type === 'minecraft:particle' && !REG['minecraft:particle_type'].has(id)) problems.push(`unbekannter Partikel "${id}"`)
    if (head === 'playsound' && c.name === 'sound' && !REG['minecraft:sound_event'].has(id)) problems.push(`unbekanntes Geräusch "${id}"`)
  }
}

/** @returns {string[]} Liste der Probleme (leer = Befehl passt zu 1.21.1) */
function validate (cmd) {
  const problems = []
  let tokens = tokenize(String(cmd).replace(/^\//, ''))
  // "execute … run <Befehl>": die Vorsilben nur grob prüfen, den eigentlichen Befehl genau
  while (tokens[0] === 'execute') {
    const r = tokens.indexOf('run')
    if (r < 0) return ['execute ohne run']
    const sub = tokens.slice(1, r)
    const known = new Set(['as', 'at', 'positioned', 'rotated', 'facing', 'in', 'if', 'unless', 'anchored', 'align', 'on', 'store', 'summon'])
    if (!sub.length || !known.has(sub[0])) problems.push(`unbekannte execute-Vorsilbe "${sub[0]}"`)
    tokens = tokens.slice(r + 1)
  }
  if (!tokens.length) return ['leerer Befehl']
  // Kurzformen, die der Server auf den langen Befehl umleitet (stehen nicht einzeln in den Daten)
  const ALIAS = { tp: 'teleport', xp: 'experience', w: 'msg', tell: 'msg', tm: 'teammsg' }
  if (ALIAS[tokens[0]]) tokens[0] = ALIAS[tokens[0]]
  const candidates = PATHS.filter(p => p[0] === tokens[0])
  if (!candidates.length) return [`Befehl "${tokens[0]}" gibt es in 1.21.1 nicht`]
  let hit = null
  for (const p of candidates) { hit = matchPath(tokens, p); if (hit) break }
  if (!hit) return [...problems, `Schreibweise passt auf keine der ${candidates.length} Formen von "${tokens[0]}"`]
  checkRegistries(hit, tokens[0], problems)
  return problems
}

/** Alle Befehle einsammeln, die das Programm erzeugen kann. */
function collect () {
  const { GiftEngine, ACTIONS, MOBS } = require('../modules/gift-engine')
  const { worldCommands, TIMES, WEATHER, DIFFICULTY, RULES, LOCKS } = require('../modules/world-control')
  const out = []
  const g = new GiftEngine({ runCommands: () => true, spawnPoint: () => ({ x: 10.5, y: 64, z: -3.5 }), botPos: () => ({ x: 8, y: 64, z: -3 }) })
  const at = { x: 10.5, y: 64, z: -3.5 }
  for (const action of Object.keys(ACTIONS)) {
    if (action === 'none') continue
    const mobs = action === 'spawn_mob' ? Object.keys(MOBS) : [null]
    for (const mob of mobs) {
      for (const [amount, hpMult] of [[1, 1], [3, 2.5]]) {
        // Zufalls-Aktionen mehrfach bauen, damit jede Variante drankommt
        for (let i = 0; i < (action === 'support_random' ? 12 : 1); i++) {
          const built = g.build({ action, mob, amount, hpMult }, 'Test_User', 1, at, { x: 8, y: 64, z: -3 })
          for (const c of built.cmds) out.push({ src: `Gift ${action}${mob ? ':' + mob : ''}`, cmd: c })
        }
      }
    }
  }
  const w = { timeLock: 'off', rules: {} }
  for (const v of Object.keys(TIMES)) out.push(...worldCommands({ op: 'time', value: v }, w).cmds.map(cmd => ({ src: 'Welt Zeit', cmd })))
  for (const v of Object.keys(LOCKS)) out.push(...worldCommands({ op: 'timelock', value: v }, w).cmds.map(cmd => ({ src: 'Welt Ablauf', cmd })))
  for (const v of Object.keys(WEATHER)) out.push(...worldCommands({ op: 'weather', value: v }, w).cmds.map(cmd => ({ src: 'Welt Wetter', cmd })))
  for (const v of Object.keys(DIFFICULTY)) out.push(...worldCommands({ op: 'difficulty', value: v }, w).cmds.map(cmd => ({ src: 'Welt Schwierigkeit', cmd })))
  for (const name of Object.keys(RULES)) for (const value of [true, false]) out.push(...worldCommands({ op: 'rule', name, value }, w).cmds.map(cmd => ({ src: 'Welt Regel', cmd })))
  out.push(...worldCommands({ op: 'save' }, w).cmds.map(cmd => ({ src: 'Welt Speichern', cmd })))
  // feste Befehle aus Bot-Kern, Kamera-Regie und Wasser-Rettung
  for (const cmd of [
    'kill @s', 'give @s cooked_beef 8', 'give @s golden_apple 1', 'stop',
    'tp KI_Streamer 10.5 64 -3.5', 'execute at KI_Streamer run spreadplayers ~ ~ 3 10 false KI_Streamer', 'effect give KI_Streamer minecraft:fire_resistance 10 0 true',
    'kill @e[tag=kicam]', 'spectate KI_Streamer Spieler', 'execute at KI_Streamer run summon item_display ~ ~2.5 ~ {Tags:["kicam"],teleport_duration:6}', 'spectate @e[tag=kicam,limit=1] Spieler',
    'execute at KI_Streamer rotated ~ 0 positioned ^-0.9 ^2.6 ^-4.6 run tp @e[tag=kicam,limit=1] ~ ~ ~ facing entity KI_Streamer eyes'
  ]) out.push({ src: 'fest', cmd })
  // ---- Arena-Modus: Aufbau, Regeln, Animation, Jubel, Bestenliste, Gegner, alle Ausrüstungs-Stufen
  const { ArenaBuilder } = require('../modules/arena/arena-builder')
  const { upgradeCommands, LEVELS } = require('../modules/arena/arena-controller')
  const ab = new ArenaBuilder({ center: { x: 400, y: 180, z: -37 }, run: () => true, botName: () => 'KI_Streamer' })
  const arena = (src, list) => { for (const cmd of list) out.push({ src: 'Arena ' + src, cmd }) }
  arena('Bau', ab.buildCommands()); arena('Betreten', ab.enterCommands()); arena('Verlassen', ab.leaveCommands())
  arena('Animation', [...ab.animationCommands(1), ...ab.animationCommands(12)])
  for (const t of ['kill', 'boss_spawn', 'upgrade', 'emerald', 'ambient']) arena('Jubel', ab.cheerCommands(t))
  arena('Bestenliste', ab.leaderboardCommands([{ name: 'Max_der_Große', score: 150 }, { name: 'xX"Lukas\'}Xx', score: 35 }]))
  arena('Zombie', ab.spawnCommands('Lukas', false).cmds); arena('Boss', ab.spawnCommands('Mia', true).cmds)
  for (let lvl = 1; lvl <= LEVELS.length + 5; lvl++) arena('Stufe ' + lvl, upgradeCommands('KI_Streamer', lvl, 6))
  arena('fest', ['kill @e[tag=arena_mob]', 'tp KI_Streamer 400.5 180 -36.5', 'effect give KI_Streamer minecraft:instant_health 1 1 true', 'effect give KI_Streamer minecraft:regeneration 6 1 true', 'effect give KI_Streamer minecraft:slow_falling 15 0 true', 'item replace entity KI_Streamer hotbar.0 with air'])
  return out
}

function run () {
  const all = collect()
  const seen = new Map()
  for (const { src, cmd } of all) {
    // Zahlen und Namen vereinheitlichen, damit gleiche Befehlsformen nur einmal gemeldet werden
    const shape = cmd.replace(/-?\d+(\.\d+)?/g, '0').replace(/g0/g, 'gN')
    if (seen.has(shape)) continue
    const problems = validate(cmd)
    // über den Bot geschickte Befehle sind Chat-Nachrichten: höchstens 256 Zeichen inklusive Schrägstrich
    if (cmd.length > 255) problems.push(`zu lang für den Chat (${cmd.length} Zeichen)`)
    seen.set(shape, { src, cmd, problems })
  }
  const bad = [...seen.values()].filter(x => x.problems.length)
  return { total: all.length, shapes: seen.size, bad }
}

module.exports = { validate, tokenize, collect, run }

if (require.main === module) {
  const r = run()
  for (const b of r.bad) console.log(`FEHLER  [${b.src}]  ${b.cmd}\n        -> ${b.problems.join('; ')}`)
  console.log(`\n${r.total} Befehle erzeugt, ${r.shapes} verschiedene Formen geprüft, ${r.bad.length} mit Problemen`)
  assert.strictEqual(validate('gamerule gibtEsNicht true').length > 0, true)
  assert.strictEqual(validate('summon minecraft:drache 1 2 3').length > 0, true)
  process.exit(r.bad.length ? 1 : 0)
}
