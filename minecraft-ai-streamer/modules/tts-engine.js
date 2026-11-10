'use strict'
/**
 * tts-engine.js – EINE männliche deutsche Neural-Stimme (edge-tts), gerendert im Backend.
 *
 * ABSOLUTE REGEL: Es gibt keinen Browser-Fallback (window.speechSynthesis) und keine andere Stimme.
 * Fällt der Dienst aus, bleibt der Streamer stumm und das Overlay zeigt nur Untertitel.
 *
 * Emotion -> Prosodie:  chill +5 % / +0 Hz · hype +18 % / +6 Hz · panic +25 % / +12 Hz
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const MALE_VOICES = ['de-DE-ConradNeural', 'de-DE-KillianNeural', 'de-DE-FlorianMultilingualNeural']
const PROSODY = {
  chill: { rate: '+5%', pitch: '+0Hz' },
  hype: { rate: '+18%', pitch: '+6Hz' },
  panic: { rate: '+25%', pitch: '+12Hz' }
}

class TTSEngine {
  constructor (opts = {}) {
    this.voice = MALE_VOICES.includes(opts.voice) ? opts.voice : MALE_VOICES[0]
    this.cache = new Map()
    this.client = null
    this.lastError = null
    this.failures = 0
    this.backend = 'msedge-tts'
  }

  setVoice (v) {
    // Nur die Whitelist männlicher Stimmen ist erlaubt – alles andere fällt auf Conrad zurück
    this.voice = MALE_VOICES.includes(v) ? v : MALE_VOICES[0]
    this.client = null
    this.cache.clear()
    return this.voice
  }

  estimateMs (text, emotion) {
    const speed = { chill: 1.05, hype: 1.18, panic: 1.25 }[emotion] || 1
    return Math.max(900, Math.round(text.length * 68 / speed))
  }

  /** Gleichmäßig verteilte Wort-Zeiten, falls der Dienst keine Wortgrenzen liefert. */
  fallbackWords (text, durationMs) {
    const words = text.split(/\s+/).filter(Boolean)
    const total = words.reduce((n, w) => n + w.length + 1, 0) || 1
    let t = 0
    return words.map(w => { const d = durationMs * (w.length + 1) / total; const o = { t: Math.round(t), d: Math.round(d), w }; t += d; return o })
  }

  /**
   * @returns {Promise<{audio: Buffer|null, mime: string, words: {t:number,d:number,w:string}[], durationMs: number, voice: string, error?: string}>}
   */
  async synthesize (text, emotion = 'chill') {
    const pros = PROSODY[emotion] || PROSODY.chill
    const key = crypto.createHash('sha1').update(this.voice + '|' + emotion + '|' + text).digest('hex')
    if (this.cache.has(key)) return this.cache.get(key)
    let result = null
    const errors = []
    for (const backend of ['msedge-tts', 'edge-tts-cli']) {
      try {
        result = backend === 'msedge-tts' ? await this._viaNode(text, pros) : await this._viaCli(text, pros)
        if (result && result.audio && result.audio.length > 400) { this.backend = backend; break }
        result = null
      } catch (e) { errors.push(`${backend}: ${e.message}`) }
    }
    if (!result) {
      this.failures++
      this.lastError = errors.join(' | ') || 'kein Audio'
      const durationMs = this.estimateMs(text, emotion)
      return { audio: null, mime: 'audio/mpeg', words: this.fallbackWords(text, durationMs), durationMs, voice: this.voice, error: this.lastError }
    }
    this.lastError = null
    // 48 kbit/s CBR -> Dauer aus der Dateigröße
    const durationMs = result.durationMs || Math.round(result.audio.length * 8 / 48)
    const words = result.words && result.words.length ? result.words : this.fallbackWords(text, durationMs)
    const out = { audio: result.audio, mime: 'audio/mpeg', words, durationMs, voice: this.voice }
    this.cache.set(key, out)
    if (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value)
    return out
  }

  async _viaNode (text, pros) {
    const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts')
    if (!this.client) {
      const c = new MsEdgeTTS({ connectionTimeoutMs: 8000, synthesisTimeoutMs: 15000 })
      await c.setMetadata(this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, { wordBoundaryEnabled: true })
      this.client = c
    }
    let streams
    try { streams = this.client.toStream(text, { rate: pros.rate, pitch: pros.pitch }) } catch (e) { this.client = null; throw e }
    const { audioStream, metadataStream } = streams
    const chunks = []
    const words = []
    if (metadataStream) {
      metadataStream.on('data', (buf) => {
        try {
          const j = JSON.parse(buf.toString())
          for (const m of j.Metadata || []) {
            if (m.Type !== 'WordBoundary' || !m.Data) continue
            words.push({ t: Math.round(m.Data.Offset / 10000), d: Math.round(m.Data.Duration / 10000), w: (m.Data.text && m.Data.text.Text) || '' })
          }
        } catch (_) {}
      })
      metadataStream.on('error', () => {})
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout')), 16000)
      audioStream.on('data', c => chunks.push(c))
      audioStream.on('end', () => { clearTimeout(timer); resolve() })
      audioStream.on('close', () => { clearTimeout(timer); resolve() })
      audioStream.on('error', e => { clearTimeout(timer); this.client = null; reject(e) })
    })
    const last = words[words.length - 1]
    return { audio: Buffer.concat(chunks), words, durationMs: last ? last.t + last.d + 250 : 0 }
  }

  /** Zweiter Weg zur SELBEN Stimme: Python-Paket edge-tts (pip install edge-tts). */
  _viaCli (text, pros) {
    return new Promise((resolve, reject) => {
      const file = path.join(os.tmpdir(), `kistreamer-${process.pid}-${Date.now()}.mp3`)
      const args = ['-m', 'edge_tts', '--voice', this.voice, `--rate=${pros.rate}`, `--pitch=${pros.pitch}`, '--text', text, '--write-media', file]
      const py = process.platform === 'win32' ? 'python' : 'python3'
      const p = spawn(py, args, { stdio: 'ignore' })
      const timer = setTimeout(() => { try { p.kill() } catch (_) {} reject(new Error('Timeout')) }, 20000)
      p.on('error', e => { clearTimeout(timer); reject(e) })
      p.on('exit', code => {
        clearTimeout(timer)
        if (code !== 0) return reject(new Error('edge-tts exit ' + code))
        fs.readFile(file, (err, buf) => { fs.unlink(file, () => {}); err ? reject(err) : resolve({ audio: buf, words: [] }) })
      })
    })
  }
}

module.exports = { TTSEngine, MALE_VOICES, PROSODY }
