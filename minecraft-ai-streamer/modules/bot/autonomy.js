'use strict'
/**
 * autonomy.js – verbindet das Lern-Gedächtnis mit dem Spiel:
 *
 *  - beschreibt die Lage beim Tod (Ursache, Ort, Gegner) für ai-learning.js
 *  - baut einen 1x1x2-Bunker und bricht wieder aus
 *  - führt die Auswege aus, wenn eine Aufgabe dreimal hintereinander scheitert
 *  - misst die Server-Ticks (TPS) und meldet starken Lag
 *  - meldet Werkzeug, das fast kaputt ist
 */
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const K = require('../mc-knowledge')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
const BUNKER_BLOCKS = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'oak_planks', 'spruce_planks', 'birch_planks', 'sand', 'gravel']
const WORN_AT = 0.10 // unter 10 % Rest-Haltbarkeit gilt ein Werkzeug als verbraucht

class Autonomy {
  /**
   * @param {object} ctx  Bot-Kontext (bot, actions, combat, mining, watchdog, planner, learn …)
   * @param {object} host MinecraftAIBot (für isUnderground, memory, Ziele)
   */
  constructor (ctx, host) {
    this.ctx = ctx
    this.bot = ctx.bot
    this.host = host
    this.bunker = null // { cell, placed: Vec3[] }
    this.fall = { topY: null, lastDrop: 0, at: 0 }
    this.lastHurtBy = null // { name, at, gift }
    this.fuseSeenAt = 0
    this.tps = { samples: [], value: 20, low: 0, lagging: false }
    this.wornSeen = new Set()
    this.lastWearCheck = 0
  }

  // ---------------------------------------------------------------- Beobachtung (aus dem 250-ms-Loop)
  tick () {
    const bot = this.bot
    const e = bot.entity
    if (!e) return
    // Fallhöhe mitschreiben: höchster Punkt seit dem letzten Bodenkontakt
    if (e.onGround || e.isInWater) {
      if (this.fall.topY != null) { this.fall.lastDrop = this.fall.topY - e.position.y; this.fall.at = Date.now() }
      this.fall.topY = null
    } else this.fall.topY = Math.max(this.fall.topY ?? e.position.y, e.position.y)
    // Wer bedroht uns gerade? (für die Todesursache)
    const threats = this.ctx.combat.scan(8)
    if (threats.length) this.lastHurtBy = { name: threats[0].e.name, at: Date.now(), gift: !!threats[0].gift, count: threats.length, names: threats.slice(0, 6).map(t => t.e.name) }
    if (threats.some(t => t.e.name === 'creeper' && t.d < 5 && (t.e.metadata || [])[16] === 1)) this.fuseSeenAt = Date.now()
  }

  /** Steht der Bot in einem engen Gang? (mindestens drei der vier Seiten auf Kopfhöhe zu) */
  inTunnel () {
    const a = this.ctx.actions
    const head = a.feet().offset(0, 1, 0)
    return SIDES.filter(s => a.isSolid(this.bot.blockAt(head.plus(s)))).length >= 3
  }

  /** Lage beim Tod für das Fehler-Gedächtnis. */
  deathContext () {
    const { bot, ctx, host } = this
    const now = Date.now()
    const recent = this.lastHurtBy && now - this.lastHurtBy.at < 6000 ? this.lastHurtBy : null
    const dim = /nether/.test(bot.game.dimension || '') ? 'nether' : /end/.test(bot.game.dimension || '') ? 'end' : 'overworld'
    const underground = safe(() => host.isUnderground(), false)
    return {
      killer: recent ? recent.name : null,
      giftMob: recent ? recent.gift : false,
      mobs: recent ? recent.names : [],
      threats: recent ? recent.count : 0,
      explosion: now - this.fuseSeenAt < 2500,
      inLava: safe(() => ctx.liquid.inLava(), false) || !!bot.entity.isInLava,
      drowning: !!bot.entity.isInWater && (bot.oxygenLevel ?? 20) <= 0 && !recent,
      fell: !recent && ((this.fall.topY != null && this.fall.topY - bot.entity.position.y >= 5) || (now - this.fall.at < 1500 && this.fall.lastDrop >= 5)),
      starving: bot.food === 0 && !recent,
      underground,
      tunnel: underground && safe(() => this.inTunnel(), false),
      night: safe(() => ctx.building.isNight(), false),
      dimension: dim,
      pickTier: safe(() => ctx.actions.pickTier(), 0),
      hasShield: safe(() => ctx.combat.hasShield(), false),
      hasBed: safe(() => ctx.building.hasBedAvailable(), false),
      y: Math.floor(bot.entity.position.y),
      activity: host.activity ? host.activity.key : null
    }
  }

  // ---------------------------------------------------------------- Server-Lag
  /** Bei jedem Zeit-Paket des Servers aufrufen. Liefert 'lag' / 'ok', wenn sich der Zustand ändert. */
  onServerTime () {
    const bot = this.bot
    const age = Number(bot.time && (bot.time.bigAge ?? bot.time.age))
    if (!Number.isFinite(age)) return null
    const now = Date.now()
    const s = this.tps.samples
    s.push({ t: now, age })
    while (s.length > 2 && now - s[0].t > 6000) s.shift()
    if (now - s[0].t < 3000) return null
    const tps = Math.max(0, Math.min(20, (age - s[0].age) / ((now - s[0].t) / 1000)))
    this.tps.value = Math.round(tps * 10) / 10
    if (tps < 10) this.tps.low++; else if (tps >= 15) this.tps.low = 0
    // erst nach rund 5 Sekunden unter 10 TPS gilt es als Lag
    if (!this.tps.lagging && this.tps.low >= 5) { this.tps.lagging = true; return 'lag' }
    if (this.tps.lagging && tps >= 15) { this.tps.lagging = false; this.tps.low = 0; return 'ok' }
    return null
  }

  // ---------------------------------------------------------------- Werkzeug-Haltbarkeit
  /** Anteil der verbleibenden Haltbarkeit (1 = neu), null bei Gegenständen ohne Haltbarkeit. */
  static durabilityLeft (item) {
    if (!item || !item.maxDurability) return null
    return Math.max(0, 1 - (item.durabilityUsed || 0) / item.maxDurability)
  }

  /** Fast verbrauchte Werkzeuge melden (einmal pro Gegenstand). */
  checkWear () {
    const now = Date.now()
    if (now - this.lastWearCheck < 15000) return []
    this.lastWearCheck = now
    const out = []
    for (const kind of ['pickaxe', 'sword', 'axe', 'shovel']) {
      const it = this.ctx.actions.bestTool(kind)
      const left = Autonomy.durabilityLeft(it)
      if (left == null || left >= WORN_AT) continue
      const key = `${it.name}:${it.slot}`
      if (this.wornSeen.has(key)) continue
      this.wornSeen.add(key)
      out.push({ item: it.name, kind, left: Math.round(left * 100) })
    }
    if (this.wornSeen.size > 40) this.wornSeen.clear()
    return out
  }

  // ---------------------------------------------------------------- Bunker (1x1x2)
  bunkerBlock () { return this.ctx.actions.findFirst(BUNKER_BLOCKS) }
  blocksAvailable () { return BUNKER_BLOCKS.reduce((n, b) => n + this.ctx.actions.count(b), 0) }

  /** Mauert sich an Ort und Stelle ein: vier Seiten auf Fuß- und Kopfhöhe, Deckel drauf. */
  async buildBunker (token) {
    const { bot, ctx } = this
    const a = ctx.actions
    if (this.bunker) return true
    if (this.blocksAvailable() < 9) return false
    await a.waitOnGround(1500)
    const cell = a.feet()
    try { await ctx.watchdog.centerOn(cell) } catch (_) {}
    const placed = []
    const spots = []
    for (const dy of [0, 1]) for (const s of SIDES) spots.push(cell.offset(s.x, dy, s.z))
    spots.push(cell.offset(0, 2, 0))
    for (const pos of spots) {
      if (token) token.check()
      if (a.isSolid(bot.blockAt(pos))) continue
      const item = this.bunkerBlock()
      if (!item) break
      const ok = await a.placeAt(pos, item, { token, sneak: false, profile: 'combat' }).catch(e => { if (e && e.isInterrupt) throw e; return false })
      if (ok) placed.push(pos)
    }
    const closed = spots.every(p => a.isSolid(bot.blockAt(p)))
    this.bunker = { cell, placed, closed }
    ctx.emit('bunker', { closed, blocks: placed.length })
    return closed
  }

  /** Bricht aus dem Bunker aus (eine Seite, zwei Blöcke hoch) und sammelt die Blöcke wieder ein. */
  async leaveBunker (token) {
    const { bot, ctx } = this
    const b = this.bunker
    if (!b) return
    this.bunker = null
    const a = ctx.actions
    for (const pos of b.placed) {
      if (token) token.check()
      const block = bot.blockAt(pos)
      if (!block || !a.isSolid(block)) continue
      if (block.position.distanceTo(bot.entity.position) > 4.5) continue
      await a.dig(block, { token }).catch(e => { if (e && e.isInterrupt) throw e })
    }
    ctx.emit('bunker_left', {})
  }

  /** Im Bunker abwarten, bis `until()` wahr wird oder die Zeit um ist. */
  async waitInBunker (token, until, maxMs) {
    const end = Date.now() + maxMs
    while (Date.now() < end && !until()) { token.check(); await sleep(1000) }
  }

  // ---------------------------------------------------------------- Auswege nach drei Fehlschlägen
  /** Geht dieser Ausweg gerade überhaupt? */
  strategyPossible (name) {
    const { ctx, host } = this
    const under = safe(() => host.isUnderground(), false)
    switch (name) {
      case 'surface_first': case 'staircase_up': return under
      case 'pillar_up': return under && this.blocksAvailable() >= 4
      case 'wait_for_day': return safe(() => ctx.building.isNight(), false) && !under
      case 'better_tools': return ctx.actions.pickTier() < 3
      case 'more_food': return ctx.food.cookedCount() < 8
      case 'more_wood': return ctx.crafting.woodValue() < 24
      default: return true
    }
  }

  /**
   * Ausweg ausführen. Liefert true, wenn die Aufgabe danach noch einmal versucht werden soll.
   * @param {string} name      Schlüssel aus mc-knowledge.STRATEGIES
   * @param {object} step      gescheiterter GOAP-Schritt ({ action, goal })
   */
  async applyStrategy (name, step, token) {
    const { ctx, host } = this
    const planner = ctx.planner
    const goal = (id, label, facts) => planner.pushGoal({ id, label, by: 'KI', facts, pre: [], auto: true })
    switch (name) {
      case 'relocate': await ctx.explore(token, 64); return true
      case 'surface_first': case 'staircase_up': await ctx.mining.returnToSurface(token); return true
      case 'pillar_up': await ctx.watchdog.pillarUp(8, token); return true
      case 'better_tools': {
        const tier = ctx.actions.pickTier()
        if (tier < 2) goal('stoneKit', 'Steinwerkzeug & Ofen', ['stoneKit']); else goal('ironKit', 'Eisenausrüstung & Schild', ['ironKit'])
        planner.cooldowns.set(step.action.name, Date.now() + 120000)
        return true
      }
      case 'more_food': goal('food', 'Essensvorrat', ['food']); planner.cooldowns.set(step.action.name, Date.now() + 90000); return true
      case 'more_wood': await ctx.wood.gather(6, token); return true
      case 'wait_for_day': {
        const bunkered = await this.buildBunker(token)
        ctx.setActivity('sleep', { waiting: true })
        await this.waitInBunker(token, () => !ctx.building.isNight(), bunkered ? 480000 : 60000)
        await this.leaveBunker(token)
        return true
      }
      case 'skip_for_now': default:
        planner.cooldowns.set(step.action.name, Date.now() + 600000)
        planner.failures.delete(step.action.name)
        return false
    }
  }

  /**
   * Dreimal gescheitert: kurz einbunkern (wenn Gefahr droht), Ausweg wählen, ausführen.
   * @returns {Promise<{name: string, label: string}|null>}
   */
  async rethink (step, token) {
    const { ctx, host } = this
    const activity = step.action.activity || 'default'
    const danger = safe(() => ctx.building.isNight(), false) || safe(() => host.isUnderground(), false) || ctx.combat.scan(24).length > 0
    ctx.emit('rethink_start', { action: step.action.name, label: step.action.label, bunker: danger })
    let bunkered = false
    if (danger) bunkered = await this.buildBunker(token).catch(e => { if (e && e.isInterrupt) throw e; return false })
    // "nachdenken": Wissensbasis und bisherige Erfahrungen abfragen
    await sleep(2500)
    const pick = ctx.learn.chooseStrategy(step.action.name, activity === 'idle' ? 'default' : activity, n => this.strategyPossible(n))
    if (bunkered && (!pick || pick.name !== 'wait_for_day')) await this.leaveBunker(token)
    if (!pick) return null
    ctx.emit('rethink', { action: step.action.name, label: step.action.label, strategy: pick.name, strategyLabel: pick.label, say: pick.say, tries: pick.stats.tries, wins: pick.stats.wins })
    await this.applyStrategy(pick.name, step, token)
    return pick
  }

  // ---------------------------------------------------------------- Creeper im Gang: Block dazwischen
  /** Setzt zwei Blöcke zwischen sich und den Gegner (Sichtlinie weg, Explosion gedämpft). */
  async wallOff (entity, token) {
    const { bot, ctx } = this
    const a = ctx.actions
    const me = a.feet()
    const d = entity.position.minus(bot.entity.position)
    const dir = Math.abs(d.x) > Math.abs(d.z) ? new Vec3(Math.sign(d.x), 0, 0) : new Vec3(0, 0, Math.sign(d.z))
    if (!dir.x && !dir.z) return false
    let ok = 0
    for (const dy of [0, 1]) {
      const pos = me.plus(dir).offset(0, dy, 0)
      if (a.isSolid(bot.blockAt(pos))) { ok++; continue }
      const item = this.bunkerBlock()
      if (!item) break
      if (await a.placeAt(pos, item, { token, sneak: false, profile: 'combat' }).catch(e => { if (e && e.isInterrupt) throw e; return false })) ok++
    }
    if (ok === 2) ctx.emit('wall_off', { mob: entity.name })
    return ok === 2
  }
}

function safe (fn, fallback) { try { return fn() } catch (_) { return fallback } }

module.exports = { Autonomy, WORN_AT, K, goals }
