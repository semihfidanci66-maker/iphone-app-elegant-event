'use strict'
/**
 * mc-ai-bot.js – das Bot-Hirn.
 *
 * Schichten:
 *   1. Human Biomechanical Input Layer   -> bot/human-look.js, bot/actions.js (Action-State-Lock)
 *   2. Reflexe (200 ms)                  -> Kampf-Interrupt, Stuck-Watchdog, Essen
 *   3. GOAP-Planer                       -> bot/planner.js (Holz -> Stein -> Eisen -> Haus -> Diamant -> Verzaubern -> Nether)
 *   4. Fähigkeiten                       -> bot/survival-*.js, bot/combat.js, bot/crafting.js, bot/gear.js, bot/hotbar.js
 *
 * Nach außen: EventEmitter. Alles, was der Streamer kommentieren oder das Overlay animieren soll,
 * kommt als 'event' { type, data, status } heraus.
 */
const EventEmitter = require('events')
const mineflayer = require('mineflayer')
const { pathfinder, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')

const { HumanLookController } = require('./bot/human-look')
const { HumanActions, TaskToken, sleep } = require('./bot/actions')
const { HotbarManager } = require('./bot/hotbar')
const { StuckWatchdog } = require('./bot/watchdog')
const { CombatSystem } = require('./bot/combat')
const { Crafting } = require('./bot/crafting')
const { Gear } = require('./bot/gear')
const { WoodPhase } = require('./bot/survival-wood')
const { MiningPhase } = require('./bot/survival-mining')
const { FoodPhase } = require('./bot/survival-food')
const { BuildingPhase } = require('./bot/survival-building')
const { EndgamePhase } = require('./bot/survival-endgame')
const { Planner } = require('./bot/planner')

const VIEWER_GOALS = {
  wood: { label: 'Holz holen', activity: 'wood', task: (ctx, t) => ctx.wood.gather(Math.ceil(ctx.crafting.woodValue() / 4) + 6, t) },
  house: { label: 'Haus bauen', facts: ['base'] },
  iron_sword: { label: 'Eisenschwert schmieden', facts: ['ironKit'] },
  iron: { label: 'Eisen farmen', facts: ['ironKit'] },
  nether: { label: 'In den Nether gehen', facts: ['blazeRods'] },
  portal: { label: 'Netherportal bauen', facts: ['portal'] },
  diamonds: { label: 'Diamanten suchen', facts: ['diamondPick'] },
  enchant: { label: 'Ausrüstung verzaubern', facts: ['enchanted'] },
  eat: {
    label: 'Essen',
    activity: 'eat',
    task: async (ctx, t) => {
      if (await ctx.food.eatIfNeeded(t)) return true
      if (ctx.combat.edible()) { const n = await ctx.combat.eat(t); if (n) { ctx.emit('ate', { item: n, health: ctx.bot.health, food: ctx.bot.food }); return true } }
      if (ctx.food.rawCount() < 3) await ctx.food.hunt(6, t)
      await ctx.food.smeltAll(t)
      return ctx.food.eatIfNeeded(t)
    }
  },
  hunt: { label: 'Tiere jagen', activity: 'hunt', pre: ['woodKit'], task: async (ctx, t) => { const ok = await ctx.food.hunt(ctx.food.foodCount() + 6, t); if (ok) await ctx.food.smeltAll(t); return ok } },
  mine: {
    label: 'Minen gehen',
    activity: 'mine',
    pre: ['woodPick'],
    task: async (ctx, t) => {
      const tier = ctx.actions.pickTier()
      const res = tier >= 3 ? 'diamond' : tier >= 2 ? 'iron' : 'stone'
      const a = ctx.actions
      const start = { diamond: a.count('diamond'), iron: a.count('raw_iron'), stone: ctx.gear.cobble() }
      const ok = await ctx.mining.mineFor(res, () => res === 'diamond' ? a.count('diamond') >= start.diamond + 3 : res === 'iron' ? a.count('raw_iron') >= start.iron + 8 : ctx.gear.cobble() >= start.stone + 32, t)
      await ctx.mining.returnToSurface(t)
      return ok
    }
  },
  sleep: { label: 'Schlafen gehen', activity: 'sleep', task: (ctx, t) => ctx.building.sleepInBed(t) },
  tidy: { label: 'Inventar aufräumen', activity: 'idle', task: async (ctx, t) => { await ctx.hotbar.organize(true); await ctx.building.storeExcess(t); return true } }
}

class MinecraftAIBot extends EventEmitter {
  /**
   * @param {{host?: string, port?: number, username?: string, version?: string, auth?: string, autoStart?: boolean}} config
   */
  constructor (config = {}) {
    super()
    this.config = { host: '127.0.0.1', port: 25565, username: 'KI_Streamer', version: '1.21.1', auth: 'offline', ...config }
    this.bot = null
    this.ctx = null
    this.running = false
    this.paused = false
    this.connected = false
    this.currentToken = null
    this.currentAction = null
    this.activity = { key: 'offline', data: {} }
    this.memory = {} // überlebt Reconnects und Tode (Basis, Portal, Ofen-Job …)
    this.deaths = 0
    this.commandQueue = []
    this.commandTimer = null
    this.reconnectTimer = null
    this.loopId = 0
    this.lastPlanKey = ''
    this.opWarned = false
  }

  // ================================================================ Lebenszyklus
  start () {
    if (this.running) return
    this.running = true
    this._connect()
  }

  stop () {
    this.running = false
    clearTimeout(this.reconnectTimer)
    this._teardown()
    if (this.bot) { try { this.bot.quit('stop') } catch (_) {} }
    this.bot = null
    this.connected = false
    this.setActivity('offline')
    this._emit('bot_stopped', {})
  }

  _connect () {
    const c = this.config
    this._emit('bot_connecting', { host: c.host, port: c.port, username: c.username })
    let bot
    try {
      bot = mineflayer.createBot({ host: c.host, port: c.port, username: c.username, version: c.version || false, auth: c.auth || 'offline', checkTimeoutInterval: 60000, hideErrors: true })
    } catch (e) {
      this._emit('bot_error', { message: e.message })
      this._scheduleReconnect()
      return
    }
    this.bot = bot
    bot.loadPlugin(pathfinder)
    bot.once('spawn', () => this._onFirstSpawn())
    bot.on('error', e => this._emit('bot_error', { message: e.message || String(e) }))
    bot.on('kicked', reason => this._emit('bot_kicked', { reason: typeof reason === 'string' ? reason : JSON.stringify(reason) }))
    bot.on('end', reason => {
      this.connected = false
      this._teardown()
      this.setActivity('offline')
      this._emit('bot_disconnected', { reason })
      this._scheduleReconnect()
    })
  }

  _scheduleReconnect () {
    if (!this.running) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => { if (this.running) this._connect() }, 6000)
  }

  _teardown () {
    this.loopId++
    if (this.currentToken) this.currentToken.cancel('shutdown')
    clearInterval(this.reflexTimer)
    clearInterval(this.statusTimer)
    clearTimeout(this.commandTimer)
    this.commandTimer = null
    this.commandQueue = []
    if (this.ctx) {
      try { this.ctx.watchdog.dispose() } catch (_) {}
      try { this.ctx.look.dispose() } catch (_) {}
    }
    this.ctx = null
  }

  _onFirstSpawn () {
    const bot = this.bot
    const mcData = require('minecraft-data')(bot.version)
    const self = this
    const ctx = {
      bot,
      mcData,
      memory: this.memory,
      emit: (type, data) => this._emit(type, data),
      log: msg => this._emit('log', { message: msg }),
      debug: null,
      interrupt: reason => this.interrupt(reason),
      setActivity: (key, data) => this.setActivity(key, data),
      explore: (token, dist) => this._explore(token, dist),
      isBaseBlock: pos => !!ctx.building && ctx.building.isBaseBlock(pos),
      isPortalBlock: pos => !!ctx.endgame && ctx.endgame.isPortalBlock(pos)
    }
    ctx.look = new HumanLookController(bot)
    ctx.actions = new HumanActions(ctx)
    ctx.hotbar = new HotbarManager(ctx)
    ctx.combat = new CombatSystem(ctx)
    ctx.crafting = new Crafting(ctx)
    ctx.gear = new Gear(ctx)
    ctx.wood = new WoodPhase(ctx)
    ctx.mining = new MiningPhase(ctx)
    ctx.food = new FoodPhase(ctx)
    ctx.building = new BuildingPhase(ctx)
    ctx.endgame = new EndgamePhase(ctx)
    ctx.watchdog = new StuckWatchdog(ctx)
    ctx.planner = new Planner(ctx)
    this.ctx = ctx
    this.connected = true
    this.exploreHeading = Math.random() * Math.PI * 2

    bot.on('death', () => {
      this.deaths++
      const p = bot.entity.position
      this.memory.deathPos = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), at: Date.now(), dimension: bot.game.dimension }
      this.memory.mineEntrance = null
      this.memory.furnaceJob = null
      this.interrupt('death')
      this._emit('death', { deaths: this.deaths })
    })
    bot.on('spawn', () => { ctx.look.syncFromEntity(); this._emit('respawn', {}) })
    bot.on('health', () => {
      if (bot.health <= 6 && bot.health > 0) this._emit('critical_hp', { health: bot.health })
    })
    bot.on('playerCollect', (collector, collected) => {
      if (collector !== bot.entity) return
      try {
        const item = collected.getDroppedItem && collected.getDroppedItem()
        if (item && /diamond$|^raw_iron$|^raw_gold$|blaze_rod|^obsidian$|golden_apple|ender_pearl/.test(item.name)) this._emit('pickup', { item: item.name, count: item.count })
      } catch (_) {}
    })
    bot.on('messagestr', (msg) => {
      if (/Unknown or incomplete command|do not have permission|Unbekannter oder unvollständiger Befehl|keine Berechtigung/i.test(msg) && !this.opWarned) {
        this.opWarned = true
        this._emit('warn', { code: 'no_op', message: `Der Bot "${bot.username}" braucht OP-Rechte für Gift-Mobs: /op ${bot.username}` })
      }
    })
    bot.on('time', () => {
      const night = ctx.building.isNight()
      if (night !== this._wasNight) {
        this._wasNight = night
        if (this._nightInit) this._emit(night ? 'night' : 'day', {})
        this._nightInit = true
      }
    })

    // 200-ms-Kampf-Reflex: unterbricht JEDE laufende Routine, sobald eine Bedrohung auftaucht
    this.reflexTimer = setInterval(() => {
      if (!this.ctx || !bot.entity || this.paused) return
      if (ctx.combat.engaged || (this.currentAction && this.currentAction.name === 'Combat')) return
      if (ctx.combat.hasThreat()) this.interrupt('combat')
    }, 200)
    this.statusTimer = setInterval(() => this.emit('status', this.status()), 1000)

    this._emit('bot_spawned', { username: bot.username, version: bot.version })
    const id = ++this.loopId
    this._mainLoop(id).catch(e => this._emit('bot_error', { message: 'Hauptschleife: ' + (e.stack || e.message) }))
  }

  // ================================================================ Hauptschleife
  interrupt (reason) {
    if (this.currentToken && !this.currentToken.cancelled) this.currentToken.cancel(reason)
  }

  setActivity (key, data = {}) {
    this.activity = { key, data, since: Date.now() }
  }

  async _run (action, fn) {
    const token = new TaskToken(action.name)
    this.currentToken = token
    this.currentAction = action
    try {
      return await fn(token)
    } catch (e) {
      if (e && e.isInterrupt) return 'interrupted'
      this._emit('log', { message: `${action.name} Fehler: ${e.stack || e.message}` })
      return false
    } finally {
      if (this.currentToken === token) { this.currentToken = null; this.currentAction = null }
      if (this.ctx) { this.ctx.actions.stopMoving(); this.ctx.actions._unlock() }
    }
  }

  async _mainLoop (id) {
    const alive = () => this.loopId === id && this.ctx && this.bot && this.bot.entity
    await sleep(1500) // Chunks laden lassen
    while (alive()) {
      const { ctx, bot } = this
      try {
        if (bot.health <= 0 || bot.isAlive === false) {
          await sleep(800)
          continue
        }
        if (this.paused) { this.setActivity('paused'); await sleep(400); continue }

        // ---- Reflex 1: Kampf ----
        if (ctx.combat.hasThreat()) {
          this.setActivity('combat', { count: ctx.combat.scan().length })
          await this._run({ name: 'Combat', label: 'Kampf' }, t => ctx.combat.fight(t))
          if (alive()) await ctx.hotbar.organize()
          continue
        }
        // ---- Reflex 2: Essen ----
        if (ctx.food.needsToEat() && ctx.combat.edible()) {
          this.setActivity('eat')
          await this._run({ name: 'Eat', label: 'Essen' }, t => ctx.food.eatIfNeeded(t))
        }
        // ---- Reflex 3: Loot nach dem Tod zurückholen (5 Minuten Zeit, wie jeder Spieler) ----
        const dp = this.memory.deathPos
        if (dp && Date.now() - dp.at < 280000 && dp.dimension === bot.game.dimension && !dp.tried) {
          dp.tried = true
          this.setActivity('recover')
          this._emit('recover_start', {})
          const r = await this._run({ name: 'RecoverLoot', label: 'Loot zurückholen' }, async t => {
            const ok = await ctx.actions.goto(new goals.GoalNear(dp.x, dp.y, dp.z, 2), { token: t, timeout: 90000 })
            if (ok) await ctx.actions.collectDrops(new Vec3(dp.x, dp.y, dp.z), 8, { token: t, timeout: 15000 })
            return ok
          })
          if (r === 'interrupted') dp.tried = false
          else { this.memory.deathPos = null; this._emit('recover_done', { ok: !!r }) }
          continue
        }
        // ---- Reflex 4: Schlafen, wenn ein Bett da ist ----
        if (this.memory.bedPlaced && ctx.building.isNight() && !ctx.endgame.inNether() && !this._sleptTonight && ctx.building.findBed()) {
          const c = this.memory.base.center
          if (bot.entity.position.distanceTo(new Vec3(c.x, c.y, c.z)) < 48) {
            this.setActivity('sleep')
            const r = await this._run({ name: 'Sleep', label: 'Schlafen' }, t => ctx.building.sleepInBed(t))
            if (r !== 'interrupted') this._sleptTonight = true
            continue
          }
        }
        if (!ctx.building.isNight()) this._sleptTonight = false
        // ---- Aufräumen: Hotbar, liegen gelassene Stationen, offener Ofen-Job ----
        await ctx.hotbar.organize()
        if (this.memory.furnaceJob) {
          this.setActivity('smelt')
          await this._run({ name: 'TendFurnace', label: 'Ofen leeren', activity: 'smelt' }, t => ctx.food.smeltAll(t))
          continue
        }
        if (this.memory.leftStations && this.memory.leftStations.length) {
          await this._run({ name: 'RecoverStations', label: 'Werkbank einsammeln' }, t => ctx.crafting.recoverLeftStations(t))
        }

        // ---- GOAP ----
        let step
        if (ctx.endgame.inNether()) {
          step = { action: ctx.planner.actions.find(a => a.name === 'NetherExpedition'), goal: { id: 'blazeRods', label: 'Nether & Lohenruten', auto: true }, plan: ['Nether-Expedition'] }
        } else step = ctx.planner.next()
        if (!step) {
          await this._idle()
          continue
        }
        const planKey = step.goal.id + '>' + step.plan.join('>')
        if (planKey !== this.lastPlanKey) {
          this.lastPlanKey = planKey
          this._emit('plan', { goal: step.goal.label, goalId: step.goal.id, by: step.goal.by || null, steps: step.plan, auto: !!step.goal.auto })
        }
        this.setActivity(step.action.activity || 'idle', { action: step.action.name, label: step.action.label, goal: step.goal.label })
        this._emit('action_start', { action: step.action.name, label: step.action.label, goal: step.goal.label })
        const result = await this._run(step.action, t => step.action.oneShot ? step.action.run(ctx, t) : step.action.run(t))
        if (!alive()) break
        if (result === 'interrupted') continue
        ctx.planner.report(step.action, step.goal, !!result)
        this._emit('action_end', { action: step.action.name, label: step.action.label, ok: !!result })
        if (!result) await sleep(600)
      } catch (e) {
        if (!(e && e.isInterrupt)) this._emit('log', { message: 'Loop: ' + (e.stack || e.message) })
        await sleep(500)
      }
    }
  }

  /** Alles erreicht: sinnvoll beschäftigen (Lager auffüllen, patrouillieren). */
  async _idle () {
    const { ctx } = this
    this.setActivity('idle')
    await this._run({ name: 'Idle', label: 'Basis-Alltag' }, async t => {
      await ctx.building.storeExcess(t)
      if (ctx.memory.base && ctx.memory.base.center) await ctx.food.patrol(new Vec3(ctx.memory.base.center.x, ctx.memory.base.center.y, ctx.memory.base.center.z), t)
      else await this._explore(t, 20)
      await sleep(1500)
      return true
    })
  }

  async _explore (token, dist = 40) {
    const { ctx, bot } = this
    ctx.setActivity('explore')
    for (let i = 0; i < 4; i++) {
      const p = bot.entity.position
      const x = Math.floor(p.x + Math.cos(this.exploreHeading) * dist)
      const z = Math.floor(p.z + Math.sin(this.exploreHeading) * dist)
      const ok = await ctx.actions.goto(new goals.GoalNearXZ(x, z, 4), { token, timeout: 25000 })
      if (ok || bot.entity.position.distanceTo(p) > dist * 0.4) { this.exploreHeading += (Math.random() - 0.5) * 0.6; return true }
      this.exploreHeading += Math.PI / 2 + Math.random() * 0.5 // Wasser/Klippe: andere Richtung
    }
    return false
  }

  // ================================================================ Öffentliche API
  _emit (type, data = {}) {
    this.emit('event', { type, data, status: this.connected ? this.status() : null, at: Date.now() })
  }

  /** Echtzeit-Zustand für Streamer-Hirn, Dashboard und Overlay. */
  status () {
    const bot = this.bot
    if (!this.ctx || !bot || !bot.entity) return { connected: false, activity: 'offline', activityData: {} }
    const { ctx } = this
    const a = ctx.actions
    const p = bot.entity.position
    const threats = ctx.combat.scan()
    const off = bot.inventory.slots[45]
    return {
      connected: true,
      username: bot.username,
      activity: this.activity.key,
      activityData: this.activity.data || {},
      goal: this.currentAction ? this.currentAction.label : null,
      paused: this.paused,
      health: Math.round(bot.health * 10) / 10,
      food: bot.food,
      xpLevel: bot.experience ? bot.experience.level : 0,
      pos: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
      dimension: /nether/.test(bot.game.dimension || '') ? 'nether' : /end/.test(bot.game.dimension || '') ? 'end' : 'overworld',
      night: ctx.building.isNight(),
      threats: threats.length,
      threatNames: threats.slice(0, 6).map(t => t.e.name),
      fighting: ctx.combat.engaged,
      shield: !!off && off.name === 'shield',
      held: bot.heldItem ? bot.heldItem.name : null,
      kills: ctx.combat.kills,
      deaths: this.deaths,
      inv: {
        logs: ctx.crafting.logCount(),
        planks: ctx.crafting.plankCount(),
        cobble: ctx.gear.cobble(),
        coal: a.count('coal'),
        rawIron: a.count('raw_iron'),
        iron: a.count('iron_ingot'),
        gold: a.count('gold_ingot'),
        diamonds: a.count('diamond'),
        obsidian: a.count('obsidian'),
        lapis: a.count('lapis_lazuli'),
        food: ctx.food.cookedCount(),
        rawFood: ctx.food.rawCount(),
        torches: a.count('torch'),
        blazeRods: a.count('blaze_rod'),
        pickTier: a.pickTier(),
        swordTier: ctx.gear.tierOf('sword')
      },
      base: this.memory.base ? { done: !!this.memory.base.done, started: !!this.memory.base.started } : null,
      portal: !!this.memory.portal,
      viewerGoals: ctx.planner.goalStack.map(g => ({ id: g.id, label: g.label, by: g.by || null }))
    }
  }

  /**
   * Zuschauer-/Operator-Wunsch ganz oben in den Verhaltensbaum legen.
   * @param {string} id  wood|house|iron_sword|iron|nether|portal|diamonds|enchant|eat|hunt|mine|sleep|tidy
   * @returns {{ok: boolean, label?: string, already?: boolean, reason?: string}}
   */
  pushGoal (id, by = null) {
    const def = VIEWER_GOALS[id]
    if (!def) return { ok: false, reason: 'unknown' }
    if (!this.ctx) return { ok: false, reason: 'offline', label: def.label }
    const ctx = this.ctx
    if (def.facts) {
      const facts = ctx.planner.facts()
      if (def.facts.every(f => facts[f])) return { ok: true, already: true, label: def.label }
    }
    const goal = { id, label: def.label, by, facts: def.facts || null, pre: def.pre || [], activity: def.activity }
    if (def.task) goal.task = (c, t) => def.task(c, t)
    ctx.planner.pushGoal(goal)
    this.lastPlanKey = ''
    // laufende Auto-Routine sauber unterbrechen, damit der Wunsch SOFORT drankommt
    if (this.currentAction && this.currentAction.name !== 'Combat' && this.currentAction.name !== 'Eat') this.interrupt('viewer_goal')
    this._emit('goal_pushed', { id, label: def.label, by })
    return { ok: true, label: def.label }
  }

  clearGoals () { if (this.ctx) this.ctx.planner.clearGoals() }
  setPaused (p) { this.paused = !!p; if (p) this.interrupt('pause'); this._emit(p ? 'paused' : 'resumed', {}) }

  async unstuck () {
    if (!this.ctx) return false
    return this.ctx.watchdog.escape('operator')
  }

  respawn () {
    if (!this.bot) return
    if (this.bot.health <= 0) { try { this.bot.respawn() } catch (_) {} } else this.runCommands(['kill @s'])
  }

  give (item, count = 1) {
    if (!/^[a-z0-9_:]+$/.test(item)) return false
    this.runCommands([`give @s ${item} ${Math.max(1, Math.min(64, count | 0))}`])
    return true
  }

  say (text) { if (this.bot && text) this.bot.chat(String(text).slice(0, 250)) }

  /** Zuschauer wird angesprochen: in ruhigen Momenten schaut sich der Bot ausdrucksvoll um. */
  expressiveLook () {
    if (!this.ctx || this.ctx.combat.engaged) return
    this.ctx.look.expressiveGlance()
  }

  /**
   * Server-Befehle (ohne führenden Slash) gedrosselt absetzen. Jeder Befehl <= 256 Zeichen.
   */
  runCommands (cmds) {
    if (!this.bot) return false
    for (const c of cmds) {
      const cmd = String(c).replace(/^\//, '')
      if (cmd.length > 255) { this._emit('log', { message: 'Befehl zu lang, übersprungen: ' + cmd.slice(0, 60) }); continue }
      this.commandQueue.push(cmd)
    }
    if (!this.commandTimer) this._drainCommands()
    return true
  }

  _drainCommands () {
    if (!this.bot || !this.commandQueue.length) { this.commandTimer = null; return }
    const cmd = this.commandQueue.shift()
    try { this.bot.chat('/' + cmd) } catch (e) { this._emit('log', { message: 'Befehl fehlgeschlagen: ' + e.message }) }
    this.commandTimer = setTimeout(() => this._drainCommands(), 70)
  }

  /**
   * Gültiger Spawnpunkt 5–7 Blöcke vor dem Bot auf festem Oberflächenboden.
   * @returns {{x:number,y:number,z:number}|null}
   */
  spawnPoint (minDist = 5, maxDist = 7) {
    const bot = this.bot
    if (!bot || !bot.entity) return null
    const p = bot.entity.position
    const yaw = bot.entity.yaw
    const tries = [0, 0.35, -0.35, 0.7, -0.7, 1.1, -1.1, 1.6, -1.6, 2.2, -2.2, Math.PI]
    for (const off of tries) {
      for (const dist of [minDist + Math.random() * (maxDist - minDist), minDist, maxDist, 4]) {
        const a = yaw + off
        const x = Math.floor(p.x - Math.sin(a) * dist)
        const z = Math.floor(p.z - Math.cos(a) * dist)
        for (const dy of [0, 1, -1, 2, -2, 3, -3]) {
          const y = Math.floor(p.y) + dy
          const floor = bot.blockAt(new Vec3(x, y - 1, z))
          const b0 = bot.blockAt(new Vec3(x, y, z))
          const b1 = bot.blockAt(new Vec3(x, y + 1, z))
          const b2 = bot.blockAt(new Vec3(x, y + 2, z))
          if (!floor || floor.boundingBox !== 'block' || /lava|magma|cactus|fire/.test(floor.name)) continue
          const free = b => !b || (b.boundingBox === 'empty' && b.name !== 'lava' && b.name !== 'water')
          if (free(b0) && free(b1) && free(b2)) return { x: x + 0.5, y, z: z + 0.5 }
        }
      }
    }
    return { x: Math.floor(p.x) + 0.5, y: Math.floor(p.y), z: Math.floor(p.z) + 0.5 }
  }
}

module.exports = { MinecraftAIBot, VIEWER_GOALS }
