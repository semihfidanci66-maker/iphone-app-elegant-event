'use strict'
/**
 * mc-server.js – startet und stoppt den lokalen Minecraft-Server direkt aus dem Dashboard / vom Handy.
 *
 * Zwei Fälle:
 *  - 'own':      das Programm hat den Server selbst gestartet. Befehle gehen über die Konsole (kein OP nötig),
 *                Stoppen ist ein sauberes "stop" mit Welt-Speicherung.
 *  - 'external': der Server läuft in einem eigenen Fenster (MC-SERVER-STARTEN.bat). Er wird über den Port
 *                erkannt; Befehle und Stop laufen dann über den Bot.
 */
const fs = require('fs')
const net = require('net')
const path = require('path')
const { spawn } = require('child_process')
const EventEmitter = require('events')

class McServer extends EventEmitter {
  /**
   * @param {{dir: string, port?: number, ramGb?: number, java?: string}} o
   */
  constructor (o) {
    super()
    this.dir = o.dir
    this.port = o.port || 25565
    this.ramGb = Math.max(1, Math.min(32, Number(o.ramGb) || 4))
    this.java = o.java || 'java'
    this.proc = null
    this.console = [] // letzte Konsolenzeilen
    this.state = { installed: this.installed(), phase: 'stopped', own: false, error: null, startedAt: 0 }
    this.probeTimer = setInterval(() => this.probe(), 5000)
    this.probeTimer.unref()
    this.probe()
  }

  installed () { return fs.existsSync(path.join(this.dir, 'server.jar')) }

  _set (p) {
    const before = JSON.stringify(this.state)
    Object.assign(this.state, p, { installed: this.installed() })
    if (JSON.stringify(this.state) !== before) this.emit('state', { ...this.state })
  }

  /** Lauscht schon jemand auf dem Server-Port? */
  portOpen () {
    return new Promise(resolve => {
      const s = net.connect({ host: '127.0.0.1', port: this.port })
      const done = v => { s.destroy(); resolve(v) }
      s.setTimeout(1200, () => done(false))
      s.once('connect', () => done(true))
      s.once('error', () => done(false))
    })
  }

  /** Erkennt einen Server, der in einem eigenen Fenster läuft (oder dort beendet wurde). */
  async probe () {
    if (this.proc) return
    const open = await this.portOpen()
    if (this.proc) return
    if (open && this.state.phase !== 'stopping') this._set({ phase: 'running', own: false, error: null })
    else if (!open && this.state.phase !== 'starting') this._set({ phase: 'stopped', own: false })
  }

  async start () {
    if (this.proc || this.state.phase === 'starting') return { ok: false, reason: 'läuft bereits' }
    if (!this.installed()) { this._set({ error: 'Kein Server eingerichtet – erst MC-SERVER-EINRICHTEN.bat ausführen.' }); return { ok: false, reason: 'nicht eingerichtet' } }
    if (await this.portOpen()) { this._set({ phase: 'running', own: false }); return { ok: false, reason: 'läuft schon in einem eigenen Fenster' } }
    this._set({ phase: 'starting', own: true, error: null, startedAt: Date.now() })
    let p
    try {
      p = spawn(this.java, [`-Xms${Math.min(2, this.ramGb)}G`, `-Xmx${this.ramGb}G`, '-jar', 'server.jar', 'nogui'], { cwd: this.dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) { this._set({ phase: 'stopped', own: false, error: 'Java konnte nicht gestartet werden: ' + e.message }); return { ok: false, reason: e.message } }
    this.proc = p
    let buf = ''
    const onData = d => {
      buf += d.toString()
      const lines = buf.split(/\r?\n/)
      buf = lines.pop()
      for (const line of lines) if (line.trim()) this._line(line)
    }
    p.stdout.on('data', onData)
    p.stderr.on('data', onData)
    p.stdin.on('error', () => {})
    p.on('error', e => { if (this.proc === p) { this.proc = null; this._set({ phase: 'stopped', own: false, error: e.code === 'ENOENT' ? 'Java wurde nicht gefunden (Java 21 installieren).' : e.message }) } })
    p.on('exit', code => {
      if (this.proc !== p) return
      this.proc = null
      clearTimeout(this.killTimer)
      const crashed = this.state.phase !== 'stopping' && code !== 0
      this._set({ phase: 'stopped', own: false, error: crashed ? `Server unerwartet beendet (Code ${code}). Details im Protokoll.` : null })
    })
    return { ok: true }
  }

  _line (line) {
    const text = line.replace(/^\[\d\d:\d\d:\d\d\] /, '').slice(0, 300)
    this.console.push(text)
    if (this.console.length > 200) this.console.shift()
    if (this.state.phase === 'starting' && /Done \(/.test(text)) this._set({ phase: 'running' })
    // Nur das Wichtige ins Protokoll: Warnungen, Fehler, Beitritte, Start/Stop
    const important = /\/(WARN|ERROR)\]|Done \(|joined the game|left the game|Stopping server|FAILED TO BIND|EULA/.test(text)
    this.emit('line', { text, important })
  }

  /** Befehl über die Konsole (nur wenn der Server vom Programm gestartet wurde). */
  command (cmd) {
    if (!this.proc || !this.proc.stdin.writable) return false
    try { this.proc.stdin.write(String(cmd).replace(/[\r\n]+/g, ' ').replace(/^\//, '') + '\n'); return true } catch (_) { return false }
  }

  get own () { return !!this.proc }

  /**
   * Sauber stoppen (Welt wird gespeichert). Löst auf, sobald der Prozess beendet ist.
   * Für einen externen Server liefert die Methode false – dann schickt der Aufrufer "/stop" über den Bot.
   */
  stop () {
    const p = this.proc
    if (!p) return Promise.resolve(false)
    this._set({ phase: 'stopping' })
    this.command('stop')
    return new Promise(resolve => {
      this.killTimer = setTimeout(() => { try { p.kill() } catch (_) {} }, 30000)
      p.once('exit', () => resolve(true))
    })
  }

  /** Externer Server wurde per Bot-Befehl gestoppt: Phase merken, der Port-Check räumt auf. */
  markStopping () { if (!this.proc) { this._set({ phase: 'stopping' }); setTimeout(() => { if (!this.proc && this.state.phase === 'stopping') this._set({ phase: 'stopped' }); this.probe() }, 12000) } }

  dispose () { clearInterval(this.probeTimer) }
}

module.exports = { McServer }
