'use strict'
/**
 * HumanActions – alle "Hände" des Bots: Laufen, Abbauen, Platzieren, Ausrüsten, Einsammeln.
 *
 * Eiserne Regel: Während bot.dig()/placeBlock läuft, sind ALLE Bewegungstasten gesperrt
 * (Action-State-Lock). Der Pathfinder darf beim normalen Laufen NIE graben (walkMoves.canDig=false);
 * nur digMoves – ausschließlich in Mining-/Baum-/Notfall-Routinen – darf das.
 */
const { Vec3 } = require('vec3')
const { goals, Movements } = require('mineflayer-pathfinder')

const MOVE_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint']
const FACES = [new Vec3(0, 1, 0), new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const rand = (lo, hi) => lo + Math.random() * (hi - lo)

class Interrupt extends Error {
  constructor (reason) { super('interrupt:' + reason); this.reason = reason; this.isInterrupt = true }
}

/** Kooperatives Abbruch-Token: jede Routine ruft token.check() an sicheren Punkten. */
class TaskToken {
  constructor (label) { this.label = label; this.cancelled = false; this.reason = null; this.handlers = [] }
  cancel (reason = 'cancel') {
    if (this.cancelled) return
    this.cancelled = true
    this.reason = reason
    for (const h of this.handlers.splice(0)) { try { h(reason) } catch (_) {} }
  }

  onCancel (fn) { if (this.cancelled) fn(this.reason); else this.handlers.push(fn); return () => { this.handlers = this.handlers.filter(h => h !== fn) } }
  check () { if (this.cancelled) throw new Interrupt(this.reason) }
}

const PICK_TIERS = ['netherite', 'diamond', 'iron', 'golden', 'stone', 'wooden']

class HumanActions {
  constructor (ctx) {
    this.ctx = ctx
    this.bot = ctx.bot
    this.locked = false
    this.lockReason = null
    const bot = this.bot
    const mcData = ctx.mcData

    // --- Bewegungsprofile ---
    const walk = new Movements(bot)
    walk.canDig = false
    walk.allow1by1towers = false
    walk.scafoldingBlocks = []
    walk.maxDropDown = 3
    walk.allowParkour = true
    walk.allowSprinting = true
    walk.canOpenDoors = true
    walk.liquidCost = 1000 // Stufe 1: Wasser und Lava strikt umlaufen
    walk.dontCreateFlow = true
    this.walkMoves = walk

    const dig = new Movements(bot)
    dig.canDig = true
    dig.digCost = 2
    dig.allow1by1towers = true
    dig.maxDropDown = 3
    dig.allowParkour = false
    dig.canOpenDoors = true
    dig.dontCreateFlow = true
    dig.dontMineUnderFallingBlock = true
    dig.scafoldingBlocks = ['cobblestone', 'dirt', 'cobbled_deepslate', 'netherrack'].map(n => mcData.itemsByName[n]?.id).filter(Boolean)
    for (const n of ['chest', 'crafting_table', 'furnace', 'enchanting_table', 'obsidian', 'oak_door', 'glass_pane', 'torch', 'wall_torch']) {
      const b = mcData.blocksByName[n]
      if (b) dig.blocksCantBreak.add(b.id)
    }
    for (const b of mcData.blocksArray) if (/_bed$|_door$|_planks$|_stairs$|_slab$|_fence$/.test(b.name)) dig.blocksCantBreak.add(b.id)
    this.digMoves = dig

    const nether = new Movements(bot)
    nether.canDig = true
    nether.digCost = 3
    nether.allowParkour = false
    nether.maxDropDown = 2
    nether.allow1by1towers = true
    nether.scafoldingBlocks = dig.scafoldingBlocks
    nether.liquidCost = 100
    this.netherMoves = nether

    bot.pathfinder.setMovements(walk)
    bot.pathfinder.thinkTimeout = 4000

    // Action-State-Lock: jede Bewegungstaste wird pro Tick wieder losgelassen
    bot.on('physicsTick', () => {
      if (!this.locked) return
      for (const k of MOVE_KEYS) if (bot.getControlState(k)) bot.setControlState(k, false)
    })
  }

  // ---------------------------------------------------------------- Basics
  stopMoving () {
    const bot = this.bot
    try { bot.pathfinder.setGoal(null) } catch (_) {}
    bot.clearControlStates()
  }

  async waitOnGround (timeout = 1500) {
    const bot = this.bot
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (bot.entity.onGround || bot.entity.isInWater || bot.entity.isInLava) return true
      await bot.waitForTicks(1)
    }
    return bot.entity.onGround
  }

  _lock (reason) {
    this.locked = true
    this.lockReason = reason
    this.ctx.look.blockGlance('action', true)
  }

  _unlock () {
    this.locked = false
    this.lockReason = null
    this.ctx.look.blockGlance('action', false)
  }

  /**
   * Block-Zelle, in der die Füße stehen. +0.2 fängt Float-Ungenauigkeit (20.99999) und flache
   * Böden (Ackerland/Trampelpfad 0.9375, Seelensand 0.875) ab; auf Stufen (x.5) bleibt es die Stufen-Zelle.
   */
  feet () {
    const p = this.bot.entity.position
    return new Vec3(Math.floor(p.x), Math.floor(p.y + 0.2), Math.floor(p.z))
  }

  eyePos () {
    const e = this.bot.entity
    return e.position.offset(0, e.eyeHeight ?? 1.62, 0)
  }

  distToBlock (pos) { return this.eyePos().distanceTo(pos.offset(0.5, 0.5, 0.5)) }

  isSolid (b) { return !!b && b.boundingBox === 'block' }
  isAir (b) { return !b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air' }
  isLiquid (b) { return !!b && (b.name === 'water' || b.name === 'lava' || b.name === 'bubble_column') }
  isLava (b) { return !!b && b.name === 'lava' }
  isReplaceable (b) {
    return this.isAir(b) || this.isLiquid(b) || (b.boundingBox === 'empty' && /grass|fern|flower|dead_bush|snow$|vine|seagrass|kelp|fire|tulip|dandelion|poppy|orchid|allium|bluet|daisy|cornflower|lily_of_the_valley|bush/.test(b.name))
  }

  /** Sichtbare Seite eines Blocks: die zum Auge nächste Fläche, deren Nachbar nicht massiv ist. */
  visibleFace (block) {
    const eye = this.eyePos()
    let best = null
    for (const f of FACES) {
      const n = this.bot.blockAt(block.position.plus(f))
      if (this.isSolid(n)) continue
      const center = block.position.offset(0.5 + f.x * 0.5, 0.5 + f.y * 0.5, 0.5 + f.z * 0.5)
      // Fläche muss dem Auge zugewandt sein
      const facing = (eye.x - center.x) * f.x + (eye.y - center.y) * f.y + (eye.z - center.z) * f.z
      if (facing <= 0) continue
      const d = eye.distanceTo(center)
      if (!best || d < best.d) best = { face: f, point: center, d }
    }
    if (best) {
      // Menschen treffen nie exakt die Mitte
      best.point = best.point.offset(
        best.face.x ? 0 : rand(-0.18, 0.18), best.face.y ? 0 : rand(-0.18, 0.18), best.face.z ? 0 : rand(-0.18, 0.18))
      return best
    }
    return { face: new Vec3(0, 1, 0), point: block.position.offset(0.5, 0.5, 0.5), d: eye.distanceTo(block.position.offset(0.5, 0.5, 0.5)) }
  }

  // ---------------------------------------------------------------- Inventar
  items () { return this.bot.inventory.items() }
  count (name) {
    let n = 0
    for (const it of this.items()) if (it.name === name) n += it.count
    const off = this.bot.inventory.slots[45]
    if (off && off.name === name) n += off.count
    return n
  }

  countMatch (re) { let n = 0; for (const it of this.items()) if (re.test(it.name)) n += it.count; return n }
  find (name) { return this.items().find(i => i.name === name) || null }
  findMatch (re) { return this.items().find(i => re.test(i.name)) || null }
  findFirst (names) { for (const n of names) { const it = this.find(n); if (it) return it } return null }

  /** Bestes Werkzeug einer Art. healthy: nur Werkzeug mit mindestens 10 % Rest-Haltbarkeit. */
  bestTool (kind, o = {}) {
    for (const t of PICK_TIERS) {
      const it = this.find(`${t}_${kind}`)
      if (!it) continue
      if (o.healthy && it.maxDurability && 1 - (it.durabilityUsed || 0) / it.maxDurability < 0.10) continue
      return it
    }
    return null
  }

  pickTier () {
    const it = this.bestTool('pickaxe', { healthy: true })
    if (!it) return 0
    return { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 }[it.name.split('_')[0]] || 0
  }

  async equip (item, dest = 'hand') {
    const bot = this.bot
    if (typeof item === 'string') item = this.find(item)
    if (!item) return false
    if (dest === 'hand') {
      if (bot.heldItem && bot.heldItem.type === item.type && bot.heldItem.slot === item.slot) return true
      // Muscle Memory: liegt das Item in der Hotbar, wird nur die Zifferntaste gedrückt
      if (item.slot >= 36 && item.slot <= 44) { bot.setQuickBarSlot(item.slot - 36); await bot.waitForTicks(1); return true }
    }
    try { await bot.equip(item, dest); return true } catch (e) { this.ctx.log('equip fehlgeschlagen: ' + e.message); return false }
  }

  /** Schnellstes Werkzeug für einen Block (entspricht bot.tool.equipForBlock). */
  async equipForBlock (block) {
    const bot = this.bot
    const creative = bot.game.gameMode === 'creative'
    let best = null
    let bestScore = Infinity
    for (const it of [null, ...this.items()]) {
      const t = block.digTime(it ? it.type : null, creative, bot.entity.isInWater, !bot.entity.onGround, it ? it.enchants : [], bot.entity.effects)
      const harvestable = !block.harvestTools || !!(it && block.harvestTools[it.type])
      // Schwerter schont man: bei Gleichstand gewinnt alles andere
      const score = t + (harvestable ? 0 : 1e6) + (it && /_sword$/.test(it.name) ? 5 : 0)
      if (score < bestScore) { best = it; bestScore = score }
    }
    if (best) await this.equip(best)
    else if (bot.heldItem && /_sword$/.test(bot.heldItem.name)) {
      const filler = this.items().find(i => i.slot >= 36 && !/_sword$/.test(i.name))
      if (filler) await this.equip(filler)
    }
    return bestScore < 1e6
  }

  canHarvest (block) {
    if (!block.harvestTools) return true
    return this.items().some(i => block.harvestTools[i.type])
  }

  // ---------------------------------------------------------------- Lava-Check
  lavaAdjacent (pos) {
    for (const f of FACES) if (this.isLava(this.bot.blockAt(pos.plus(f)))) return pos.plus(f)
    return null
  }

  /** Lava versiegeln: einen Schritt zurück und Bruchstein in die Öffnung. */
  async sealLava (holePos, token) {
    const bot = this.bot
    this.ctx.emit('lava', { pos: holePos })
    const away = bot.entity.position.minus(holePos.offset(0.5, 0, 0.5))
    away.y = 0
    if (away.norm() > 0.01) {
      await this.ctx.look.aim(holePos.offset(0.5, 0.5, 0.5), { profile: 'panic', timeout: 500 })
      bot.setControlState('back', true)
      await sleep(350)
      bot.setControlState('back', false)
    }
    const filler = this.findFirst(['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'tuff'])
    if (!filler) return false
    return this.placeAt(holePos, filler.name, { token, sneak: false })
  }

  // ---------------------------------------------------------------- Abbauen (Eiserne Regel)
  /**
   * @returns {Promise<'ok'|'gone'|'lava'|'unreachable'|'unharvestable'|'failed'>}
   */
  async dig (block, o = {}) {
    const bot = this.bot
    const token = o.token
    if (token) token.check()
    block = block && bot.blockAt(block.position)
    if (!block || this.isAir(block) || this.isLiquid(block)) return 'gone'
    if (block.name === 'bedrock' || !bot.canDigBlock(block)) {
      if (this.distToBlock(block.position) > 5.2) return 'unreachable'
    }
    if (o.requireHarvest && !this.canHarvest(block)) return 'unharvestable'
    if (o.lavaCheck) {
      const lava = this.lavaAdjacent(block.position)
      if (lava) return 'lava'
    }

    // 1) Pathfinder stoppen, Tasten los, auf dem Boden stehen
    this.stopMoving()
    await this.waitOnGround(1500)
    this._lock('dig')
    let cancelUnsub = null
    try {
      // 2) Fadenkreuz weich auf die sichtbare Blockfläche
      const vf = this.visibleFace(block)
      await this.ctx.look.aim(vf.point, { profile: o.profile || 'work', tolerance: 2.2 })
      if (token) token.check()
      // 3) Optimales Werkzeug
      await this.equipForBlock(block)
      // 4) Abbauen – Tasten bleiben bis diggingCompleted/diggingAborted gesperrt
      if (token) cancelUnsub = token.onCancel(() => { try { bot.stopDigging() } catch (_) {} })
      this.ctx.emit('swing', { kind: 'dig', block: block.name })
      await bot.dig(block, 'ignore')
      if (token) token.check()
      if (o.lavaCheck) {
        await bot.waitForTicks(2)
        const now = bot.blockAt(block.position)
        if (this.isLava(now) || this.lavaAdjacent(block.position)) {
          this._unlock()
          await this.sealLava(block.position, token)
          return 'lava'
        }
      }
      return 'ok'
    } catch (e) {
      if (e.isInterrupt) throw e
      if (token && token.cancelled) throw new Interrupt(token.reason)
      this.ctx.log(`dig(${block.name}) abgebrochen: ${e.message}`)
      return 'failed'
    } finally {
      if (cancelUnsub) cancelUnsub()
      this._unlock()
    }
  }

  /** Baut einen Block so lange ab, bis die Position wirklich frei ist (Kies/Sand rutscht nach). */
  async digUntilClear (pos, o = {}) {
    for (let i = 0; i < 12; i++) {
      const b = this.bot.blockAt(pos)
      if (!b || this.isAir(b) || (b.boundingBox === 'empty' && !this.isLiquid(b) && !o.clearPlants)) return 'ok'
      if (this.isLiquid(b)) return this.isLava(b) ? 'lava' : 'water'
      const r = await this.dig(b, o)
      if (r !== 'ok' && r !== 'gone') return r
      await this.bot.waitForTicks(5) // fallende Blöcke abwarten
    }
    return 'failed'
  }

  // ---------------------------------------------------------------- Platzieren
  /** Referenzblock + Fläche finden, an die ein Block bei pos gesetzt werden kann. */
  findPlaceReference (pos, preferVisible = true) {
    const eye = this.eyePos()
    let best = null
    for (const f of FACES) {
      const ref = this.bot.blockAt(pos.minus(f))
      if (!this.isSolid(ref)) continue
      const center = ref.position.offset(0.5 + f.x * 0.5, 0.5 + f.y * 0.5, 0.5 + f.z * 0.5)
      const facing = (eye.x - center.x) * f.x + (eye.y - center.y) * f.y + (eye.z - center.z) * f.z
      const d = eye.distanceTo(center) + (preferVisible && facing <= 0 ? 3 : 0)
      if (!best || d < best.d) best = { ref, face: f, point: center, d, visible: facing > 0 }
    }
    return best
  }

  botOccupies (pos) {
    const p = this.bot.entity.position
    return p.x + 0.3 > pos.x && p.x - 0.3 < pos.x + 1 && p.z + 0.3 > pos.z && p.z - 0.3 < pos.z + 1 && p.y + 1.8 > pos.y && p.y < pos.y + 1
  }

  /**
   * Setzt itemName an die Weltposition pos. Sneak-Placement wie ein Mensch am Rand/an Containern.
   */
  async placeAt (pos, itemName, o = {}) {
    const bot = this.bot
    const token = o.token
    if (token) token.check()
    const existing = bot.blockAt(pos)
    if (existing && !this.isReplaceable(existing)) return existing.name === itemName || (o.accept && o.accept(existing))
    const item = typeof itemName === 'string' ? this.find(itemName) : itemName
    if (!item) return false
    if (this.botOccupies(pos)) return false
    const target = this.findPlaceReference(pos)
    if (!target) return false
    if (target.d > 4.6 && this.eyePos().distanceTo(target.point) > 4.6) return false

    this.stopMoving()
    if (!o.midAir) await this.waitOnGround(1200)
    this._lock('place')
    try {
      await this.equip(item)
      const aimPoint = target.point.offset(target.face.x ? 0 : rand(-0.15, 0.15), target.face.y ? 0 : rand(-0.15, 0.15), target.face.z ? 0 : rand(-0.15, 0.15))
      await this.ctx.look.aim(aimPoint, { profile: o.profile || 'work', tolerance: 2.5 })
      if (token) token.check()
      const sneak = o.sneak !== false
      if (sneak) { bot.setControlState('sneak', true); await bot.waitForTicks(2) }
      this.ctx.emit('swing', { kind: 'place', block: item.name })
      try {
        await bot.placeBlock(target.ref, target.face)
      } catch (e) {
        // mineflayer wirft, wenn das blockUpdate-Event ausbleibt – der Block kann trotzdem stehen
        const now = bot.blockAt(pos)
        if (!now || this.isReplaceable(now)) { this.ctx.log(`place(${item.name}) fehlgeschlagen: ${e.message}`); return false }
      } finally {
        if (sneak) bot.setControlState('sneak', false)
      }
      await sleep(rand(60, 140)) // menschlicher Klick-Rhythmus
      return true
    } finally {
      this._unlock()
    }
  }

  /** Läuft in Reichweite und setzt dann den Block. */
  async gotoAndPlace (pos, itemName, o = {}) {
    if (!(await this.reach(pos, o.range ?? 3.6, o))) return false
    if (this.botOccupies(pos)) {
      // Platz machen
      await this.goto(new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, 1)), { token: o.token, timeout: 4000 })
    }
    return this.placeAt(pos, itemName, o)
  }

  /** Stellt sicher, dass der Bot einen Block bei pos mit der Hand erreichen kann. */
  async reach (pos, range = 3.8, o = {}) {
    if (this.distToBlock(pos) <= range + 0.4) return true
    const ok = await this.goto(new goals.GoalNear(pos.x, pos.y, pos.z, Math.max(1, Math.floor(range))), { token: o.token, timeout: o.timeout ?? 15000, moves: o.moves })
    return ok && this.distToBlock(pos) <= 4.9
  }

  // ---------------------------------------------------------------- Laufen
  /**
   * Pathfinder-Wrapper mit Token-Abbruch und Timeout. canDig bleibt AUS, außer moves=digMoves wird
   * explizit von einer Mining-/Baum-/Notfall-Routine übergeben.
   */
  async goto (goal, o = {}) {
    const bot = this.bot
    const token = o.token
    if (token) token.check()
    const moves = o.moves || this.walkMoves
    // gelernt: nach einem Sturz-Tod keine tiefen Sprünge mehr
    if (this.ctx.policy) { const d = this.ctx.policy().maxDrop; this.walkMoves.maxDropDown = d; this.digMoves.maxDropDown = d }
    bot.pathfinder.setMovements(moves)
    this.ctx.look.setProfile(o.profile || 'walk')
    let timer = null
    let unsub = null
    let outcome = 'ok'
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => { outcome = 'timeout'; bot.pathfinder.stop(); resolve() }, o.timeout ?? 30000)
        if (token) unsub = token.onCancel(() => { outcome = 'cancel'; try { bot.pathfinder.setGoal(null) } catch (_) {} resolve() })
        bot.pathfinder.goto(goal).then(resolve, reject)
      })
    } catch (e) {
      outcome = /NoPath|No path|Timeout|Took to long/i.test(e.message || e.name || '') ? 'nopath' : 'error'
      if (!/GoalChanged|PathStopped|goal was changed/i.test(e.message || e.name || '')) this.ctx.debug && this.ctx.debug('goto: ' + (e.message || e.name))
    } finally {
      clearTimeout(timer)
      if (unsub) unsub()
      if (moves !== this.walkMoves) bot.pathfinder.setMovements(this.walkMoves)
    }
    if (token) token.check()
    if (outcome !== 'ok') { bot.clearControlStates(); return false }
    // Der Pathfinder meldet das Ziel schon im Fallen/Springen – erst landen, dann weiterarbeiten
    await this.waitOnGround(900)
    return true
  }

  // ---------------------------------------------------------------- Drops einsammeln
  nearbyDrops (center, radius) {
    const out = []
    for (const e of Object.values(this.bot.entities)) {
      if (e.name !== 'item' || !e.position) continue
      if (e.position.distanceTo(center) <= radius) out.push(e)
    }
    return out
  }

  /** Sanfter Sammel-Lauf über alle Item-Entities im Radius. */
  async collectDrops (center, radius = 6, o = {}) {
    const bot = this.bot
    const end = Date.now() + (o.timeout ?? 12000)
    await sleep(350) // Drops brauchen einen Moment zum Landen
    while (Date.now() < end) {
      if (o.token) o.token.check()
      const drops = this.nearbyDrops(center, radius).filter(d => bot.entities[d.id])
      if (!drops.length) break
      drops.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
      const d = drops[0]
      const p = d.position
      const ok = await this.goto(new goals.GoalNear(p.x, p.y, p.z, 0.6), { token: o.token, timeout: 5000, moves: o.moves })
      if (!ok) {
        // unerreichbarer Drop (z. B. in Lava/Loch) – nicht ewig hinterherlaufen
        if (bot.entities[d.id]) { radius = Math.min(radius, d.position.distanceTo(center) - 0.1); if (radius < 1) break }
      }
      await bot.waitForTicks(4)
    }
  }

  // ---------------------------------------------------------------- Türen / Interaktion
  async useDoor (doorBlock, open = true) {
    const bot = this.bot
    const b = bot.blockAt(doorBlock.position)
    if (!b || !/_door$/.test(b.name)) return false
    const props = b.getProperties ? b.getProperties() : {}
    if (!!props.open === open) return true
    this.stopMoving()
    await this.ctx.look.aim(b.position.offset(0.5, 0.5, 0.5), { profile: 'work' })
    await bot.activateBlock(b)
    await bot.waitForTicks(3)
    return true
  }

  /** Müll wegwerfen, wenn das Inventar voll läuft – so wie Streamer zwischendurch aufräumen. */
  async tossJunk (keepCobble = 192) {
    const bot = this.bot
    if (bot.inventory.emptySlotCount() > 3) return
    const junk = /^(diorite|andesite|granite|tuff|gravel|rotten_flesh|spider_eye|poisonous_potato|wheat_seeds|.*_sapling|bone|string|gunpowder|arrow|flint)$/
    for (const it of this.items()) {
      if (bot.inventory.emptySlotCount() > 6) break
      if (junk.test(it.name) && !(it.name === 'flint' && this.count('flint') <= 2)) {
        try { await bot.tossStack(it); await sleep(150) } catch (_) {}
      }
    }
    let cobble = this.count('cobblestone') + this.count('cobbled_deepslate')
    for (const it of this.items()) {
      if (cobble <= keepCobble) break
      if (it.name === 'cobbled_deepslate' || it.name === 'cobblestone') {
        try { await bot.tossStack(it); cobble -= it.count; await sleep(150) } catch (_) {}
      }
    }
  }
}

module.exports = { HumanActions, TaskToken, Interrupt, FACES, sleep, rand }
