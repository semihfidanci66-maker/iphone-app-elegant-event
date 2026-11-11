'use strict'
// Test des eingebauten Hintergrund-Browsers gegen eine lokale Nachbau-Seite: node test/browser-grabber.js
// Die Seite öffnet einen "webcast"-WebSocket; der Testserver sendet echte Protobuf-Frames (Chat, Gift, Like).
const http = require('http')
const assert = require('assert')
const zlib = require('zlib')
const { WebSocketServer } = require('ws')
const lib = require('tiktok-live-connector')
const { TikTokBridge } = require('../modules/tiktok-bridge')

const EMPTY = new Uint8Array()
const ENTRY = Object.keys(lib).find(k => { try { const o = lib[k].decode(EMPTY); return 'method' in o && 'payload' in o && 'msgId' in o } catch (_) { return false } })
const make = (type, data) => Object.assign(lib[type].decode(EMPTY), data)
const user = (id, nick) => make('User', { displayId: id, nickname: nick, avatarThumb: make('ImageModel', { urlList: [`https://example.com/${id}.jpg`] }) })
function frame (messages) {
  const res = lib.ProtoMessageFetchResult.encode(make('ProtoMessageFetchResult', { messages: messages.map(([method, data]) => make(ENTRY, { method, type: method, payload: lib[method].encode(make(method, data)).finish() })) })).finish()
  return lib.WebcastPushFrame.encode(Object.assign(lib.WebcastPushFrame.decode(EMPTY), { payloadEncoding: 'pb', payloadType: 'msg', payload: zlib.gzipSync(Buffer.from(res)) })).finish()
}
const PAGE = `<!doctype html><meta charset="utf-8"><body><div id="chat"></div><script>
  const ws = new WebSocket('ws://' + location.host + '/webcast/im/push/v2/'); ws.binaryType = 'arraybuffer'
  setTimeout(() => { const d = document.createElement('div'); d.setAttribute('data-e2e', 'chat-message'); d.innerHTML = '<img src="https://example.com/a.jpg"><span data-e2e="message-owner-name">DomUser</span><span>Hallo aus dem DOM</span>'; document.getElementById('chat').appendChild(d) }, 300)
</script>`

;(async () => {
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE) })
  const wss = new WebSocketServer({ server })
  wss.on('connection', ws => {
    setTimeout(() => ws.send(frame([
      ['WebcastChatMessage', { user: user('mia_01', 'Mia'), content: 'Bau ein Haus' }],
      ['WebcastGiftMessage', { user: user('lukas', 'Lukas'), giftId: 5655, repeatCount: 3, repeatEnd: 1, gift: make('Gift', { name: 'Rose', diamondCount: 1, type: 1, image: make('ImageModel', { urlList: ['https://example.com/rose.png'] }) }) }],
      ['WebcastLikeMessage', { user: user('tom', 'Tom'), count: 15, total: 400 }]
    ])), 700)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const b = new TikTokBridge()
  const got = []
  b.on('chat', e => got.push(['chat', e.viewer.uniqueId, e.text, !!e.viewer.avatar]))
  b.on('gift', e => got.push(['gift', e.viewer.uniqueId, e.gift.name, e.gift.coins, e.count, e.delta, e.streakEnd]))
  b.on('like', e => got.push(['like', e.viewer.uniqueId, e.count]))
  let live = 0
  b.on('live', e => { live++; assert.strictEqual(e.engine, 'B') })
  b.wanted = true; b.state.username = 'testuser'
  const how = await b._engineB('testuser', { url: `http://127.0.0.1:${port}/@testuser/live`, signalMs: 8000 })
  await new Promise(resolve => setTimeout(resolve, 1500))
  console.log('Signal:', how, '| Phase:', b.state.phase, '| Badge:', b.state.badge)
  for (const g of got) console.log('  ', JSON.stringify(g))
  assert.strictEqual(live, 1)
  assert.strictEqual(b.state.phase, 'live')
  assert(got.some(g => g[0] === 'chat' && g[2] === 'Bau ein Haus' && g[1] === 'mia_01'), 'Chat aus WebSocket-Frame')
  assert(got.some(g => g[0] === 'gift' && g[2] === 'Rose' && g[3] === 1 && g[4] === 3), 'Gift mit Coins und Combo')
  assert(got.some(g => g[0] === 'like' && g[2] === 15), 'Like')
  await b.stop()
  assert.strictEqual(b.grabber, null)
  server.close(); wss.close()
  console.log('PASS  Hintergrund-Browser liest Chat, Gift und Like aus den Webcast-Frames')
  setTimeout(() => process.exit(0), 300)
})().catch(e => { console.error('FAIL', e); process.exit(1) })
