'use strict'
/**
 * Phase 5: Verzauberungstisch und Nether-Expedition.
 */
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { sleep, rand } = require('./actions')

const ENCHANT_DE = {
  sharpness: 'Schärfe', smite: 'Bann', bane_of_arthropods: 'Nemesis der Gliederfüßer', knockback: 'Rückstoß', fire_aspect: 'Verbrennung', looting: 'Plünderung', sweeping_edge: 'Schwungkraft', sweeping: 'Schwungkraft', unbreaking: 'Haltbarkeit', efficiency: 'Effizienz', fortune: 'Glück', silk_touch: 'Behutsamkeit', protection: 'Schutz', fire_protection: 'Feuerschutz', blast_protection: 'Explosionsschutz', projectile_protection: 'Schusssicher', thorns: 'Dornen', mending: 'Reparatur'
}
const PORTAL_FRAME = [[1, 0], [2, 0], [0, 1], [3, 1], [0, 2], [3, 2], [0, 3], [3, 3], [1, 4], [2, 4]]
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V']
const ITEM_DE = { diamond_sword: 'Diamantschwert', diamond_pickaxe: 'Diamantspitzhacke', diamond_chestplate: 'Diamantbrustplatte', iron_sword: 'Eisenschwert', iron_pickaxe: 'Eisenspitzhacke', iron_chestplate: 'Eisenbrustplatte' }

class EndgamePhase {
  constructor (ctx) {
    this.ctx = ctx
    this.bot = ctx.bot
  }

  // ================================================================ Verzaubern
  async harvestSugarCane (need, token) {
    const { bot, ctx } = this
    const a = ctx.actions
    const caneId = ctx.mcData.blocksByName.sugar_cane.id
    for (let round = 0; round < 12 && a.count('sugar_cane') + a.count('paper') < need; round++) {
      token.check()
      // nur die oberen Segmente ernten – der unterste Block bleibt stehen und wächst nach
      const tops = bot.findBlocks({ matching: caneId, maxDistance: 64, count: 60 })
        .filter(p => bot.blockAt(p.offset(0, -1, 0))?.type === caneId && bot.blockAt(p.offset(0, -2, 0))?.type !== caneId)
        .sort((p, q) => p.distanceTo(bot.entity.position) - q.distanceTo(bot.entity.position))
      if (!tops.length) { await ctx.explore(token, 48); continue }
      const p = tops[0]
      if (!(await a.reach(p, 3.5, { token, timeout: 40000 }))) continue
      await a.dig(bot.blockAt(p), { token })
      await a.collectDrops(p.offset(0.5, 0, 0.5), 4, { token, timeout: 5000 })
    }
    return a.count('sugar_cane') + a.count('paper') >= need
  }

  /** Buch (3 Papier + Leder) und Verzauberungstisch craften und aufstellen. */
  async setupEnchantingTable (token) {
    const { bot, ctx } = this
    const a = ctx.actions
    const c = ctx.crafting
    if (ctx.memory.enchantTable && bot.blockAt(this.vec(ctx.memory.enchantTable))?.name === 'enchanting_table') return true
    if (!a.find('enchanting_table')) {
      if (a.count('diamond') < 2 || a.count('obsidian') < 4) return false
      if (!a.find('book')) {
        if (a.count('paper') < 3 && !(await this.harvestSugarCane(3, token))) { ctx.emit('enchant_blocked', { reason: 'sugar_cane' }); return false }
        if (a.count('leather') < 1) {
          await ctx.food.hunt(3, token, ['cow', 'mooshroom'])
          if (a.count('leather') < 1) { ctx.emit('enchant_blocked', { reason: 'leather' }); return false }
        }
      }
      const ok = await c.craftAtTable([['paper', 3], ['book', 1], ['enchanting_table', 1]].filter(([n]) => !(n !== 'enchanting_table' && a.find('book'))), token)
      if (!ok || !a.find('enchanting_table')) return false
    }
    // Platz: Verzauberungs-Ecke im Haus, sonst neben dem Bot
    let spot = null
    if (ctx.memory.base && ctx.memory.base.done) {
      spot = ctx.building.world(5, 1, 1)
      await a.goto(new goals.GoalBlock(spot.x - 2, spot.y, spot.z + 1), { token, timeout: 40000 })
      if (!a.isReplaceable(bot.blockAt(spot))) spot = null
    }
    if (!spot) spot = c.findPlacementSpot(2, 3)
    if (!spot || !(await a.placeAt(spot, 'enchanting_table', { token }))) return false
    ctx.memory.enchantTable = { x: spot.x, y: spot.y, z: spot.z }
    ctx.memory.enchantTablePlaced = true
    ctx.emit('enchant_table', {})
    return true
  }

  vec (o) { return new Vec3(o.x, o.y, o.z) }

  enchantCandidates () {
    const { bot } = this
    const order = ['diamond_sword', 'diamond_pickaxe', 'diamond_chestplate', 'iron_sword', 'iron_pickaxe', 'iron_chestplate']
    const all = [...bot.inventory.items(), ...[5, 6, 7, 8].map(s => bot.inventory.slots[s]).filter(Boolean)]
    return order.map(n => all.find(i => i.name === n && (!i.enchants || i.enchants.length === 0))).filter(Boolean)
  }

  canEnchantNow () {
    const { bot, ctx } = this
    return !!ctx.memory.enchantTable && ctx.actions.count('lapis_lazuli') >= 1 && (bot.experience?.level || 0) >= 1 && this.enchantCandidates().length > 0
  }

  /** Öffnet das Verzauberungs-GUI, legt Item + Lapis ein und wählt die höchste verfügbare Stufe. */
  async enchantGear (token) {
    const { bot, ctx } = this
    const a = ctx.actions
    if (!ctx.memory.enchantTable) return false
    const pos = this.vec(ctx.memory.enchantTable)
    let did = 0
    for (let round = 0; round < 3; round++) {
      token.check()
      let item = this.enchantCandidates()[0]
      const lapis = a.find('lapis_lazuli')
      const level = bot.experience?.level || 0
      if (!item || !lapis || level < 1) break
      if (item.slot >= 5 && item.slot <= 8) {
        // getragene Rüstung erst ausziehen
        const dest = ['head', 'torso', 'legs', 'feet'][item.slot - 5]
        const name = item.name
        try { await bot.unequip(dest) } catch (_) { break }
        await sleep(200)
        item = a.find(name)
        if (!item) break
      }
      const block = bot.blockAt(pos)
      if (!block || block.name !== 'enchanting_table') { ctx.memory.enchantTable = null; return false }
      if (!(await a.reach(pos, 3, { token, timeout: 40000 }))) return false
      a.stopMoving()
      await ctx.look.aim(pos.offset(0.5, 0.75, 0.5), { profile: 'work' })
      let table
      try { table = await bot.openEnchantmentTable(block) } catch (e) { ctx.log('Verzauberungstisch: ' + e.message); return false }
      try {
        await table.putTargetItem(item)
        await sleep(rand(250, 400))
        await table.putLapis(lapis)
        await new Promise(resolve => { const t = setTimeout(resolve, 2500); table.once('ready', () => { clearTimeout(t); resolve() }) })
        let choice = -1
        const lapisCount = lapis.count
        for (let i = 2; i >= 0; i--) {
          const e = table.enchantments[i]
          if (e && e.level > 0 && e.level <= level && lapisCount >= i + 1) { choice = i; break }
        }
        if (choice === -1) { await table.takeTargetItem().catch(() => {}); break }
        const expected = table.enchantments[choice].expected
        await sleep(rand(500, 900)) // kurz "überlegen" – wie jeder Spieler vor dem Klick
        await table.enchant(choice)
        const result = await table.takeTargetItem()
        const real = (result && result.enchants && result.enchants[0]) || null
        const key = real ? real.name : (expected && ctx.mcData.enchantments[expected.enchant]?.name)
        const lvl = real ? real.lvl : (expected ? expected.level : 1)
        did++
        ctx.emit('enchanted', {
          item: item.name,
          itemLabel: ITEM_DE[item.name] || item.name,
          enchant: key,
          enchantLabel: `${ENCHANT_DE[key] || key || 'Verzauberung'} ${ROMAN[lvl] || lvl}`.trim(),
          cost: choice + 1
        })
      } catch (e) {
        ctx.log('Verzaubern: ' + e.message)
        try { await table.takeTargetItem() } catch (_) {}
        break
      } finally {
        try { table.close() } catch (_) {}
      }
      await sleep(400)
    }
    await ctx.hotbar.organize(true)
    return did > 0
  }

  // ================================================================ Nether-Portal
  isPortalBlock (pos) {
    const f = this.ctx.memory.portalFrame
    if (!f) return false
    return pos.x >= f.x - 1 && pos.x <= f.x + 4 && pos.z >= f.z - 1 && pos.z <= f.z + 1 && pos.y >= f.y - 1 && pos.y <= f.y + 5
  }

  /** Wie viele Obsidian-Blöcke fehlen dem (ggf. angefangenen) Rahmen noch? */
  portalRemaining () {
    const f = this.ctx.memory.portalFrame
    if (!f) return PORTAL_FRAME.length
    const o = this.vec(f)
    return PORTAL_FRAME.filter(([i, j]) => this.bot.blockAt(o.offset(i, j, 0))?.name !== 'obsidian').length
  }

  /** Ebene 4x1-Linie mit 5 Blöcken Luft darüber (Portal steht in X-Richtung). */
  findPortalSite () {
    const { bot, ctx } = this
    const a = ctx.actions
    const p = ctx.actions.feet()
    for (let r = 3; r <= 14; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
          for (const dy of [0, 1, -1, 2, -2]) {
            const o = p.offset(dx, dy - 1, dz) // o = Bodenhöhe (Block), linke untere Ecke
            let ok = !ctx.isBaseBlock(o) && !ctx.isBaseBlock(o.offset(3, 0, 0))
            for (let i = 0; i < 4 && ok; i++) {
              if (!a.isSolid(bot.blockAt(o.offset(i, 0, 0)))) ok = false
              for (let j = 1; j <= 5 && ok; j++) if (!a.isReplaceable(bot.blockAt(o.offset(i, j, 0))) || a.isLiquid(bot.blockAt(o.offset(i, j, 0)))) ok = false
              // Standfläche davor
              if (ok && (!a.isSolid(bot.blockAt(o.offset(i, 0, 1))) || a.isSolid(bot.blockAt(o.offset(i, 1, 1))) || a.isSolid(bot.blockAt(o.offset(i, 2, 1))))) ok = false
            }
            if (ok) return o
          }
        }
      }
    }
    return null
  }

  /**
   * Baut den 4x5-Obsidianrahmen Block für Block (Ecken werden wie bei Profis gespart: 10 Obsidian),
   * zündet ihn mit dem Feuerzeug an.
   */
  async buildPortal (token) {
    const { bot, ctx } = this
    const a = ctx.actions
    if (ctx.memory.portal && bot.blockAt(this.vec(ctx.memory.portal))?.name === 'nether_portal') return true
    if (!a.find('flint_and_steel')) return false
    let o = ctx.memory.portalFrame ? this.vec(ctx.memory.portalFrame) : null
    if (!o) {
      if (ctx.memory.base && ctx.memory.base.done) {
        const c = ctx.memory.base.center
        await a.goto(new goals.GoalNear(c.x, c.y, c.z - 9, 3), { token, timeout: 60000 })
      }
      o = this.findPortalSite()
      if (!o) { await ctx.explore(token, 24); return false }
      ctx.memory.portalFrame = { x: o.x, y: o.y, z: o.z }
      ctx.emit('portal_start', {})
    }
    const frame = PORTAL_FRAME
    const missing = frame.filter(([i, j]) => bot.blockAt(o.offset(i, j, 0))?.name !== 'obsidian')
    if (a.count('obsidian') < missing.length) return false
    const stand = o.offset(1, 1, 1)
    await a.goto(new goals.GoalBlock(stand.x, stand.y, stand.z), { token, timeout: 30000 })
    // Innenraum freiräumen
    for (let i = 1; i <= 2; i++) for (let j = 1; j <= 3; j++) await a.digUntilClear(o.offset(i, j, 0), { token, clearPlants: true })
    let temp = null
    for (const [i, j] of frame) {
      token.check()
      const pos = o.offset(i, j, 0)
      const cur = bot.blockAt(pos)
      if (cur && cur.name === 'obsidian') continue
      if (a.distToBlock(pos) > 4.3 || a.botOccupies(pos)) await a.goto(new goals.GoalBlock(stand.x + (i >= 2 ? 1 : 0), stand.y, stand.z), { token, timeout: 8000 })
      if (cur && !a.isReplaceable(cur)) { await a.dig(cur, { token }); await bot.waitForTicks(2) }
      if (j === 4 && i === 1 && !a.isSolid(bot.blockAt(o.offset(0, 4, 0)))) {
        // Hilfsblock auf die linke Säule, damit der obere Riegel eine Anlegefläche hat
        const filler = a.findFirst(['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack'])
        if (filler && await a.placeAt(o.offset(0, 4, 0), filler.name, { token })) temp = o.offset(0, 4, 0)
      }
      const ok = await a.placeAt(pos, 'obsidian', { token })
      if (!ok) { ctx.log(`Portal: Obsidian (${i},${j}) nicht gesetzt`); return false }
      ctx.emit('portal_progress', { placed: frame.length - frame.filter(([x, y]) => bot.blockAt(o.offset(x, y, 0))?.name !== 'obsidian').length, total: frame.length })
    }
    if (temp) { const t = bot.blockAt(temp); if (t && t.name !== 'obsidian') await a.dig(t, { token }) }
    // Anzünden: Feuerzeug auf die Oberseite des unteren Obsidians
    await a.goto(new goals.GoalBlock(stand.x, stand.y, stand.z), { token, timeout: 8000 })
    const bottom = bot.blockAt(o.offset(1, 0, 0))
    await a.equip('flint_and_steel')
    await ctx.look.aim(bottom.position.offset(0.5, 1, 0.4), { profile: 'work' })
    await bot.activateBlock(bottom, new Vec3(0, 1, 0))
    await sleep(900)
    const inside = o.offset(1, 1, 0)
    if (bot.blockAt(inside)?.name !== 'nether_portal') { ctx.emit('portal_failed', {}); return false }
    ctx.memory.portal = { x: inside.x, y: inside.y, z: inside.z }
    ctx.emit('portal_lit', {})
    return true
  }

  dimension () { return this.bot.game.dimension || 'overworld' }
  inNether () { return /nether/.test(this.dimension()) }

  async stepThroughPortal (portalPos, token, moves) {
    const { bot, ctx } = this
    const from = this.dimension()
    if (!(await ctx.actions.goto(new goals.GoalBlock(portalPos.x, portalPos.y, portalPos.z), { token, timeout: 60000, moves }))) {
      if (bot.entity.position.distanceTo(portalPos.offset(0.5, 0, 0.5)) > 1.2) return false
    }
    ctx.actions.stopMoving()
    const end = Date.now() + 15000
    while (Date.now() < end) {
      token.check()
      if (this.dimension() !== from) { await sleep(2500); ctx.look.syncFromEntity(); return true }
      await sleep(250)
    }
    return false
  }

  nearestPortalBlock (maxDistance = 24) {
    const id = this.ctx.mcData.blocksByName.nether_portal.id
    const ps = this.bot.findBlocks({ matching: id, maxDistance, count: 12 })
    if (!ps.length) return null
    ps.sort((p, q) => p.y - q.y || p.distanceTo(this.bot.entity.position) - q.distanceTo(this.bot.entity.position))
    return ps[0]
  }

  /**
   * Nether-Expedition: Goldteil anlegen (Piglins bleiben neutral), Festung suchen, Blazes mit
   * Schild bekämpfen (übernimmt der Kampf-Reflex), Lohenruten einsammeln, sicher zurück.
   */
  async netherExpedition (token, rodsWanted = 2) {
    const { bot, ctx } = this
    const a = ctx.actions
    if (!this.inNether()) {
      if (!ctx.memory.portal) return false
      const gold = a.findFirst(['golden_boots', 'golden_helmet'])
      if (gold) { try { await bot.equip(gold, gold.name.endsWith('boots') ? 'feet' : 'head') } catch (_) {} }
      const hasGold = [5, 6, 7, 8].some(s => bot.inventory.slots[s] && /^golden_/.test(bot.inventory.slots[s].name))
      ctx.emit('nether_enter', { gold: hasGold })
      if (!(await this.stepThroughPortal(this.vec(ctx.memory.portal), token))) return false
      const np = this.nearestPortalBlock()
      if (np) ctx.memory.netherPortal = { x: np.x, y: np.y, z: np.z }
      ctx.memory.netherStart = Date.now()
      ctx.emit('nether_arrived', {})
    }
    const started = ctx.memory.netherStart || Date.now()
    let heading = Math.random() * Math.PI * 2
    const bricksId = ctx.mcData.blocksByName.nether_bricks.id
    const spawnerId = ctx.mcData.blocksByName.spawner.id
    let fortressSeen = false
    while (a.count('blaze_rod') < rodsWanted) {
      token.check()
      const lowSupplies = bot.health < 9 || (bot.food < 8 && !ctx.combat.edible())
      if (Date.now() - started > 12 * 60000 || lowSupplies) { ctx.emit('nether_retreat', { reason: lowSupplies ? 'supplies' : 'time' }); break }
      await ctx.food.eatIfNeeded(token)
      // herumliegende Lohenruten zuerst
      const rod = Object.values(bot.entities).find(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 16)
      if (rod) await a.collectDrops(bot.entity.position, 16, { token, timeout: 8000, moves: a.netherMoves })
      const spawner = bot.findBlock({ matching: spawnerId, maxDistance: 48 })
      if (spawner) {
        if (!fortressSeen) { fortressSeen = true; ctx.emit('fortress_found', { spawner: true }) }
        // in Schlagdistanz zum Spawner warten – die Blazes kommen von selbst
        await a.goto(new goals.GoalNear(spawner.position.x, spawner.position.y, spawner.position.z, 5), { token, timeout: 40000, moves: a.netherMoves })
        await sleep(1500)
        continue
      }
      const bricks = bot.findBlock({ matching: bricksId, maxDistance: 96 })
      if (bricks) {
        if (!fortressSeen) { fortressSeen = true; ctx.emit('fortress_found', { spawner: false }) }
        const ok = await a.goto(new goals.GoalNear(bricks.position.x, bricks.position.y + 1, bricks.position.z, 3), { token, timeout: 60000, moves: a.netherMoves })
        if (ok) { heading += rand(-0.6, 0.6); await this.exploreNether(heading, 20, token) }
        continue
      }
      if (!(await this.exploreNether(heading, 32, token))) heading += rand(0.8, 1.6)
    }
    // Rückweg
    const back = ctx.memory.netherPortal ? this.vec(ctx.memory.netherPortal) : this.nearestPortalBlock(128)
    if (!back) { ctx.emit('nether_lost', {}); return a.count('blaze_rod') >= rodsWanted }
    ctx.emit('nether_return', { rods: a.count('blaze_rod') })
    for (let i = 0; i < 3 && this.inNether(); i++) await this.stepThroughPortal(back, token, a.netherMoves)
    if (!this.inNether()) ctx.emit('nether_home', { rods: a.count('blaze_rod') })
    return a.count('blaze_rod') >= rodsWanted
  }

  async exploreNether (heading, dist, token) {
    const { bot, ctx } = this
    const p = bot.entity.position
    const x = Math.floor(p.x + Math.cos(heading) * dist)
    const z = Math.floor(p.z + Math.sin(heading) * dist)
    return ctx.actions.goto(new goals.GoalNearXZ(x, z, 4), { token, timeout: 45000, moves: ctx.actions.netherMoves })
  }
}

module.exports = { EndgamePhase, ENCHANT_DE }
