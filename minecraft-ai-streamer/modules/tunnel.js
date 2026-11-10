'use strict'
/**
 * tunnel.js – öffentliche Cloud-Tunnel-URL für die Handy-Fernbedienung (5G, ohne Heim-WLAN).
 * Bevorzugt cloudflared (falls installiert), sonst localtunnel. Liefert URL + QR-Code.
 */
const { spawn } = require('child_process')
const QRCode = require('qrcode')

class Tunnel {
  constructor (port, onChange = () => {}) {
    this.port = port
    this.onChange = onChange
    this.state = { active: false, starting: false, provider: null, url: null, qr: null, error: null }
    this.proc = null
    this.lt = null
  }

  _set (p) { Object.assign(this.state, p); this.onChange({ ...this.state }) }

  async start (key) {
    if (this.state.active || this.state.starting) return this.state
    this._set({ starting: true, error: null })
    let url = null
    let provider = null
    try { url = await this._cloudflared(); provider = 'cloudflared' } catch (e1) {
      try { url = await this._localtunnel(); provider = 'localtunnel' } catch (e2) {
        this._set({ starting: false, error: `Kein Tunnel möglich (cloudflared: ${e1.message}; localtunnel: ${e2.message})` })
        return this.state
      }
    }
    const full = `${url}/mobile.html?k=${encodeURIComponent(key)}`
    const qr = await QRCode.toDataURL(full, { margin: 1, width: 360, color: { dark: '#0b0f14', light: '#ffffff' } })
    this._set({ active: true, starting: false, provider, url: full, qr })
    return this.state
  }

  _cloudflared () {
    return new Promise((resolve, reject) => {
      let done = false
      let p
      try { p = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${this.port}`], { stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { return reject(e) }
      const timer = setTimeout(() => { if (!done) { done = true; try { p.kill() } catch (_) {} reject(new Error('Timeout')) } }, 25000)
      const scan = buf => {
        const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf.toString())
        if (m && !done) { done = true; clearTimeout(timer); this.proc = p; resolve(m[0]) }
      }
      p.stdout.on('data', scan)
      p.stderr.on('data', scan)
      p.on('error', e => { if (!done) { done = true; clearTimeout(timer); reject(new Error('nicht installiert')) } })
      p.on('exit', () => { if (!done) { done = true; clearTimeout(timer); reject(new Error('beendet')) } else if (this.proc === p) { this.proc = null; this._set({ active: false, url: null, qr: null, error: 'Tunnel wurde beendet' }) } })
    })
  }

  async _localtunnel () {
    const localtunnel = require('localtunnel')
    const t = await Promise.race([localtunnel({ port: this.port }), new Promise((resolve, reject) => setTimeout(() => reject(new Error('Timeout')), 20000))])
    this.lt = t
    t.on('close', () => { if (this.lt === t) { this.lt = null; this._set({ active: false, url: null, qr: null }) } })
    t.on('error', () => {})
    return t.url
  }

  stop () {
    if (this.proc) { try { this.proc.kill() } catch (_) {} this.proc = null }
    if (this.lt) { try { this.lt.close() } catch (_) {} this.lt = null }
    this._set({ active: false, starting: false, url: null, qr: null, provider: null })
  }
}

module.exports = { Tunnel }
