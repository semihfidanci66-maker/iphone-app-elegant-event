'use strict'
/**
 * Phase 2: Intelligentes Mining – 1 breite / 3 hohe Treppe (nie gerade runter!), Fackeln an die
 * rechte Wand, kompletter Erzader-Abbau (Vein-Crawler über alle 26 Nachbarn) und Lava-Sicherheit.
 */
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { sleep } = require('./actions')

const DIRS = [new Vec3(0, 0, -1), new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(-1, 0, 0)] // N, O, S, W (im Uhrzeigersinn)
const ORE_TIER = { coal: 1, copper: 2, iron: 2, lapis: 2, gold: 3, redstone: 3, diamond: 3, emerald: 3, quartz: 1, ancient_debris: 4 }
const ORE_LABEL = { coal: 'Kohle', iron: 'Eisen', gold: 'Gold', lapis: 'Lapis', diamond: 'Diamanten', redstone: 'Redstone', emerald: 'Smaragde', copper: 'Kupfer', quartz: 'Quarz' }

function oreFamily (name) {
  if (!name) return null
  if (name === 'ancient_debris') return 'ancient_debris'
  const m = /^(?:deepslate_|nether_)?([a-z]+)_ore$/.exec(name)
  return m ? m[1] : null
}

class MiningPhase {
  constructor (ctx) {
    this.ctx = ctx
    this.bot = ctx.bot
    this.oreIds = ctx.mcData.blocksArray.filter(b => oreFamily(b.name)).map(b => b.id)
    this.skipOres = new Set()
    this.stepsSinceTorch = 0
  }

  right (dir) { return new Vec3(-dir.z, 0, dir.x) }
  rotate (dir) { return DIRS[(DIRS.findIndex(d => d.equals(dir)) + 1) % 4] }
  facingDir () {
    const yaw = this.bot.entity.yaw
    const fx = -Math.sin(yaw)
    const fz = -Math.cos(yaw)
    return Math.abs(fx) > Math.abs(fz) ? new Vec3(Math.sign(fx), 0, 0) : new Vec3(0, 0, Math.sign(fz))
  }

  feet () { return this.ctx.actions.feet() }
  modernWorld () { return (this.bot.game.minY ?? 0) < 0 }
  levelFor (res) {
    const modern = this.modernWorld()
    return { stone: null, coal: modern ? 48 : 40, iron: modern ? 16 : 30, gold: modern ? -16 : 20, lapis: modern ? 0 : 18, diamond: modern ? -54 : 11, redstone: modern ? -54 : 11 }[res]
  }

  wantedFamilies () {
    const tier = this.ctx.actions.pickTier()
    return Object.keys(ORE_TIER).filter(f => ORE_TIER[f] <= tier && f !== 'copper' && f !== 'quartz' && f !== 'emerald')
  }

  // ---------------------------------------------------------------- Erze
  exposed (pos) {
    const { bot, ctx } = this
    for (const f of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const n = bot.blockAt(pos.offset(f[0], f[1], f[2]))
      if (n && !ctx.actions.isSolid(n) && n.name !== 'lava') return true
    }
    return false
  }

  /** Sichtbare (freiliegende) Erze im Umkreis – ein Mensch hat keinen Röntgenblick. */
  scanOres (radius = 5, families = this.wantedFamilies()) {
    const { bot } = this
    const found = bot.findBlocks({ matching: this.oreIds, maxDistance: radius, count: 40 })
    const out = []
    for (const p of found) {
      const key = `${p.x},${p.y},${p.z}`
      if (this.skipOres.has(key)) continue
      const b = bot.blockAt(p)
      const fam = oreFamily(b && b.name)
      if (!fam || !families.includes(fam)) continue
      if (!this.exposed(p)) continue
      out.push({ pos: p, fam, d: p.distanceTo(bot.entity.position), value: ORE_TIER[fam] + (fam === 'diamond' ? 5 : 0) })
    }
    out.sort((a, b) => (b.value - a.value) || (a.d - b.d))
    return out
  }

  /**
   * Vein-Crawler: Nach jedem abgebauten Erzblock werden alle 26 Nachbarn (3x3x3) geprüft und die
   * gesamte zusammenhängende Ader abgebaut; alle Drops werden eingesammelt, bevor es weitergeht.
   */
  async mineVein (startPos, token) {
    const { bot, ctx } = this
    const a = ctx.actions
    const first = bot.blockAt(startPos)
    const fam = oreFamily(first && first.name)
    if (!fam) return 0
    if (!a.canHarvest(first)) { this.skipOres.add(`${startPos.x},${startPos.y},${startPos.z}`); return 0 }
    ctx.emit('ore_found', { ore: fam, label: ORE_LABEL[fam] || fam, y: startPos.y })
    const queue = [startPos.clone()]
    const seen = new Set()
    const minedAt = []
    let mined = 0
    while (queue.length && mined < 48) {
      token.check()
      queue.sort((p, q) => p.distanceTo(bot.entity.position) - q.distanceTo(bot.entity.position))
      const pos = queue.shift()
      const key = `${pos.x},${pos.y},${pos.z}`
      if (seen.has(key)) continue
      seen.add(key)
      const b = bot.blockAt(pos)
      if (oreFamily(b && b.name) !== fam) continue
      if (a.distToBlock(pos) > 4.3) {
        // innerhalb der Mining-Routine darf sich der Bot zum Erz durchgraben
        const ok = await a.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2), { token, timeout: 12000, moves: a.digMoves })
        if (!ok || a.distToBlock(pos) > 4.8) { this.skipOres.add(key); continue }
      }
      const r = await a.dig(bot.blockAt(pos), { token, lavaCheck: true, requireHarvest: true })
      if (r === 'lava') { this.skipOres.add(key); ctx.emit('lava_avoided', { ore: fam }); continue }
      if (r !== 'ok') { this.skipOres.add(key); continue }
      mined++
      minedAt.push(pos)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            if (!dx && !dy && !dz) continue
            const n = pos.offset(dx, dy, dz)
            if (!seen.has(`${n.x},${n.y},${n.z}`) && oreFamily(bot.blockAt(n)?.name) === fam) queue.push(n)
          }
        }
      }
    }
    // jeden einzelnen Drop mitnehmen
    if (minedAt.length) {
      const c = minedAt.reduce((s, p) => s.plus(p), new Vec3(0, 0, 0)).scaled(1 / minedAt.length)
      await a.collectDrops(c.offset(0.5, 0, 0.5), 5, { token, timeout: 9000, moves: a.digMoves })
    }
    ctx.emit('vein_done', { ore: fam, label: ORE_LABEL[fam] || fam, count: mined, y: Math.floor(bot.entity.position.y) })
    return mined
  }

  async mineVisibleOres (token, radius = 5) {
    let total = 0
    for (let i = 0; i < 6; i++) {
      const ores = this.scanOres(radius)
      if (!ores.length) break
      total += await this.mineVein(ores[0].pos, token)
    }
    return total
  }

  // ---------------------------------------------------------------- Fackeln
  async ensureTorches (token) {
    const { ctx } = this
    const a = ctx.actions
    const want = ctx.policy ? ctx.policy().torchStock : 6
    if (a.count('torch') >= want) return
    const fuel = a.find('coal') || a.find('charcoal')
    if (!fuel) return
    if (!(await ctx.crafting.ensureSticks(1, token))) return
    await ctx.crafting.craftDirect('torch', Math.min(32, a.count('torch') + fuel.count * 4), token)
  }

  /** Alle 8 Blöcke: wenn Blocklicht < 7, Fackel an die rechte Wand. */
  async maybeTorch (dir, token) {
    const { bot, ctx } = this
    const a = ctx.actions
    if (++this.stepsSinceTorch < 8) return false
    const here = bot.blockAt(this.feet())
    const light = here ? (here.light ?? 0) : 0
    if (light >= 7) { this.stepsSinceTorch = 4; return false }
    if (!a.find('torch')) { await this.ensureTorches(token); if (!a.find('torch')) return false }
    const r = this.right(dir)
    const feet = this.feet()
    const wall = bot.blockAt(feet.offset(r.x, 1, r.z))
    if (!a.isSolid(wall)) return false
    a.stopMoving()
    await a.waitOnGround()
    await a.equip('torch')
    const face = new Vec3(-r.x, 0, -r.z)
    await ctx.look.aim(wall.position.offset(0.5 + face.x * 0.5, 0.5, 0.5 + face.z * 0.5), { profile: 'work' })
    try {
      ctx.emit('swing', { kind: 'place', block: 'torch' })
      await bot.placeBlock(wall, face)
      this.stepsSinceTorch = 0
      ctx.emit('torch', { y: feet.y })
      return true
    } catch (_) { return false }
  }

  // ---------------------------------------------------------------- Treppe & Tunnel
  /**
   * Ein Treppenschritt nach unten: Spalte vor dem Bot 3 hoch freiräumen (Kopf, Körper, Stufe),
   * dann einen Block vor und einen runter gehen.
   * @returns {Promise<'ok'|'lava'|'water'|'void'|'blocked'>}
   */
  async stairStepDown (dir, token) {
    const { bot, ctx } = this
    const a = ctx.actions
    await a.waitOnGround(1500) // erst landen, dann die Fußposition lesen
    const p = this.feet()
    const f = p.plus(dir)
    const under = bot.blockAt(f.offset(0, -2, 0))
    if (!under) return 'blocked'
    if (a.isLava(under)) return 'lava'
    if (!a.isSolid(under)) {
      // Höhle unter der nächsten Stufe: nur weiter, wenn der Fall kurz ist
      let drop = 0
      while (drop < 5 && !a.isSolid(bot.blockAt(f.offset(0, -2 - drop, 0)))) {
        if (a.isLava(bot.blockAt(f.offset(0, -2 - drop, 0)))) return 'lava'
        drop++
      }
      if (drop > 2) return 'void'
    }
    for (const dy of [1, 0, -1]) {
      token.check()
      const r = await a.digUntilClear(f.offset(0, dy, 0), { token, lavaCheck: true })
      if (r === 'lava') return 'lava'
      if (r === 'water') return 'water'
      if (r !== 'ok') return 'blocked'
    }
    const ok = await a.goto(new goals.GoalBlock(f.x, f.y - 1, f.z), { token, timeout: 6000 })
    if (!ok && this.feet().y >= p.y && this.feet().distanceTo(p) < 0.5) return 'blocked'
    return 'ok'
  }

  /** Ein Tunnelschritt geradeaus (1 breit, 2 hoch). */
  async tunnelStep (dir, token) {
    const { bot, ctx } = this
    const a = ctx.actions
    await a.waitOnGround(1500) // erst landen, dann die Fußposition lesen
    const p = this.feet()
    const f = p.plus(dir)
    for (const dy of [1, 0]) {
      token.check()
      const r = await a.digUntilClear(f.offset(0, dy, 0), { token, lavaCheck: true })
      if (r === 'lava') return 'lava'
      if (r === 'water') return 'water'
      if (r !== 'ok') return 'blocked'
    }
    const floor = bot.blockAt(f.offset(0, -1, 0))
    if (a.isLava(floor)) return 'lava'
    if (!a.isSolid(floor)) {
      const filler = a.findFirst(['cobblestone', 'cobbled_deepslate', 'dirt', 'stone'])
      if (!filler || !(await a.placeAt(f.offset(0, -1, 0), filler.name, { token }))) return 'void'
    }
    const ok = await a.goto(new goals.GoalBlock(f.x, f.y, f.z), { token, timeout: 6000 })
    return ok ? 'ok' : 'blocked'
  }

  /** Ein Treppenschritt nach oben (Rückweg, falls der alte Gang nicht begehbar ist). */
  async stairStepUp (dir, token) {
    const { bot, ctx } = this
    const a = ctx.actions
    await a.waitOnGround(1500) // erst landen, dann die Fußposition lesen
    const p = this.feet()
    const f = p.plus(dir)
    for (const q of [p.offset(0, 2, 0), f.offset(0, 2, 0), f.offset(0, 1, 0)]) {
      const r = await a.digUntilClear(q, { token, lavaCheck: true })
      if (r === 'lava' || r === 'water') return r
      if (r !== 'ok') return 'blocked'
    }
    if (!a.isSolid(bot.blockAt(f))) {
      const filler = a.findFirst(['cobblestone', 'cobbled_deepslate', 'dirt', 'stone'])
      if (!filler || !(await a.placeAt(f, filler.name, { token }))) return 'blocked'
    }
    const ok = await a.goto(new goals.GoalBlock(f.x, f.y + 1, f.z), { token, timeout: 6000 })
    return ok ? 'ok' : 'blocked'
  }

  canKeepMining () {
    const { bot, ctx } = this
    if (ctx.actions.pickTier() < 1) return 'no_pickaxe'
    if (bot.health < 8) return 'low_health'
    if (bot.food <= 6 && !ctx.actions.findMatch(/^(cooked_|bread|golden_apple|apple|baked_potato)/)) return 'starving'
    return null
  }

  /**
   * Gräbt eine saubere Treppe bis targetY (oder bis done() true liefert) und baut unterwegs alle
   * freigelegten Erzadern ab.
   */
  async staircaseDown (targetY, token, done = () => false) {
    const { bot, ctx } = this
    let dir = this.facingDir()
    let turns = 0
    let steps = 0
    ctx.look.attentive = true
    this.rememberEntrance()
    ctx.emit('mine_start', { targetY, fromY: this.feet().y })
    try {
      while (this.feet().y > targetY && !done()) {
        token.check()
        const stop = this.canKeepMining()
        if (stop) { ctx.emit('mine_abort', { reason: stop }); return false }
        const r = await this.stairStepDown(dir, token)
        if (r === 'ok') {
          turns = 0
          steps++
          await this.maybeTorch(dir, token)
          await this.mineVisibleOres(token, 5)
          if (steps % 6 === 0) { await ctx.actions.tossJunk(); await this.ensureTorches(token) }
          if (steps % 12 === 0) ctx.emit('mine_progress', { y: this.feet().y, targetY })
        } else {
          // Lava/Wasser/Abgrund voraus: wie ein Mensch die Richtung wechseln
          ctx.emit('mine_turn', { reason: r, y: this.feet().y })
          dir = this.rotate(dir)
          if (++turns >= 4) return false
        }
      }
      return true
    } finally {
      ctx.look.attentive = false
      void bot
    }
  }

  /** Stollen auf einer Ebene (Branch-Mining): gerade Gänge, alle 3 Blöcke ein paralleler Ast. */
  async branchMine (token, done, budget = 220) {
    const { ctx } = this
    let dir = this.facingDir()
    let dug = 0
    let straight = 0
    let turns = 0
    ctx.look.attentive = true
    try {
      while (dug < budget && !done()) {
        token.check()
        const stop = this.canKeepMining()
        if (stop) { ctx.emit('mine_abort', { reason: stop }); return false }
        const r = await this.tunnelStep(dir, token)
        if (r === 'ok') {
          dug++; straight++; turns = 0
          await this.maybeTorch(dir, token)
          await this.mineVisibleOres(token, 5)
          if (dug % 8 === 0) { await ctx.actions.tossJunk(); await this.ensureTorches(token) }
          if (dug % 16 === 0) ctx.emit('mine_progress', { y: this.feet().y, tunnel: dug })
          if (straight >= 24) {
            // Seitenast: 3 Blöcke nach rechts, dann parallel zurück
            const side = this.rotate(dir)
            for (let i = 0; i < 3 && !done(); i++) { if ((await this.tunnelStep(side, token)) !== 'ok') break; dug++ }
            dir = this.rotate(side)
            straight = 0
          }
        } else {
          ctx.emit('mine_turn', { reason: r, y: this.feet().y })
          dir = this.rotate(dir)
          straight = 0
          if (++turns >= 4) return false
        }
      }
      return done()
    } finally {
      ctx.look.attentive = false
    }
  }

  rememberEntrance () {
    const { bot, ctx } = this
    const p = this.feet()
    const here = bot.blockAt(p)
    // nur merken, wenn wir (noch) an der Oberfläche stehen
    if (here && this.isSurface() && !ctx.memory.mineEntrance) ctx.memory.mineEntrance = { x: p.x, y: p.y, z: p.z }
  }

  /** Oberfläche = Himmelslicht UND keine Decke über dem Kopf (Himmelslicht allein ist nicht auf jedem Server verlässlich). */
  isSurface () {
    const { bot, ctx } = this
    const head = this.feet().offset(0, 1, 0)
    const b = bot.blockAt(head)
    if (!b || (b.skyLight ?? 0) < 13) return false
    for (let dy = 1; dy <= 24; dy++) if (ctx.actions.isSolid(bot.blockAt(head.offset(0, dy, 0)))) return false
    return true
  }

  async returnToSurface (token) {
    const { bot, ctx } = this
    const a = ctx.actions
    if (this.isSurface() || /nether|end/.test(bot.game.dimension || '')) return true
    ctx.emit('mine_return', { y: this.feet().y })
    const e = ctx.memory.mineEntrance
    if (e) {
      // zuerst die eigene Treppe hochlaufen (ohne zu graben), sonst freigraben
      if (await a.goto(new goals.GoalNear(e.x, e.y, e.z, 2), { token, timeout: 60000 })) { ctx.memory.mineEntrance = null; return true }
      if (await a.goto(new goals.GoalNear(e.x, e.y, e.z, 2), { token, timeout: 60000, moves: a.digMoves })) { ctx.memory.mineEntrance = null; return true }
    }
    let dir = this.facingDir()
    let turns = 0
    for (let i = 0; i < 160 && !this.isSurface(); i++) {
      token.check()
      const r = await this.stairStepUp(dir, token)
      if (r !== 'ok') { dir = this.rotate(dir); if (++turns >= 4) break } else turns = 0
    }
    ctx.memory.mineEntrance = null
    return this.isSurface()
  }

  /**
   * Beschafft eine Ressource ('stone'|'coal'|'iron'|'gold'|'lapis'|'diamond').
   * done() entscheidet anhand des Inventars, wann genug da ist.
   */
  async mineFor (resource, done, token) {
    const { bot, ctx } = this
    const a = ctx.actions
    if (done()) return true
    // SURFACE_SURVIVAL: ohne Freigabe kein Erzabbau unter Tage; Stein nur als flacher Steinbruch (nie unter Y 58)
    const cave = ctx.caveAllowed()
    if (!cave && resource !== 'stone') { ctx.emit('cave_locked', { resource }); return false }
    if (a.pickTier() < 1) return false
    await a.equip(a.bestTool('pickaxe'))
    // 1) Sichtbare Erze/Höhlen zuerst – kein Mensch gräbt, wenn das Erz offen in der Wand hängt
    const fams = resource === 'stone' ? [] : [resource, 'coal'].filter(f => this.wantedFamilies().includes(f))
    for (let i = 0; i < 4 && fams.length && !done(); i++) {
      const ores = this.scanOres(24, fams)
      if (!ores.length) break
      const o = ores[0]
      const ok = await a.goto(new goals.GoalNear(o.pos.x, o.pos.y, o.pos.z, 3), { token, timeout: 30000 })
      if (!ok) { this.skipOres.add(`${o.pos.x},${o.pos.y},${o.pos.z}`); continue }
      await this.mineVein(o.pos, token)
    }
    if (done()) return true
    // 2) Treppe auf die richtige Ebene
    const level = this.levelFor(resource)
    const y = this.feet().y
    let target = level === null || level === undefined ? y - 8 : Math.min(level, y - 4)
    if (!cave) { target = Math.max(target, 58); if (y - 2 < target) return done() }
    if (y > target) {
      const ok = await this.staircaseDown(target, token, done)
      if (done()) return true
      if (!ok && this.feet().y > target + 6) return false
    }
    // 3) Stollen auf der Ebene (nur mit Höhlen-Freigabe)
    if (!cave) return done()
    return this.branchMine(token, done, resource === 'diamond' ? 420 : 200)
  }

  // ---------------------------------------------------------------- Obsidian / Feuerstein
  /** Obsidian mit Wassereimer an einem Lavasee erzeugen und mit der Diamantspitzhacke abbauen. */
  async harvestObsidian (count, token) {
    const { bot, ctx } = this
    if (!ctx.caveAllowed()) return false
    const a = ctx.actions
    const obsId = ctx.mcData.blocksByName.obsidian.id
    const lavaId = ctx.mcData.blocksByName.lava.id
    if (a.pickTier() < 4) return false
    let attempts = 0
    while (a.count('obsidian') < count && attempts++ < 30) {
      token.check()
      const obs = bot.findBlocks({ matching: obsId, maxDistance: 20, count: 20 })
        .filter(p => !ctx.isBaseBlock(p) && !ctx.isPortalBlock(p))
        .sort((p, q) => p.distanceTo(bot.entity.position) - q.distanceTo(bot.entity.position))
      if (obs.length) {
        const p = obs[0]
        if (!(await a.reach(p, 3.6, { token, timeout: 20000 })) && !(await a.reach(p, 3.6, { token, timeout: 20000, moves: a.digMoves }))) { attempts += 3; continue }
        const r = await a.dig(bot.blockAt(p), { token })
        if (r === 'ok') {
          await bot.waitForTicks(3)
          if (a.isLava(bot.blockAt(p))) await a.sealLava(p, token)
          await a.collectDrops(p.offset(0.5, 0, 0.5), 3, { token, timeout: 5000 })
          ctx.emit('obsidian', { count: a.count('obsidian'), need: count })
        }
        continue
      }
      if (!a.find('water_bucket')) return false
      // Lavasee suchen: Quellblock mit Luft darüber und festem Rand daneben
      const lava = bot.findBlocks({ matching: lavaId, maxDistance: 28, count: 80 }).filter(p => {
        const b = bot.blockAt(p)
        return b && b.metadata === 0 && a.isAir(bot.blockAt(p.offset(0, 1, 0)))
      })
      let edge = null
      for (const p of lava) {
        for (const d of DIRS) {
          const e = p.plus(d)
          if (a.isSolid(bot.blockAt(e)) && a.isAir(bot.blockAt(e.offset(0, 1, 0))) && a.isAir(bot.blockAt(e.offset(0, 2, 0)))) { edge = e; break }
        }
        if (edge) break
      }
      if (!edge) return false
      if (!(await a.goto(new goals.GoalNear(edge.x, edge.y + 1, edge.z, 2), { token, timeout: 30000 }))) return false
      // Wasser auf die Kante kippen -> fließt über die Lava -> Obsidian; danach Wasser wieder aufnehmen
      await this.useBucket('water_bucket', edge.offset(0.5, 1, 0.5), token)
      await sleep(2500)
      await this.useBucket('bucket', edge.offset(0.5, 1.2, 0.5), token)
      await sleep(1200)
    }
    return a.count('obsidian') >= count
  }

  async useBucket (itemName, point, token) {
    const { bot, ctx } = this
    const a = ctx.actions
    if (!a.find(itemName)) return false
    a.stopMoving()
    await a.waitOnGround()
    await a.equip(itemName)
    await ctx.look.aim(point, { profile: 'work' })
    if (token) token.check()
    bot.activateItem()
    await bot.waitForTicks(6)
    try { bot.deactivateItem() } catch (_) {}
    return true
  }

  /** Feuerstein: Kies abbauen – und wie ein Profi denselben Kies wieder setzen und erneut abbauen. */
  async gatherFlint (token) {
    const { bot, ctx } = this
    const a = ctx.actions
    if (a.count('flint') >= 1) return true
    const gravelId = ctx.mcData.blocksByName.gravel.id
    for (let i = 0; i < 40 && a.count('flint') < 1; i++) {
      token.check()
      const pos = bot.findBlock({ matching: gravelId, maxDistance: 32 })
      if (!pos) {
        if (!a.find('gravel')) return false
        const spot = ctx.crafting.findPlacementSpot()
        if (!spot || !(await a.placeAt(spot, 'gravel', { token }))) return false
        continue
      }
      if (!(await a.reach(pos.position, 3.6, { token, timeout: 20000 }))) return false
      await a.dig(bot.blockAt(pos.position), { token })
      await a.collectDrops(pos.position.offset(0.5, 0, 0.5), 3, { token, timeout: 4000 })
    }
    return a.count('flint') >= 1
  }
}

module.exports = { MiningPhase, oreFamily, ORE_LABEL, DIRS }
