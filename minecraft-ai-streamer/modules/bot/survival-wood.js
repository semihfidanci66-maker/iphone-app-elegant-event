'use strict'
/**
 * Phase 1: Natürliches Bäumefällen + saubere Werkbank-Etikette.
 */
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { sleep } = require('./actions')

class WoodPhase {
  constructor (ctx) {
    this.ctx = ctx
    this.bot = ctx.bot
    this.logIds = ctx.mcData.blocksArray.filter(b => /^(oak|birch|spruce|jungle|acacia|dark_oak|cherry|mangrove)_log$/.test(b.name)).map(b => b.id)
    this.badTrees = new Map() // "x,y,z" -> Zeitstempel (unerreichbare Bäume)
  }

  isLog (b) { return !!b && this.logIds.includes(b.type) }
  isLeaves (b) { return !!b && /_leaves$/.test(b.name) }

  /** Stammfuß eines natürlichen Baums (Erde darunter, Blätter darüber) – keine Häuser zerlegen. */
  findTree (maxDistance = 64) {
    const { bot, ctx } = this
    const found = bot.findBlocks({ matching: this.logIds, maxDistance, count: 120 })
    const seen = new Set()
    const trees = []
    const base = ctx.memory.base && ctx.memory.base.center
    for (const p of found) {
      let b = p.clone()
      while (this.isLog(bot.blockAt(b.offset(0, -1, 0)))) b = b.offset(0, -1, 0)
      const key = `${b.x},${b.y},${b.z}`
      if (seen.has(key)) continue
      seen.add(key)
      if (this.badTrees.has(key) && Date.now() - this.badTrees.get(key) < 300000) continue
      const soil = bot.blockAt(b.offset(0, -1, 0))
      if (!soil || !/dirt|grass_block|podzol|mycelium|moss|mud|rooted/.test(soil.name)) continue
      if (base && Math.hypot(b.x - base.x, b.z - base.z) < 9) continue
      let top = b.clone()
      let h = 1
      while (this.isLog(bot.blockAt(top.offset(0, 1, 0))) && h < 30) { top = top.offset(0, 1, 0); h++ }
      let leaves = false
      for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [0, 1, 1]]) {
        if (this.isLeaves(bot.blockAt(top.offset(dx, dy, dz)))) { leaves = true; break }
      }
      if (!leaves) continue
      const d = b.distanceTo(bot.entity.position)
      // normale 4–7er-Bäume bevorzugen; Riesenbäume sind Zeitverschwendung
      trees.push({ base: b, height: h, key, score: d + (h > 8 ? 30 : 0) + Math.abs(b.y - bot.entity.position.y) * 2 })
    }
    trees.sort((a, b) => a.score - b.score)
    return trees[0] || null
  }

  /** Alle zusammenhängenden Stämme (Äste bei großen Eichen/Akazien), begrenzt. */
  treeLogs (base) {
    const bot = this.bot
    const out = []
    const seen = new Set()
    const stack = [base]
    while (stack.length && out.length < 28) {
      const p = stack.pop()
      const k = `${p.x},${p.y},${p.z}`
      if (seen.has(k)) continue
      seen.add(k)
      if (!this.isLog(bot.blockAt(p))) continue
      out.push(p)
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) if (dx || dy || dz) stack.push(p.offset(dx, dy, dz))
    }
    return out
  }

  standSpot (base) {
    const { bot, ctx } = this
    const a = ctx.actions
    let best = null
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      for (const dy of [0, 1, -1]) {
        const p = base.offset(dx, dy, dz)
        if (a.isSolid(bot.blockAt(p.offset(0, -1, 0))) && !a.isSolid(bot.blockAt(p)) && !a.isSolid(bot.blockAt(p.offset(0, 1, 0))) && !a.isLiquid(bot.blockAt(p))) {
          const d = p.distanceTo(bot.entity.position) + Math.abs(dy) * 2 + (dx && dz ? 0.5 : 0)
          if (!best || d < best.d) best = { p, d }
          break
        }
      }
    }
    return best ? best.p : null
  }

  /**
   * Fällt einen Baum wie ein Mensch: erst alles Erreichbare über dem untersten Block, dann den
   * untersten Block als Tritt benutzen, um die oberen Stämme zu holen, und ihn ganz zum Schluss abbauen.
   */
  async chopTree (tree, token) {
    const { bot, ctx } = this
    const a = ctx.actions
    const base = tree.base
    const spot = this.standSpot(base)
    const ok = spot
      ? await a.goto(new goals.GoalNear(spot.x, spot.y, spot.z, 0), { token, timeout: 25000 })
      : await a.goto(new goals.GoalNear(base.x, base.y, base.z, 2), { token, timeout: 25000 })
    if (!ok || a.distToBlock(base) > 4.6) { this.badTrees.set(tree.key, Date.now()); return 0 }
    ctx.emit('tree_start', { height: tree.height, type: bot.blockAt(base)?.name })
    let chopped = 0
    const logs = () => this.treeLogs(base).sort((p, q) => p.y - q.y || p.distanceTo(base) - q.distanceTo(base))

    // 1) Vom Boden aus: alles Erreichbare ÜBER dem untersten Block, von unten nach oben
    const chopReachable = async (skipBase) => {
      let progress = true
      while (progress) {
        progress = false
        for (const p of logs()) {
          token.check()
          if (skipBase && p.equals(base)) continue
          if (a.distToBlock(p) > 4.45) continue
          const b = bot.blockAt(p)
          if (!this.isLog(b)) continue
          // Blätter im Weg (Sichtlinie) wegschlagen wie ein Spieler
          const r = await a.dig(b, { token })
          if (r === 'ok') { chopped++; progress = true }
        }
      }
    }
    await chopReachable(true)

    // 2) Sind oben noch Stämme? Dann den untersten Block als Tritt-Hocker benutzen
    let remaining = logs().filter(p => !p.equals(base))
    if (remaining.length && this.isLog(bot.blockAt(base))) {
      const head1 = bot.blockAt(base.offset(0, 1, 0))
      const head2 = bot.blockAt(base.offset(0, 2, 0))
      if (!a.isSolid(head1) && !a.isSolid(head2)) {
        const up = await a.goto(new goals.GoalBlock(base.x, base.y + 1, base.z), { token, timeout: 6000 })
        if (up) {
          await sleep(150)
          await chopReachable(true)
          // wieder runter neben den Stamm
          const down = this.standSpot(base)
          if (down) await a.goto(new goals.GoalNear(down.x, down.y, down.z, 0), { token, timeout: 6000 })
        }
      }
    }
    // 3) Der unterste Block kommt IMMER zuletzt
    if (this.isLog(bot.blockAt(base))) {
      if (a.distToBlock(base) > 4.4) await a.reach(base, 3, { token })
      const r = await a.dig(bot.blockAt(base), { token })
      if (r === 'ok') chopped++
    }
    remaining = logs()
    if (remaining.length > 2) this.badTrees.set(tree.key, Date.now()) // Rest hängt zu hoch
    // 4) Sammel-Lauf über alle Drops
    await a.collectDrops(base.offset(0.5, 0, 0.5), 6, { token })
    // 5) Setzling nachpflanzen – macht jeder anständige Survival-Spieler
    const sapling = a.findMatch(/_sapling$/)
    const soil = bot.blockAt(base.offset(0, -1, 0))
    if (sapling && soil && /dirt|grass_block|podzol/.test(soil.name) && a.isAir(bot.blockAt(base)) && !a.botOccupies(base)) {
      await a.placeAt(base, sapling.name, { token, sneak: false })
    }
    ctx.emit('tree_done', { logs: chopped, total: ctx.crafting.logCount() })
    return chopped
  }

  /** Sammelt Holz, bis mindestens `targetLogs` Stämme (bzw. Planken-Äquivalent) im Inventar sind. */
  async gather (targetLogs, token) {
    const { ctx, bot } = this
    let fails = 0
    while (ctx.crafting.woodValue() < targetLogs * 4) {
      token.check()
      const tree = this.findTree(64)
      if (!tree) {
        // kein Baum in Sicht: in eine neue Richtung erkunden
        if (++fails > 6) return false
        await ctx.explore(token, 40)
        continue
      }
      const n = await this.chopTree(tree, token)
      if (n === 0) fails++
      await ctx.hotbar.organize()
      void bot
    }
    return true
  }

  /** Holz-Grundausstattung: Planken, Stöcke, Werkbank, Holzspitzhacke/-schwert/-axt. */
  async craftWoodTools (token) {
    const { ctx } = this
    const c = ctx.crafting
    const a = ctx.actions
    const list = []
    if (a.pickTier() < 1) list.push(['wooden_pickaxe', 1])
    if (!a.bestTool('axe')) list.push(['wooden_axe', 1])
    if (!a.bestTool('sword')) list.push(['wooden_sword', 1])
    if (!list.length) return true
    const ok = await c.craftAtTable(list, token)
    await ctx.hotbar.organize(true)
    return ok || a.pickTier() >= 1
  }
}

module.exports = { WoodPhase }
