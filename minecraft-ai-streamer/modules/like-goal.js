'use strict'
/**
 * like-goal.js – Like-Ziel: alle N Likes passiert etwas im Spiel.
 *
 * Alle Zuschauer füllen gemeinsam den Balken. Wer das Ziel knackt (den letzten Like der Runde
 * schickt), bekommt die Aktion gutgeschrieben. Mit "steigern" wird jede Runde eins mehr gespawnt.
 * Reine Logik ohne Timer und ohne Netzwerk – testbar.
 */
const MAX_BONUS = 4 // höchstens +4 zusätzliche Mobs durch Steigerung
const MAX_PER_EVENT = 3 // ein einzelnes Like-Paket löst höchstens drei Ziele aus

function sanitizeLikes (c, actions = null, mobs = null) {
  const o = c && typeof c === 'object' ? c : {}
  const action = typeof o.action === 'string' && (!actions || actions[o.action]) && o.action !== 'none' ? o.action : 'zombie_fast'
  return {
    enabled: o.enabled !== false,
    every: Math.max(10, Math.min(100000, Math.round(Number(o.every) || 100))),
    action,
    mob: typeof o.mob === 'string' && (!mobs || mobs[o.mob]) ? o.mob : 'zombie',
    amount: Math.max(1, Math.min(10, Math.round(Number(o.amount) || 1))),
    escalate: o.escalate !== false
  }
}

class LikeGoal {
  constructor (config) {
    this.config = sanitizeLikes(config)
    this.reset()
  }

  reset () {
    this.total = 0 // Likes in dieser Sitzung
    this.progress = 0 // Likes in der laufenden Runde
    this.level = 0 // geknackte Ziele
    this.last = null // wer zuletzt geliked hat
    this.round = new Map() // uniqueId -> { name, count } in der laufenden Runde
  }

  setConfig (c, actions, mobs) {
    this.config = sanitizeLikes({ ...this.config, ...c }, actions, mobs)
    if (this.progress >= this.config.every) this.progress = this.config.every - 1
    return this.config
  }

  /** So viele Mobs bringt das Ziel mit der Nummer `level` (1 = erstes Ziel). */
  amountFor (level) { return this.config.amount + (this.config.escalate ? Math.min(MAX_BONUS, Math.max(0, level - 1)) : 0) }

  /**
   * @param {{uniqueId: string, nickname?: string, avatar?: string}} viewer
   * @param {number} count Likes in diesem Paket
   * @returns {{winner: object, level: number, amount: number, nextAmount: number, helpers: string[]}[]} geknackte Ziele
   */
  add (viewer, count = 1) {
    const n = Math.max(1, Math.min(500, Math.round(Number(count) || 1)))
    const id = String((viewer && viewer.uniqueId) || 'unbekannt')
    const name = String((viewer && (viewer.nickname || viewer.uniqueId)) || 'Jemand')
    this.total += n
    this.last = { uniqueId: id, name, avatar: (viewer && viewer.avatar) || null }
    const hits = []
    if (!this.config.enabled) return hits
    this.progress += n
    const r = this.round.get(id) || { name, count: 0 }
    r.count += n
    this.round.set(id, r)
    while (this.progress >= this.config.every && hits.length < MAX_PER_EVENT) {
      this.progress -= this.config.every
      this.level++
      // Mitstreiter der Runde (ohne den Gewinner), die fleißigsten zuerst
      const helpers = [...this.round.entries()].filter(([k]) => k !== id).sort((a, b) => b[1].count - a[1].count).slice(0, 2).map(([, v]) => v.name)
      hits.push({ winner: { ...this.last }, level: this.level, amount: this.amountFor(this.level), nextAmount: this.amountFor(this.level + 1), helpers })
      this.round.clear()
    }
    if (this.progress >= this.config.every) this.progress = this.config.every - 1
    // übrige Likes des Gewinners zählen schon für die nächste Runde
    if (hits.length && this.progress > 0) this.round.set(id, { name, count: this.progress })
    return hits
  }

  /** Zustand für Overlay und Dashboard. */
  state () {
    return { enabled: this.config.enabled, every: this.config.every, progress: this.progress, total: this.total, level: this.level, last: this.last ? this.last.name : null, nextAmount: this.amountFor(this.level + 1) }
  }
}

module.exports = { LikeGoal, sanitizeLikes }
