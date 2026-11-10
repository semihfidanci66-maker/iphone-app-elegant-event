'use strict'
/**
 * Phase 4: Echter Block-für-Block-Hausbau ("Cozy Survival Starter House", 7x7).
 *
 *  j=0  Bruchstein-Fundament, Ecken = Stämme
 *  j=1  Steinsockel, Tür vorne in der Mitte
 *  j=2  Plankenwand mit Fenstern auf Augenhöhe (Glasscheiben, sonst Zäune)
 *  j=3  Plankenwand, Eckpfeiler (j=0..3 = 4 hoch)
 *  j=4  Dach: außen Stufen-Ring, innen Planken
 *  j=5  Dachkappe aus Stufen (geschlossen -> keine Spinnen)
 *
 * Der Bau ist idempotent: jede Zelle wird geprüft, fertige Zellen werden übersprungen. Nach einer
 * Kampf-Unterbrechung macht der Bot exakt dort weiter, wo er aufgehört hat.
 */
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { sleep, rand } = require('./actions')

const SIZE = 7
const WINDOWS = new Set(['0,2', '0,4', '6,2', '6,4', '2,6', '4,6', '1,0', '5,0'])
const DOOR = { i: 3, k: 0 }

const MATCH = {
  cobble: /^(cobblestone|cobbled_deepslate|stone_bricks|mossy_cobblestone)$/,
  log: /(_log|_stem)$/,
  planks: /_planks$/,
  slab: /^(oak|spruce|birch|jungle|acacia|dark_oak|cherry|mangrove|bamboo|crimson|warped)_slab$/,
  window: /^(glass_pane|glass|.*_fence)$/,
  door: /_door$/,
  torch: /^(torch|wall_torch)$/,
  crafting_table: /^crafting_table$/,
  furnace: /^furnace$/,
  chest: /^chest$/,
  bed: /_bed$/
}

class BuildingPhase {
  constructor (ctx) {
    this.ctx = ctx
    this.bot = ctx.bot
  }

  get base () { return this.ctx.memory.base || null }
  origin () { const o = this.base.origin; return new Vec3(o.x, o.y, o.z) }
  world (i, j, k) { return this.origin().offset(i, j, k) }

  isBaseBlock (pos) {
    if (!this.base) return false
    const o = this.base.origin
    return pos.x >= o.x - 1 && pos.x <= o.x + SIZE && pos.z >= o.z - 1 && pos.z <= o.z + SIZE && pos.y >= o.y - 1 && pos.y <= o.y + 6
  }

  // ---------------------------------------------------------------- Blueprint
  blueprint () {
    const cells = []
    const edge = (i, k) => i === 0 || k === 0 || i === SIZE - 1 || k === SIZE - 1
    const corner = (i, k) => (i === 0 || i === SIZE - 1) && (k === 0 || k === SIZE - 1)
    const ring = (i, k) => Math.min(i, k, SIZE - 1 - i, SIZE - 1 - k)
    for (let i = 0; i < SIZE; i++) {
      for (let k = 0; k < SIZE; k++) {
        cells.push({ i, j: 0, k, kind: corner(i, k) ? 'log' : 'cobble', stage: 0 })
        if (edge(i, k)) {
          const isDoor = i === DOOR.i && k === DOOR.k
          for (let j = 1; j <= 3; j++) {
            if (corner(i, k)) { cells.push({ i, j, k, kind: 'log', stage: j }); continue }
            if (isDoor && j <= 2) continue
            if (j === 1) cells.push({ i, j, k, kind: 'cobble', stage: 1 })
            else if (j === 2 && WINDOWS.has(`${i},${k}`)) cells.push({ i, j, k, kind: 'window', stage: 2 })
            else cells.push({ i, j, k, kind: 'planks', stage: j })
          }
        }
        const r = ring(i, k)
        cells.push({ i, j: 4, k, kind: r === 0 ? 'slab' : 'planks', stage: 4 + r * 0.1, face: r === 0 ? new Vec3(0, 1, 0) : null })
        if (r >= 2) cells.push({ i, j: 5, k, kind: 'slab', stage: 7, face: new Vec3(0, 1, 0), cap: true })
      }
    }
    cells.push({ i: DOOR.i, j: 1, k: DOOR.k, kind: 'door', stage: 5, face: new Vec3(0, 1, 0), from: { i: 3, k: 2 } })
    cells.push({ i: 1, j: 2, k: 3, kind: 'torch', stage: 5.1, optional: true })
    cells.push({ i: 5, j: 2, k: 3, kind: 'torch', stage: 5.1, optional: true })
    cells.push({ i: 1, j: 1, k: 5, kind: 'crafting_table', stage: 6 })
    cells.push({ i: 2, j: 1, k: 5, kind: 'furnace', stage: 6 })
    cells.push({ i: 3, j: 1, k: 5, kind: 'furnace', stage: 6 })
    cells.push({ i: 5, j: 1, k: 4, kind: 'chest', stage: 6 })
    cells.push({ i: 5, j: 1, k: 5, kind: 'chest', stage: 6 })
    cells.push({ i: 2, j: 1, k: 1, kind: 'bed', stage: 6.5, face: new Vec3(0, 1, 0), from: { i: 4, k: 1 }, optional: true })
    cells.sort((a, b) => a.stage - b.stage || a.j - b.j)
    return cells
  }

  cellDone (c) {
    const b = this.bot.blockAt(this.world(c.i, c.j, c.k))
    return !!b && MATCH[c.kind].test(b.name)
  }

  /** Was fehlt noch insgesamt? -> für den Planer (Holz/Stein sammeln). */
  requirements () {
    const need = { cobble: 0, log: 0, planks: 0, slab: 0, window: 0, door: 0, torch: 0, crafting_table: 0, furnace: 0, chest: 0, bed: 0 }
    const cells = this.base ? this.blueprint().filter(c => !this.cellDone(c)) : this.blueprint()
    for (const c of cells) need[c.kind]++
    const a = this.ctx.actions
    const have = {
      slab: a.countMatch(MATCH.slab), window: a.countMatch(MATCH.window), door: a.countMatch(MATCH.door), chest: a.count('chest'), crafting_table: a.count('crafting_table'), furnace: a.count('furnace')
    }
    // in Planken umgerechnet (inkl. Zwischenprodukte, die noch gecraftet werden müssen)
    let planks = need.planks
    planks += Math.ceil(Math.max(0, need.slab - have.slab) / 6) * 3
    planks += need.door && !have.door ? 6 : 0
    planks += Math.max(0, need.chest - have.chest) * 8
    planks += need.crafting_table && !have.crafting_table ? 4 : 0
    if (have.window < need.window) planks += Math.ceil((need.window - have.window) / 3) * 5
    let cobble = need.cobble + Math.max(0, need.furnace - have.furnace) * 8
    const c = this.ctx.crafting
    const woodNeed = need.log * 4 + planks
    const woodHave = c.woodValue() + (a.count('stick') >= 4 ? 0 : -2)
    const cobbleHave = a.count('cobblestone') + a.count('cobbled_deepslate')
    cobble = Math.max(0, cobble - cobbleHave)
    return {
      need,
      missingLogs: Math.max(0, Math.ceil((woodNeed - woodHave) / 4)),
      missingCobble: cobble,
      logsToKeep: need.log
    }
  }

  // ---------------------------------------------------------------- Bauplatz
  surfaceY (x, z, around) {
    const bot = this.bot
    for (let y = around + 10; y >= around - 12; y--) {
      const b = bot.blockAt(new Vec3(x, y, z))
      if (!b) continue
      if (b.name === 'water' || b.name === 'lava') return { y, liquid: true }
      if (b.boundingBox === 'block' && !/_leaves$|_log$/.test(b.name)) return { y, liquid: false, name: b.name }
      if (/_log$/.test(b.name)) return { y, tree: true }
    }
    return null
  }

  /** Sucht eine möglichst ebene 9x9-Fläche in der Nähe. */
  findSite () {
    const bot = this.bot
    const p = this.ctx.actions.feet()
    let best = null
    for (let r = 0; r <= 24; r += 3) {
      for (let dx = -r; dx <= r; dx += 3) {
        for (let dz = -r; dz <= r; dz += 3) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
          const cx = p.x + dx
          const cz = p.z + dz
          const hs = []
          let bad = false
          for (let i = -4; i <= 4 && !bad; i++) {
            for (let k = -4; k <= 4; k++) {
              const s = this.surfaceY(cx + i, cz + k, p.y)
              if (!s || s.liquid || s.tree) { bad = true; break }
              hs.push(s.y)
            }
          }
          if (bad) continue
          hs.sort((a, b) => a - b)
          const spread = hs[hs.length - 1] - hs[0]
          if (spread > 3) continue
          const median = hs[hs.length >> 1]
          const rough = hs.reduce((s, h) => s + Math.abs(h - median), 0)
          const score = rough * 1.5 + r * 0.6
          if (!best || score < best.score) best = { score, origin: { x: cx - 3, y: median, z: cz - 3 }, center: { x: cx, y: median + 1, z: cz }, rough }
        }
      }
      if (best && best.rough <= 6) break
    }
    return best
  }

  /** Gras, Blumen und Erdhügel im Grundriss entfernen, Löcher auffüllen. */
  async levelSite (token) {
    const { bot, ctx } = this
    const a = ctx.actions
    const columns = []
    for (let i = 0; i < SIZE; i++) for (let k = 0; k < SIZE; k++) columns.push([i, k])
    columns.push([DOOR.i, -1]) // Platz vor der Tür
    for (const [i, k] of columns) {
      for (let j = 5; j >= 1; j--) {
        token.check()
        const pos = this.world(i, j, k)
        const b = bot.blockAt(pos)
        if (!b || a.isAir(b)) continue
        if (!(await a.reach(pos, 3.6, { token, timeout: 12000 }))) continue
        await a.digUntilClear(pos, { token, clearPlants: true })
      }
      if (k < 0) continue
      // Loch unter dem Fundament -> auffüllen
      const under = this.world(i, -1, k)
      if (!a.isSolid(bot.blockAt(under)) && !a.isSolid(bot.blockAt(this.world(i, 0, k)))) {
        const filler = a.findFirst(['dirt', 'cobblestone', 'cobbled_deepslate'])
        if (filler) await a.gotoAndPlace(under, filler.name, { token })
      }
    }
  }

  // ---------------------------------------------------------------- Material
  itemFor (kind) {
    const a = this.ctx.actions
    switch (kind) {
      case 'cobble': return a.findFirst(['cobblestone', 'cobbled_deepslate'])
      case 'log': return a.findMatch(MATCH.log)
      case 'planks': return a.items().filter(i => MATCH.planks.test(i.name)).sort((x, y) => y.count - x.count)[0] || null
      case 'slab': return a.findMatch(MATCH.slab)
      case 'window': return a.find('glass_pane') || a.findMatch(/_fence$/)
      case 'door': return a.findMatch(MATCH.door)
      case 'torch': return a.find('torch')
      case 'bed': return a.findMatch(MATCH.bed)
      default: return a.find(kind)
    }
  }

  woodType () {
    const it = this.ctx.actions.items().filter(i => MATCH.planks.test(i.name)).sort((x, y) => y.count - x.count)[0]
    return it ? it.name.replace('_planks', '') : null
  }

  /** Alle Bauteile vorab an der Werkbank craften (eine saubere Sitzung statt 20 einzelner). */
  async prepareParts (token) {
    const { ctx } = this
    const a = ctx.actions
    const c = ctx.crafting
    const need = this.requirements().need
    // Stämme für die Eckpfeiler zurückhalten, den Rest zu Planken
    const logs = c.logItems().reduce((n, i) => n + i.count, 0)
    const spare = Math.max(0, logs - need.log)
    if (spare > 0) await c.ensurePlanks(c.plankCount() + spare * 4, token)
    const wood = this.woodType()
    if (!wood) return false
    const list = []
    if (a.countMatch(MATCH.slab) < need.slab) list.push([`${wood}_slab`, need.slab])
    if (need.door && !a.countMatch(MATCH.door)) list.push([`${wood}_door`, 1])
    if (a.countMatch(MATCH.window) < need.window) list.push([`${wood}_fence`, need.window])
    if (a.count('chest') < need.chest) list.push(['chest', need.chest])
    if (a.count('furnace') < need.furnace) list.push(['furnace', need.furnace])
    if (need.crafting_table && a.count('crafting_table') < 1) list.push(['crafting_table', 1])
    if (need.bed && !a.findMatch(MATCH.bed) && ctx.gear.sameWool() >= 3) list.push([ctx.gear.sameWoolName().replace('_wool', '_bed'), 1])
    if (list.length) await c.craftAtTable(list, token, { keep: false })
    await ctx.mining.ensureTorches(token)
    return true
  }

  // ---------------------------------------------------------------- Bauen
  /** Standplatz im Innenraum, von dem aus die Zelle gut erreichbar ist. */
  async standFor (c, token) {
    const { bot, ctx } = this
    const a = ctx.actions
    const target = this.world(c.i, c.j, c.k)
    if (c.from) {
      const s = this.world(c.from.i, 1, c.from.k)
      await a.goto(new goals.GoalBlock(s.x, s.y, s.z), { token, timeout: 10000 })
      return a.distToBlock(target) <= 4.6
    }
    const cands = []
    for (let i = 1; i <= 5; i++) {
      for (let k = 1; k <= 5; k++) {
        const s = this.world(i, 1, k)
        if (a.isSolid(bot.blockAt(s)) || a.isSolid(bot.blockAt(s.offset(0, 1, 0)))) continue
        if (!a.isSolid(bot.blockAt(s.offset(0, -1, 0)))) continue
        const hd = Math.hypot(i - c.i, k - c.k)
        if (hd < (c.j <= 1 ? 1.4 : 0.9)) continue
        const eye = s.offset(0.5, 1.62, 0.5)
        const d = eye.distanceTo(target.offset(0.5, 0.5, 0.5))
        if (d > 4.3) continue
        cands.push({ s, score: Math.abs(d - 2.6) + s.distanceTo(bot.entity.position) * 0.15 })
      }
    }
    cands.sort((x, y) => x.score - y.score)
    for (const cand of cands.slice(0, 3)) {
      if (bot.entity.position.distanceTo(cand.s.offset(0.5, 0, 0.5)) < 0.6 && a.distToBlock(target) <= 4.5) return true
      if (await a.goto(new goals.GoalBlock(cand.s.x, cand.s.y, cand.s.z), { token, timeout: 9000 })) {
        if (a.distToBlock(target) <= 4.6) return true
      }
    }
    // Fundament-Phase: es gibt noch keinen Innenraum-Boden -> einfach in Reichweite gehen
    return a.reach(target, 3.4, { token, timeout: 10000 })
  }

  async buildCell (c, token) {
    const { bot, ctx } = this
    const a = ctx.actions
    if (this.cellDone(c)) return 'done'
    const pos = this.world(c.i, c.j, c.k)
    const item = this.itemFor(c.kind)
    if (!item) return 'missing'
    for (let attempt = 0; attempt < 3; attempt++) {
      token.check()
      if (!(await this.standFor(c, token))) continue
      if (a.botOccupies(pos)) {
        await a.goto(new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, 1)), { token, timeout: 4000 })
        continue
      }
      // falscher Block an der Stelle (Erde/Gras im Fundament) -> erst abbauen
      const cur = bot.blockAt(pos)
      if (cur && !a.isReplaceable(cur)) {
        if (/chest|furnace|crafting_table|_bed$|enchanting_table|obsidian/.test(cur.name)) return 'blocked'
        const r = await a.dig(cur, { token })
        if (r !== 'ok' && r !== 'gone') continue
        await bot.waitForTicks(2)
      } else if (cur && !a.isAir(cur) && !a.isLiquid(cur)) {
        await a.dig(cur, { token }) // Gras/Blume
      }
      const opts = { token, sneak: true }
      let ok
      if (c.kind === 'torch') ok = await this.placeWallTorch(c, token)
      else if (c.face) ok = await this.placeWithFace(pos, item, c.face, opts)
      else ok = await a.placeAt(pos, item, opts)
      await bot.waitForTicks(2)
      if (ok && this.cellDone(c)) {
        ctx.emit('swing', { kind: 'place', block: item.name })
        return 'placed'
      }
    }
    return 'failed'
  }

  /** Platzieren an einer festen Referenzfläche (z. B. Stufe AUF die Wand = untere Stufe). */
  async placeWithFace (pos, item, face, o) {
    const { bot, ctx } = this
    const a = ctx.actions
    const ref = bot.blockAt(pos.minus(face))
    if (!a.isSolid(ref)) return a.placeAt(pos, item, o)
    if (a.botOccupies(pos)) return false
    a.stopMoving()
    await a.waitOnGround()
    a._lock('place')
    try {
      await a.equip(item)
      await ctx.look.aim(ref.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5), { profile: 'work', tolerance: 2.5 })
      bot.setControlState('sneak', true)
      await bot.waitForTicks(2)
      try { await bot.placeBlock(ref, face) } catch (e) {
        const now = bot.blockAt(pos)
        if (!now || a.isReplaceable(now)) return false
      } finally { bot.setControlState('sneak', false) }
      await sleep(rand(60, 140))
      return true
    } finally { a._unlock() }
  }

  async placeWallTorch (c, token) {
    const pos = this.world(c.i, c.j, c.k)
    const wallI = c.i <= 1 ? 0 : SIZE - 1
    const face = new Vec3(c.i <= 1 ? 1 : -1, 0, 0)
    const wall = this.bot.blockAt(this.world(wallI, c.j, c.k))
    if (!this.ctx.actions.isSolid(wall)) return false
    return this.placeWithFace(pos, this.ctx.actions.find('torch'), face, { token })
  }

  /**
   * Hauptroutine. Liefert true, wenn das Haus fertig ist.
   */
  async build (token) {
    const { bot, ctx } = this
    const a = ctx.actions
    if (!this.base) {
      const site = this.findSite()
      if (!site) { ctx.emit('build_blocked', { reason: 'no_site' }); await ctx.explore(token, 40); return false }
      ctx.memory.base = { origin: site.origin, center: site.center, done: false, started: false }
      ctx.emit('build_site', { x: site.center.x, y: site.center.y, z: site.center.z })
    }
    const c0 = this.base.center
    await a.goto(new goals.GoalNear(c0.x, c0.y, c0.z, 4), { token, timeout: 60000 })
    await this.prepareParts(token)
    if (!this.base.started) {
      await this.levelSite(token)
      this.base.started = true
      ctx.emit('build_start', {})
    }
    const cells = this.blueprint()
    const total = cells.length
    let lastStage = -1
    let missingKinds = new Set()
    for (const c of cells) {
      token.check()
      if (c.cap) continue // Dachkappe kommt ganz zum Schluss von oben
      if (Math.floor(c.stage) !== lastStage) {
        lastStage = Math.floor(c.stage)
        const done = cells.filter(x => this.cellDone(x)).length
        ctx.emit('build_progress', { stage: lastStage, done, total, percent: Math.round(done / total * 100) })
      }
      const r = await this.buildCell(c, token)
      if (r === 'missing' && !c.optional) missingKinds.add(c.kind)
    }
    if (!missingKinds.size) {
      try { await this.buildCap(token) } catch (e) { if (e.isInterrupt) throw e; ctx.log('Dachkappe: ' + e.message) }
    }
    missingKinds = new Set(cells.filter(c => !c.optional && !c.cap && !this.cellDone(c)).map(c => c.kind))
    const remaining = cells.filter(c => !c.optional && !c.cap && !this.cellDone(c)).length
    if (remaining === 0) {
      this.base.done = true
      ctx.memory.bedPlaced = cells.some(c => c.kind === 'bed' && this.cellDone(c))
      ctx.emit('build_done', { bed: ctx.memory.bedPlaced })
      await this.storeExcess(token)
      return true
    }
    ctx.emit('build_paused', { remaining, missing: [...missingKinds] })
    void bot
    return false
  }

  /** Dachkappe (3x3 Stufen) von oben: außen hochpillern, aufs Dach, setzen, Pfeiler wieder abbauen. */
  async buildCap (token) {
    const { bot, ctx } = this
    const a = ctx.actions
    const caps = this.blueprint().filter(c => c.cap && !this.cellDone(c))
    if (!caps.length) return true
    if (a.countMatch(MATCH.slab) < caps.length) return false
    const pillar = this.world(-1, 1, 3)
    const scaffold = a.findFirst(['dirt', 'cobblestone', 'cobbled_deepslate'])
    if (!scaffold || scaffold.count < 4) return false
    if (!(await a.goto(new goals.GoalBlock(pillar.x, pillar.y, pillar.z), { token, timeout: 20000 }))) return false
    if (!(await ctx.watchdog.pillarUp(4, token, { force: true }))) return false
    const roof = this.world(1, 5, 3)
    if (!(await a.goto(new goals.GoalBlock(roof.x, roof.y, roof.z), { token, timeout: 8000 }))) return false
    for (const c of caps) {
      token.check()
      const pos = this.world(c.i, c.j, c.k)
      if (a.botOccupies(pos)) continue
      await this.placeWithFace(pos, this.itemFor('slab'), new Vec3(0, 1, 0), { token })
    }
    // zurück auf den Pfeiler und ihn unter den Füßen wieder abbauen (eigener Pfeiler, kein Mining)
    const top = this.world(-1, 5, 3)
    if (await a.goto(new goals.GoalBlock(top.x, top.y, top.z), { token, timeout: 8000 })) {
      for (let j = 4; j >= 1; j--) {
        const b = bot.blockAt(this.world(-1, j, 3))
        if (b && a.isSolid(b)) { await a.dig(b, { token }); await a.waitOnGround(1500) }
      }
    } else {
      const g = this.world(-2, 1, 3)
      a.walkMoves.maxDropDown = 4
      try { await a.goto(new goals.GoalNear(g.x, g.y, g.z, 1), { token, timeout: 8000 }) } finally { a.walkMoves.maxDropDown = 3 }
      for (let j = 4; j >= 1; j--) {
        const b = bot.blockAt(this.world(-1, j, 3))
        if (b && a.isSolid(b) && await a.reach(b.position, 4, { token })) await a.dig(b, { token })
      }
    }
    await a.collectDrops(pillar, 4, { token, timeout: 4000 })
    return true
  }

  // ---------------------------------------------------------------- Wohnen
  findBed () {
    if (!this.base) return null
    const o = this.origin()
    for (let i = 1; i <= 5; i++) for (let k = 1; k <= 5; k++) { const b = this.bot.blockAt(o.offset(i, 1, k)); if (b && /_bed$/.test(b.name)) return b }
    return null
  }

  isNight () { const t = this.bot.time.timeOfDay; return t >= 12542 && t <= 23459 }

  /** Nachts ins Bett: Rechtsklick setzt den Spawnpunkt. */
  async sleepInBed (token) {
    const { bot, ctx } = this
    const bed = this.findBed()
    if (!bed || !this.isNight()) return false
    if (!(await ctx.actions.reach(bed.position, 2.5, { token, timeout: 30000 }))) return false
    ctx.actions.stopMoving()
    await ctx.look.aim(bed.position.offset(0.5, 0.4, 0.5), { profile: 'work' })
    try {
      await bot.sleep(bed)
      ctx.emit('sleep', {})
      ctx.memory.spawnSet = true
      await new Promise(resolve => {
        const done = () => { bot.removeListener('wake', done); clearTimeout(t); unsub(); resolve() }
        const t = setTimeout(done, 12000)
        const unsub = token.onCancel(() => { bot.wake().catch(() => {}); done() })
        bot.once('wake', done)
      })
      token.check()
      ctx.emit('wake', {})
      return true
    } catch (e) {
      ctx.emit('sleep_failed', { reason: e.message })
      return false
    }
  }

  /** Überschuss (Bruchstein, Loot) in die Doppelkiste legen. */
  async storeExcess (token) {
    const { bot, ctx } = this
    const a = ctx.actions
    if (!this.base || !this.base.done) return false
    const chestPos = this.world(5, 1, 4)
    const block = bot.blockAt(chestPos)
    if (!block || block.name !== 'chest') return false
    const keep = { cobblestone: 64, cobbled_deepslate: 0, dirt: 16, rotten_flesh: 0, bone: 0, string: 0, gunpowder: 0, spider_eye: 0, andesite: 0, diorite: 0, granite: 0, tuff: 0, gravel: 0, raw_copper: 0, redstone: 0 }
    const excess = a.items().filter(it => it.name in keep && a.count(it.name) > keep[it.name])
    if (!excess.length) return false
    if (!(await a.reach(chestPos, 3, { token, timeout: 20000 }))) return false
    a.stopMoving()
    await ctx.look.aim(chestPos.offset(0.5, 0.6, 0.5), { profile: 'work' })
    let chest
    try { chest = await bot.openContainer(block) } catch (e) { return false }
    let stored = 0
    try {
      for (const it of excess) {
        const n = a.count(it.name) - keep[it.name]
        if (n <= 0) continue
        try { await chest.deposit(it.type, null, Math.min(n, it.count)); stored += Math.min(n, it.count); await sleep(rand(120, 220)) } catch (_) { break }
      }
    } finally { try { chest.close() } catch (_) {} }
    if (stored) ctx.emit('stored', { count: stored })
    return stored > 0
  }
}

module.exports = { BuildingPhase, SIZE }
