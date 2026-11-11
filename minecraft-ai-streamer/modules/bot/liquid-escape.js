'use strict'
/**
 * 3-Stufen-Schutz gegen Wasser und Lava.
 *
 *  Stufe 1  Pathfinder meidet Flüssigkeiten (liquidCost = 1000, siehe actions.js)
 *  Stufe 2  Im Wasser/in Lava: Ziel abbrechen, oben schwimmen (Sprung + Sprint gehalten), nächstes
 *           trockenes Ufer im 12-Block-Radius ansteuern; hängt der Bot an einer steilen Kante,
 *           setzt er sich einen Block unter die Füße. Bei Lava/Feuer: Wassereimer + Essen.
 *  Stufe 3  Nach 4,0 s immer noch in der Flüssigkeit -> harte Rettung per Server-Befehl auf den
 *           nächsten trockenen Punkt (bzw. spreadplayers), dazu Feuerresistenz. Braucht OP.
 *
 * Kein eigener Timer: physicsTick (50 ms) hält nur die Tasten, der 250-ms-Loop prüft die 4 Sekunden.
 */
const { Vec3 } = require('vec3')

const HARD_MS = 4000

class LiquidEscape {
  constructor (ctx, ai) {
    this.ctx = ctx
    this.ai = ai
    this.bot = ctx.bot
    this.since = 0
    this.active = false
    this.lastHard = 0
    this.rescues = 0
    this.notified = false
    this._onTick = () => this.physicsTick()
    this.bot.on('physicsTick', this._onTick)
  }

  dispose () { this.bot.removeListener('physicsTick', this._onTick) }

  inLava () { return !!this.bot.entity.isInLava }
  inLiquid () { const e = this.bot.entity; return !!(e.isInWater || e.isInLava) }
  onFire () { const m = this.bot.entity.metadata; return !!(m && typeof m[0] === 'number' && (m[0] & 1)) }
  timeInLiquid () { return this.since ? Date.now() - this.since : 0 }

  physicsTick () {
    const bot = this.bot
    if (!bot.entity) return
    if (!this.inLiquid()) { this.since = 0; this.notified = false; return }
    if (!this.since) this.since = Date.now()
    // sofort: laufende Routine abbrechen, damit die Rettung drankommt
    if (!this.notified && !this.active) { this.notified = true; this.ctx.interrupt('liquid') }
    // oben bleiben, nie absinken (die Platzier-Sperre darf kurz übersteuern)
    if (!this.ctx.actions.locked) { bot.setControlState('jump', true); if (this.active) bot.setControlState('sprint', true) }
  }

  /** Aus dem zentralen 250-ms-Loop: Stufe 3 greift garantiert, auch wenn eine Routine hängt. */
  brainTick () {
    if (this.since && Date.now() - this.since >= HARD_MS && Date.now() - this.lastHard > 2500) this.hardRescue('timeout')
  }

  dry (pos) {
    const { bot, ctx } = this
    const a = ctx.actions
    const floor = bot.blockAt(pos.offset(0, -1, 0))
    const b0 = bot.blockAt(pos)
    const b1 = bot.blockAt(pos.offset(0, 1, 0))
    if (!floor || !a.isSolid(floor) || /magma|cactus|campfire|fire/.test(floor.name)) return false
    const free = b => b && !a.isSolid(b) && !a.isLiquid(b) && b.name !== 'fire'
    return free(b0) && free(b1)
  }

  /** Nächster trockener, fester Uferblock mit 2 Blöcken Luft darüber. Liefert die Stehposition. */
  findShore (radius = 12, flatOnly = false) {
    const { bot, ctx } = this
    const p = ctx.actions.feet()
    let best = null
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const hd = Math.hypot(dx, dz)
        if (hd > radius || hd < 1) continue
        for (let dy = 3; dy >= -3; dy--) {
          const q = p.offset(dx, dy, dz)
          if (!this.dry(q)) continue
          if (flatOnly && bot.blockAt(q.offset(0, 2, 0)) && ctx.actions.isSolid(bot.blockAt(q.offset(0, 2, 0)))) continue
          const score = hd + Math.abs(dy) * 1.5
          if (!best || score < best.score) best = { pos: q, score }
          break
        }
      }
    }
    return best ? best.pos : null
  }

  /** Stufe 2: aktiv ans Ufer schwimmen und herausklettern. */
  async escape (token) {
    const { bot, ctx } = this
    const a = ctx.actions
    if (this.active) return false
    this.active = true
    const lava = this.inLava()
    ctx.emit('liquid_escape', { lava })
    ctx.look.blockGlance('liquid', true)
    let blockedSince = 0
    let shore = this.findShore(12)
    let rescan = 0
    try {
      a.stopMoving()
      while (this.inLiquid()) {
        token.check()
        if (!bot.entity) return false
        if (++rescan % 12 === 0 || !shore) shore = this.findShore(12)
        if (shore) {
          ctx.look.track(shore.offset(0.5, 1.2, 0.5), 'panic')
          bot.setControlState('forward', true)
          bot.setControlState('sprint', true)
        }
        bot.setControlState('jump', true)
        if (bot.entity.isCollidedHorizontally) {
          if (!blockedSince) blockedSince = Date.now()
          // steile Kante: Block unter die Füße und heraussteigen
          if (Date.now() - blockedSince > 500) {
            const filler = a.findFirst(['cobblestone', 'dirt', 'cobbled_deepslate', 'oak_planks', 'spruce_planks', 'birch_planks', 'netherrack', 'stone', 'sand', 'gravel'])
            if (filler) {
              const under = a.feet().offset(0, -1, 0)
              bot.setControlState('forward', false)
              await a.placeAt(under, filler.name, { token, sneak: false, midAir: true, profile: 'panic' })
            }
            blockedSince = 0
          }
        } else blockedSince = 0
        await bot.waitForTicks(1)
      }
      // an Land: zwei Schritte weg vom Rand
      if (shore) { ctx.look.track(shore.offset(0.5, 1.2, 0.5), 'panic'); bot.setControlState('forward', true); await bot.waitForTicks(8) }
      return true
    } finally {
      this.active = false
      ctx.look.blockGlance('liquid', false)
      for (const k of ['forward', 'sprint', 'jump']) bot.setControlState(k, false)
      if (!(token && token.cancelled)) await this.afterCare(lava, token).catch(e => { if (e.isInterrupt) throw e })
    }
  }

  /** Nach Lava/Feuer: mit dem Wassereimer löschen und essen. */
  async afterCare (wasLava, token) {
    const { bot, ctx } = this
    const a = ctx.actions
    if ((wasLava || this.onFire()) && !this.inLiquid()) {
      if (this.onFire() && a.find('water_bucket') && !/nether/.test(bot.game.dimension || '')) {
        const feet = a.feet()
        await ctx.mining.useBucket('water_bucket', feet.offset(0.5, 0, 0.5), token)
        await bot.waitForTicks(16)
        await ctx.mining.useBucket('bucket', feet.offset(0.5, 0.2, 0.5), token)
      }
      if (bot.health < 16) { const item = await ctx.combat.eat(token); if (item) ctx.emit('ate', { item, health: bot.health, underPressure: true }) }
    }
  }

  /**
   * Stufe 3 / Sofort-Rettung: setzt den Bot auf den nächsten trockenen, ebenen Punkt.
   * @returns {boolean} true, wenn ein Rettungsbefehl abgesetzt wurde
   */
  hardRescue (reason = 'manual') {
    const { bot, ctx, ai } = this
    if (!bot.entity) return false
    this.lastHard = Date.now()
    this.rescues++
    const name = bot.username
    const spot = this.findShore(8, true) || this.findShore(12)
    const cmds = []
    if (spot && reason !== 'surface') cmds.push(`tp ${name} ${spot.x + 0.5} ${spot.y} ${spot.z + 0.5}`)
    else cmds.push(`execute at ${name} run spreadplayers ~ ~ 3 10 false ${name}`)
    cmds.push(`effect give ${name} minecraft:fire_resistance 10 0 true`)
    ai.runCommands(cmds)
    try { bot.pathfinder.setGoal(null) } catch (_) {}
    bot.clearControlStates()
    this.since = 0
    ctx.interrupt('rescue')
    ctx.emit('liquid_rescue', { reason, lava: this.inLava(), to: spot ? { x: spot.x, y: spot.y, z: spot.z } : null })
    return true
  }
}

module.exports = { LiquidEscape, HARD_MS }
