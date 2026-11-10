'use strict'
/**
 * Pro-Player-PvP: 1.9+-Cooldown-Rhythmus, Spacing, Circle-Strafe, W-Tap, Jump-Crits,
 * reaktives Schild, Crowd-Funneling und Essen unter Druck.
 */
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { sleep, rand, Interrupt } = require('./actions')
const { FOOD_PRIORITY } = require('./hotbar')

const NEUTRAL = new Set(['enderman', 'zombified_piglin', 'piglin', 'iron_golem', 'wolf', 'bee', 'llama', 'trader_llama', 'polar_bear', 'panda', 'dolphin', 'goat', 'snow_golem', 'axolotl', 'villager', 'wandering_trader'])
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'blaze', 'ghast', 'witch', 'drowned', 'shulker', 'breeze'])
const BOSSES = new Set(['warden', 'ravager', 'wither', 'ender_dragon', 'elder_guardian', 'iron_golem', 'piglin_brute', 'wither_skeleton'])
const PASSIVE_FOOD = new Set(['cow', 'pig', 'sheep', 'chicken', 'mooshroom', 'rabbit'])

function cooldownFor (item) {
  if (!item) return 250
  const n = item.name
  if (n.endsWith('_sword')) return 625
  if (n.endsWith('_axe')) return /^(wooden|stone)_/.test(n) ? 1250 : /^iron_/.test(n) ? 1112 : 1000
  if (n.endsWith('_pickaxe')) return 834
  if (n.endsWith('_shovel')) return 1000
  if (n === 'trident') return 910
  if (n === 'mace') return 1667
  return 250
}

class CombatSystem {
  constructor (ctx) {
    this.ctx = ctx
    this.bot = ctx.bot
    this.engaged = false
    this.lastSwingAt = 0
    this.lastHitAt = 0
    this.strafeDir = Math.random() < 0.5 ? 'left' : 'right'
    this.strafeUntil = 0
    this.wtapUntil = 0
    this.blocking = null
    this.critPrep = false
    this.aggro = new Map() // entityId -> Zeitpunkt (neutrale Mobs, die uns angegriffen haben)
    this.drawing = new Map() // Skelett-Id -> seit wann wird der Bogen gespannt
    this.recentTargets = new Map() // id -> { name, donor, at }
    this.lastFunnelAt = 0
    this.lastRetreatAt = 0
    this.pathing = false
    this.giftMobs = new Set() // Entity-Ids, die per Gift gespawnt wurden
    this.friendly = new Set()
    this.ignoreUntil = new Map() // unerreichbare Gegner werden kurzzeitig ignoriert (kein Deadlock)
    this.kills = 0

    const hostile = new Set()
    for (const e of ctx.mcData.entitiesArray) if (e.type === 'hostile' && !NEUTRAL.has(e.name)) hostile.add(e.name)
    for (const n of ['phantom', 'slime', 'magma_cube', 'ghast', 'hoglin', 'zoglin', 'shulker', 'warden', 'ravager', 'vex', 'evoker', 'vindicator', 'pillager', 'piglin_brute', 'wither_skeleton', 'blaze', 'breeze', 'bogged']) hostile.add(n)
    this.hostile = hostile

    const bot = this.bot
    bot.on('entityHurt', (e) => {
      if (e !== bot.entity) return
      ctx.emit('hurt', { health: bot.health })
      // wer steht direkt neben uns? -> neutrale Mobs werden zum Ziel
      for (const o of Object.values(bot.entities)) {
        if (o === bot.entity || !o.position || !NEUTRAL.has(o.name)) continue
        if (o.position.distanceTo(bot.entity.position) < 4.5 && !this.friendly.has(o.id)) this.aggro.set(o.id, Date.now())
      }
    })
    bot.on('entityGone', (e) => this._onGone(e))
    bot.on('entityDead', (e) => this._onGone(e, true))
  }

  _onGone (e, dead) {
    const rec = this.recentTargets.get(e.id)
    this.aggro.delete(e.id)
    this.drawing.delete(e.id)
    this.giftMobs.delete(e.id)
    if (!rec) return
    this.recentTargets.delete(e.id)
    if (Date.now() - rec.at < 4000 || dead) {
      this.kills++
      this.ctx.emit('kill', { mob: rec.name, donor: rec.donor, kills: this.kills })
    }
  }

  donorOf (e) {
    try {
      const n = e.getCustomName && e.getCustomName()
      if (!n) return null
      const m = /@([^\s"]+)/.exec(n.toString())
      return m ? m[1] : null
    } catch (_) { return null }
  }

  isFriendly (e) {
    if (this.friendly.has(e.id)) return true
    if (e.name === 'iron_golem' || e.name === 'wolf') return !this.aggro.has(e.id)
    return false
  }

  isThreat (e) {
    const bot = this.bot
    if (!e || e === bot.entity || !e.position || !e.name) return false
    if (e.type === 'player' || e.name === 'item' || e.name === 'experience_orb') return false
    if (this.isFriendly(e)) return false
    if ((this.ignoreUntil.get(e.id) || 0) > Date.now()) return false
    if (this.aggro.has(e.id)) return Date.now() - this.aggro.get(e.id) < 30000
    if (e.name === 'piglin') {
      const gold = [5, 6, 7, 8].some(s => bot.inventory.slots[s] && /^golden_/.test(bot.inventory.slots[s].name))
      if (gold) return false
    }
    if (!this.hostile.has(e.name)) return false
    return true
  }

  /** Alle akuten Bedrohungen, sortiert nach Dringlichkeit. */
  scan (radius = 16) {
    const bot = this.bot
    const me = bot.entity.position
    const out = []
    for (const e of Object.values(bot.entities)) {
      if (!this.isThreat(e)) continue
      const d = e.position.distanceTo(me)
      const gift = this.giftMobs.has(e.id) || !!this.donorOf(e)
      if (d > (gift ? 40 : radius)) continue
      if (Math.abs(e.position.y - me.y) > 10 && !gift) continue
      // Mobs hinter Wänden in >6 Blöcken ignoriert ein Mensch (er sieht sie nicht)
      if (!gift && d > 6 && !this.hasLineOfSight(e)) continue
      out.push({ e, d, gift })
    }
    out.sort((a, b) => a.d - b.d)
    return out
  }

  hasThreat () { return this.scan().length > 0 }

  hasLineOfSight (e) {
    const bot = this.bot
    const from = bot.entity.position.offset(0, 1.62, 0)
    const to = e.position.offset(0, (e.height || 1.8) * 0.7, 0)
    const dir = to.minus(from)
    const len = dir.norm()
    if (len < 0.01) return true
    const step = dir.scaled(1 / len)
    for (let t = 0.6; t < len; t += 0.6) {
      const b = bot.blockAt(from.plus(step.scaled(t)))
      if (b && b.boundingBox === 'block' && !b.transparent) return false
    }
    return true
  }

  /** Abstand Auge -> nächster Punkt der Hitbox (echte Minecraft-Reichweite). */
  reachDistance (e) {
    const eye = this.bot.entity.position.offset(0, 1.62, 0)
    const w = (e.width || 0.6) / 2
    const h = e.height || 1.8
    const cx = Math.max(e.position.x - w, Math.min(eye.x, e.position.x + w))
    const cy = Math.max(e.position.y, Math.min(eye.y, e.position.y + h))
    const cz = Math.max(e.position.z - w, Math.min(eye.z, e.position.z + w))
    return eye.distanceTo(new Vec3(cx, cy, cz))
  }

  aimPoint (e) { return e.position.offset(0, (e.height || 1.8) * 0.62, 0) }

  weapon () {
    const a = this.ctx.actions
    return a.bestTool('sword') || a.bestTool('axe') || a.bestTool('pickaxe') || null
  }

  hasShield () { const o = this.bot.inventory.slots[45]; return !!o && o.name === 'shield' }

  // ---------------------------------------------------------------- Boden-/Kanten-Sicherheit
  safeToStep (dx, dz, dist = 0.9) {
    const bot = this.bot
    const p = bot.entity.position
    for (const k of [dist, dist * 1.9]) {
      const x = p.x + dx * k
      const z = p.z + dz * k
      let ground = false
      for (let dy = 0; dy >= -3; dy--) {
        const b = bot.blockAt(new Vec3(x, Math.floor(p.y) + dy - 1, z).floored())
        if (!b) return false
        if (b.name === 'lava' || b.name === 'fire' || b.name === 'magma_block' || b.name === 'cactus' || b.name === 'sweet_berry_bush') return false
        if (b.boundingBox === 'block') { ground = true; break }
      }
      if (!ground) return false
      const feet = bot.blockAt(new Vec3(x, Math.floor(p.y), z).floored())
      if (feet && (feet.name === 'lava' || feet.name === 'fire')) return false
    }
    return true
  }

  dirVectors () {
    const yaw = this.bot.entity.yaw
    const f = { x: -Math.sin(yaw), z: -Math.cos(yaw) }
    const l = { x: -Math.cos(yaw), z: Math.sin(yaw) }
    return { forward: f, back: { x: -f.x, z: -f.z }, left: l, right: { x: -l.x, z: -l.z } }
  }

  setKeys (want) {
    const bot = this.bot
    const dirs = this.dirVectors()
    for (const k of ['forward', 'back', 'left', 'right']) {
      let on = !!want[k]
      if (on && !this.safeToStep(dirs[k].x, dirs[k].z)) on = false
      bot.setControlState(k, on)
    }
    bot.setControlState('sprint', !!want.sprint && bot.getControlState('forward'))
    bot.setControlState('jump', !!want.jump)
  }

  releaseKeys () {
    const bot = this.bot
    for (const k of ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'sneak']) bot.setControlState(k, false)
  }

  stopPathing () {
    if (!this.pathing) return
    this.pathing = false
    try { this.bot.pathfinder.setGoal(null) } catch (_) {}
  }

  // ---------------------------------------------------------------- Schild
  shieldThreat (threats) {
    const now = Date.now()
    for (const { e, d } of threats) {
      const md = e.metadata || []
      if (e.name === 'creeper' && d <= 4.5 && (md[16] === 1 || md[18] === true)) return { e, kind: 'creeper', until: now + 1800 }
      if (RANGED.has(e.name) && e.name !== 'blaze' && e.name !== 'witch') {
        const handActive = typeof md[8] === 'number' && (md[8] & 1) === 1
        if (handActive) {
          if (!this.drawing.has(e.id)) this.drawing.set(e.id, now)
          if (now - this.drawing.get(e.id) > 800 && d > 3.4 && d < 20 && this.hasLineOfSight(e)) return { e, kind: 'arrow', until: now + 900 }
        } else this.drawing.delete(e.id)
      }
      if (e.name === 'blaze' && typeof md[16] === 'number' && (md[16] & 1) === 1 && d < 24) return { e, kind: 'fireball', until: now + 1800 }
      if (e.name === 'ghast' && md[16] === true && d < 40) return { e, kind: 'fireball', until: now + 1200 }
    }
    return null
  }

  raiseShield (t) {
    if (this.blocking && this.blocking.e === t.e) { this.blocking.until = Math.max(this.blocking.until, t.until); return }
    this.blocking = { ...t, since: Date.now() }
    this.releaseKeys()
    this.bot.activateItem(true)
    this.ctx.emit('shield', { kind: t.kind, mob: t.e.name })
  }

  lowerShield () {
    if (!this.blocking) return
    this.blocking = null
    try { this.bot.deactivateItem() } catch (_) {}
  }

  // ---------------------------------------------------------------- Hauptschleife
  async fight (token) {
    const { bot, ctx } = this
    if (this.engaged) return
    this.engaged = true
    ctx.look.blockGlance('combat', true)
    ctx.look.setProfile('combat', 60000)
    let clearSince = 0
    let announced = false
    const fightStart = Date.now()
    const center = bot.entity.position.clone()
    try {
      if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow) } catch (_) {} }
      while (true) {
        token.check()
        if (!bot.entity || bot.health <= 0) break
        const threats = this.scan()
        if (!threats.length) {
          if (!clearSince) clearSince = Date.now()
          this.lowerShield(); this.stopPathing(); this.releaseKeys()
          if (Date.now() - clearSince > 1400) break
          await bot.waitForTicks(2)
          continue
        }
        clearSince = 0
        // 20 s kein einziger Treffer: Gegner ist unerreichbar (fliegt/hinter Wand) -> vorerst ignorieren
        if (Date.now() - Math.max(fightStart, this.lastHitAt) > 20000) {
          for (const t of threats) if (this.reachDistance(t.e) > 4) this.ignoreUntil.set(t.e.id, Date.now() + 25000)
          if (threats.every(t => this.ignoreUntil.has(t.e.id))) ctx.emit('combat_unreachable', { mobs: threats.map(t => t.e.name) })
        }
        if (!announced) {
          announced = true
          ctx.emit('combat_start', { count: threats.length, mobs: threats.slice(0, 5).map(t => t.e.name), donor: this.donorOf(threats[0].e) })
        }
        await this.tick(threats, token)
        await bot.waitForTicks(1)
      }
    } finally {
      this.lowerShield()
      this.stopPathing()
      this.releaseKeys()
      this.critPrep = false
      this.engaged = false
      ctx.look.blockGlance('combat', false)
      ctx.look.setProfile('walk')
    }
    ctx.emit('combat_end', { kills: this.kills, health: bot.health })
    // Loot einsammeln wie jeder Spieler nach dem Kampf
    try { await ctx.actions.collectDrops(center, 7, { token, timeout: 6000 }) } catch (e) { if (e.isInterrupt) throw e }
  }

  async tick (threats, token) {
    const { bot, ctx } = this
    const now = Date.now()
    const near = threats.filter(t => t.d <= 5)

    // 1) Leben retten: <= 12 HP -> Abstand gewinnen und essen
    if (bot.health <= 12 && now - this.lastRetreatAt > 9000 && this.edible()) {
      this.lastRetreatAt = now
      await this.retreatAndEat(threats, token)
      return
    }
    // 2) Umzingelt (>= 4 Mobs): 5 Blöcke zurücksprinten und die Meute in eine Linie ziehen
    if (near.length >= 4 && now - this.lastFunnelAt > 6000) {
      this.lastFunnelAt = now
      await this.funnel(near, token)
      return
    }
    // 3) Reaktives Schild
    if (this.hasShield()) {
      const st = this.shieldThreat(threats)
      if (st) this.raiseShield(st)
    } else {
      const creeper = threats.find(t => t.e.name === 'creeper' && t.d <= 4.5 && ((t.e.metadata || [])[16] === 1))
      if (creeper) { await this.backOff([creeper], 1500, token); return }
    }
    if (this.blocking) {
      const b = this.blocking
      const gone = !bot.entities[b.e.id]
      const md = b.e.metadata || []
      const stillDanger = b.kind === 'creeper' ? md[16] === 1 : b.kind === 'arrow' ? (typeof md[8] === 'number' && (md[8] & 1) === 1) : now < b.until
      if (gone || now > b.until + 600 || (!stillDanger && now - b.since > 350)) {
        this.lowerShield() // Schild runter und sofort kontern
      } else {
        ctx.look.track(this.aimPoint(b.e), 'combat')
        return
      }
    }

    // 4) Ziel wählen: gezündete Creeper/Fernkämpfer in Reichweite zuerst, sonst der Nächste
    let target = threats[0].e
    const reachable = threats.find(t => this.reachDistance(t.e) <= 3.1)
    if (reachable) target = reachable.e
    const tDist = target.position.distanceTo(bot.entity.position)
    const reach = this.reachDistance(target)
    this.recentTargets.set(target.id, { name: target.name, donor: this.donorOf(target), at: this.recentTargets.get(target.id)?.at || 0 })

    // 5) Waffe (Slot 1)
    const weapon = this.weapon()
    if (weapon && (!bot.heldItem || bot.heldItem.slot !== weapon.slot)) await ctx.actions.equip(weapon)
    const cd = cooldownFor(bot.heldItem)
    const ready = now - this.lastSwingAt >= cd
    const readyIn = Math.max(0, cd - (now - this.lastSwingAt))

    // 6) Annäherung über Distanz/Höhenunterschied: Pathfinder (ohne Graben!)
    const dy = target.position.y - bot.entity.position.y
    if (tDist > 6 || Math.abs(dy) > 2.2 || (tDist > 3.5 && !this.hasLineOfSight(target))) {
      if (!this.pathing) {
        this.pathing = true
        this.releaseKeys()
        bot.pathfinder.setMovements(ctx.actions.walkMoves)
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
      }
      return
    }
    this.stopPathing()

    // 7) Zielen
    ctx.look.track(this.aimPoint(target), 'combat')
    const aimErr = ctx.look.errorTo(this.aimPoint(target))

    // 8) Spacing, Circle-Strafe, W-Tap
    const want = {}
    const melee = !RANGED.has(target.name) || tDist < 6
    if (reach > 3.05) { want.forward = true; want.sprint = reach > 3.6 && !this.critPrep } else if (reach < 2.7 && melee && target.name !== 'creeper') want.back = true
    if (target.name === 'creeper' && reach < 2.9) want.back = true
    if (now > this.strafeUntil) {
      this.strafeDir = this.strafeDir === 'left' ? 'right' : 'left'
      this.strafeUntil = now + rand(500, 900)
    }
    if (tDist < 6.5) want[this.strafeDir] = true
    if (now < this.wtapUntil) { want.forward = false; want.sprint = false }
    // 1-Block-Stufen hochspringen statt hängen zu bleiben
    if (want.forward && bot.entity.isCollidedHorizontally && bot.entity.onGround) want.jump = true

    // 9) Angriffs-Rhythmus
    const critMode = (near.length <= 1 || BOSSES.has(target.name)) && target.name !== 'creeper'
    const inReach = reach <= 3.0 && aimErr < 0.42
    const vy = bot.entity.velocity.y
    if (critMode) {
      // Timed Jump-Crit: abspringen, kurz bevor der Cooldown voll ist, Schlag strikt in der Fallphase
      if (bot.entity.onGround && readyIn <= 330 && reach <= 3.5 && !this.critPrep) {
        this.critPrep = true
        want.jump = true
        want.sprint = false
      } else if (this.critPrep) {
        want.sprint = false
        if (!bot.entity.onGround && vy < -0.08 && ready && inReach) {
          this.strike(target, true)
          this.critPrep = false
        } else if (bot.entity.onGround && vy <= 0 && now - this.lastSwingAt > cd + 450) {
          // Sprung verpasst (Decke/Knockback) – normal zuschlagen statt den Cooldown zu verschenken
          if (ready && inReach) this.strike(target, false)
          this.critPrep = false
        }
      } else if (ready && inReach && !bot.entity.onGround && vy < -0.08) {
        this.strike(target, true)
      }
    } else if (ready && inReach) {
      // Gruppenkampf: voller Cooldown = 100 % Schaden + Sweep (am Boden, ohne Sprint)
      if (bot.entity.onGround) want.sprint = false
      this.strike(target, false)
    }
    this.setKeys(want)
  }

  strike (target, crit) {
    const { bot, ctx } = this
    const sprinting = bot.getControlState('sprint')
    bot.attack(target)
    const now = Date.now()
    this.lastSwingAt = now
    this.lastHitAt = now
    const rec = this.recentTargets.get(target.id)
    if (rec) rec.at = now
    // W-Tap: Sprint beim Treffer kurz loslassen -> nächster Treffer hat wieder vollen Sprint-Knockback
    if (sprinting || !crit) this.wtapUntil = now + 110
    ctx.emit('swing', { kind: 'attack', crit, mob: target.name })
  }

  // ---------------------------------------------------------------- Taktische Manöver
  centroid (threats) {
    const c = new Vec3(0, 0, 0)
    for (const t of threats) c.add(t.e.position)
    return c.scaled(1 / threats.length)
  }

  /** Sichere Fluchtrichtung weg vom Schwerpunkt der Gegner. */
  escapeVector (threats) {
    const me = this.bot.entity.position
    const c = this.centroid(threats)
    let base = Math.atan2(me.z - c.z, me.x - c.x)
    if (!Number.isFinite(base)) base = Math.random() * Math.PI * 2
    for (const off of [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6, 2.4, -2.4]) {
      const a = base + off
      const dx = Math.cos(a)
      const dz = Math.sin(a)
      if (this.safeToStep(dx, dz, 1.2) && this.safeToStep(dx, dz, 2.6)) return { dx, dz }
    }
    return null
  }

  async backOff (threats, ms, token) {
    const { bot, ctx } = this
    this.lowerShield(); this.stopPathing(); this.critPrep = false
    const v = this.escapeVector(threats)
    if (!v) return false
    const end = Date.now() + ms
    while (Date.now() < end) {
      token.check()
      const p = bot.entity.position
      ctx.look.track(new Vec3(p.x + v.dx * 6, p.y + 1.6, p.z + v.dz * 6), 'panic')
      const facingAway = Math.abs(ctx.look.errorTo(new Vec3(p.x + v.dx * 6, p.y + 1.6, p.z + v.dz * 6))) < 0.7
      const safe = this.safeToStep(v.dx, v.dz)
      bot.setControlState('forward', facingAway && safe)
      bot.setControlState('sprint', facingAway && safe)
      bot.setControlState('jump', facingAway && safe && bot.entity.onGround && (bot.entity.isCollidedHorizontally || bot.food > 6))
      for (const k of ['back', 'left', 'right']) bot.setControlState(k, false)
      if (!safe) { const nv = this.escapeVector(threats); if (!nv) break; v.dx = nv.dx; v.dz = nv.dz }
      await bot.waitForTicks(1)
    }
    this.releaseKeys()
    return true
  }

  /** Crowd-Funneling: 5 Blöcke zurück, damit die Mobs in einer Linie nachkommen. */
  async funnel (near, token) {
    const { bot, ctx } = this
    ctx.emit('kite', { count: near.length })
    const start = bot.entity.position.clone()
    const end = Date.now() + 1600
    const v = this.escapeVector(near)
    if (!v) return
    this.lowerShield(); this.stopPathing(); this.critPrep = false
    while (Date.now() < end && bot.entity.position.distanceTo(start) < 5) {
      token.check()
      const p = bot.entity.position
      const away = new Vec3(p.x + v.dx * 6, p.y + 1.6, p.z + v.dz * 6)
      ctx.look.track(away, 'panic')
      const ok = Math.abs(ctx.look.errorTo(away)) < 0.8 && this.safeToStep(v.dx, v.dz)
      bot.setControlState('forward', ok)
      bot.setControlState('sprint', ok)
      bot.setControlState('jump', ok && bot.entity.onGround && bot.entity.isCollidedHorizontally)
      await bot.waitForTicks(1)
    }
    this.releaseKeys()
    // umdrehen – die Meute kommt jetzt aus einer Richtung
    const c = this.centroid(near)
    await ctx.look.aim(c.offset(0, 1.2, 0), { profile: 'combat', timeout: 500, tolerance: 8 })
  }

  edible () {
    const { bot, ctx } = this
    const apple = ctx.actions.findFirst(['enchanted_golden_apple', 'golden_apple'])
    if (apple) return apple
    if (bot.food >= 20) return null
    return ctx.actions.findFirst(FOOD_PRIORITY)
  }

  /** 180°-Drehung, 3 s Sprint-Jump-Flucht, Slot 6 essen, zurück in den Kampf. */
  async retreatAndEat (threats, token) {
    const { bot, ctx } = this
    ctx.emit('low_hp', { health: bot.health, count: threats.length })
    if (threats.length) await this.backOff(threats, 3000, token)
    const ate = await this.eat(token)
    if (ate) ctx.emit('ate', { item: ate, health: bot.health, underPressure: true })
  }

  async eat (token) {
    const { bot, ctx } = this
    const food = this.edible()
    if (!food) return null
    this.lowerShield()
    this.releaseKeys()
    await ctx.actions.equip(food)
    try {
      await Promise.race([bot.consume(), sleep(3200).then(() => { throw new Error('consume timeout') })])
    } catch (e) {
      if (token && token.cancelled) throw new Interrupt(token.reason)
      try { bot.deactivateItem() } catch (_) {}
      return null
    }
    return food.name
  }

  // ---------------------------------------------------------------- Jagd / Duell (auch für Tiere)
  /**
   * Verfolgt ein einzelnes Ziel und erlegt es mit getimten Jump-Crits.
   * @returns {Promise<boolean>} true, wenn das Ziel besiegt wurde
   */
  async duel (target, token, o = {}) {
    const { bot, ctx } = this
    const end = Date.now() + (o.maxMs ?? 25000)
    ctx.look.blockGlance('duel', true)
    let jumped = false
    try {
      const weapon = this.weapon()
      if (weapon) await ctx.actions.equip(weapon)
      while (Date.now() < end) {
        token.check()
        if (!bot.entities[target.id] || !target.position) return true
        const tDist = target.position.distanceTo(bot.entity.position)
        if (tDist > 48) return false
        const reach = this.reachDistance(target)
        const now = Date.now()
        const cd = cooldownFor(bot.heldItem)
        const ready = now - this.lastSwingAt >= cd
        if (tDist > 4.5 || Math.abs(target.position.y - bot.entity.position.y) > 1.6) {
          if (!this.pathing) {
            this.pathing = true
            this.releaseKeys()
            bot.pathfinder.setMovements(ctx.actions.walkMoves)
            bot.pathfinder.setGoal(new goals.GoalFollow(target, 1.6), true)
          }
          await bot.waitForTicks(2)
          continue
        }
        this.stopPathing()
        ctx.look.track(this.aimPoint(target), 'combat')
        const aimErr = ctx.look.errorTo(this.aimPoint(target))
        const want = { forward: reach > 2.4, sprint: false }
        if (want.forward && bot.entity.isCollidedHorizontally && bot.entity.onGround) want.jump = true
        const inReach = reach <= 3.0 && aimErr < 0.45
        const vy = bot.entity.velocity.y
        if (bot.entity.onGround && cd - (now - this.lastSwingAt) <= 330 && reach <= 3.4 && !jumped) { want.jump = true; jumped = true } else if (jumped) {
          if (!bot.entity.onGround && vy < -0.08 && ready && inReach) { this.strikeAnimal(target, true); jumped = false } else if (bot.entity.onGround && vy <= 0 && now - this.lastSwingAt > cd + 450) {
            if (ready && inReach) this.strikeAnimal(target, false)
            jumped = false
          }
        }
        this.setKeys(want)
        await bot.waitForTicks(1)
      }
      return false
    } finally {
      this.stopPathing()
      this.releaseKeys()
      ctx.look.blockGlance('duel', false)
    }
  }

  strikeAnimal (target, crit) {
    this.bot.attack(target)
    this.lastSwingAt = Date.now()
    this.ctx.emit('swing', { kind: 'attack', crit, mob: target.name })
  }
}

module.exports = { CombatSystem, cooldownFor, PASSIVE_FOOD, RANGED, BOSSES }
