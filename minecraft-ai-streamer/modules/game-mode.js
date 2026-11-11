'use strict'
/**
 * game-mode.js – übergeordneter Umschalter zwischen SURVIVAL (bisherige Logik) und ARENA.
 *
 * Der Survival-Code bleibt unangetastet: Im Arena-Modus pausiert seine Hauptschleife nur
 * (mc-ai-bot.js fragt `gameMode` ab), und der Arena-Controller übernimmt. Beim Zurückschalten
 * wird der Bot an seinen alten Platz gesetzt, Regeln und überschriebene Ausrüstung kommen zurück.
 */
const { ArenaBuilder } = require('./arena/arena-builder')
const { ArenaController } = require('./arena/arena-controller')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// Diese Plätze überschreibt die Arena (Schwert, Goldäpfel, Rüstung) – ihr Survival-Inhalt wird gemerkt
const SAVED_SLOTS = [[36, 'hotbar.0'], [37, 'hotbar.1'], [5, 'armor.head'], [6, 'armor.chest'], [7, 'armor.legs'], [8, 'armor.feet']]

class GameModeManager {
  /**
   * @param {object} host MinecraftAIBot
   * @param {{run: (cmds: string[]) => boolean, emit: (type: string, data: object) => void, saved?: object, onChange?: () => void, restoreRules?: () => string[]}} deps
   */
  constructor (host, deps) {
    this.host = host
    this.run = deps.run
    this.emit = deps.emit
    this.onChange = deps.onChange || (() => {})
    this.restoreRules = deps.restoreRules || (() => [])
    this.mode = 'SURVIVAL'
    this.busy = false
    this.center = deps.saved && deps.saved.center ? deps.saved.center : null
    this.builtOnce = !!(deps.saved && deps.saved.built)
    this.survival = null // { pos, slots } – wohin und womit es nach der Arena zurückgeht
    this.builder = new ArenaBuilder({ center: this.center, run: this.run, botName: () => (host.bot ? host.bot.username : host.config.username) })
    this.arena = new ArenaController(host, this.builder, { run: this.run, emit: this.emit })
    host.gameMode = 'SURVIVAL'
  }

  toJSON () { return { center: this.center, built: this.builtOnce } }

  /** Standort der Arena: einmal festgelegt, 400 Blöcke neben dem Bot hoch in der Luft – weit weg vom Survival-Gelände. */
  ensureCenter () {
    if (this.center) return this.center
    const bot = this.host.bot
    if (!bot || !bot.entity) return null
    const p = bot.entity.position
    this.center = { x: Math.floor(p.x) + 400, y: 180, z: Math.floor(p.z) }
    this.builder.setCenter(this.center)
    this.onChange()
    return this.center
  }

  /** Arena bauen oder neu aufbauen. Der Bot wird dafür hingesetzt, damit die Chunks geladen sind. */
  async build () {
    if (this.busy) return { ok: false, reason: 'beschäftigt' }
    const bot = this.host.bot
    if (!bot || !bot.entity) return { ok: false, reason: 'Bot ist nicht in der Welt' }
    this.busy = true
    try {
      if (!this.ensureCenter()) return { ok: false, reason: 'kein Standort' }
      this.builder.setCenter(this.center)
      const c = this.builder.getWaypoints().center
      const wasArena = this.mode === 'ARENA'
      if (!wasArena) { this.rememberSurvival(); this.host.gameMode = 'ARENA'; this.host.interrupt('arena') } // Survival wartet, solange gebaut wird
      this.emit('arena_build', { center: this.center })
      // Plattform unter die Füße, hinsetzen, Chunks laden lassen, dann bauen
      const { x: cx, y: cy, z: cz } = this.center
      this.run([`forceload add ${cx - 28} ${cz - 28} ${cx + 28} ${cz + 28}`, `fill ${cx - 1} ${cy - 1} ${cz - 1} ${cx + 1} ${cy - 1} ${cz + 1} polished_blackstone_bricks`, `tp ${bot.username} ${c.x} ${c.y + 1} ${c.z}`, `effect give ${bot.username} minecraft:slow_falling 15 0 true`])
      await sleep(3500)
      const n = await this.builder.build()
      this.builtOnce = true
      this.onChange()
      this.run([`tp ${bot.username} ${c.x} ${c.y} ${c.z}`])
      this.builder.startAnimations()
      this.arena.lastBoard = ''
      this.arena.syncBoard()
      this.emit('arena_built', { commands: n })
      if (!wasArena && this.mode !== 'ARENA') { await sleep(1500); this.returnToSurvival(); await sleep(600) }
      return { ok: true, commands: n }
    } finally {
      this.busy = false
      if (this.mode !== 'ARENA') this.host.gameMode = 'SURVIVAL'
    }
  }

  rememberSurvival () {
    const bot = this.host.bot
    if (!bot || !bot.entity) return
    const p = bot.entity.position
    const slots = SAVED_SLOTS.map(([i, name]) => { const it = bot.inventory.slots[i]; return { name, item: it ? it.name : null, count: it ? it.count : 0 } })
    this.survival = { pos: { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 }, dimension: bot.game.dimension, slots }
  }

  returnToSurvival () {
    const bot = this.host.bot
    const s = this.survival
    if (!bot || !s) return
    const cmds = []
    // Ausrüstung zurück (Art und Menge; Verzauberungen und Abnutzung dieser sechs Plätze gehen verloren)
    for (const sl of s.slots) cmds.push(sl.item ? `item replace entity ${bot.username} ${sl.name} with ${sl.item} ${sl.count}` : `item replace entity ${bot.username} ${sl.name} with air`)
    cmds.push(`tp ${bot.username} ${s.pos.x} ${s.pos.y} ${s.pos.z}`)
    this.run(cmds)
    this.survival = null
  }

  /**
   * Modus wechseln – jederzeit im laufenden Betrieb.
   * @param {'SURVIVAL'|'ARENA'} mode
   */
  async setMode (mode) {
    if (mode !== 'SURVIVAL' && mode !== 'ARENA') return { ok: false, reason: 'unbekannter Modus' }
    if (mode === this.mode) return { ok: true, mode }
    if (this.busy) return { ok: false, reason: 'beschäftigt' }
    const host = this.host
    const bot = host.bot
    if (mode === 'ARENA') {
      if (!bot || !bot.entity) return { ok: false, reason: 'Bot ist nicht in der Welt' }
      // Survival anhalten: laufende Aktion abbrechen, die Hauptschleife wartet ab jetzt
      this.rememberSurvival()
      host.gameMode = 'ARENA'
      host.interrupt('arena')
      this.mode = 'ARENA'
      if (!this.builtOnce) { const r = await this.build(); if (!r.ok) { this.mode = 'SURVIVAL'; host.gameMode = 'SURVIVAL'; return r } }
      this.builder.setCenter(this.center)
      this.run(this.builder.enterCommands())
      await sleep(1200)
      this.arena.reset()
      this.arena.equip()
      this.builder.built = true
      this.builder.startAnimations()
      this.arena.lastBoard = ''
      this.arena.syncBoard()
      this.arena.start()
      this.emit('arena_enter', {})
    } else {
      this.arena.stop()
      this.builder.stopAnimations()
      this.run([...this.builder.leaveCommands(), ...this.restoreRules()])
      this.mode = 'SURVIVAL'
      this.returnToSurvival()
      await sleep(800)
      host.gameMode = 'SURVIVAL'
      this.emit('arena_exit', { kills: this.arena.kills, level: this.arena.level })
    }
    this.onChange()
    return { ok: true, mode: this.mode }
  }

  /** Bot hat die Verbindung verloren: Arena-Loop stoppen, der Modus bleibt gemerkt. */
  onBotGone () { this.arena.stop(); this.builder.stopAnimations() }

  /** Bot ist (wieder) in der Welt und der Modus steht auf ARENA: Loop wieder anwerfen. */
  onBotBack () {
    if (this.mode !== 'ARENA' || !this.center) return
    this.host.gameMode = 'ARENA'
    this.builder.setCenter(this.center)
    setTimeout(() => {
      if (this.mode !== 'ARENA' || !this.host.bot) return
      this.run(this.builder.enterCommands())
      this.arena.equip()
      this.builder.startAnimations()
      this.arena.start()
    }, 2500)
  }

  status () {
    return { mode: this.mode, busy: this.busy, built: this.builtOnce, center: this.center, ...(this.mode === 'ARENA' ? this.arena.status() : { state: null, top: this.arena.top(5) }) }
  }
}

module.exports = { GameModeManager }
