'use strict'
/**
 * tiktok-browser-grabber.js – eingebauter Hintergrund-Browser als zweiter Weg zu TikTok Live.
 *
 * Öffnet unsichtbar https://www.tiktok.com/@name/live im ohnehin installierten Edge/Chrome
 * (puppeteer-core lädt KEINEN eigenen Browser herunter) und liest mit:
 *   1. die Webcast-WebSocket-Frames der Seite (CDP Network.webSocketFrameReceived), dekodiert mit
 *      den Protobuf-Schemata von tiktok-live-connector  -> Chat, Gifts, Likes, Follows, Zuschauerzahl
 *   2. als Reserve einen MutationObserver auf die Chat-Liste der Seite (nur Chat)
 *
 * Bilder, Videos und Schriften werden blockiert, damit der Hintergrund-Browser wenig RAM/CPU braucht.
 */
const EventEmitter = require('events')
const fs = require('fs')
const path = require('path')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function findBrowser () {
  const env = process.env.TIKTOK_BROWSER_PATH
  if (env && fs.existsSync(env)) return env
  const c = []
  if (process.platform === 'win32') {
    for (const base of [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean)) {
      c.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(base, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'))
    }
  } else if (process.platform === 'darwin') {
    c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
  } else {
    c.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge')
    try { for (const d of fs.readdirSync('/opt/pw-browsers')) c.push(path.join('/opt/pw-browsers', d, 'chrome-linux', 'chrome'), path.join('/opt/pw-browsers', d, 'chrome-linux64', 'chrome')) } catch (_) {}
    c.push('/opt/pw-browsers/chromium')
  }
  return c.find(p => { try { return fs.statSync(p).isFile() } catch (_) { return false } }) || null
}

class BrowserGrabber extends EventEmitter {
  constructor () {
    super()
    this.browser = null
    this.page = null
    this.framesSeen = 0
    this.domSeen = 0
    this.closedByUs = false
  }

  /**
   * @param {string} username
   * @param {{url?: string, wsPattern?: RegExp}} o  (url/wsPattern nur für Tests)
   */
  async start (username, o = {}) {
    const exe = findBrowser()
    if (!exe) throw new Error('Kein Edge/Chrome gefunden (Pfad per TIKTOK_BROWSER_PATH setzbar)')
    const puppeteer = require('puppeteer-core')
    const lib = require('tiktok-live-connector')
    const wsPattern = o.wsPattern || /webcast/i
    this.closedByUs = false
    this.browser = await puppeteer.launch({
      executablePath: exe,
      headless: true,
      args: ['--mute-audio', '--disable-gpu', '--no-first-run', '--disable-extensions', '--disable-background-networking', '--window-size=900,700', '--lang=de-DE', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])]
    })
    this.browser.on('disconnected', () => { this.browser = null; this.page = null; if (!this.closedByUs) this.emit('closed', 'Hintergrund-Browser wurde beendet') })
    const page = this.page = await this.browser.newPage()
    await page.setUserAgent(UA)
    await page.setViewport({ width: 900, height: 700 })
    await page.setRequestInterception(true)
    page.on('request', r => { const t = r.resourceType(); if (t === 'image' || t === 'media' || t === 'font') r.abort().catch(() => {}); else r.continue().catch(() => {}) })

    // --- 1) Webcast-WebSocket mitlesen ---
    const cdp = await page.createCDPSession()
    await cdp.send('Network.enable')
    const sockets = new Set()
    cdp.on('Network.webSocketCreated', e => { if (wsPattern.test(e.url)) sockets.add(e.requestId) })
    cdp.on('Network.webSocketClosed', e => { if (sockets.delete(e.requestId) && sockets.size === 0 && this.framesSeen > 0) this.emit('socket_closed') })
    cdp.on('Network.webSocketFrameReceived', async e => {
      if (!sockets.has(e.requestId) || e.response.opcode !== 2) return
      try {
        const frame = await lib.deserializeWebSocketMessage(Buffer.from(e.response.payloadData, 'base64'))
        const res = frame.protoMessageFetchResult
        if (!res) return
        if (++this.framesSeen === 1) this.emit('first_signal', 'websocket')
        for (const m of res.messages || []) {
          const method = m.method || m.type
          let data = m.decodedData && (m.decodedData.data || m.decodedData)
          if (!data && m.payload && lib[method] && lib[method].decode) { try { data = lib[method].decode(m.payload) } catch (_) {} }
          if (data) this.emit('message', method, data)
        }
      } catch (_) { /* unbekannter Frame – ignorieren */ }
    })

    // --- 2) Reserve: Chat direkt aus dem DOM ---
    await page.exposeFunction('__kiDomChat', (name, text, avatar) => {
      if (!name || !text) return
      if (++this.domSeen === 1 && this.framesSeen === 0) this.emit('first_signal', 'dom')
      if (this.framesSeen === 0) this.emit('dom_chat', { uniqueId: String(name).slice(0, 40), nickname: String(name).slice(0, 40), profilePictureUrl: avatar || null, comment: String(text).slice(0, 300) })
    })
    await page.evaluateOnNewDocument(() => {
      const seen = new WeakSet()
      const scan = root => {
        if (!root.querySelectorAll) return
        const nodes = root.matches && root.matches('[data-e2e="chat-message"]') ? [root] : root.querySelectorAll('[data-e2e="chat-message"]')
        for (const n of nodes) {
          if (seen.has(n)) continue
          seen.add(n)
          const nameEl = n.querySelector('[data-e2e="message-owner-name"]')
          const img = n.querySelector('img')
          const spans = n.querySelectorAll('span, div')
          let text = ''
          for (let i = spans.length - 1; i >= 0 && !text; i--) { const t = (spans[i].childElementCount === 0 ? spans[i].textContent : '').trim(); if (t && (!nameEl || t !== nameEl.textContent.trim())) text = t }
          if (nameEl && text) window.__kiDomChat(nameEl.textContent.trim(), text, img ? img.src : null)
        }
      }
      const boot = () => { new MutationObserver(list => { for (const m of list) for (const n of m.addedNodes) scan(n) }).observe(document.documentElement, { childList: true, subtree: true }); scan(document) }
      if (document.documentElement) boot(); else document.addEventListener('DOMContentLoaded', boot)
    })

    const url = o.url || `https://www.tiktok.com/@${encodeURIComponent(username)}/live`
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    return true
  }

  /** Wartet auf das erste Live-Signal (WebSocket-Frame oder Chat im DOM). */
  waitForSignal (ms) {
    if (this.framesSeen || this.domSeen) return Promise.resolve(this.framesSeen ? 'websocket' : 'dom')
    return new Promise(resolve => {
      const t = setTimeout(() => { this.removeListener('first_signal', done); resolve(null) }, ms)
      const done = kind => { clearTimeout(t); resolve(kind) }
      this.once('first_signal', done)
    })
  }

  async stop () {
    this.closedByUs = true
    const b = this.browser
    this.browser = null; this.page = null
    this.removeAllListeners()
    if (b) { try { await b.close() } catch (_) { try { b.process() && b.process().kill() } catch (_) {} } }
  }
}

module.exports = { BrowserGrabber, findBrowser }
