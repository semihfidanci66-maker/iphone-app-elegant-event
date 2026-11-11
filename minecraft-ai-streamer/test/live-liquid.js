'use strict'
// Live-Test der Wasser-Rettung und des zentralen Game-Loops: node test/live-liquid.js [port]
const { MinecraftAIBot } = require('../modules/mc-ai-bot')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const ai = new MinecraftAIBot({ host: '127.0.0.1', port: Number(process.argv[2] || 25599), username: 'KI_Streamer', version: '1.21.1' })
const ev = []
ai.on('event', e => { ev.push(e.type); if (['liquid_escape', 'liquid_rescue', 'plan', 'action_start', 'log', 'bot_error', 'mode', 'cave_aborted', 'cave_locked'].includes(e.type)) console.log('   ·', e.type, JSON.stringify(e.data).slice(0, 150)) })
const results = []
const check = (n, ok, info = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${info}`) }
;(async () => {
  ai.paused = true
  ai.start()
  await new Promise(resolve => ai.on('event', e => e.type === 'bot_spawned' && resolve()))
  await sleep(2500)
  const { ctx, bot } = ai
  const f = ctx.actions.feet()
  const X = f.x + 20; const Z = f.z + 20; const G = f.y - 1 // G = Grasebene
  // 3x3-Becken, 3 tief, steile Wände
  const cmds = []
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = 0; dy >= -2; dy--) cmds.push(`setblock ${X + dx} ${G + dy} ${Z + dz} water`)
  ai.runCommands([...cmds, 'give KI_Streamer cobblestone 32', `tp KI_Streamer ${X} ${G - 1} ${Z}`])
  await sleep(cmds.length * 75 + 1500)
  ctx.look.syncFromEntity()
  check('wasser: Bot ist im Becken', ctx.liquid.inLiquid(), `(y ${bot.entity.position.y.toFixed(1)})`)
  const t0 = Date.now()
  ai.paused = false // Hauptschleife übernimmt: Reflex 0
  let outAt = 0
  for (let i = 0; i < 80; i++) { await sleep(100); if (!ctx.liquid.inLiquid() && bot.entity.onGround) { outAt = Date.now(); break } }
  ai.paused = true; ai.interrupt('test')
  const secs = outAt ? (outAt - t0) / 1000 : 99
  check('wasser: nach spätestens ~5 s auf trockenem Boden', !!outAt && secs <= 5.5, `(${secs.toFixed(1)} s, y ${bot.entity.position.y.toFixed(1)}, Rettung per ${ev.includes('liquid_rescue') ? 'Stufe 3' : 'Stufe 2 (geschwommen/geklettert)'})`)
  check('wasser: Rettung wurde gemeldet', ev.includes('liquid_escape'))
  check('modus: Standard ist Oberfläche, Höhle gesperrt', ai.mode === 'surface' && ctx.caveAllowed() === false && ai.pushGoal('mine').reason === 'cave_locked')
  const mined = await ctx.mining.mineFor('iron', () => false, { check () {}, cancelled: false, onCancel: () => () => {} })
  check('modus: mineFor(Eisen) wird an der Oberfläche abgelehnt', mined === false && ev.includes('cave_locked'))
  ai.setMode('cave')
  check('modus: Höhlen-Button gibt genau einen Trip frei', ai.mode === 'cave' && ctx.caveAllowed() === true && ctx.planner.goalStack[0].id === 'cave')
  ai.abortCave()
  check('modus: Abbruch sperrt wieder und plant den Ausstieg', ai.mode === 'surface' && ctx.caveAllowed() === false && ai.exitCaveRequested === true && !ctx.planner.goalStack.some(g => g.id === 'cave'))
  // Game-Loop 12 s frei laufen lassen: darf nicht abstürzen und muss an der Oberfläche bleiben
  const y0 = ctx.actions.feet().y
  ai.paused = false
  await sleep(12000)
  ai.paused = true
  check('loop: Höhlen-Abbruch wurde angesagt', ev.includes('cave_aborted'))
  check('loop: läuft ohne Fehler und bleibt an der Oberfläche', !ev.includes('bot_error') && ctx.actions.feet().y >= Math.min(58, y0 - 4), `(y ${ctx.actions.feet().y}, Aktivität ${ai.status().activity})`)
  console.log(`\n${results.filter(Boolean).length}/${results.length} Checks bestanden`)
  ai.dispose(); setTimeout(() => process.exit(results.every(Boolean) ? 0 : 1), 400)
})().catch(e => { console.error('ABBRUCH', e); process.exit(2) })
setTimeout(() => { console.error('TIMEOUT'); process.exit(3) }, 90000)
