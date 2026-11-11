'use strict'
/**
 * Kamera-Regie für DEIN aufgenommenes Minecraft-Fenster (dein Account im Zuschauermodus).
 *
 *  ego    – /spectate <Bot>: echte Ego-Sicht mit Hand, Schwertschlägen, Abbauen, Schild
 *  third  – eine unsichtbare Kamera-Entity (item_display mit teleport_duration) folgt dem Bot weich
 *           über die Schulter; dein Client schaut durch sie -> Cinematic-Freecam mit sichtbarem Skin
 *  auto   – Regie: unter Tage/Craften = Ego, Bosskämpfe/Hausbau/Siege = 3rd-Person
 *
 * Läuft ohne eigenen Timer im zentralen 250-ms-Game-Loop.
 */
class CameraDirector {
  constructor (ai) {
    this.ai = ai
    this.mode = 'auto'
    this.player = ''
    this.applied = null
    this.dimension = null
    this.holdThirdUntil = 0
    this.ticks = 0
  }

  setMode (mode) { if (['ego', 'third', 'auto'].includes(mode)) { this.mode = mode; this.applied = null } return this.mode }
  setPlayer (name) { this.player = String(name || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16); this.applied = null; return this.player }
  /** Sieg/Highlight: ein paar Sekunden Action-Ansicht halten. */
  highlight (ms = 6000) { this.holdThirdUntil = Date.now() + ms }

  autoMode (s) {
    if (Date.now() < this.holdThirdUntil) return 'third'
    if (s.fighting && (s.threats >= 3 || (s.threatNames || []).some(n => /warden|ravager|wither|brute|vindicator/.test(n)))) return 'third'
    if (s.activity === 'build' || s.activity === 'portal' || s.activity === 'sleep') return 'third'
    return 'ego'
  }

  tick () {
    const ai = this.ai
    if (!this.player || !ai.ctx || !ai.bot || !ai.bot.entity) { this.applied = null; return }
    const s = ai.status()
    if (!s.connected) return
    this.ticks++
    const bot = ai.bot.username
    const want = this.mode === 'auto' ? this.autoMode(s) : this.mode
    const dimChanged = s.dimension !== this.dimension
    // alle 10 s erneut setzen: fängt Tod/Respawn, Reconnect und manuelles Verlassen der Ansicht ab
    if (want !== this.applied || dimChanged || this.ticks % 40 === 0) {
      this.dimension = s.dimension
      const cmds = [`gamemode spectator ${this.player}`]
      if (want === 'ego') {
        cmds.push('kill @e[tag=kicam]', `spectate ${bot} ${this.player}`)
      } else {
        if (this.applied !== 'third' || dimChanged) {
          cmds.push('kill @e[tag=kicam]')
          cmds.push(`execute at ${bot} run summon item_display ~ ~2.5 ~ {Tags:["kicam"],teleport_duration:6}`)
        }
        cmds.push(`spectate @e[tag=kicam,limit=1] ${this.player}`)
      }
      ai.runCommands(cmds)
      if (want !== this.applied) ai._emit('camera', { mode: want, auto: this.mode === 'auto' })
      this.applied = want
    }
    if (this.applied === 'third') {
      ai.runCommands([`execute at ${bot} rotated ~ 0 positioned ^-0.9 ^2.6 ^-4.6 run tp @e[tag=kicam,limit=1] ~ ~ ~ facing entity ${bot} eyes`])
    }
  }
}

module.exports = { CameraDirector }
