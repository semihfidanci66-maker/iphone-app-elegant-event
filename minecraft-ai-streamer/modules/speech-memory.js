'use strict'
/**
 * speech-memory.js – Gedächtnis des Streamers: was er gesagt hat und was Zuschauer geschrieben haben.
 *
 * - Jeder gesprochene Satz wird gespeichert (auch über Neustarts, config/speech_memory.json).
 *   Vor dem Sprechen wird geprüft, ob er denselben oder einen sehr ähnlichen Satz kürzlich schon
 *   gesagt hat – dann nimmt er eine andere Formulierung oder lässt die Ansage weg.
 * - Pro Zuschauer werden die letzten Nachrichten gemerkt (config/viewers.json), damit er sich
 *   in späteren Antworten und Streams darauf beziehen kann.
 * Schreiben gebündelt über writeLater des Servers; harte Obergrenzen halten den Speicher klein.
 */

const MAX_LINES = 600
const MAX_VIEWERS = 300
const MAX_NOTES = 6

/** Für den Vergleich: Kleinbuchstaben, Zahlen vereinheitlicht, Satzzeichen weg. */
function normalize (text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\d+/g, '#').replace(/[^a-z#ß ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function words (n) { return new Set(n.split(' ').filter(w => w.length > 2)) }

/** Anteil gemeinsamer Wörter (0..1). */
function similarity (a, b) {
  const A = words(a); const B = words(b)
  if (!A.size || !B.size) return a === b ? 1 : 0
  let common = 0
  for (const w of A) if (B.has(w)) common++
  return common / Math.max(A.size, B.size)
}

class SpeechMemory {
  /**
   * @param {{lines?: object[], viewers?: object}} data  gespeicherter Stand
   * @param {{onChange?: () => void, now?: () => number}} o
   */
  constructor (data = {}, o = {}) {
    this.now = o.now || Date.now
    this.onChange = o.onChange || (() => {})
    this.lines = Array.isArray(data.lines) ? data.lines.filter(l => l && l.n).slice(-MAX_LINES) : []
    this.viewers = data.viewers && typeof data.viewers === 'object' ? data.viewers : {}
  }

  /**
   * Hat er diesen (oder einen sehr ähnlichen) Satz kürzlich gesagt?
   * Exakt gleich: 45 Minuten gesperrt. Sehr ähnlich (≥ 75 % gleiche Wörter): 12 Minuten.
   */
  recentlySaid (text, o = {}) {
    const n = normalize(text)
    if (!n) return false
    const now = this.now()
    const exactMs = o.exactMs ?? 45 * 60000
    const similarMs = o.similarMs ?? 12 * 60000
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i]
      const age = now - l.at
      if (age > exactMs) break
      if (l.n === n) return true
      if (age <= similarMs && similarity(l.n, n) >= 0.75) return true
    }
    return false
  }

  record (text, kind = 'misc') {
    const n = normalize(text)
    if (!n) return
    this.lines.push({ n, t: String(text).slice(0, 240), k: kind, at: this.now() })
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES)
    this.onChange()
  }

  /** Die letzten gesprochenen Sätze (für das Sprachmodell: "nicht wiederholen"). */
  recent (count = 10) { return this.lines.slice(-count).map(l => l.t) }

  // ---------------------------------------------------------------- Zuschauer
  viewer (id, name) {
    const key = String(id || name || 'anonym').toLowerCase().slice(0, 40)
    let v = this.viewers[key]
    if (!v) {
      v = this.viewers[key] = { name: String(name || id).slice(0, 30), first: this.now(), streams: 1, msgs: 0, notes: [] }
      const keys = Object.keys(this.viewers)
      if (keys.length > MAX_VIEWERS) {
        keys.sort((a, b) => (this.viewers[a].last || 0) - (this.viewers[b].last || 0))
        for (const k of keys.slice(0, keys.length - MAX_VIEWERS)) delete this.viewers[k]
      }
    }
    return v
  }

  /** Neue Nachricht merken. Liefert, was es über den Zuschauer schon gab (vor dieser Nachricht). */
  noteMessage (id, name, text, sessionStart) {
    const v = this.viewer(id, name)
    const before = { notes: v.notes.slice(), msgs: v.msgs, returning: !!v.last && v.last < sessionStart, last: v.last || 0 }
    if (v.last && v.last < sessionStart && v.lastSession !== sessionStart) v.streams = (v.streams || 1) + 1
    v.lastSession = sessionStart
    v.name = String(name || v.name).slice(0, 30)
    v.msgs++
    v.last = this.now()
    v.notes.push({ t: String(text).slice(0, 160), at: v.last })
    if (v.notes.length > MAX_NOTES) v.notes.splice(0, v.notes.length - MAX_NOTES)
    this.onChange()
    return before
  }

  /** Hat dieser Zuschauer exakt diese Nachricht gerade erst geschickt? (Spam: nur einmal beantworten) */
  isRepeat (id, text, ms = 90000) {
    const v = this.viewers[String(id || '').toLowerCase().slice(0, 40)]
    if (!v || !v.notes.length) return false
    const n = normalize(text)
    const now = this.now()
    return v.notes.some(x => now - x.at < ms && normalize(x.t) === n)
  }

  toJSON () { return { lines: this.lines, viewers: this.viewers } }
}

module.exports = { SpeechMemory, normalize, similarity }
