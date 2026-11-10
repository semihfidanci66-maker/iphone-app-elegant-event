'use strict'
/**
 * HumanLookController – menschliche Maus-Kinematik für mineflayer.
 *
 * Der Controller besitzt bot.entity.yaw/pitch exklusiv. Jede Blickanfrage (auch die des
 * Pathfinders und von bot.dig/placeBlock) läuft über bot.look -> request() und wird pro
 * Physik-Tick (50 ms) mit Beschleunigung, Abbremsen und – bei schnellen Kampfdrehungen –
 * leichtem Überschwingen samt Korrektur angefahren.
 *
 * Mineflayer-Konvention: yaw 0 = Norden (-Z), wächst gegen den Uhrzeigersinn; pitch > 0 = oben.
 */
const DEG = Math.PI / 180
const TAU = Math.PI * 2

const PROFILES = {
  // maxSpeed: Grad/Tick, accel: Grad/Tick², gain: Anteil des Restfehlers pro Tick (Ease-Out)
  idle: { maxSpeed: 9, accel: 2.2, gain: 0.22 },
  walk: { maxSpeed: 14, accel: 4.5, gain: 0.42 },
  work: { maxSpeed: 12, accel: 3.5, gain: 0.34 },
  combat: { maxSpeed: 22, accel: 8, gain: 0.5 },
  panic: { maxSpeed: 25, accel: 11, gain: 0.58 }
}

function wrap (a) {
  a = (a + Math.PI) % TAU
  if (a < 0) a += TAU
  return a - Math.PI
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const rand = (lo, hi) => lo + Math.random() * (hi - lo)

class HumanLookController {
  constructor (bot, opts = {}) {
    this.bot = bot
    this.opts = opts
    this.yaw = bot.entity.yaw
    this.pitch = bot.entity.pitch
    this.targetYaw = this.yaw
    this.targetPitch = this.pitch
    this.velYaw = 0
    this.velPitch = 0
    this.profile = 'walk'
    this.profileUntil = 0
    this.overshoot = null // { yaw, pitch } zusätzlicher Winkel, der erst angefahren und dann korrigiert wird
    this.waiters = []
    this.glance = null // { yaw, pitch, phase: 'out'|'hold'|'back', holdUntil }
    this.nextGlanceAt = Date.now() + rand(4000, 7000)
    this.attentive = false // true in Tunneln/Minen: Glances auch im Stand
    this.glanceBlockers = new Set()
    this.headYawOffset = 0
    this.headPitchOffset = 0
    this.lastExternalRequest = 0
    this._tick = this._tick.bind(this)

    // Der Server soll exakt unsere geglättete Kurve sehen, nicht mineflayers lineare Nachführung.
    if (bot.physics) { bot.physics.yawSpeed = 1000; bot.physics.pitchSpeed = 1000 }

    this._origLook = bot.look
    bot.look = (yaw, pitch, force) => this.request(yaw, pitch, { external: true, force })
    bot.lookAt = (point, force) => {
      const a = this.anglesTo(point)
      return this.request(a.yaw, a.pitch, { external: true, force })
    }
    bot.on('physicsTick', this._tick)
    bot.on('forcedMove', () => this.syncFromEntity())
    bot._client.on('player_rotation', () => this.syncFromEntity())
  }

  dispose () {
    this.bot.removeListener('physicsTick', this._tick)
    this._resolveAll(false)
  }

  syncFromEntity () {
    this.yaw = this.bot.entity.yaw
    this.pitch = this.bot.entity.pitch
    this.targetYaw = this.yaw
    this.targetPitch = this.pitch
    this.velYaw = this.velPitch = 0
    this.overshoot = null
    this.glance = null
  }

  anglesTo (point) {
    const e = this.bot.entity
    const dx = point.x - e.position.x
    const dy = point.y - (e.position.y + (e.eyeHeight ?? 1.62))
    const dz = point.z - e.position.z
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)) }
  }

  /** Winkelabstand (rad) zwischen aktueller Blickrichtung und einem Punkt. */
  errorTo (point) {
    const a = this.anglesTo(point)
    return Math.hypot(wrap(a.yaw - this.yaw), a.pitch - this.pitch)
  }

  setProfile (name, holdMs = 0) {
    if (!PROFILES[name]) return
    this.profile = name
    this.profileUntil = holdMs ? Date.now() + holdMs : 0
  }

  /** Blockiert Umschau-Blicke, solange mindestens ein Grund aktiv ist (Abbauen, Kampf, Platzieren). */
  blockGlance (reason, on) {
    if (on) { this.glanceBlockers.add(reason); this._cancelGlance() } else this.glanceBlockers.delete(reason)
  }

  /**
   * Präzises Anvisieren eines Punktes. Löst erst auf, wenn das Fadenkreuz wirklich steht.
   * @param {Vec3} point
   * @param {{profile?: string, tolerance?: number, timeout?: number}} o
   */
  aim (point, o = {}) {
    const a = this.anglesTo(point)
    return this.request(a.yaw, a.pitch, { profile: o.profile || 'work', tolerance: o.tolerance, timeout: o.timeout, precise: true })
  }

  aimAngles (yaw, pitch, o = {}) {
    return this.request(yaw, pitch, { profile: o.profile || 'work', tolerance: o.tolerance, timeout: o.timeout, precise: true })
  }

  /** Nicht-blockierendes Nachführen (z. B. Kampf-Tracking pro Tick). */
  track (point, profile = 'combat') {
    const a = this.anglesTo(point)
    this._setTarget(a.yaw, a.pitch, profile, false)
  }

  request (yaw, pitch, o = {}) {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return Promise.resolve(false)
    if (o.external) this.lastExternalRequest = Date.now()
    if (o.precise) this._cancelGlance()
    const profile = o.profile || (o.external ? null : 'work')
    this._setTarget(yaw, pitch, profile, true)
    const tol = (o.tolerance ?? 1.6) * DEG
    if (this._aligned(tol) && !this.overshoot) return Promise.resolve(true)
    return new Promise(resolve => {
      const w = { resolve, tol, deadline: Date.now() + (o.timeout ?? 1600) }
      this.waiters.push(w)
    })
  }

  _setTarget (yaw, pitch, profile, supersede) {
    const prevYaw = this.targetYaw
    this.targetPitch = clamp(pitch, -Math.PI / 2, Math.PI / 2)
    // Fast senkrechter Blick: die Drehrichtung ist bedeutungslos (atan2 von ~0) – nicht wild um die Achse drehen
    this.targetYaw = Math.abs(this.targetPitch) > 1.4 ? this.yaw : wrap(yaw)
    if (profile) this.setProfile(profile, profile === 'walk' ? 0 : 600)
    if (supersede && this.waiters.length && Math.abs(wrap(this.targetYaw - prevYaw)) > 0.02) this._resolveAll(false)

    // Menschliches Überschwingen: nur bei großen, schnellen Drehungen (Kampf/Panik)
    const p = this._profile()
    const err = wrap(this.targetYaw - this.yaw)
    if (!this.overshoot && Math.abs(err) > 100 * DEG && p.maxSpeed >= 20 && Math.abs(wrap(this.targetYaw - prevYaw)) > 40 * DEG) {
      // Überschwingen liegt in Drehrichtung HINTER dem Ziel (bei ~180° ist die Richtung sonst mehrdeutig)
      let over = Math.sign(err) * rand(3, 8) * DEG
      if (Math.sign(wrap(this.targetYaw + over - this.yaw)) !== Math.sign(err)) over = -over
      this.overshoot = { yaw: over, pitch: rand(-2, 2) * DEG, dir: Math.sign(wrap(this.targetYaw + over - this.yaw)) }
    }
  }

  _profile () {
    if (this.profileUntil && Date.now() > this.profileUntil) { this.profile = 'walk'; this.profileUntil = 0 }
    return PROFILES[this.profile] || PROFILES.walk
  }

  _aligned (tol) {
    return Math.abs(wrap(this.targetYaw - this.yaw)) <= tol && Math.abs(this.targetPitch - this.pitch) <= tol
  }

  _resolveAll (value) {
    const ws = this.waiters
    this.waiters = []
    for (const w of ws) w.resolve(value)
  }

  _cancelGlance () {
    if (this.glance) this.glance.phase = 'back'
  }

  /** Startet sofort einen Umschau-Blick (z. B. wenn der Streamer einen Zuschauer anspricht). */
  expressiveGlance () {
    if (this.glanceBlockers.size || this.glance) return false
    this._startGlance(rand(25, 60) * (Math.random() < 0.5 ? -1 : 1), rand(-4, 12), 500)
    return true
  }

  _startGlance (yawDeg, pitchDeg, holdMs = 400) {
    this.glance = { yaw: yawDeg * DEG, pitch: pitchDeg * DEG, phase: 'out', holdMs, holdUntil: 0 }
  }

  _scheduleGlance (now) {
    if (now < this.nextGlanceAt) return
    this.nextGlanceAt = now + rand(4000, 7000)
    if (this.glanceBlockers.size || this.glance) return
    const pf = this.bot.pathfinder
    const moving = !!(pf && pf.isMoving && pf.isMoving())
    if (!moving && !this.attentive) return
    const r = Math.random()
    const side = Math.random() < 0.5 ? -1 : 1
    // 20 %: Schulterblick nach hinten, sonst links/rechts
    const yawDeg = r < 0.2 ? side * rand(140, 170) : side * rand(55, 105)
    this._startGlance(yawDeg, rand(-8, 6), 400)
  }

  _stepAxis (err, vel, p, speedScale) {
    const maxSpeed = p.maxSpeed * DEG * speedScale
    const accel = p.accel * DEG
    let desired = clamp(err * p.gain, -maxSpeed, maxSpeed)
    // Mindestgeschwindigkeit, damit das Ziel nicht asymptotisch "verhungert"
    const minStep = 0.35 * DEG
    if (Math.abs(desired) < minStep) desired = Math.sign(err) * Math.min(Math.abs(err), minStep)
    let v = vel + clamp(desired - vel, -accel, accel)
    // Bremsen ist beim Menschen schneller als Beschleunigen
    if (Math.abs(desired) < Math.abs(vel)) v = vel + clamp(desired - vel, -accel * 2.5, accel * 2.5)
    if (Math.abs(v) > Math.abs(err)) v = err
    return v
  }

  _tick () {
    const bot = this.bot
    if (!bot.entity) return
    const now = Date.now()
    const p = this._profile()
    this._scheduleGlance(now)

    // --- Hauptachsen (Bewegungsrichtung) ---
    let ty = this.targetYaw
    let tp = this.targetPitch
    if (this.overshoot) {
      ty = wrap(ty + this.overshoot.yaw)
      tp = clamp(tp + this.overshoot.pitch, -Math.PI / 2, Math.PI / 2)
    }
    const errYaw = wrap(ty - this.yaw)
    const errPitch = tp - this.pitch
    this.velYaw = this._stepAxis(errYaw, this.velYaw, p, 1)
    this.velPitch = this._stepAxis(errPitch, this.velPitch, p, 0.75)
    this.yaw = wrap(this.yaw + this.velYaw)
    this.pitch = clamp(this.pitch + this.velPitch, -Math.PI / 2, Math.PI / 2)
    if (this.overshoot && Math.abs(wrap(ty - this.yaw)) < 2 * DEG) {
      this.overshoot = null // Korrekturphase: zurück auf das echte Ziel, mit ruhigerem Profil
      this.velYaw *= 0.3
    }

    // --- Kopf-Offset (Umschau) – beeinflusst nur den gesendeten Blick, nicht die Laufrichtung ---
    const g = this.glance
    if (g) {
      const gp = PROFILES.walk
      const wantYaw = g.phase === 'back' ? 0 : g.yaw
      const wantPitch = g.phase === 'back' ? 0 : g.pitch
      const ey = wantYaw - this.headYawOffset
      const ep = wantPitch - this.headPitchOffset
      this.headYawOffset += clamp(ey * 0.38, -gp.maxSpeed * 1.3 * DEG, gp.maxSpeed * 1.3 * DEG)
      this.headPitchOffset += clamp(ep * 0.38, -6 * DEG, 6 * DEG)
      if (g.phase === 'out' && Math.abs(ey) < 3 * DEG) { g.phase = 'hold'; g.holdUntil = now + g.holdMs }
      if (g.phase === 'hold' && now >= g.holdUntil) g.phase = 'back'
      if (g.phase === 'back' && Math.abs(this.headYawOffset) < 1 * DEG && Math.abs(this.headPitchOffset) < 1 * DEG) {
        this.headYawOffset = 0; this.headPitchOffset = 0; this.glance = null
      }
    }

    // --- Schreiben: Physik rechnet mit der Laufrichtung, gesendet wird Laufrichtung + Kopf-Offset ---
    const moveYaw = this.yaw
    const movePitch = this.pitch
    if (this.headYawOffset !== 0 || this.headPitchOffset !== 0) {
      bot.entity.yaw = wrap(moveYaw + this.headYawOffset)
      bot.entity.pitch = clamp(movePitch + this.headPitchOffset, -Math.PI / 2, Math.PI / 2)
      // updatePosition() läuft synchron direkt nach diesem Listener; danach Laufrichtung wiederherstellen
      queueMicrotask(() => { if (bot.entity) { bot.entity.yaw = moveYaw; bot.entity.pitch = movePitch } })
    } else {
      bot.entity.yaw = moveYaw
      bot.entity.pitch = movePitch
    }

    // --- Dreh-Gate: Ein Mensch läuft nicht blind los, bevor er sich umgedreht hat ---
    const pf = bot.pathfinder
    if (pf && pf.isMoving && pf.isMoving() && now - this.lastExternalRequest < 150) {
      const turnErr = Math.abs(wrap(this.targetYaw - this.yaw))
      if (turnErr > 38 * DEG) {
        bot.setControlState('forward', false)
        bot.setControlState('sprint', false)
        if (bot.entity.onGround) bot.setControlState('jump', false)
      }
    }

    // --- Wartende auflösen ---
    if (this.waiters.length) {
      const still = []
      for (const w of this.waiters) {
        if (!this.overshoot && this._aligned(w.tol)) w.resolve(true)
        else if (now > w.deadline) w.resolve(false)
        else still.push(w)
      }
      this.waiters = still
    }
  }
}

module.exports = { HumanLookController, wrap, DEG, PROFILES }
