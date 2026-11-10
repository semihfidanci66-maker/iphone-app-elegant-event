'use strict'
/**
 * Pro-Player-Hotbar (Muscle-Memory-Layout). Läuft nur, wenn der Bot sicher ist.
 *  1 Schwert · 2 Spitzhacke · 3 Axt · 4 Schaufel/Bogen · 5 Bau-Blöcke · 6 Essen · 7 Fackeln · 8 Utility · 9 Wassereimer
 *  Off-Hand: Schild oder Totem
 */
const { sleep, rand } = require('./actions')

const TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']
const tiered = kind => TIERS.map(t => `${t}_${kind}`)

const FOOD_PRIORITY = ['enchanted_golden_apple', 'golden_apple', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_salmon', 'cooked_cod', 'bread', 'baked_potato', 'cooked_rabbit', 'apple', 'carrot', 'melon_slice', 'sweet_berries']
const BLOCK_PRIORITY = ['cobblestone', 'cobbled_deepslate', 'oak_planks', 'spruce_planks', 'birch_planks', 'dirt', 'netherrack', 'stone', 'andesite', 'diorite', 'granite']

const LAYOUT = [
  { slot: 0, label: 'Schwert', pick: a => a.findFirst(tiered('sword')) },
  { slot: 1, label: 'Spitzhacke', pick: a => a.findFirst(tiered('pickaxe')) },
  { slot: 2, label: 'Axt', pick: a => a.findFirst(tiered('axe')) },
  { slot: 3, label: 'Schaufel/Bogen', pick: a => a.find('bow') || a.find('crossbow') || a.findFirst(tiered('shovel')) },
  {
    slot: 4,
    label: 'Bau-Blöcke',
    pick: a => {
      // größter Stack des bevorzugten Baumaterials
      let best = null
      let bestScore = -1
      for (const it of a.items()) {
        const pr = BLOCK_PRIORITY.indexOf(it.name)
        const plank = /_planks$/.test(it.name)
        if (pr === -1 && !plank) continue
        const score = it.count + (pr === 0 ? 40 : 0) + (plank ? 5 : 0)
        if (score > bestScore) { best = it; bestScore = score }
      }
      return best
    }
  },
  { slot: 5, label: 'Essen', pick: a => a.findFirst(FOOD_PRIORITY) },
  { slot: 6, label: 'Fackeln', pick: a => a.find('torch') },
  { slot: 7, label: 'Utility', pick: a => a.findFirst(['flint_and_steel', 'crafting_table', 'furnace', 'bucket']) },
  { slot: 8, label: 'Wassereimer', pick: a => a.find('water_bucket') }
]

class HotbarManager {
  constructor (ctx) {
    this.ctx = ctx
    this.bot = ctx.bot
    this.lastRun = 0
    this.busy = false
  }

  /** @returns {Promise<number>} Anzahl der Umsortierungen */
  async organize (force = false) {
    const { bot, ctx } = this
    if (this.busy || bot.currentWindow) return 0
    if (!force && Date.now() - this.lastRun < 8000) return 0
    if (ctx.actions.locked || (ctx.combat && ctx.combat.engaged)) return 0
    this.busy = true
    this.lastRun = Date.now()
    let moved = 0
    try {
      for (const rule of LAYOUT) {
        if (ctx.combat && ctx.combat.engaged) break
        const want = rule.pick(ctx.actions)
        if (!want) continue
        const dest = 36 + rule.slot
        if (want.slot === dest) continue
        const cur = bot.inventory.slots[dest]
        if (cur && cur.name === want.name && cur.count >= want.count) continue
        try {
          await bot.moveSlotItem(want.slot, dest)
          moved++
          await sleep(rand(110, 240)) // menschliches Inventar-Tempo
        } catch (e) { ctx.log('Hotbar: ' + e.message); break }
      }
      moved += await this.equipOffhand()
      moved += await this.equipArmor()
    } finally {
      this.busy = false
    }
    if (moved) ctx.emit('hotbar', { moved })
    return moved
  }

  async equipOffhand () {
    const { bot, ctx } = this
    const off = bot.inventory.slots[45]
    const want = ctx.actions.find('totem_of_undying') && bot.health <= 8 ? 'totem_of_undying' : (ctx.actions.find('shield') ? 'shield' : (ctx.actions.find('totem_of_undying') ? 'totem_of_undying' : null))
    if (!want || (off && off.name === want)) return 0
    if (off && off.name === 'shield' && want !== 'totem_of_undying') return 0
    const it = ctx.actions.find(want)
    if (!it) return 0
    try { await bot.equip(it, 'off-hand'); await sleep(rand(120, 220)); return 1 } catch (_) { return 0 }
  }

  /** Beste Rüstung anlegen (im Nether zwingend ein Goldteil gegen Piglins). */
  async equipArmor () {
    const { bot, ctx } = this
    const parts = [['helmet', 'head', 5], ['chestplate', 'torso', 6], ['leggings', 'legs', 7], ['boots', 'feet', 8]]
    const order = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather']
    const rank = n => { const i = order.indexOf(n.split('_')[0]); return i === -1 ? 99 : i }
    const nether = bot.game.dimension && /nether/.test(bot.game.dimension)
    let changed = 0
    let goldWorn = [5, 6, 7, 8].some(s => bot.inventory.slots[s] && /^golden_/.test(bot.inventory.slots[s].name))
    for (const [part, dest, slot] of parts) {
      const cur = bot.inventory.slots[slot]
      let cands = ctx.actions.items().filter(i => i.name.endsWith('_' + part))
      if (!cands.length) continue
      cands.sort((a, b) => rank(a.name) - rank(b.name))
      let pick = cands[0]
      if (nether && !goldWorn) {
        const gold = cands.find(c => c.name.startsWith('golden_'))
        if (gold && (part === 'boots' || part === 'helmet')) { pick = gold; goldWorn = true }
      } else if (cur && rank(cur.name) <= rank(pick.name)) continue
      if (cur && cur.name === pick.name) continue
      if (nether && cur && /^golden_/.test(cur.name) && [5, 6, 7, 8].filter(s => bot.inventory.slots[s] && /^golden_/.test(bot.inventory.slots[s].name)).length === 1) continue
      try { await bot.equip(pick, dest); changed++; await sleep(rand(140, 260)) } catch (_) {}
    }
    return changed
  }
}

module.exports = { HotbarManager, LAYOUT, FOOD_PRIORITY, BLOCK_PRIORITY, tiered }
