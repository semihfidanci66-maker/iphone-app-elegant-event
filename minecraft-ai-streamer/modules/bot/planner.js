'use strict'
/**
 * GOAP (Goal-Oriented Action Planning) für den Survival-Durchlauf.
 *
 * - Fakten werden bei jedem Planungsschritt frisch aus Inventar/Welt gelesen (nie geraten).
 * - Aktionen haben Vorbedingungen, Effekte und Kosten; der Planer löst ein Ziel per
 *   Rückwärtsverkettung in eine geordnete Aktionsfolge auf.
 * - Nach JEDER Aktion wird neu geplant – Tod, Gifts oder Zuschauerwünsche ändern den Plan sofort.
 */

// Aktionen, die unter Tage führen – nur mit Höhlen-Freigabe (Dashboard) oder als EIN automatischer Kurztrip
const UNDERGROUND = new Set(['MineIron', 'MineDiamonds', 'MineLapis', 'MineObsidian4', 'MineObsidian10', 'GetGold'])

const GOAL_LABEL = {
  woodKit: 'Holzwerkzeug', bed: 'Bett craften', stoneKit: 'Steinwerkzeug & Ofen', food: 'Essensvorrat', ironKit: 'Eisenausrüstung & Schild', waterBucket: 'Wassereimer', base: 'Haus bauen', diamondPick: 'Diamantspitzhacke', enchanted: 'Ausrüstung verzaubern', blazeRods: 'Nether & Lohenruten', diamonds: 'Diamanten', portal: 'Netherportal'
}

class Planner {
  constructor (ctx) {
    this.ctx = ctx
    this.cooldowns = new Map() // Aktionsname -> bis wann gesperrt
    this.failures = new Map()
    this.goalStack = [] // Zuschauer-/Operator-Ziele (oben = höchste Priorität)
    this.progression = ['woodKit', 'stoneKit', 'food', 'bed', 'ironKit', 'waterBucket', 'base', 'diamondPick', 'enchanted', 'blazeRods']
    this.actions = this.buildActions()
    this.lastPlanKey = ''
  }

  // ---------------------------------------------------------------- Fakten
  facts () {
    const { ctx } = this
    const a = ctx.actions
    const g = ctx.gear
    const m = ctx.memory
    const cobble = g.cobble()
    const iron = a.count('iron_ingot')
    const rawIron = a.count('raw_iron')
    const dia = a.count('diamond')
    const pick = a.pickTier()
    const sword = g.tierOf('sword')
    const baseDone = !!(m.base && m.base.done)
    const req = baseDone ? null : ctx.building.requirements()
    const ironKit = pick >= 3 && g.owns('shield') && sword >= 3
    const f = {
      wood: ctx.crafting.woodValue() >= 16 || pick >= 1,
      woodPick: pick >= 1,
      woodKit: pick >= 1 && sword >= 1 && g.tierOf('axe') >= 1,
      cobble: cobble >= 16 || (pick >= 2 && sword >= 2),
      stoneKit: pick >= 2 && sword >= 2 && (g.has('furnace') || baseDone || !!m.furnaceJob),
      rawFood: ctx.food.foodCount() >= 5,
      food: ctx.food.cookedCount() >= 5,
      bed: !!a.findMatch(/_bed$/) || !!m.bedPlaced,
      rawIron: rawIron + iron >= 6 || ironKit,
      ironIngots: iron >= 6 || ironKit,
      ironKit,
      waterBucket: g.has('water_bucket'),
      buildMats: baseDone || (req.missingLogs === 0 && req.missingCobble === 0),
      base: baseDone,
      diamonds: dia >= 5 || (pick >= 4 && (dia >= 2 || !!m.enchantTable || g.has('enchanting_table'))),
      diamondPick: pick >= 4,
      lapis: a.count('lapis_lazuli') >= 1,
      obsidian4: a.count('obsidian') >= 4 || !!m.enchantTable || g.has('enchanting_table'),
      enchantTable: !!m.enchantTable,
      enchanted: !!m.enchantedOnce,
      gold: g.owns('golden_boots') || g.owns('golden_helmet'),
      flintSteel: g.has('flint_and_steel'),
      obsidian10: !!m.portal || a.count('obsidian') >= ctx.endgame.portalRemaining(),
      portal: !!m.portal,
      blazeRods: a.count('blaze_rod') >= 2
    }
    return f
  }

  // ---------------------------------------------------------------- Aktionen
  buildActions () {
    const ctx = this.ctx
    const a = () => ctx.actions
    const surface = async (t) => { await ctx.mining.returnToSurface(t) }
    const A = (name, label, activity, pre, eff, cost, run) => ({ name, label, activity, pre, eff, cost, run })
    return [
      A('GatherWood', 'Holz hacken', 'wood', [], ['wood'], 4, async t => ctx.wood.gather(5, t)),
      A('CraftWoodTools', 'Holzwerkzeug craften', 'craft', ['wood'], ['woodPick', 'woodKit'], 1, async t => ctx.wood.craftWoodTools(t)),
      A('MineStone', 'Stein abbauen', 'mine', ['woodPick'], ['cobble'], 3, async t => {
        const ok = await ctx.mining.mineFor('stone', () => ctx.gear.cobble() >= 22, t)
        await surface(t)
        return ok
      }),
      A('CraftStoneKit', 'Steinwerkzeug craften', 'craft', ['cobble', 'woodPick'], ['stoneKit'], 1, async t => ctx.gear.craftUpgrades(t)),
      A('Hunt', 'Tiere jagen', 'hunt', ['woodKit'], ['rawFood'], 4, async t => ctx.food.hunt(8, t)),
      A('CookFood', 'Fleisch braten', 'smelt', ['rawFood', 'stoneKit'], ['food'], 3, async t => ctx.food.smeltAll(t)),
      A('GetBed', 'Schafe für ein Bett scheren', 'hunt', ['woodKit'], ['bed'], 5, async t => {
        // 3 Schafe -> 3 Wolle, dazu 3 Planken an der Werkbank
        for (let i = 0; i < 3 && ctx.gear.sameWool() < 3; i++) await ctx.food.hunt(3 - ctx.gear.sameWool(), t, ['sheep'])
        if (ctx.gear.sameWool() < 3) return false
        if (!(await ctx.crafting.ensurePlanks(3, t))) await ctx.wood.gather(Math.ceil(ctx.crafting.woodValue() / 4) + 1, t)
        const ok = await ctx.crafting.craftAtTable([[ctx.gear.sameWoolName().replace('_wool', '_bed'), 1]], t)
        if (ok) ctx.emit('bed_crafted', {})
        return ok
      }),
      A('MineIron', 'Eisen suchen', 'mine', ['stoneKit'], ['rawIron'], 8, async t => {
        const ok = await ctx.mining.mineFor('iron', () => a().count('raw_iron') + a().count('iron_ingot') >= 12, t)
        await surface(t)
        return ok || a().count('raw_iron') + a().count('iron_ingot') >= 6
      }),
      A('SmeltIron', 'Eisen schmelzen', 'smelt', ['rawIron', 'stoneKit'], ['ironIngots'], 3, async t => ctx.food.smeltAll(t)),
      A('CraftIronKit', 'Eisenausrüstung craften', 'craft', ['ironIngots'], ['ironKit'], 1, async t => ctx.gear.craftUpgrades(t)),
      A('FillBucket', 'Wassereimer füllen', 'explore', ['ironKit'], ['waterBucket'], 4, async t => {
        if (!ctx.gear.has('bucket')) {
          if (a().count('iron_ingot') < 3) {
            await ctx.mining.mineFor('iron', () => a().count('raw_iron') + a().count('iron_ingot') >= 3, t)
            await surface(t)
            await ctx.food.smeltAll(t)
          }
          await ctx.crafting.craftAtTable([['bucket', 1]], t)
        }
        if (await ctx.gear.fillWaterBucket(t)) return true
        await ctx.explore(t, 48)
        return ctx.gear.fillWaterBucket(t)
      }),
      A('GatherBuildMaterials', 'Baumaterial sammeln', 'wood', ['stoneKit'], ['buildMats'], 10, async t => {
        const req = ctx.building.requirements()
        if (req.missingLogs > 0) {
          ctx.setActivity('wood', { forBuild: true })
          await ctx.wood.gather(Math.ceil(ctx.crafting.woodValue() / 4) + req.missingLogs, t)
        }
        const req2 = ctx.building.requirements()
        if (req2.missingCobble > 0) {
          ctx.setActivity('mine', { resource: 'stone', forBuild: true })
          const want = ctx.gear.cobble() + req2.missingCobble
          await ctx.mining.mineFor('stone', () => ctx.gear.cobble() >= want, t)
          await surface(t)
        }
        const r = ctx.building.requirements()
        return r.missingLogs === 0 && r.missingCobble === 0
      }),
      A('BuildBase', 'Haus bauen', 'build', ['buildMats', 'stoneKit'], ['base'], 12, async t => ctx.building.build(t)),
      A('MineDiamonds', 'Diamanten suchen', 'mine', ['ironKit'], ['diamonds'], 15, async t => {
        const ok = await ctx.mining.mineFor('diamond', () => a().count('diamond') >= 5, t)
        await surface(t)
        return ok
      }),
      A('MineLapis', 'Lapis suchen', 'mine', ['ironKit'], ['lapis'], 9, async t => {
        const ok = await ctx.mining.mineFor('lapis', () => a().count('lapis_lazuli') >= 3, t)
        await surface(t)
        return ok
      }),
      A('CraftDiamondKit', 'Diamantwerkzeug craften', 'craft', ['diamonds'], ['diamondPick'], 1, async t => ctx.gear.craftUpgrades(t)),
      A('MineObsidian4', 'Obsidian abbauen', 'mine', ['diamondPick', 'waterBucket'], ['obsidian4'], 10, async t => this.obsidianRun(4, t)),
      A('MineObsidian10', 'Obsidian fürs Portal abbauen', 'mine', ['diamondPick', 'waterBucket'], ['obsidian10'], 14, async t => this.obsidianRun(10, t)),
      A('SetupEnchanting', 'Verzauberungstisch bauen', 'enchant', ['obsidian4', 'diamonds'], ['enchantTable'], 6, async t => ctx.endgame.setupEnchantingTable(t)),
      A('Enchant', 'Ausrüstung verzaubern', 'enchant', ['enchantTable', 'lapis'], ['enchanted'], 2, async t => {
        const ok = await ctx.endgame.enchantGear(t)
        if (ok) ctx.memory.enchantedOnce = true
        return ok
      }),
      A('GetGold', 'Gold für Piglin-Schutz', 'mine', ['ironKit'], ['gold'], 9, async t => {
        if (a().count('gold_ingot') < 4) {
          await ctx.mining.mineFor('gold', () => a().count('raw_gold') + a().count('gold_ingot') >= 4, t)
          await surface(t)
          await ctx.food.smeltAll(t)
        }
        return ctx.crafting.craftAtTable([['golden_boots', 1]], t)
      }),
      A('GetFlintSteel', 'Feuerzeug craften', 'craft', ['ironKit'], ['flintSteel'], 5, async t => {
        if (!(await ctx.mining.gatherFlint(t))) { await ctx.explore(t, 40); return false }
        if (a().count('iron_ingot') < 1) {
          await ctx.mining.mineFor('iron', () => a().count('raw_iron') + a().count('iron_ingot') >= 1, t)
          await surface(t)
          await ctx.food.smeltAll(t)
        }
        return ctx.crafting.craft('flint_and_steel', 1, t)
      }),
      A('BuildPortal', 'Netherportal bauen', 'portal', ['obsidian10', 'flintSteel'], ['portal'], 5, async t => ctx.endgame.buildPortal(t)),
      A('NetherExpedition', 'Nether-Expedition', 'nether', ['portal', 'gold', 'ironKit', 'food'], ['blazeRods'], 20, async t => ctx.endgame.netherExpedition(t))
    ]
  }

  async obsidianRun (n, t) {
    const { ctx } = this
    const have = () => ctx.actions.count('obsidian') >= n
    if (await ctx.mining.harvestObsidian(n, t)) { await ctx.mining.returnToSurface(t); return true }
    // kein Lavasee in der Nähe: auf Diamant-Ebene runter und beim Stollenbau nach Lava Ausschau halten
    const lavaId = ctx.mcData.blocksByName.lava.id
    const lavaSeen = () => ctx.bot.findBlocks({ matching: lavaId, maxDistance: 14, count: 6 }).length >= 4
    await ctx.mining.mineFor('diamond', () => have() || lavaSeen(), t)
    const ok = await ctx.mining.harvestObsidian(n, t)
    await ctx.mining.returnToSurface(t)
    return ok
  }

  // ---------------------------------------------------------------- Planung
  onCooldown (name) { return (this.cooldowns.get(name) || 0) > Date.now() }

  /**
   * Rückwärtsverkettung: liefert die geordnete Aktionsfolge, die `fact` wahr macht.
   * @returns {{steps: object[], cost: number}|null}
   */
  resolve (fact, facts, visiting = new Set(), planned = new Set()) {
    if (facts[fact] || planned.has(fact)) return { steps: [], cost: 0 }
    if (visiting.has(fact)) return null
    visiting.add(fact)
    let best = null
    for (const act of this.actions) {
      if (!act.eff.includes(fact)) continue
      const steps = []
      let cost = act.cost + (this.onCooldown(act.name) ? 50 : 0)
      let ok = true
      const localPlanned = new Set(planned)
      for (const pre of act.pre) {
        const sub = this.resolve(pre, facts, visiting, localPlanned)
        if (!sub) { ok = false; break }
        for (const s of sub.steps) { steps.push(s); for (const e of s.eff) localPlanned.add(e) }
        cost += sub.cost
      }
      if (!ok) continue
      steps.push(act)
      if (!best || cost < best.cost) best = { steps, cost }
    }
    visiting.delete(fact)
    return best
  }

  planFor (goalFacts, facts = this.facts()) {
    const steps = []
    const planned = new Set()
    let cost = 0
    for (const g of goalFacts) {
      const r = this.resolve(g, facts, new Set(), planned)
      if (!r) return null
      for (const s of r.steps) if (!steps.includes(s)) { steps.push(s); for (const e of s.eff) planned.add(e) }
      cost += r.cost
    }
    return { steps, cost }
  }

  /** Zuschauer-/Operator-Ziel ganz nach oben legen. */
  pushGoal (goal) {
    this.goalStack = this.goalStack.filter(g => g.id !== goal.id)
    this.goalStack.unshift({ ...goal, at: Date.now(), attempts: 0 })
    if (this.goalStack.length > 5) this.goalStack.length = 5
  }

  clearGoals () { this.goalStack = [] }

  /**
   * Nächster Schritt: { action, goal, plan } oder null (alles erreicht).
   */
  next () {
    const facts = this.facts()
    // 1) Zuschauerziele
    while (this.goalStack.length) {
      const g = this.goalStack[0]
      if (g.task) {
        const pre = this.planFor(g.pre || [], facts)
        if (pre && pre.steps.length) {
          const step = pre.steps.find(s => !this.onCooldown(s.name)) || pre.steps[0]
          return { action: step, goal: g, plan: [...pre.steps.map(s => s.label), g.label], facts }
        }
        return { action: { name: 'Task:' + g.id, label: g.label, activity: g.activity || 'idle', run: g.task, oneShot: true }, goal: g, plan: [g.label], facts }
      }
      if (g.facts.every(f => facts[f])) { this.goalStack.shift(); this.ctx.emit('goal_done', { goal: g }); continue }
      const plan = this.planFor(g.facts, facts)
      if (!plan || !plan.steps.length) { this.goalStack.shift(); this.ctx.emit('goal_failed', { goal: g, reason: 'no_plan' }); continue }
      if (UNDERGROUND.has(plan.steps[0].name) && !this.ctx.caveAllowed()) { this.goalStack.shift(); this.ctx.emit('goal_failed', { goal: g, reason: 'cave_locked' }); continue }
      return { action: plan.steps[0], goal: g, plan: plan.steps.map(s => s.label), facts }
    }
    // 2) Progression: erstes offenes Ziel, dessen erster Schritt nicht gesperrt ist
    let fallback = null
    for (const fact of this.progression) {
      if (facts[fact]) continue
      const plan = this.planFor([fact], facts)
      if (!plan || !plan.steps.length) continue
      const res = { action: plan.steps[0], goal: { id: fact, label: GOAL_LABEL[fact] || fact, auto: true }, plan: plan.steps.map(s => s.label), facts }
      if (UNDERGROUND.has(plan.steps[0].name) && !this.ctx.caveAllowed()) {
        // genau EIN kurzer Automatik-Trip, und erst wenn Holz, Werkzeug und gebratenes Essen da sind
        if (this.ctx.memory.autoCaveTripUsed || !(facts.woodKit && facts.stoneKit && facts.food)) continue
        res.autoCaveTrip = true
      }
      if (!this.onCooldown(plan.steps[0].name)) return res
      if (!fallback) fallback = res
    }
    return fallback
  }

  /** Ergebnis einer Aktion verbuchen (Fehlschläge -> Cooldown, damit der Bot nicht in Schleifen hängt). */
  report (action, goal, ok) {
    if (action.oneShot) {
      this.goalStack = this.goalStack.filter(g => g !== goal)
      this.ctx.emit(ok ? 'goal_done' : 'goal_failed', { goal, reason: ok ? null : 'task_failed' })
      return
    }
    if (ok) { this.failures.delete(action.name); return }
    const n = (this.failures.get(action.name) || 0) + 1
    this.failures.set(action.name, n)
    if (n >= 2) {
      this.cooldowns.set(action.name, Date.now() + Math.min(240000, 45000 * n))
      this.ctx.emit('action_cooldown', { action: action.name, label: action.label, failures: n })
    }
    if (goal && !goal.auto) {
      goal.attempts = (goal.attempts || 0) + 1
      if (goal.attempts >= 4) {
        this.goalStack = this.goalStack.filter(g => g !== goal)
        this.ctx.emit('goal_failed', { goal, reason: 'too_many_attempts' })
      }
    }
  }
}

module.exports = { Planner, GOAL_LABEL, UNDERGROUND }
