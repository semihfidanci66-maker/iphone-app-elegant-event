'use strict'
/**
 * Crafting mit sauberer Werkbank-Etikette: Werkbank hinstellen, craften und – außerhalb der
 * Basis – mit der Axt wieder abbauen und mitnehmen. Kein Müll in der Welt.
 */
const { Vec3 } = require('vec3')
const { sleep, rand } = require('./actions')

const INTERMEDIATE = /_planks$|^stick$|^paper$|^book$|^crafting_table$|^torch$|^chest$/

class Crafting {
  constructor (ctx) {
    this.ctx = ctx
    this.bot = ctx.bot
    this.table = null // aktuell benutzte Werkbank (Block)
  }

  id (name) { return this.ctx.mcData.itemsByName[name]?.id }
  nameOf (id) { return this.ctx.mcData.items[id]?.name }

  logItems () { return this.ctx.actions.items().filter(i => /(_log|_stem)$/.test(i.name)) }
  logCount () { return this.logItems().reduce((n, i) => n + i.count, 0) }
  plankCount () { return this.ctx.actions.countMatch(/_planks$/) }
  /** Holz gesamt in Planken-Äquivalent */
  woodValue () { return this.plankCount() + this.logCount() * 4 }

  plankNameFor (logName) {
    return logName.replace(/^stripped_/, '').replace(/(_log|_stem|_wood|_hyphae)$/, '_planks')
  }

  async ensurePlanks (n, token) {
    while (this.plankCount() < n) {
      if (token) token.check()
      const log = this.logItems()[0]
      if (!log) return false
      const need = Math.min(log.count, Math.ceil((n - this.plankCount()) / 4))
      const ok = await this.craftDirect(this.plankNameFor(log.name), need * 4, token)
      if (!ok) return false
    }
    return true
  }

  async ensureSticks (n, token) {
    if (this.ctx.actions.count('stick') >= n) return true
    const batches = Math.ceil((n - this.ctx.actions.count('stick')) / 4)
    if (!(await this.ensurePlanks(batches * 2, token))) return false
    return this.craftDirect('stick', n, token)
  }

  /** Craftet, wenn die Zutaten jetzt im Inventar liegen. count = gewünschter Gesamtbestand. */
  async craftDirect (name, count, token) {
    const { bot, ctx } = this
    const itemId = this.id(name)
    if (!itemId) return false
    const have = ctx.actions.count(name)
    if (have >= count) return true
    const recipes = bot.recipesFor(itemId, null, 1, this.table)
    if (!recipes.length) return false
    const recipe = recipes[0]
    const times = Math.ceil((count - have) / recipe.result.count)
    if (token) token.check()
    ctx.actions.stopMoving()
    try {
      if (this.table) await ctx.look.aim(this.table.position.offset(0.5, 0.9, 0.5), { profile: 'work', timeout: 900 })
      // so oft wie möglich (bis times) – recipesFor garantiert nur 1x
      let done = 0
      for (; done < times; done++) {
        if (!bot.recipesFor(itemId, null, 1, this.table).length) break
        await bot.craft(recipe, 1, this.table || undefined)
        if (done % 4 === 3) await sleep(rand(60, 120))
      }
      if (done > 0) ctx.emit('craft', { item: name, count: done * recipe.result.count })
      await sleep(rand(120, 260))
      return ctx.actions.count(name) >= count || done >= times
    } catch (e) {
      ctx.log(`craft(${name}) fehlgeschlagen: ${e.message}`)
      return false
    }
  }

  /**
   * Craftet name bis zum Bestand count, löst Zwischenprodukte (Planken, Stöcke, Papier …) rekursiv auf.
   */
  async craft (name, count = 1, token, depth = 0) {
    const { bot, ctx } = this
    if (ctx.actions.count(name) >= count) return true
    if (/_planks$/.test(name)) { if (await this.craftDirect(name, count, token)) return true; return this.ensurePlanks(count, token) }
    if (name === 'stick') return this.ensureSticks(count, token)
    if (await this.craftDirect(name, count, token)) return true
    if (depth >= 3) return false
    const itemId = this.id(name)
    if (!itemId) return false
    const all = bot.recipesAll(itemId, null, this.table || true)
    if (!all.length) return false
    const have = ctx.actions.count(name)
    // Rezepte nach "wie viel fehlt" sortieren
    const scored = all.slice(0, 24).map(r => {
      const times = Math.ceil((count - have) / r.result.count)
      let missing = 0
      for (const d of r.delta) {
        if (d.count >= 0) continue
        const n = this.nameOf(d.id)
        const lack = Math.max(0, -d.count * times - ctx.actions.count(n))
        if (lack > 0) missing += INTERMEDIATE.test(n) ? 1 : 100
      }
      return { r, times, missing }
    }).sort((a, b) => a.missing - b.missing)
    for (const { r, times, missing } of scored.slice(0, 3)) {
      if (missing >= 100) break
      let ok = true
      for (const d of r.delta) {
        if (d.count >= 0) continue
        const n = this.nameOf(d.id)
        const need = -d.count * times
        if (ctx.actions.count(n) >= need) continue
        if (!(await this.craft(n, need, token, depth + 1))) { ok = false; break }
      }
      if (ok && await this.craftDirect(name, count, token)) return true
    }
    return false
  }

  // ---------------------------------------------------------------- Werkbank-Etikette
  findNearbyBlock (name, maxDistance = 5) {
    const id = this.ctx.mcData.blocksByName[name]?.id
    if (id === undefined) return null
    const pos = this.bot.findBlock({ matching: id, maxDistance })
    return pos || null
  }

  /** Freie, flache Stelle direkt neben dem Bot (fester Boden, Luft darüber). */
  findPlacementSpot (minDist = 1, maxDist = 2) {
    const { bot, ctx } = this
    const a = ctx.actions
    const base = ctx.actions.feet()
    const yaw = bot.entity.yaw
    const fx = -Math.sin(yaw)
    const fz = -Math.cos(yaw)
    const cands = []
    for (let dx = -maxDist; dx <= maxDist; dx++) {
      for (let dz = -maxDist; dz <= maxDist; dz++) {
        const m = Math.max(Math.abs(dx), Math.abs(dz))
        if (m < minDist) continue
        for (const dy of [0, 1, -1]) {
          const p = base.offset(dx, dy, dz)
          const here = bot.blockAt(p)
          const below = bot.blockAt(p.offset(0, -1, 0))
          const above = bot.blockAt(p.offset(0, 1, 0))
          if (!a.isSolid(below) || !a.isReplaceable(here) || a.isLiquid(here) || a.isSolid(above)) continue
          if (/_door$|chest|furnace|crafting_table/.test(below.name)) continue
          // bevorzugt vor dem Bot, auf gleicher Höhe
          const front = dx * fx + dz * fz
          cands.push({ p, score: front * 2 - Math.abs(dy) * 3 - m * 0.5 })
          break
        }
      }
    }
    cands.sort((x, y) => y.score - x.score)
    return cands.length ? cands[0].p : null
  }

  /**
   * Stellt eine Station (crafting_table/furnace) bereit, führt fn(block) aus und räumt danach auf.
   * In der Basis bleibt die Station stehen (keep) – unterwegs wird sie wieder eingepackt.
   */
  async withStation (kind, token, fn, o = {}) {
    const { bot, ctx } = this
    let block = this.findNearbyBlock(kind, 4.5)
    let placedHere = false
    if (!block) {
      if (!ctx.actions.find(kind)) {
        if (kind === 'crafting_table') {
          if (!(await this.ensurePlanks(4, token)) || !(await this.craftDirect('crafting_table', 1, token))) return false
        } else return false
      }
      const spot = this.findPlacementSpot()
      if (!spot) { ctx.log(`Kein Platz für ${kind}`); return false }
      if (!(await ctx.actions.placeAt(spot, kind, { token }))) return false
      await bot.waitForTicks(3)
      block = bot.blockAt(spot)
      if (!block || block.name !== kind) return false
      placedHere = true
      ctx.emit('station_placed', { kind })
    } else if (ctx.actions.distToBlock(block.position) > 3.5) {
      await ctx.actions.reach(block.position, 3, { token })
    }
    const inBase = ctx.memory.base && ctx.memory.base.center && new Vec3(ctx.memory.base.center.x, ctx.memory.base.center.y, ctx.memory.base.center.z).distanceTo(block.position) < 8
    let result
    const prevTable = this.table
    if (kind === 'crafting_table') this.table = block
    try {
      result = await fn(block)
    } finally {
      if (kind === 'crafting_table') this.table = prevTable
      if (placedHere && !o.keep && !inBase && !(token && token.cancelled)) {
        // Werkbank/Ofen wieder mitnehmen (Axt bzw. Spitzhacke wird automatisch gewählt)
        try {
          const b = bot.blockAt(block.position)
          if (b && b.name === kind) {
            await ctx.actions.dig(b, { token })
            await ctx.actions.collectDrops(block.position.offset(0.5, 0, 0.5), 4, { token, timeout: 5000 })
            ctx.emit('station_packed', { kind })
          }
        } catch (e) { if (!e.isInterrupt) ctx.log('Einpacken: ' + e.message) }
      } else if (placedHere && (token && token.cancelled)) {
        ctx.memory.leftStations = ctx.memory.leftStations || []
        ctx.memory.leftStations.push({ kind, pos: { x: block.position.x, y: block.position.y, z: block.position.z } })
      }
    }
    return result
  }

  withTable (token, fn, o) { return this.withStation('crafting_table', token, fn, o) }

  /** Unterwegs stehen gelassene Stationen (z. B. wegen Kampf-Unterbrechung) nachträglich einsammeln. */
  async recoverLeftStations (token) {
    const { bot, ctx } = this
    const list = ctx.memory.leftStations || []
    while (list.length) {
      const s = list[0]
      const pos = new Vec3(s.pos.x, s.pos.y, s.pos.z)
      if (pos.distanceTo(bot.entity.position) < 48) {
        const b = bot.blockAt(pos)
        if (b && b.name === s.kind && await ctx.actions.reach(pos, 3.5, { token })) {
          await ctx.actions.dig(bot.blockAt(pos), { token })
          await ctx.actions.collectDrops(pos, 4, { token, timeout: 5000 })
        }
      }
      list.shift()
    }
  }

  /** Mehrere Items in einer Werkbank-Sitzung craften. list: [[name, bestand], ...] */
  async craftAtTable (list, token, o = {}) {
    const need = list.filter(([n, c]) => this.ctx.actions.count(n) < c)
    if (!need.length) return true
    const res = await this.withTable(token, async () => {
      let all = true
      for (const [name, count] of need) {
        if (token) token.check()
        const ok = await this.craft(name, count, token)
        if (!ok) all = false
      }
      return all
    }, o)
    return !!res
  }
}

module.exports = { Crafting }
