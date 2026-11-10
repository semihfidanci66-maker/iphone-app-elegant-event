'use strict'
/**
 * Anti-Pit-Intelligenz: 2-Sekunden-Stuck-Watchdog + menschlicher Pillar-Jump.
 */
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { sleep, TaskToken } = require('./actions')

const CARDINALS = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

class StuckWatchdog {
  constructor (ctx) {
    this.ctx = ctx
    this.bot = ctx.bot
    this.samples = []
    this.escaping = false
    this.strikes = 0
    this._pillarFails = 0
    this.lastEscape = 0
    this.timer = setInterval(() => this._sample(), 250)
  }

  dispose () { clearInterval(this.timer) }

  _sample () {
    const { bot, ctx } = this
    if (!bot.entity || this.escaping) return
    const now = Date.now()
    const wantsToMove = !!bot.pathfinder.goal && bot.pathfinder.isMoving() && !ctx.actions.locked && !bot.pathfinder.isMining() && !bot.pathfinder.isBuilding() && !bot.currentWindow
    if (!wantsToMove) { this.samples = []; return }
    this.samples.push({ t: now, x: bot.entity.position.x, z: bot.entity.position.z })
    while (this.samples.length && now - this.samples[0].t > 2000) this.samples.shift()
    if (this.samples.length < 7 || now - this.samples[0].t < 1700) return
    const a = this.samples[0]
    const dist = Math.hypot(bot.entity.position.x - a.x, bot.entity.position.z - a.z)
    // < 0.05 Blöcke/Tick über 2 s wäre 2 Blöcke; "steht" heißt hier: weniger als 0.1 Block Versatz in 2 s
    const speed = dist / ((now - a.t) / 50)
    if (speed < 0.05 && dist < 0.35) {
      this.samples = []
      this.escape('watchdog').catch(e => ctx.log('Escape-Fehler: ' + e.message))
    }
  }

  /** Tiefe des Lochs, in dem der Bot steht (0 = kein Loch, er kann seitlich weglaufen). */
  holeDepth () {
    const { bot, ctx } = this
    const a = ctx.actions
    const feet = ctx.actions.feet()
    const open = p => !a.isSolid(bot.blockAt(p)) && !a.isSolid(bot.blockAt(p.offset(0, 1, 0)))
    for (let up = 0; up <= 12; up++) {
      for (const c of CARDINALS) {
        const p = feet.offset(c.x, up, c.z)
        if (!open(p)) continue
        // auf Fußhöhe reicht ein freier Nachbar (auch Wasser/Kante); weiter oben braucht es Boden
        if (up === 0 || a.isSolid(bot.blockAt(p.offset(0, -1, 0)))) return up
      }
    }
    return 13
  }

  async escape (reason = 'manual') {
    const { bot, ctx } = this
    if (this.escaping || !bot.entity) return false
    this.escaping = true
    const now = Date.now()
    this.strikes = now - this.lastEscape < 20000 ? this.strikes + 1 : 1
    this.lastEscape = now
    const savedGoal = bot.pathfinder.goal
    try {
      // 1) Pathfinder sofort abbrechen (laufende Routine bekommt 'stuck' und plant neu)
      ctx.interrupt && ctx.interrupt('stuck')
      ctx.actions.stopMoving()
      await sleep(120)
      const depth = this.holeDepth()
      ctx.emit('stuck', { reason, depth, strikes: this.strikes })
      const token = new TaskToken('escape')

      if (depth > 1) {
        const ok = await this.pillarUp(depth, token)
        if (ok) return true
      } else if (depth === 1) {
        // 1 tief: einfach rausspringen
        if (await this.hopOut()) return true
      }
      if (this.strikes <= 2 && depth <= 1) {
        // Hängt an einer Kante/Mob: kurzer menschlicher Befreiungs-Wackler
        await this.wiggle()
        return true
      }
      // Notfall-Routine: jetzt (und nur jetzt) darf gegraben werden
      const p = bot.entity.position
      const up = this.surfaceTarget()
      await ctx.actions.goto(new goals.GoalNear(up.x, up.y, up.z, 1), { moves: ctx.actions.digMoves, timeout: 20000, token })
      return bot.entity.position.distanceTo(p) > 1.5
    } finally {
      this.escaping = false
      this.samples = []
      void savedGoal
    }
  }

  surfaceTarget () {
    const { bot, ctx } = this
    const p = ctx.actions.feet()
    for (let r = 2; r <= 6; r++) {
      for (const c of CARDINALS) {
        for (let dy = 6; dy >= -1; dy--) {
          const q = p.offset(c.x * r, dy, c.z * r)
          if (ctx.actions.isSolid(bot.blockAt(q.offset(0, -1, 0))) && !ctx.actions.isSolid(bot.blockAt(q)) && !ctx.actions.isSolid(bot.blockAt(q.offset(0, 1, 0)))) return q
        }
      }
    }
    return p.offset(0, 3, 0)
  }

  async hopOut () {
    const { bot, ctx } = this
    const feet = ctx.actions.feet()
    for (const c of CARDINALS) {
      const p = feet.offset(c.x, 1, c.z)
      if (ctx.actions.isSolid(bot.blockAt(p.offset(0, -1, 0))) && !ctx.actions.isSolid(bot.blockAt(p)) && !ctx.actions.isSolid(bot.blockAt(p.offset(0, 1, 0))) && !ctx.actions.isSolid(bot.blockAt(feet.offset(0, 2, 0)))) {
        await ctx.look.aim(p.offset(0.5, 1.2, 0.5), { profile: 'combat', timeout: 600 })
        bot.setControlState('forward', true)
        bot.setControlState('jump', true)
        await sleep(450)
        bot.clearControlStates()
        await sleep(150)
        if (bot.entity.position.y >= feet.y + 0.9) return true
      }
    }
    return false
  }

  async wiggle () {
    const { bot } = this
    const side = Math.random() < 0.5 ? 'left' : 'right'
    bot.setControlState('back', true)
    bot.setControlState(side, true)
    await sleep(280)
    bot.setControlState('jump', true)
    await sleep(260)
    bot.clearControlStates()
  }

  /**
   * Klassischer Pillar-Jump: senkrecht nach unten schauen, Slot 5 (Bau-Blöcke), springen und am
   * Scheitelpunkt einen Block unter die Füße setzen. Blätter/Erde über dem Kopf werden vorher entfernt.
   */
  async pillarUp (height, token = new TaskToken('pillar'), o = {}) {
    const { bot, ctx } = this
    const a = ctx.actions
    for (let i = 0; i < height; i++) {
      token.check()
      const block = a.findFirst(['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'oak_planks', 'spruce_planks', 'birch_planks', 'stone', 'andesite', 'diorite', 'granite', 'oak_log', 'sand', 'gravel'])
      if (!block) { ctx.log('Pillar-Jump: keine Bau-Blöcke'); return false }
      await a.waitOnGround(2000)
      const feet = ctx.actions.feet()
      // Kopffreiheit: zwei Blöcke über dem Kopf müssen frei sein
      for (const dy of [2, 3]) {
        const above = bot.blockAt(feet.offset(0, dy, 0))
        if (a.isSolid(above)) {
          const r = await a.dig(above, { token, profile: 'combat' })
          if (r !== 'ok' && r !== 'gone') return false
        }
      }
      // zentrieren, damit der Block unter den Füßen landet
      await this.centerOn(feet)
      await a.equip(block)
      await ctx.look.aimAngles(bot.entity.yaw, -Math.PI / 2, { profile: 'combat', tolerance: 3, timeout: 900 })
      const ref = bot.blockAt(feet.offset(0, -1, 0))
      if (!a.isSolid(ref)) return false
      const startY = bot.entity.position.y
      bot.setControlState('jump', true)
      let placed = false
      for (let t = 0; t < 14; t++) {
        await bot.waitForTicks(1)
        if (!placed && bot.entity.position.y >= startY + 1.02) {
          bot.setControlState('jump', false)
          ctx.emit('swing', { kind: 'place', block: block.name })
          try { await bot.placeBlock(ref, new Vec3(0, 1, 0)); placed = true } catch (_) {
            placed = a.isSolid(bot.blockAt(feet))
          }
          break
        }
      }
      bot.setControlState('jump', false)
      await a.waitOnGround(1500)
      if (!placed && bot.entity.position.y < startY + 0.9) {
        // Sprung blockiert – ein zweiter Versuch, dann aufgeben
        if (i > 0) i--
        if (++this._pillarFails > 3) { this._pillarFails = 0; return false }
        continue
      }
      this._pillarFails = 0
      // schon draußen?
      if (!o.force && this.holeDepth() === 0) break
    }
    if (o.force) return true
    // letzter Schritt vom Pfeiler auf festen Boden
    const out = this.surfaceTarget()
    await a.goto(new goals.GoalNear(out.x, out.y, out.z, 1), { timeout: 5000, token })
    return this.holeDepth() <= 1
  }

  async centerOn (cell) {
    const { bot, ctx } = this
    const cx = cell.x + 0.5
    const cz = cell.z + 0.5
    for (let i = 0; i < 12; i++) {
      const dx = cx - bot.entity.position.x
      const dz = cz - bot.entity.position.z
      if (Math.hypot(dx, dz) < 0.18) break
      ctx.look.track(new Vec3(cx, bot.entity.position.y + 1.62, cz), 'combat')
      bot.setControlState('forward', true)
      bot.setControlState('sneak', true)
      await bot.waitForTicks(1)
    }
    bot.setControlState('forward', false)
    bot.setControlState('sneak', false)
  }
}

module.exports = { StuckWatchdog, CARDINALS }
