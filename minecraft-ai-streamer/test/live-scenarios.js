'use strict'
/**
 * Live-Szenarien gegen einen echten Server (Bot braucht OP, Welt: superflat).
 *   node test/live-scenarios.js [port] [szenario,szenario,...]
 * Szenarien: look, hotbar, tree, stairs, pillar, house
 */
const { Vec3 } = require('vec3')
const { MinecraftAIBot } = require('../modules/mc-ai-bot')
const { TaskToken, sleep } = require('../modules/bot/actions')
const { LAYOUT } = require('../modules/bot/hotbar')

const port = Number(process.argv[2] || 25599)
const only = (process.argv[3] || 'look,hotbar,tree,stairs,pillar,house').split(',')
const ai = new MinecraftAIBot({ host: '127.0.0.1', port, username: 'KI_Streamer', version: '1.21.1' })
ai.paused = true
const results = []
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`) }
const events = []
ai.on('event', e => { events.push(e); if (process.env.VERBOSE && !['swing','hotbar'].includes(e.type)) console.log('   ·', e.type, JSON.stringify(e.data).slice(0, 160)); else if (e.type === 'log' || e.type === 'bot_error') console.log('   ·', e.type, e.data.message) })

async function cmd (...list) { ai.runCommands(list); await sleep(120 + list.length * 80) }
const DEG = 180 / Math.PI

async function run () {
  await new Promise(resolve => ai.on('event', e => e.type === 'bot_spawned' && resolve()))
  await sleep(2500)
  const { ctx, bot } = ai
  const token = new TaskToken('test')
  const ground = () => ctx.actions.feet().y
  // trockene, ebene Grasfläche suchen (der Testserver streut Wasser/Sand in die Flachwelt)
  const dry = (c, r) => { for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) { if (bot.blockAt(c.offset(dx, -1, dz))?.name !== 'grass_block' || bot.blockAt(c.offset(dx, 0, dz))?.name !== 'air') return false } return true }
  const used = []
  const findDry = (r) => {
    const f = ctx.actions.feet()
    for (let d = 0; d <= 60; d += 4) for (let dx = -d; dx <= d; dx += 4) for (let dz = -d; dz <= d; dz += 4) {
      for (const dy of [0, 1, 2, -1, 3]) { const c = f.offset(dx, dy, dz); if (dry(c, r) && used.every(u => u.distanceTo(c) > 26)) { used.push(c); return c } }
    }
    throw new Error('keine trockene Fläche')
  }
  const goDry = async (r) => { const c = findDry(r); await cmd(`teleport KI_Streamer ${c.x} ${c.y} ${c.z}`); await sleep(1500); ctx.look.syncFromEntity(); return c }
  let home = await goDry(8)

  if (only.includes('look')) {
    const samples = []
    const rec = () => samples.push(bot.entity.yaw)
    bot.on('physicsTick', rec)
    const start = bot.entity.yaw
    const done = await ctx.look.aimAngles(start + Math.PI * 0.97, 0, { profile: 'combat', timeout: 3000 })
    await bot.waitForTicks(6)
    bot.removeListener('physicsTick', rec)
    let maxStep = 0
    for (let i = 1; i < samples.length; i++) { let d = Math.abs(samples[i] - samples[i - 1]); if (d > Math.PI) d = 2 * Math.PI - d; maxStep = Math.max(maxStep, d * DEG) }
    let firstStep = Math.abs(samples[1] - samples[0]); if (firstStep > Math.PI) firstStep = 2 * Math.PI - firstStep; firstStep *= DEG
    console.log('   · yaw/Tick:', samples.map(s => Math.round(s * DEG)).join(' '))
    check('look: 180°-Drehung kommt an', done === true, `(${samples.length} Ticks)`)
    check('look: nie schneller als 25°/Tick', maxStep <= 25.01, `(max ${maxStep.toFixed(1)}°/Tick)`)
    check('look: kein 1-Tick-Snap (>= 7 Ticks für 175°)', samples.filter((s, i) => i && Math.abs(s - samples[i - 1]) > 0.001).length >= 7)
    check('look: weiches Anfahren (erster Tick < max)', firstStep < maxStep, `(erster ${firstStep.toFixed(1)}°, max ${maxStep.toFixed(1)}°)`)
    // Umschau-Blick ändert nur den gesendeten Kopf, nicht die Laufrichtung
    ctx.look.attentive = true
    ctx.look.nextGlanceAt = 0
    const moveYaw = ctx.look.yaw
    let sawOffset = false
    const watch = () => { if (Math.abs(ctx.look.headYawOffset) > 0.5) sawOffset = true }
    bot.on('physicsTick', watch)
    await sleep(1600)
    bot.removeListener('physicsTick', watch)
    ctx.look.attentive = false
    check('look: Umschau-Blick (Glance) wird ausgeführt', sawOffset)
    check('look: Laufrichtung bleibt beim Glance stabil', Math.abs(ctx.look.yaw - moveYaw) < 0.02)
    await sleep(900)
  }

  if (only.includes('hotbar')) {
    await cmd('give KI_Streamer dirt 20', 'give KI_Streamer torch 16', 'give KI_Streamer stone_sword 1', 'give KI_Streamer cooked_beef 8', 'give KI_Streamer iron_pickaxe 1', 'give KI_Streamer cobblestone 64', 'give KI_Streamer stone_axe 1', 'give KI_Streamer water_bucket 1', 'give KI_Streamer wooden_sword 1', 'give KI_Streamer stone_shovel 1', 'give KI_Streamer crafting_table 1', 'give KI_Streamer shield 1')
    await sleep(800)
    await ctx.hotbar.organize(true)
    await sleep(500)
    const slot = i => bot.inventory.slots[36 + i]?.name
    const want = ['stone_sword', 'iron_pickaxe', 'stone_axe', 'stone_shovel', 'cobblestone', 'cooked_beef', 'torch', 'crafting_table', 'water_bucket']
    const got = want.map((_, i) => slot(i))
    check('hotbar: Muscle-Memory-Layout 1–9', JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got))
    check('hotbar: Schild in der Off-Hand', bot.inventory.slots[45]?.name === 'shield')
    void LAYOUT
  }

  if (only.includes('tree')) {
    const g = ground()
    const t = home.offset(7, 0, 4)
    const c = []
    for (let j = 0; j < 6; j++) c.push(`setblock ${t.x} ${g + j} ${t.z} oak_log`)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const j of [4, 5]) c.push(`setblock ${t.x + dx} ${g + j} ${t.z + dz} oak_leaves`)
    c.push(`setblock ${t.x} ${g + 6} ${t.z} oak_leaves`)
    await cmd(...c)
    await sleep(600)
    const order = []
    for (let j = 0; j < 6; j++) bot.on(`blockUpdate:(${t.x}, ${g + j}, ${t.z})`, (o, n) => { if (n && n.name === 'air') order.push(j) })
    const tree = ctx.wood.findTree(32)
    check('tree: natürlicher Baum wird gefunden', !!tree && tree.base.x === t.x && tree.base.z === t.z, tree ? `(Höhe ${tree.height})` : '')
    const before = ctx.crafting.logCount()
    const n = tree ? await ctx.wood.chopTree(tree, token) : 0
    check('tree: alle 6 Stämme gefällt', n === 6, `(${n})`)
    check('tree: unterster Block zuletzt', order.length === 6 && order[order.length - 1] === 0, JSON.stringify(order))
    check('tree: Drops eingesammelt', ctx.crafting.logCount() - before >= 5, `(+${ctx.crafting.logCount() - before})`)
    check('tree: kein Bewegungs-Lock übrig', ctx.actions.locked === false)
  }

  if (only.includes('stairs')) {
    await goDry(9)
    const y0 = ground()
    const start = ctx.actions.feet()
    console.log('   · start', bot.entity.position.toString(), [2, 1, 0, -1, -2].map(dy => bot.blockAt(start.offset(1, dy, 0))?.name).join(','))
    let jumpedWhileDigging = 0
    const guard = () => { if (bot.targetDigBlock && ['forward', 'back', 'left', 'right', 'jump', 'sprint'].some(k => bot.getControlState(k))) jumpedWhileDigging++ }
    bot.on('physicsTick', guard)
    await ctx.actions.equip(ctx.actions.bestTool('pickaxe'))
    const trail = []
    const tr = setInterval(() => trail.push(ctx.actions.feet().toString()), 400)
    const ok = await ctx.mining.staircaseDown(y0 - 6, token)
    clearInterval(tr)
    console.log('   · Spur:', [...new Set(trail)].join(' '))
    bot.removeListener('physicsTick', guard)
    const end = ctx.actions.feet()
    check('stairs: 6 Ebenen tiefer', ok && end.y === y0 - 6, `(y ${y0} -> ${end.y})`)
    check('stairs: nie gerade nach unten (horizontaler Versatz = Tiefe)', Math.abs(end.x - start.x) + Math.abs(end.z - start.z) === 6, `(Versatz ${Math.abs(end.x - start.x) + Math.abs(end.z - start.z)})`)
    check('stairs: 3 Blöcke Kopffreiheit', ctx.actions.isAir(bot.blockAt(end.offset(0, 1, 0))) && ctx.actions.isAir(bot.blockAt(end.offset(0, 2, 0))))
    check('stairs: keine Bewegungstaste während bot.dig()', jumpedWhileDigging === 0, `(${jumpedWhileDigging} Ticks)`)
    const back = await ctx.mining.returnToSurface(token)
    check('stairs: Rückweg zur Oberfläche', back && ground() >= y0 - 1, `(y ${ground()})`)
  }

  if (only.includes('pillar')) {
    await goDry(8)
    const g = ground()
    const h = ctx.actions.feet().offset(5, 0, -5)
    await cmd(`setblock ${h.x} ${g - 1} ${h.z} air`, `setblock ${h.x} ${g - 2} ${h.z} air`, `setblock ${h.x} ${g - 3} ${h.z} air`, `teleport KI_Streamer ${h.x} ${g - 3} ${h.z}`)
    await sleep(1500)
    ctx.look.syncFromEntity()
    const depth = ctx.watchdog.holeDepth()
    check('pillar: Loch erkannt', depth >= 2, `(Tiefe ${depth})`)
    await ctx.watchdog.escape('test')
    await sleep(500)
    check('pillar: per Pillar-Jump zurück an der Oberfläche', ground() >= g, `(y ${ground()}, Boden ${g})`)
    check('pillar: Blick ging senkrecht nach unten', events.some(e => e.type === 'stuck'))
  }

  if (only.includes('house')) {
    home = await goDry(10)
    await cmd('give KI_Streamer cobblestone 64', 'give KI_Streamer cobblestone 64', 'give KI_Streamer oak_log 20', 'give KI_Streamer oak_planks 64', 'give KI_Streamer oak_planks 20', 'give KI_Streamer oak_slab 40', 'give KI_Streamer oak_door 1', 'give KI_Streamer oak_fence 8', 'give KI_Streamer chest 2', 'give KI_Streamer furnace 2', 'give KI_Streamer torch 8', 'give KI_Streamer red_bed 1', 'give KI_Streamer dirt 16')
    await sleep(1500)
    const t0 = Date.now()
    let done = false
    for (let i = 0; i < 3 && !done; i++) done = await ctx.building.build(token)
    const cells = ctx.building.blueprint()
    const built = cells.filter(c => ctx.building.cellDone(c)).length
    const byKind = {}
    for (const c of cells) { byKind[c.kind] = byKind[c.kind] || [0, 0]; byKind[c.kind][1]++; if (ctx.building.cellDone(c)) byKind[c.kind][0]++ }
    console.log('   · Bauzeit', Math.round((Date.now() - t0) / 1000), 's ·', JSON.stringify(byKind))
    check('house: Fundament, Wände, Ecken komplett', ['cobble', 'log', 'planks'].every(k => byKind[k][0] === byKind[k][1]))
    check('house: Fenster + Tür gesetzt', byKind.window[0] === byKind.window[1] && byKind.door[0] === 1)
    check('house: Dach geschlossen (inkl. Kappe)', byKind.slab[0] === byKind.slab[1], `(${byKind.slab[0]}/${byKind.slab[1]})`)
    check('house: Einrichtung (Werkbank, Öfen, Kiste, Bett)', byKind.crafting_table[0] === 1 && byKind.furnace[0] === 2 && byKind.chest[0] === 2 && byKind.bed[0] === 1, JSON.stringify([byKind.crafting_table, byKind.furnace, byKind.chest, byKind.bed, byKind.torch]))
    check('house: Bau als fertig gemeldet', done === true, `(${built}/${cells.length} Zellen)`)
  }

  const failed = results.filter(r => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} Checks bestanden`)
  ai.stop()
  setTimeout(() => process.exit(failed ? 1 : 0), 400)
}

ai.start()
run().catch(e => { console.error('ABBRUCH', e); process.exit(2) })
setTimeout(() => { console.error('TIMEOUT'); process.exit(3) }, 15 * 60000)
