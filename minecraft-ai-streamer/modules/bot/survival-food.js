'use strict'
/**
 * Phase 3: Jagd, Schlachten und Ofen-Multitasking.
 */
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { sleep, rand } = require('./actions')
const { PASSIVE_FOOD } = require('./combat')

const RAW_FOOD = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon']
const COOKED_FOOD = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'bread', 'baked_potato', 'golden_apple']
const SMELT_ORE = ['raw_iron', 'raw_gold']
// Brenndauer in "Items pro Brennstoff"
const FUELS = [['coal', 8], ['charcoal', 8], ['coal_block', 80], ['blaze_rod', 12]]
const ANIMAL_LABEL = { cow: 'Kuh', pig: 'Schwein', sheep: 'Schaf', chicken: 'Huhn', mooshroom: 'Pilzkuh', rabbit: 'Hase' }

class FoodPhase {
  constructor (ctx) {
    this.ctx = ctx
    this.bot = ctx.bot
  }

  cookedCount () { return COOKED_FOOD.reduce((n, f) => n + this.ctx.actions.count(f), 0) }
  rawCount () { return RAW_FOOD.reduce((n, f) => n + this.ctx.actions.count(f), 0) }
  foodCount () { return this.cookedCount() + this.rawCount() }

  // ---------------------------------------------------------------- Essen (außerhalb des Kampfes)
  needsToEat () {
    const bot = this.bot
    const eatAt = this.ctx.policy ? this.ctx.policy().eatAt : 14
    return bot.food <= eatAt || (bot.health < 14 && bot.food < 20)
  }

  async eatIfNeeded (token) {
    const { ctx, bot } = this
    let ate = null
    for (let i = 0; i < 3 && this.needsToEat(); i++) {
      const name = await ctx.combat.eat(token)
      if (!name) break
      ate = name
    }
    if (ate) ctx.emit('ate', { item: ate, health: bot.health, food: bot.food })
    return !!ate
  }

  // ---------------------------------------------------------------- Jagd
  findAnimal (maxDistance = 48, only = null) {
    const bot = this.bot
    let best = null
    for (const e of Object.values(bot.entities)) {
      if (!e.position || !PASSIVE_FOOD.has(e.name)) continue
      if (only && !only.includes(e.name)) continue
      if ((e.metadata || [])[16] === true) continue // Babys lässt man leben
      const d = e.position.distanceTo(bot.entity.position)
      if (d > maxDistance) continue
      // Kühe/Schweine geben am meisten Fleisch
      const score = d - (e.name === 'cow' || e.name === 'pig' ? 8 : 0)
      if (!best || score < best.score) best = { e, score }
    }
    return best ? best.e : null
  }

  /** Jagt, bis `target` Stück Fleisch (roh + gebraten) im Inventar sind. */
  async hunt (target, token, only = null) {
    const { ctx } = this
    let kills = 0
    let misses = 0
    const goalMet = () => only ? false : this.foodCount() >= target
    while (!goalMet() && kills < 12) {
      token.check()
      const animal = this.findAnimal(48, only)
      if (!animal) {
        if (++misses > 3) break
        await ctx.explore(token, 36)
        continue
      }
      ctx.emit('hunt_start', { animal: animal.name, label: ANIMAL_LABEL[animal.name] || animal.name })
      const pos = animal.position.clone()
      const dead = await ctx.combat.duel(animal, token, { maxMs: 20000 })
      if (dead) {
        kills++
        await ctx.actions.collectDrops(ctx.bot.entity.position, 6, { token, timeout: 6000 })
        ctx.emit('hunt_kill', { animal: animal.name, label: ANIMAL_LABEL[animal.name] || animal.name, food: this.foodCount() })
      } else misses++
      void pos
      if (only && kills >= target) break
    }
    return kills > 0 || goalMet()
  }

  // ---------------------------------------------------------------- Ofen
  smeltables (extra = []) {
    const a = this.ctx.actions
    const out = []
    for (const n of [...RAW_FOOD, ...SMELT_ORE, ...extra]) {
      const c = a.count(n)
      if (c > 0) out.push({ name: n, count: c })
    }
    return out
  }

  /** Exakte Brennstoff-Mathematik: 1 Kohle = 8 Items, 1 Planke/Stamm = 1,5 Items. */
  planFuel (itemCount, furnace) {
    const a = this.ctx.actions
    const inSlot = furnace && furnace.fuelItem()
    const per = n => (FUELS.find(f => f[0] === n) || [n, /_planks$|_log$|_stem$/.test(n) ? 1.5 : n === 'stick' ? 0.5 : 0])[1]
    let covered = 0
    if (inSlot) covered += inSlot.count * per(inSlot.name)
    if (furnace && furnace.fuel > 0) covered += 1
    if (covered >= itemCount) return { fuel: null, count: 0, capacity: itemCount }
    const missing = itemCount - covered
    const options = []
    for (const [name, p] of FUELS) if (a.count(name)) options.push({ name, per: p, have: a.count(name) })
    for (const it of a.items()) {
      if (/_planks$/.test(it.name)) options.push({ name: it.name, per: 1.5, have: it.count })
    }
    for (const it of a.items()) {
      if (/(_log|_stem)$/.test(it.name)) options.push({ name: it.name, per: 1.5, have: it.count })
    }
    // im Brennstoff-Slot liegt schon etwas -> nur dieselbe Sorte nachlegen
    const usable = inSlot ? options.filter(o => o.name === inSlot.name) : options
    if (!usable.length) return { fuel: null, count: 0, capacity: Math.floor(covered) }
    const o = usable[0]
    const count = Math.min(o.have, Math.ceil(missing / o.per), 64 - (inSlot ? inSlot.count : 0))
    return { fuel: o.name, count, capacity: Math.min(itemCount, Math.floor(covered + count * o.per)) }
  }

  async acquireFurnace (token) {
    const { bot, ctx } = this
    const a = ctx.actions
    const near = ctx.crafting.findNearbyBlock('furnace', 6)
    if (near) return { block: near, temp: false }
    if (!a.find('furnace')) {
      if (a.count('cobblestone') + a.count('cobbled_deepslate') < 8) return null
      if (!(await ctx.crafting.craftAtTable([['furnace', 1]], token))) return null
    }
    const spot = ctx.crafting.findPlacementSpot()
    if (!spot || !(await a.placeAt(spot, 'furnace', { token }))) return null
    await bot.waitForTicks(3)
    const block = bot.blockAt(spot)
    if (!block || block.name !== 'furnace') return null
    ctx.emit('station_placed', { kind: 'furnace' })
    return { block, temp: !ctx.isBaseBlock(spot) }
  }

  async openFurnaceAt (pos, token) {
    const { bot, ctx } = this
    const block = bot.blockAt(pos)
    if (!block || !/furnace$/.test(block.name)) return null
    if (!(await ctx.actions.reach(pos, 3.2, { token }))) return null
    ctx.actions.stopMoving()
    await ctx.look.aim(pos.offset(0.5, 0.6, 0.5), { profile: 'work' })
    try { return await bot.openFurnace(block) } catch (e) { ctx.log('Ofen öffnen: ' + e.message); return null }
  }

  /**
   * Schmilzt alles Schmelzbare. Statt 60 Sekunden auf den Ofen zu starren, wird zwischendurch
   * sortiert, gecraftet und der Umkreis bewacht; alle 10 Sekunden wird der Output geholt.
   */
  async smeltAll (token, extra = []) {
    const { bot, ctx } = this
    const a = ctx.actions
    let job = ctx.memory.furnaceJob
    if (!job) {
      if (!this.smeltables(extra).length) return false
      const fz = await this.acquireFurnace(token)
      if (!fz) { ctx.emit('smelt_blocked', { reason: 'no_furnace' }); return false }
      const p = fz.block.position
      job = ctx.memory.furnaceJob = { pos: { x: p.x, y: p.y, z: p.z }, temp: fz.temp, extra, started: Date.now(), smelted: 0 }
    }
    const pos = new Vec3(job.pos.x, job.pos.y, job.pos.z)
    let idleRounds = 0
    while (true) {
      token.check()
      const f = await this.openFurnaceAt(pos, token)
      if (!f) { ctx.memory.furnaceJob = null; return false }
      let running = false
      try {
        const out = f.outputItem()
        if (out) {
          await f.takeOutput()
          job.smelted += out.count
          ctx.emit('smelt_take', { item: out.name, count: out.count })
          await sleep(rand(120, 220))
        }
        if (f.inputItem()) running = true
        else {
          const next = this.smeltables(job.extra || [])[0]
          if (next) {
            const plan = this.planFuel(next.count, f)
            const n = Math.min(next.count, plan.capacity)
            if (n > 0) {
              if (plan.fuel && plan.count > 0) {
                await f.putFuel(ctx.mcData.itemsByName[plan.fuel].id, null, plan.count)
                await sleep(rand(150, 260))
              }
              await f.putInput(ctx.mcData.itemsByName[next.name].id, null, n)
              running = true
              ctx.emit('smelt_start', { item: next.name, count: n, fuel: plan.fuel, fuelCount: plan.count, seconds: n * 10 })
            } else ctx.emit('smelt_blocked', { reason: 'no_fuel' })
          }
        }
      } catch (e) {
        ctx.log('Ofen: ' + e.message)
      } finally {
        try { f.close() } catch (_) {}
      }
      if (!running) break
      // --- Multitasking, 10 Sekunden lang ---
      await this.multitask(pos, token, 10000, idleRounds++)
    }
    // Fertig: Ofen einpacken (außer in der festen Basis)
    if (job.temp) {
      const b = bot.blockAt(pos)
      if (b && /furnace$/.test(b.name) && await a.reach(pos, 3.4, { token })) {
        await a.dig(bot.blockAt(pos), { token })
        await a.collectDrops(pos.offset(0.5, 0, 0.5), 4, { token, timeout: 5000 })
        ctx.emit('station_packed', { kind: 'furnace' })
      }
    }
    ctx.memory.furnaceJob = null
    ctx.emit('smelt_done', { smelted: job.smelted })
    await ctx.hotbar.organize(true)
    return true
  }

  async multitask (furnacePos, token, ms, round) {
    const { bot, ctx } = this
    const end = Date.now() + ms
    const tasks = [
      async () => { await ctx.hotbar.organize(true) },
      async () => { await ctx.gear.craftUpgrades(token, { quick: true }) },
      async () => { await this.patrol(furnacePos, token) },
      async () => { await ctx.mining.ensureTorches(token) }
    ]
    let i = round
    while (Date.now() < end) {
      token.check()
      await tasks[i++ % tasks.length]()
      if (Date.now() < end) { await this.patrol(furnacePos, token); await sleep(rand(600, 1200)) }
    }
    void bot
  }

  /** Umkreis (5 Blöcke) bewachen: ein paar Schritte gehen, sich umschauen. */
  async patrol (center, token) {
    const { bot, ctx } = this
    const ang = Math.random() * Math.PI * 2
    const r = rand(2.5, 5)
    const x = Math.floor(center.x + Math.cos(ang) * r)
    const z = Math.floor(center.z + Math.sin(ang) * r)
    await ctx.actions.goto(new goals.GoalNearXZ(x, z, 1), { token, timeout: 3500 })
    // Blick einmal über die Umgebung schweifen lassen
    const yaw = bot.entity.yaw + rand(-2.4, 2.4)
    await ctx.look.aimAngles(yaw, rand(-0.15, 0.1), { profile: 'idle', tolerance: 4, timeout: 1500 })
    await sleep(rand(300, 700))
  }
}

module.exports = { FoodPhase, RAW_FOOD, COOKED_FOOD, ANIMAL_LABEL }
