'use strict'
/**
 * arena-controller.js – die Kampf-KI für den Arena-Modus.
 *
 * Läuft alle 100 ms und prüft strikt von oben nach unten:
 *   1. SURVIVAL_HEAL  – unter 4 Herzen: weg vom Gegner, Goldapfel essen
 *   2. PRO_COMBAT     – Zombie in der Arena: nächster Gegner, W-Tap, Sprung-Krits, Kreis-Strafe, Rückwärts-Reihe
 *   3. AUTO_UPGRADE   – Arena leer und genug Smaragde: zur Schmiede, aufrüsten
 *   4. IDLE_FARMING   – Arena leer: hinten rechts an der Maschine Smaragde farmen
 *
 * Bewegung läuft direkt über Blickrichtung und Tasten (kein Pathfinder) – die Arena ist flach,
 * und so kann nichts einfrieren. Ein Wächter prüft alle 2 Sekunden, ob der Bot hängt.
 *
 * Smaragde sind ein Zähler im Programm (keine Gegenstände im Inventar).
 */
const { Vec3 } = require('vec3')
const K = require('../mc-knowledge')
const { cleanName } = require('./arena-builder')

const TICK_MS = 100
const MAX_ACTIVE = 12 // so viele Zombies gleichzeitig, der Rest wartet in der Schlange
const MAX_QUEUE = 300
const HEAL_BELOW = 8
const REWARD = { normal: 3, boss: 15 }

const ench = levels => `[enchantments={levels:{${Object.entries(levels).map(([k, v]) => `"minecraft:${k}":${v}`).join(',')}}}]`
const SET = (mat, parts = ['head', 'chest', 'legs', 'feet']) => parts.map(p => [`armor.${p}`, `${mat}_${{ head: 'helmet', chest: 'chestplate', legs: 'leggings', feet: 'boots' }[p]}`])
/** Fester Upgrade-Pfad. cost = Smaragde für diese Stufe. */
const LEVELS = [
  { level: 1, cost: 0, label: 'Holzschwert + Lederrüstung', sword: 'wooden_sword', armor: SET('leather') },
  { level: 2, cost: 10, label: 'Steinschwert', sword: 'stone_sword', armor: [] },
  { level: 3, cost: 25, label: 'Eisenschwert + Eisenbrustpanzer', sword: 'iron_sword', armor: SET('iron', ['chest']) },
  { level: 4, cost: 45, label: 'Eisenschwert (Schärfe II) + volles Eisen-Set', sword: 'iron_sword' + ench({ sharpness: 2, unbreaking: 2 }), armor: SET('iron') },
  { level: 5, cost: 75, label: 'Diamantschwert (Schärfe III) + Diamantbrustpanzer', sword: 'diamond_sword' + ench({ sharpness: 3 }), armor: SET('diamond', ['chest']) },
  { level: 6, cost: 110, label: 'Diamantschwert (Schärfe IV, Rückstoß I) + volles Diamant-Set', sword: 'diamond_sword' + ench({ sharpness: 4, knockback: 1 }), armor: SET('diamond') },
  { level: 7, cost: 160, label: 'Netheritschwert (Schärfe V) + volles Netherit-Set', sword: 'netherite_sword' + ench({ sharpness: 5, unbreaking: 3, knockback: 2 }), armor: SET('netherite') }
]
const REPEAT_COST = 50 // ab Stufe 8

/** Kosten der nächsten Stufe. */
function nextCost (level) { return level < LEVELS.length ? LEVELS[level].cost : REPEAT_COST }

/** Befehle, um Stufe `level` anzulegen (1 … 7 fest, danach Bonus-Stufen). */
function upgradeCommands (bot, level, apples) {
  const cmds = []
  if (level <= LEVELS.length) {
    const L = LEVELS[level - 1]
    cmds.push(`item replace entity ${bot} hotbar.0 with ${L.sword}`)
    for (const [slot, item] of L.armor) cmds.push(`item replace entity ${bot} ${slot} with ${item}`)
  } else {
    // ab Stufe 8: Goldäpfel, 60 s Stärke, Schutz auf der Rüstung (bis Schutz IV)
    const prot = Math.min(4, level - LEVELS.length)
    for (const [slot, item] of SET('netherite')) cmds.push(`item replace entity ${bot} ${slot} with ${item}${ench({ protection: prot })}`)
    cmds.push(`effect give ${bot} minecraft:strength 60 0 true`)
  }
  cmds.push(`item replace entity ${bot} hotbar.1 with golden_apple ${Math.max(1, Math.min(64, apples))}`)
  return cmds
}

class ArenaController {
  /**
   * @param {object} host    MinecraftAIBot (liefert bot und ctx)
   * @param {object} builder ArenaBuilder
   * @param {{run: (cmds: string[]) => boolean, emit: (type: string, data: object) => void}} deps
   */
  constructor (host, builder, deps) {
    this.host = host
    this.builder = builder
    this.run = deps.run
    this.emit = deps.emit
    this.timer = null
    this.reset()
  }

  reset () {
    this.state = 'IDLE_FARMING'
    this.emeralds = 0
    this.level = 1
    this.apples = 2
    this.kills = 0
    this.deaths = 0
    this.scores = new Map() // Name -> Punkte
    this.mobs = new Map() // Entity-Id -> { supporter, boss }
    this.pending = [] // gesendete Spawns, deren Zombie noch nicht erschienen ist
    this.queue = [] // wartende Spawns (Arena voll)
    this.combat = { lastSwing: 0, wtapUntil: 0, strafeDir: 'left', strafeUntil: 0, backUntil: 0, backCooldown: 0, jumpAt: 0 }
    this.heal = { eating: false, cooldownUntil: 0, since: 0 }
    this.farm = { swings: 0, lastSwing: 0, announced: false }
    this.upgrade = { since: 0, swings: 0, lastSwing: 0 }
    this.dog = { lastCheck: 0, pos: null, stuckSince: 0, nudged: 0, moving: false }
    this.lastBoard = ''
  }

  get bot () { return this.host.bot }
  get ctx () { return this.host.ctx }
  get ready () { return !!(this.bot && this.bot.entity && this.ctx && this.builder.center) }

  // ---------------------------------------------------------------- Start / Stopp
  start () {
    if (this.timer) return
    const bot = this.bot
    if (bot) {
      this._onDead = e => this.onEntityGone(e, true)
      this._onGone = e => this.onEntityGone(e, false)
      this._onSpawn = e => this.onEntitySpawn(e)
      this._onDeath = () => { this.deaths++; this.clearKeys(); this.emit('arena_death', { deaths: this.deaths }) }
      this._onRespawn = () => { if (this.builder.center) { const c = this.builder.getWaypoints().center; setTimeout(() => this.run([`tp ${bot.username} ${c.x} ${c.y} ${c.z}`]), 600) } }
      bot.on('entityDead', this._onDead); bot.on('entityGone', this._onGone); bot.on('entitySpawn', this._onSpawn); bot.on('death', this._onDeath); bot.on('spawn', this._onRespawn)
      this._bound = bot
      try { bot.pathfinder.setGoal(null) } catch (_) {}
      try { bot.setQuickBarSlot(0) } catch (_) {}
    }
    this.timer = setInterval(() => { try { this.tick() } catch (e) { this.emit('log', { message: 'Arena-Tick: ' + e.message }) } }, TICK_MS)
  }

  stop () {
    clearInterval(this.timer); this.timer = null
    const bot = this._bound
    if (bot) { bot.removeListener('entityDead', this._onDead); bot.removeListener('entityGone', this._onGone); bot.removeListener('entitySpawn', this._onSpawn); bot.removeListener('death', this._onDeath); bot.removeListener('spawn', this._onRespawn) }
    this._bound = null
    this.clearKeys()
  }

  /** Ausrüstung der aktuellen Stufe (neu) anlegen. */
  equip () { if (this.bot) this.run(upgradeCommands(this.bot.username, this.level, this.apples)) }

  // ---------------------------------------------------------------- Spawns: Deckel und Warteschlange
  /** Zombies anfordern. Ist die Arena voll, warten sie in der Schlange. */
  requestSpawn (supporter, o = {}) {
    const n = Math.max(1, Math.min(20, o.count || 1))
    for (let i = 0; i < n && this.queue.length < MAX_QUEUE; i++) this.queue.push({ supporter: cleanName(supporter), boss: !!o.boss })
    this.pump()
    return { active: this.activeCount(), queued: this.queue.length }
  }

  activeCount () { return this.mobs.size + this.pending.length }

  pump () {
    const now = Date.now()
    // Spawns, deren Zombie nie erschienen ist (Bot offline, Chunk nicht geladen), nach 6 s vergessen
    this.pending = this.pending.filter(p => now - p.at < 6000)
    if (!this.ready) return
    // Bosse zuerst, damit ein großes Gift nicht hinter fünfzig Rosen wartet
    this.queue.sort((a, b) => (b.boss ? 1 : 0) - (a.boss ? 1 : 0))
    while (this.queue.length && this.activeCount() < MAX_ACTIVE) {
      const s = this.queue.shift()
      const built = this.builder.spawnCommands(s.supporter, s.boss)
      this.run(built.cmds)
      this.pending.push({ ...s, at: now, pos: built.at })
    }
  }

  onEntitySpawn (e) {
    if (!e || e.name !== 'zombie' || !this.pending.length || !e.position) return
    // der neue Zombie gehört zum ältesten offenen Spawn an diesem Punkt
    const i = this.pending.findIndex(p => p.pos.distanceTo(e.position) < 3.5)
    if (i < 0) return
    const [p] = this.pending.splice(i, 1)
    this.mobs.set(e.id, { supporter: p.supporter, boss: p.boss })
  }

  onEntityGone (e, dead) {
    if (!e || !this.mobs.has(e.id)) return
    const m = this.mobs.get(e.id)
    this.mobs.delete(e.id)
    if (dead) this.reward(m)
    this.pump()
  }

  reward (m) {
    const gain = m.boss ? REWARD.boss : REWARD.normal
    this.emeralds += gain
    this.kills++
    this.builder.cheer('kill')
    this.emit('arena_kill', { supporter: m.supporter, boss: m.boss, emeralds: gain })
    this.emit('kill', { mob: 'zombie' }) // Overlay: Siegerfaust in der Facecam
  }

  /** Punkte für die Bestenliste gutschreiben. */
  addScore (name, points) {
    const n = cleanName(name)
    this.scores.set(n, (this.scores.get(n) || 0) + points)
    if (this.scores.size > 500) this.scores.delete(this.scores.keys().next().value)
    this.syncBoard()
  }

  top (n = 5) { return [...this.scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, score]) => ({ name, score })) }

  syncBoard () {
    const top = this.top(3)
    const key = JSON.stringify(top)
    if (key === this.lastBoard || !this.builder.built) return
    this.lastBoard = key
    this.run(this.builder.leaderboardCommands(top))
  }

  /** Alle Arena-Zombies entfernen (Dashboard-Knopf). */
  clearMobs () { this.queue = []; this.pending = []; this.mobs.clear(); this.run(['kill @e[tag=arena_mob]']) }

  // ---------------------------------------------------------------- Hilfen
  clearKeys () { const bot = this.bot; if (bot) { try { bot.clearControlStates() } catch (_) {} } }
  setKeys (want) { const bot = this.bot; for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(k, !!want[k]) }
  look (point) { this.ctx.look.track(point, 'combat') }
  aimError (point) { return Math.abs(this.ctx.look.errorTo(point)) }

  /** Lebende Zombies im Umkreis von 25 Blöcken um die Mitte, nächster zuerst. */
  zombies () {
    const bot = this.bot
    const c = this.builder.getWaypoints().center
    const me = bot.entity.position
    const out = []
    for (const e of Object.values(bot.entities)) {
      if (e.name !== 'zombie' || !e.position || e.isValid === false) continue
      if (e.position.distanceTo(c) > 25 || Math.abs(e.position.y - c.y) > 6) continue
      out.push({ e, d: e.position.distanceTo(me) })
    }
    return out.sort((a, b) => a.d - b.d)
  }

  /** Direkt auf einen Punkt zulaufen. Liefert die Entfernung. */
  walkTo (pos, sprint = true) {
    const bot = this.bot
    const d = Math.hypot(pos.x - bot.entity.position.x, pos.z - bot.entity.position.z)
    const aim = new Vec3(pos.x, bot.entity.position.y + 1.6, pos.z)
    this.look(aim)
    const facing = this.aimError(aim) < 0.6
    this.setKeys({ forward: facing, sprint: facing && sprint && d > 3, jump: facing && bot.entity.isCollidedHorizontally && bot.entity.onGround })
    this.dog.moving = true
    return d
  }

  // ---------------------------------------------------------------- Tick
  tick () {
    if (!this.ready) return
    const bot = this.bot
    if (bot.health <= 0) { this.clearKeys(); return }
    this.dog.moving = false
    const now = Date.now()
    const zs = this.zombies()
    if (this.pending.length || this.queue.length) this.pump()
    let state
    if ((bot.health < HEAL_BELOW && (this.apples > 0 || now > this.heal.cooldownUntil)) || this.heal.eating) state = 'SURVIVAL_HEAL'
    else if (zs.length) state = 'PRO_COMBAT'
    else if (this.emeralds >= nextCost(this.level)) state = 'AUTO_UPGRADE'
    else state = 'IDLE_FARMING'
    if (state !== this.state) {
      // Sofort-Abbruch: Tasten los, neuer Zustand beginnt im selben Tick
      this.clearKeys()
      if (state === 'IDLE_FARMING' && this.state === 'PRO_COMBAT') this.emit('arena_clear', {})
      if (state === 'IDLE_FARMING') { this.farm.swings = 0; this.farm.announced = false }
      if (state === 'AUTO_UPGRADE') this.upgrade = { since: 0, swings: 0, lastSwing: 0 }
      if (state === 'PRO_COMBAT' && bot.quickBarSlot !== 0 && !this.heal.eating) { try { bot.setQuickBarSlot(0) } catch (_) {} }
      this.state = state
      this.emit('arena_state', { state })
    }
    if (state === 'SURVIVAL_HEAL') this.tickHeal(zs, now)
    else if (state === 'PRO_COMBAT') this.tickCombat(zs, now)
    else if (state === 'AUTO_UPGRADE') this.tickUpgrade(now)
    else this.tickFarm(now)
    this.watchdog(now)
  }

  // ---- 1. Notfall-Heilung
  tickHeal (zs, now) {
    const bot = this.bot
    const me = bot.entity.position
    const c = this.builder.getWaypoints().center
    if (!this.heal.since) { this.heal.since = now; this.emit('arena_heal', { health: bot.health }) }
    if (zs.length) {
      // weg vom nächsten Gegner; nahe der Wand zur Mitte hin abbiegen, damit er nicht in der Ecke landet
      const z = zs[0].e.position
      let dx = me.x - z.x; let dz = me.z - z.z
      const len = Math.hypot(dx, dz) || 1
      dx /= len; dz /= len
      const fromCenter = Math.hypot(me.x - c.x, me.z - c.z)
      if (fromCenter > 14) { const tx = (c.x - me.x) / fromCenter; const tz = (c.z - me.z) / fromCenter; dx = dx * 0.35 + tx * 0.65 + -dz * 0.4; dz = dz * 0.35 + tz * 0.65 + dx * 0.4 }
      this.walkTo(new Vec3(me.x + dx * 6, me.y, me.z + dz * 6), true)
    } else this.setKeys({})
    const far = !zs.length || zs[0].d >= 4.5 || now - this.heal.since > 1500
    if (!this.heal.eating && far) {
      if (this.apples > 0) {
        this.heal.eating = true
        try { bot.setQuickBarSlot(1) } catch (_) {}
        Promise.resolve().then(() => bot.consume()).then(() => { this.apples--; this.emit('arena_ate', { apples: this.apples }) }, () => {}).then(() => {
          this.heal.eating = false; this.heal.since = 0
          try { bot.setQuickBarSlot(0) } catch (_) {}
        })
      } else {
        // kein Apfel mehr: Sofort-Heilung per Effekt, höchstens alle 20 Sekunden
        this.heal.cooldownUntil = now + 20000
        this.heal.since = 0
        this.run([`effect give ${bot.username} minecraft:instant_health 1 1 true`, `effect give ${bot.username} minecraft:regeneration 6 1 true`])
      }
    }
    if (bot.health >= HEAL_BELOW + 6 && !this.heal.eating) this.heal.since = 0
  }

  // ---- 2. Kampf
  tickCombat (zs, now) {
    const bot = this.bot
    const k = this.combat
    const target = zs[0].e
    const dist = zs[0].d
    const near = zs.filter(z => z.d < 3).length
    const aim = target.position.offset(0, (target.height || 1.9) * 0.8, 0)
    this.look(aim)
    const cd = K.cooldownFor(bot.heldItem ? bot.heldItem.name : '')
    const ready = now - k.lastSwing >= cd
    const readyIn = Math.max(0, cd - (now - k.lastSwing))
    const want = {}
    const crowd = near >= 3
    // Rückwärts-Reihe: bei vier oder mehr Gegnern in Schlagweite kurz zurück, dann trifft der Rundumschlag alle
    if (near >= 4 && now > k.backCooldown) { k.backUntil = now + 600; k.backCooldown = now + 2200 }
    if (now < k.backUntil) want.back = true
    else if (dist > 2.7) { want.forward = true; want.sprint = dist > 3.4 && !crowd }
    else if (dist < 1.7) want.back = true
    // Kreis-Strafe: alle 700 ms die Seite wechseln
    if (now > k.strafeUntil) { k.strafeDir = k.strafeDir === 'left' ? 'right' : 'left'; k.strafeUntil = now + 700 }
    if (dist < 5) want[k.strafeDir] = true
    // W-Tap: direkt nach dem Treffer 60 ms Vorwärts und Sprint loslassen
    if (now < k.wtapUntil) { want.forward = false; want.sprint = false }
    const inReach = dist <= 3.2 && this.aimError(aim) < 0.5
    const vy = bot.entity.velocity.y
    if (!crowd) {
      // Sprung-Krit: abspringen kurz bevor der Schlag bereit ist, zuschlagen im Fallen
      if (bot.entity.onGround && dist >= 2.0 && dist <= 3.8 && readyIn <= 300 && now - k.jumpAt > 600) { want.jump = true; k.jumpAt = now }
      if (ready && inReach && ((!bot.entity.onGround && vy < -0.08) || (bot.entity.onGround && now - k.jumpAt > 550))) this.strike(target, now)
    } else if (ready && inReach && bot.entity.onGround) {
      want.sprint = false // Rundumschlag gibt es nur ohne Sprint
      this.strike(target, now)
    }
    if (want.forward && bot.entity.isCollidedHorizontally && bot.entity.onGround) want.jump = true
    this.setKeys(want)
    this.dog.moving = !!want.forward && dist > 4
  }

  strike (target, now) {
    try { this.bot.attack(target) } catch (_) { return }
    this.combat.lastSwing = now
    this.combat.wtapUntil = now + 60
    this.emit('swing', {})
  }

  // ---- 3. Aufrüsten
  tickUpgrade (now) {
    const bot = this.bot
    const wp = this.builder.getWaypoints()
    const d = this.walkTo(wp.upgradePos)
    if (d > 2) return
    this.setKeys({})
    this.dog.moving = false
    this.look(wp.anvilBlock)
    const u = this.upgrade
    if (!u.since) u.since = now
    if (now - u.lastSwing > 350 && u.swings < 3) { u.lastSwing = now; u.swings++; try { bot.swingArm('right') } catch (_) {} }
    if (u.swings >= 3 && now - u.lastSwing > 300) {
      const cost = nextCost(this.level)
      if (this.emeralds < cost) return
      this.emeralds -= cost
      this.level++
      if (this.level > LEVELS.length) this.apples = Math.min(64, this.apples + 4)
      else this.apples = Math.max(this.apples, 2)
      this.run(upgradeCommands(bot.username, this.level, this.apples))
      this.builder.cheer('upgrade')
      const label = this.level <= LEVELS.length ? LEVELS[this.level - 1].label : `Bonus-Stufe ${this.level}: Goldäpfel, Stärke und mehr Schutz`
      this.emit('arena_upgrade', { level: this.level, label })
      this.upgrade = { since: 0, swings: 0, lastSwing: 0 }
    }
  }

  // ---- 4. Smaragde farmen
  tickFarm (now) {
    const bot = this.bot
    const wp = this.builder.getWaypoints()
    const d = this.walkTo(wp.farmStandPos)
    if (d > 2.5) return
    this.setKeys({})
    this.dog.moving = false
    this.look(wp.farmTargetBlock)
    const f = this.farm
    if (!f.announced) { f.announced = true; this.emit('arena_farm', { emeralds: this.emeralds, need: nextCost(this.level) }) }
    if (now - f.lastSwing >= 450) {
      f.lastSwing = now
      try { bot.swingArm('right') } catch (_) {}
      if (++f.swings % 3 === 0) { this.emeralds++; this.builder.cheer('emerald') }
    }
  }

  // ---------------------------------------------------------------- Wächter gegen Hänger
  watchdog (now) {
    const bot = this.bot
    const g = this.dog
    if (now - g.lastCheck < 2000) return
    g.lastCheck = now
    const c = this.builder.getWaypoints().center
    const me = bot.entity.position
    const out = Math.hypot(me.x - c.x, me.z - c.z) > 22 || me.y < c.y - 3 || me.y > c.y + 8
    const moved = g.pos ? Math.hypot(me.x - g.pos.x, me.z - g.pos.z) : 99
    g.pos = me.clone()
    if (out) return this.unstuck('draußen')
    if (!g.moving || moved >= 0.15) { g.stuckSince = 0; g.nudged = 0; return }
    if (!g.stuckSince) { g.stuckSince = now; return } // erst beim zweiten Mal in Folge (rund 3–4 s) eingreifen
    if (g.nudged < 1) {
      // erster Versuch: Tasten los, Sprung und zufällig zur Seite
      g.nudged++
      this.clearKeys()
      bot.setControlState('jump', true); bot.setControlState(Math.random() < 0.5 ? 'left' : 'right', true)
      setTimeout(() => { if (this.timer) this.clearKeys() }, 400)
      this.emit('arena_stuck', { step: 'nudge' })
      return
    }
    this.unstuck('hängt')
  }

  /** Sauber zurück in die Mitte setzen. */
  unstuck (why = 'manuell') {
    if (!this.ready) return false
    const c = this.builder.getWaypoints().center
    this.clearKeys()
    this.run([`tp ${this.bot.username} ${c.x} ${c.y} ${c.z}`])
    this.dog.stuckSince = 0; this.dog.nudged = 0; this.dog.pos = null
    this.emit('arena_stuck', { step: 'teleport', why })
    return true
  }

  // ---------------------------------------------------------------- Zustand fürs Dashboard
  status () {
    const cost = nextCost(this.level)
    return {
      state: this.state,
      emeralds: this.emeralds,
      level: this.level,
      levelLabel: this.level <= LEVELS.length ? LEVELS[this.level - 1].label : `Bonus-Stufe ${this.level}`,
      nextCost: cost,
      nextLabel: this.level < LEVELS.length ? LEVELS[this.level].label : '+4 Goldäpfel, 60 s Stärke, mehr Schutz',
      apples: this.apples,
      active: this.mobs.size,
      spawning: this.pending.length,
      queued: this.queue.length,
      maxActive: MAX_ACTIVE,
      kills: this.kills,
      deaths: this.deaths,
      top: this.top(5)
    }
  }
}

module.exports = { ArenaController, LEVELS, nextCost, upgradeCommands, MAX_ACTIVE, REWARD }
