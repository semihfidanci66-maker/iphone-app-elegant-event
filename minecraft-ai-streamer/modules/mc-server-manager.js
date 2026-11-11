'use strict'
/**
 * mc-server-manager.js – startet, stoppt und steuert den lokalen Minecraft-Server aus dem Programm
 * heraus, damit er auch vom Handy aus bedienbar ist (Start/Stop/Neustart/Konsole).
 * Kein eigener Timer; die Konsole wird als Ringpuffer (120 Zeilen) gehalten.
 */
const EventEmitter = require('events')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

class McServerManager extends EventEmitter {
  /** @param {{dir: string, memoryMb?: number, command?: string[]}} o  (command nur für Tests) */
  constructor (o) {
    super()
    this.dir = o.dir
    this.memoryMb = Math.max(1024, Math.min(16384, o.memoryMb || 4096))
    this.command = o.command || null
    this.proc = null
    this.lines = []
    this.state = { installed: this.installed(), running: false, ready: false, stopping: false, startedAt: 0, players: [], error: null }
    this.restartWanted = false
  }

  installed () { return !!this.command || fs.existsSync(path.join(this.dir, 'server.jar')) }
  _set (p) { Object.assign(this.state, p, { installed: this.installed() }); this.emit('state', this.snapshot()) }
  snapshot () { return { ...this.state, players: [...this.state.players], lines: this.lines.slice(-60) } }

  _line (text) {
    const line = String(text).replace(/\x1b\[[0-9;]*m/g, '').trimEnd()
    if (!line) return
    this.lines.push(line)
    if (this.lines.length > 120) this.lines.shift()
    this.emit('line', line)
    if (!this.state.ready && /Done \([\d.,]+s\)!/.test(line)) this._set({ ready: true })
    let m = /: (\w{1,16}) joined the game/.exec(line)
    if (m && !this.state.players.includes(m[1])) { this.state.players.push(m[1]); this._set({}) }
    m = /: (\w{1,16}) left the game/.exec(line)
    if (m) { this.state.players = this.state.players.filter(p => p !== m[1]); this._set({}) }
    if (/FAILED TO BIND TO PORT/.test(line)) this._set({ error: 'Port 25565 ist belegt – läuft schon ein Minecraft-Server?' })
    if (/You need to agree to the EULA/.test(line)) this._set({ error: 'EULA nicht bestätigt (MC-SERVER-EINRICHTEN.bat ausführen)' })
  }

  start () {
    if (this.proc) return false
    if (!this.installed()) { this._set({ error: 'Kein Server gefunden. Erst MC-SERVER-EINRICHTEN.bat bzw. ALLES-STARTEN.bat ausführen.' }); return false }
    const cmd = this.command || ['java', `-Xms${Math.min(2048, this.memoryMb)}M`, `-Xmx${this.memoryMb}M`, '-jar', 'server.jar', 'nogui']
    let p
    try { p = spawn(cmd[0], cmd.slice(1), { cwd: this.command ? undefined : this.dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) } catch (e) { this._set({ error: 'Start fehlgeschlagen: ' + e.message }); return false }
    this.proc = p
    this.lines = []
    this._set({ running: true, ready: false, stopping: false, startedAt: Date.now(), players: [], error: null })
    let buf = ''
    const feed = d => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { this._line(buf.slice(0, i)); buf = buf.slice(i + 1) } }
    p.stdout.on('data', feed)
    p.stderr.on('data', feed)
    p.on('error', e => { this._line('[Manager] ' + e.message); this._set({ error: e.code === 'ENOENT' ? 'Java wurde nicht gefunden (Java 21 installieren)' : e.message }) })
    p.on('exit', code => {
      if (buf) this._line(buf)
      this.proc = null
      this._line(`[Manager] Server beendet (Code ${code})`)
      const again = this.restartWanted
      this.restartWanted = false
      this._set({ running: false, ready: false, stopping: false, players: [], error: code && !this.state.stopping && !this.state.error ? `Server abgestürzt (Code ${code})` : this.state.error })
      if (again) this.start()
    })
    return true
  }

  /** Konsolenbefehl ohne führenden Slash. */
  send (cmd) {
    if (!this.proc || !this.proc.stdin.writable) return false
    const line = String(cmd).replace(/^\//, '').replace(/[\r\n]+/g, ' ').slice(0, 300)
    if (!line) return false
    this._line('> ' + line)
    this.proc.stdin.write(line + '\n')
    return true
  }

  stop () {
    if (!this.proc) return false
    this._set({ stopping: true })
    this.send('stop')
    const p = this.proc
    const t = setTimeout(() => { try { p.kill() } catch (_) {} }, 25000)
    p.once('exit', () => clearTimeout(t))
    return true
  }

  restart () {
    if (!this.proc) return this.start()
    this.restartWanted = true
    return this.stop()
  }

  dispose () { this.restartWanted = false; if (this.proc) { try { this.proc.stdin.write('stop\n') } catch (_) {} } }
}

module.exports = { McServerManager }
