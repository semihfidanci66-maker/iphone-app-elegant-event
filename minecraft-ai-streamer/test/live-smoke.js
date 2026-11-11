// Live-Rauchtest gegen einen laufenden Server: node test/live-smoke.js [port] [sekunden]
const { MinecraftAIBot } = require('../modules/mc-ai-bot')
const port = Number(process.argv[2] || 25599)
const secs = Number(process.argv[3] || 40)
const bot = new MinecraftAIBot({ host: '127.0.0.1', port, username: 'KI_Streamer', version: '1.21.1' })
const t0 = Date.now()
const quiet = new Set(['swing', 'hotbar'])
let swings = 0
bot.on('event', e => {
  if (e.type === 'swing') { swings++; return }
  if (quiet.has(e.type)) return
  console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6), e.type, JSON.stringify(e.data).slice(0, 230))
})
bot.start()
setInterval(() => {
  const s = bot.status()
  if (s.connected) console.log('  [status]', s.activity, s.goal, JSON.stringify(s.pos), 'hp', s.health, 'inv', JSON.stringify(s.inv), 'swings', swings)
}, 10000)
setTimeout(() => { bot.stop(); setTimeout(() => process.exit(0), 500) }, secs * 1000)
