'use strict'
// Live-Test: Gift-Mobs spawnen direkt neben dem Bot und nur dort, wo er hinsieht: node test/live-spawn.js [port]
const { Vec3 } = require('vec3')
const { MinecraftAIBot } = require('../modules/mc-ai-bot')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const ai = new MinecraftAIBot({ host: '127.0.0.1', port: Number(process.argv[2] || 25599), username: 'KI_Streamer', version: '1.21.1' })
const results = []
const check = (n, ok, info = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${info}`) }
;(async () => {
  ai.paused = true
  ai.start()
  await new Promise(resolve => ai.on('event', e => e.type === 'bot_spawned' && resolve()))
  await sleep(2500)
  const { ctx, bot } = ai
  const f = ctx.actions.feet()
  const X = f.x - 30; const Z = f.z - 30; const Y = f.y
  ai.runCommands([`tp KI_Streamer ${X}.5 ${Y} ${Z}.5`])
  await sleep(1500)
  ctx.look.syncFromEntity()
  // Freie Fläche: Spawnpunkt muss 2,5–4,5 Blöcke entfernt, auf gleicher Höhe und sichtbar sein
  for (let i = 0; i < 20; i++) {
    const p = ai.spawnPoint()
    const d = Math.hypot(p.x - bot.entity.position.x, p.z - bot.entity.position.z)
    if (d < 2 || d > 4.6 || Math.abs(p.y - Y) > 1 || !ai._canSee(new Vec3(p.x, p.y + 1.2, p.z))) { check('frei: Spawnpunkt nah und sichtbar', false, JSON.stringify(p) + ' d=' + d.toFixed(1)); break }
    if (i === 19) check('frei: 20 Spawnpunkte alle 2–4,5 Blöcke entfernt, gleiche Höhe, sichtbar', true)
  }
  // Wand-Ring im Abstand 3 mit einer Lücke: Mobs dürfen nur INNERHALB des Rings landen, nie dahinter
  const cmds = []
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== 3) continue
    for (const dy of [0, 1, 2]) cmds.push(`setblock ${X + dx} ${Y + dy} ${Z + dz} stone`)
  }
  ai.runCommands(cmds)
  await sleep(cmds.length * 75 + 1500)
  let inside = 0
  for (let i = 0; i < 20; i++) {
    const p = ai.spawnPoint()
    const cx = Math.floor(p.x) - X; const cz = Math.floor(p.z) - Z
    if (Math.max(Math.abs(cx), Math.abs(cz)) < 3) inside++
  }
  check('Wand-Ring: kein Mob hinter der Wand', inside === 20, `(${inside}/20 innerhalb)`)
  console.log(`\n${results.filter(Boolean).length}/${results.length} Checks bestanden`)
  ai.dispose(); setTimeout(() => process.exit(results.every(Boolean) ? 0 : 1), 400)
})().catch(e => { console.error('ABBRUCH', e); process.exit(2) })
setTimeout(() => { console.error('TIMEOUT'); process.exit(3) }, 90000)
