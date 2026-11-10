'use strict'
/**
 * Ausrüstungs-Progression: Stein -> Eisen -> Diamant, Schild, Eimer, Bett, Goldstiefel.
 */
const { goals } = require('mineflayer-pathfinder')
const { sleep } = require('./actions')

class Gear {
  constructor (ctx) {
    this.ctx = ctx
    this.bot = ctx.bot
  }

  cobble () { const a = this.ctx.actions; return a.count('cobblestone') + a.count('cobbled_deepslate') }
  has (n) { return this.ctx.actions.count(n) > 0 }
  wearing (re) { return [5, 6, 7, 8, 45].some(s => this.bot.inventory.slots[s] && re.test(this.bot.inventory.slots[s].name)) }
  owns (n) { return this.has(n) || this.wearing(new RegExp('^' + n + '$')) }

  tierOf (kind) {
    const it = this.ctx.actions.bestTool(kind)
    if (!it) return 0
    return { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 }[it.name.split('_')[0]] || 0
  }

  /** Was lässt sich mit dem aktuellen Inventar sinnvoll verbessern? (Reihenfolge = Priorität) */
  plan () {
    const a = this.ctx.actions
    const list = []
    let cobble = this.cobble()
    let iron = a.count('iron_ingot')
    let dia = a.count('diamond')
    let gold = a.count('gold_ingot')
    const take = (pool, n) => pool >= n
    // --- Diamant ---
    if (this.tierOf('pickaxe') < 4 && take(dia, 3)) { list.push(['diamond_pickaxe', 1]); dia -= 3 }
    const reserveTable = this.ctx.memory.enchantTablePlaced || this.has('enchanting_table') ? 0 : 2
    if (this.tierOf('sword') < 4 && take(dia - reserveTable, 2)) { list.push(['diamond_sword', 1]); dia -= 2 }
    if (!this.owns('diamond_chestplate') && take(dia - reserveTable, 8)) { list.push(['diamond_chestplate', 1]); dia -= 8 }
    // --- Eisen ---
    if (this.tierOf('pickaxe') < 3 && take(iron, 3)) { list.push(['iron_pickaxe', 1]); iron -= 3 }
    if (!this.owns('shield') && take(iron, 1)) { list.push(['shield', 1]); iron -= 1 }
    if (this.tierOf('sword') < 3 && take(iron, 2)) { list.push(['iron_sword', 1]); iron -= 2 }
    if (!this.has('bucket') && !this.has('water_bucket') && !this.has('lava_bucket') && take(iron, 3)) { list.push(['bucket', 1]); iron -= 3 }
    if (!this.owns('flint_and_steel') && this.has('flint') && take(iron, 1) && this.tierOf('pickaxe') >= 4) { list.push(['flint_and_steel', 1]); iron -= 1 }
    if (!this.wearing(/_chestplate$/) && !this.has('iron_chestplate') && take(iron, 8)) { list.push(['iron_chestplate', 1]); iron -= 8 }
    if (!this.wearing(/_leggings$/) && !this.has('iron_leggings') && take(iron, 7)) { list.push(['iron_leggings', 1]); iron -= 7 }
    if (!this.wearing(/_helmet$/) && !this.has('iron_helmet') && take(iron, 5)) { list.push(['iron_helmet', 1]); iron -= 5 }
    if (!this.wearing(/_boots$/) && !this.has('iron_boots') && !this.has('golden_boots') && take(iron, 4)) { list.push(['iron_boots', 1]); iron -= 4 }
    if (this.tierOf('axe') < 3 && take(iron, 3)) { list.push(['iron_axe', 1]); iron -= 3 }
    // --- Gold (Piglin-Schutz für den Nether) ---
    if (!this.owns('golden_boots') && !this.owns('golden_helmet') && take(gold, 4)) { list.push(['golden_boots', 1]); gold -= 4 }
    // --- Stein ---
    if (this.tierOf('pickaxe') < 2 && take(cobble, 3)) { list.push(['stone_pickaxe', 1]); cobble -= 3 }
    if (this.tierOf('sword') < 2 && take(cobble, 2)) { list.push(['stone_sword', 1]); cobble -= 2 }
    if (this.tierOf('axe') < 2 && take(cobble, 3)) { list.push(['stone_axe', 1]); cobble -= 3 }
    if (this.tierOf('shovel') < 2 && take(cobble, 1)) { list.push(['stone_shovel', 1]); cobble -= 1 }
    if (!this.has('furnace') && !this.ctx.memory.furnaceJob && !(this.ctx.memory.base && this.ctx.memory.base.done) && take(cobble, 8)) { list.push(['furnace', 1]); cobble -= 8 }
    // --- Bett ---
    if (!this.ctx.actions.findMatch(/_bed$/) && !this.ctx.memory.bedPlaced && this.sameWool() >= 3) list.push([this.sameWoolName().replace('_wool', '_bed'), 1])
    return list
  }

  sameWoolName () {
    let best = null
    for (const it of this.ctx.actions.items()) if (/_wool$/.test(it.name) && (!best || it.count > best.count)) best = it
    return best ? best.name : 'white_wool'
  }

  sameWool () { return this.ctx.actions.count(this.sameWoolName()) }

  async craftUpgrades (token, o = {}) {
    const { ctx } = this
    const list = this.plan()
    if (!list.length) return false
    const before = list.map(([n]) => ctx.actions.count(n))
    // Stöcke/Planken vorab (ohne Werkbank), damit die Sitzung an der Werkbank kurz bleibt
    await ctx.crafting.ensureSticks(Math.min(8, list.length * 2), token)
    const ok = await ctx.crafting.craftAtTable(o.quick ? list.slice(0, 2) : list, token)
    const made = list.filter(([n], i) => ctx.actions.count(n) > before[i]).map(([n]) => n)
    if (made.length) {
      ctx.emit('gear', { items: made })
      await ctx.hotbar.organize(true)
    }
    return ok
  }

  /** Leeren Eimer an einer Wasserquelle füllen (Slot 9: Notfall-Wasser). */
  async fillWaterBucket (token) {
    const { bot, ctx } = this
    const a = ctx.actions
    if (this.has('water_bucket')) return true
    if (!this.has('bucket')) return false
    const waterId = ctx.mcData.blocksByName.water.id
    const spots = bot.findBlocks({ matching: waterId, maxDistance: 48, count: 60 }).filter(p => {
      const b = bot.blockAt(p)
      return b && b.metadata === 0 && a.isAir(bot.blockAt(p.offset(0, 1, 0)))
    })
    if (!spots.length) return false
    spots.sort((p, q) => p.distanceTo(bot.entity.position) - q.distanceTo(bot.entity.position))
    const w = spots[0]
    if (!(await a.goto(new goals.GoalNear(w.x, w.y + 1, w.z, 2), { token, timeout: 40000 }))) return false
    await ctx.mining.useBucket('bucket', w.offset(0.5, 0.9, 0.5), token)
    await sleep(400)
    if (this.has('water_bucket')) { ctx.emit('water_bucket', {}); await ctx.hotbar.organize(true); return true }
    return false
  }
}

module.exports = { Gear }
