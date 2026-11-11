'use strict'
/**
 * ai-learning.js – der Bot lernt aus Fehlern.
 *
 * Kein neuronales Netz, sondern ein nachvollziehbares Erfahrungs-Gedächtnis:
 *
 *  1. Fehler-Gedächtnis: Tode und schwere Fehlschläge werden mit ihrer Lage gespeichert
 *     (Ursache, Gegner, Ort, Tageszeit, Ausrüstung). Gleiche Lage = gleiche Signatur.
 *  2. Lehren: Aus wiederholten Signaturen entstehen feste Verhaltensänderungen ("Policy"),
 *     z. B. früher zurückziehen, mehr Abstand zu Creepern, erst mit Eisen in die Höhle.
 *  3. Strategie-Wahl: Scheitert eine Aufgabe dreimal hintereinander, wählt der Bot einen
 *     Ausweg aus der Wissensbasis – bevorzugt den, der früher am häufigsten geholfen hat.
 *     Erfolg und Misserfolg jedes Auswegs werden mitgezählt (einfaches Bandit-Lernen).
 *  4. Planer-Gewichte: Aufgaben, die oft scheitern, werden für den GOAP-Planer teurer.
 *
 * Alles liegt in config/mistakes_memory.json und überlebt Neustarts. Reine Logik, testbar ohne Server.
 */
const K = require('./mc-knowledge')

const MAX_MISTAKES = 200
const RETHINK_AFTER = 3 // so viele Fehlschläge hintereinander, dann Bunker + neue Strategie
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** Grundwerte der Policy – das Verhalten ohne jede Erfahrung. */
const BASE_POLICY = () => ({
  retreatHp: 12, // ab so wenig Leben (halbe Herzen) Abstand nehmen und essen
  funnelAt: 4, // ab so vielen Nahkämpfern zurückweichen und in eine Reihe ziehen
  eatAt: 14, // Hungerbalken, ab dem gegessen wird
  foodReserve: 5, // so viel gebratenes Essen gilt als "genug"
  creeperCaution: 0, // 0 normal · 1 mehr Abstand · 2 nur noch treffen-und-weg, in Gängen einmauern
  mobCaution: {}, // Gegner -> Stufe (jede Stufe: +1 Rückzugs-Leben, wenn dieser Gegner dabei ist)
  avoid: [], // natürliche Gegner, denen der Bot ausweicht statt zu kämpfen
  caveNeedsIron: false, // Höhle erst mit Eisenausrüstung
  caveNeedsWater: false, // tiefe Mine erst mit Wassereimer
  nightShelter: false, // nachts ohne Bett einbunkern statt herumlaufen
  bedEarly: false, // Bett früher in der Reihenfolge
  maxDrop: 3, // so tief lässt sich der Bot fallen
  pillarWhenSwarmed: false, // bei Übermacht hochbauen
  shieldFirst: false, // Schild vor Schwert und Spitzhacke aus Eisen
  torchStock: 6, // so viele Fackeln nimmt er mit unter Tage
  reasons: {} // Policy-Feld -> kurzer Grund (fürs Dashboard)
})

/** Tod in eine Signatur und einen lesbaren Satz übersetzen. */
function describeDeath (c) {
  const mob = c.killer || (c.mobs && c.mobs[0]) || null
  let cause = 'unknown'
  if (c.inLava) cause = 'lava'
  else if (c.starving) cause = 'starvation'
  else if (c.explosion || mob === 'creeper') cause = 'creeper'
  else if (c.fell) cause = 'fall'
  else if (c.drowning) cause = 'drowning'
  else if (mob) cause = 'mob:' + mob
  const where = c.dimension === 'nether' ? 'nether' : c.underground ? (c.tunnel ? 'tunnel' : 'cave') : 'surface'
  const swarm = (c.threats || 0) >= 3
  const sig = ['death', cause, where, swarm ? 'swarm' : '', c.night && where === 'surface' ? 'night' : ''].filter(Boolean).join(':')
  const mobDe = mob ? mob.replace(/_/g, ' ') : 'etwas'
  const whereDe = { nether: 'im Nether', tunnel: 'in einem engen Gang', cave: 'in einer Höhle', surface: c.night ? 'nachts an der Oberfläche' : 'an der Oberfläche' }[where]
  const causeDe = cause === 'lava' ? 'In Lava gestorben' : cause === 'starvation' ? 'Verhungert' : cause === 'creeper' ? 'Von einem Creeper gesprengt' : cause === 'fall' ? 'Zu tief gefallen' : cause === 'drowning' ? 'Ertrunken' : cause === 'unknown' ? 'Gestorben' : `Von ${mobDe} getötet`
  const text = `${causeDe} ${whereDe}${swarm ? ` gegen ${c.threats} Gegner` : ''}${c.pickTier != null && c.pickTier < 3 ? ' ohne Eisenausrüstung' : ''}`
  return { sig, cause, where, swarm, mob, text }
}

class AILearning {
  /**
   * @param {object|null} saved  Inhalt von mistakes_memory.json
   * @param {{onChange?: () => void, now?: () => number, random?: () => number}} [opts]
   */
  constructor (saved, opts = {}) {
    this.onChange = opts.onChange || (() => {})
    this.now = opts.now || Date.now
    this.random = opts.random || Math.random
    const s = saved && typeof saved === 'object' ? saved : {}
    this.mistakes = Array.isArray(s.mistakes) ? s.mistakes.slice(-MAX_MISTAKES) : []
    this.signatures = s.signatures && typeof s.signatures === 'object' ? s.signatures : {} // sig -> { count, last, text }
    this.strategies = s.strategies && typeof s.strategies === 'object' ? s.strategies : {} // "Aktion|Strategie" -> { tries, wins }
    this.tasks = s.tasks && typeof s.tasks === 'object' ? s.tasks : {} // Aktion -> { ok, fail }
    this.lessons = Array.isArray(s.lessons) ? s.lessons : [] // { id, text, at, sig }
    this.streak = new Map() // Aktion -> Fehlschläge hintereinander (nur diese Sitzung)
    this.pending = new Map() // Aktion -> zuletzt angewandte Strategie (wartet auf Ergebnis)
    this.tips = {} // aktive Chat-Tipps: Regel-Id -> { by }
    this._policy = null
  }

  toJSON () { return { version: 1, mistakes: this.mistakes, signatures: this.signatures, strategies: this.strategies, tasks: this.tasks, lessons: this.lessons } }
  _changed () { this._policy = null; this.onChange() }

  // ---------------------------------------------------------------- 1. Fehler-Gedächtnis
  /**
   * Tod festhalten und prüfen, ob daraus eine neue Lehre entsteht.
   * @param {object} c Lage beim Tod: { killer, mobs[], threats, underground, tunnel, night, dimension, inLava, fell, drowning, starving, explosion, pickTier, hasShield, y, activity }
   * @returns {{mistake: object, lessons: object[]}} neue Lehren (leer, wenn nichts Neues gelernt wurde)
   */
  recordDeath (c) {
    const d = describeDeath(c || {})
    const mistake = { at: this.now(), kind: 'death', sig: d.sig, text: d.text, cause: d.cause, where: d.where, mob: d.mob, threats: c.threats || 0, y: c.y ?? null, activity: c.activity || null }
    this._store(mistake)
    return { mistake, lessons: this._learnFrom(d, c) }
  }

  /** Anderen Fehlschlag festhalten (Aufgabe gescheitert, festgesteckt, fast gestorben …). */
  recordFailure (kind, text, extra = {}) {
    const sig = [kind, extra.action || extra.where || ''].filter(Boolean).join(':')
    const mistake = { at: this.now(), kind, sig, text: String(text).slice(0, 160), ...extra }
    this._store(mistake)
    return mistake
  }

  _store (m) {
    this.mistakes.push(m)
    if (this.mistakes.length > MAX_MISTAKES) this.mistakes.shift()
    const s = this.signatures[m.sig] || (this.signatures[m.sig] = { count: 0, last: 0, text: m.text })
    s.count++; s.last = m.at; s.text = m.text
    this._changed()
  }

  count (sigPrefix) { return Object.entries(this.signatures).filter(([k]) => k === sigPrefix || k.startsWith(sigPrefix + ':')).reduce((n, [, v]) => n + v.count, 0) }

  // ---------------------------------------------------------------- 2. Lehren -> Policy
  _lesson (id, text, sig) {
    if (this.lessons.some(l => l.id === id)) return null
    const l = { id, text, at: this.now(), sig }
    this.lessons.push(l)
    if (this.lessons.length > 60) this.lessons.shift()
    this._changed()
    return l
  }

  /** Aus einem Tod Lehren ziehen. Jede Lehre entsteht genau einmal; Stufen steigen mit Wiederholungen. */
  _learnFrom (d, c) {
    const out = []
    const add = (id, text) => { const l = this._lesson(id, text, d.sig); if (l) out.push(l) }
    const n = prefix => this.count(prefix)
    if (d.cause === 'creeper') {
      add('creeper_1', 'Creeper: mehr Abstand halten, nur treffen und sofort zurück.')
      if (d.where === 'tunnel' || d.where === 'cave') add('creeper_tunnel', 'Creeper im engen Gang: nicht kämpfen, sondern einen Block dazwischen setzen.')
      if (n('death:creeper') >= 2) add('creeper_2', 'Creeper zum zweiten Mal: ab jetzt nur noch treffen-und-weg, ohne Schild gar nicht mehr in den Nahkampf.')
    }
    if (d.mob && d.cause.startsWith('mob:')) {
      const info = K.threatInfo(d.mob)
      add('mob_' + d.mob + '_1', `${d.mob.replace(/_/g, ' ')}: früher zurückziehen. ${info.tactic}`)
      if (n('death:mob:' + d.mob) >= 3) add('mob_' + d.mob + '_2', `${d.mob.replace(/_/g, ' ')} hat mich schon dreimal erwischt: noch vorsichtiger, bei wenig Leben sofort weg.`)
      if (info.danger >= 5 && !c.giftMob) add('avoid_' + d.mob, `${d.mob.replace(/_/g, ' ')} ist zu stark: ausweichen statt kämpfen, wenn er nicht von einem Gift kommt.`)
    }
    if (d.swarm) {
      add('swarm_1', 'Gegen viele Gegner: früher zurückweichen und sie in eine Reihe ziehen.')
      const swarmDeaths = Object.keys(this.signatures).filter(k => k.includes(':swarm')).reduce((x, k) => x + this.signatures[k].count, 0)
      if (swarmDeaths >= 2) add('swarm_2', 'Wieder überrannt: bei Übermacht hochbauen und von oben kämpfen.')
    }
    if (d.cause === 'lava') add('lava_1', 'Lava: tief unten nur noch mit Wassereimer abbauen.')
    if (d.cause === 'fall') add('fall_1', 'Sturz: keine Sprünge mehr tiefer als zwei Blöcke.')
    if (d.cause === 'starvation') add('food_1', 'Verhungert: früher essen und mehr Vorrat mitnehmen.')
    if ((d.where === 'cave' || d.where === 'tunnel') && (c.pickTier ?? 0) < 3) add('cave_iron', 'Unter Tage ohne Eisen gestorben: Höhle erst mit Eisenausrüstung und Schild.')
    if (d.where === 'surface' && c.night && !c.hasBed) add('night_1', 'Nachts draußen gestorben: Bett früher besorgen und nachts ohne Bett einbunkern.')
    if (this.count('death') >= 4) add('careful_1', 'Vier Tode: generell früher zurückziehen und essen.')
    if (this.count('death') >= 8) add('careful_2', 'Acht Tode: noch defensiver spielen.')
    return out
  }

  /** Chat-Tipps, die das Verhalten ändern (kommen aus chat-wisdom.js). */
  setTips (tips) { this.tips = tips && typeof tips === 'object' ? tips : {}; this._policy = null }

  /** Aktuelles Verhalten = Grundwerte + Lehren + Chat-Tipps. Wird zwischengespeichert. */
  policy () {
    if (this._policy) return this._policy
    const p = BASE_POLICY()
    const has = id => this.lessons.some(l => l.id === id)
    const why = (field, text) => { p.reasons[field] = text }
    if (has('creeper_1')) { p.creeperCaution = 1; why('creeperCaution', 'aus einem Creeper-Tod gelernt') }
    if (has('creeper_2') || has('creeper_tunnel')) { p.creeperCaution = 2; why('creeperCaution', 'aus Creeper-Toden gelernt') }
    for (const l of this.lessons) {
      let m = /^mob_(.+)_([12])$/.exec(l.id)
      if (m) p.mobCaution[m[1]] = Math.max(p.mobCaution[m[1]] || 0, Number(m[2]))
      m = /^avoid_(.+)$/.exec(l.id)
      if (m && !p.avoid.includes(m[1])) p.avoid.push(m[1])
    }
    if (has('swarm_1')) { p.funnelAt = 3; why('funnelAt', 'schon einmal überrannt worden') }
    if (has('swarm_2')) { p.pillarWhenSwarmed = true; why('pillarWhenSwarmed', 'mehrfach überrannt worden') }
    if (has('lava_1')) { p.caveNeedsWater = true; why('caveNeedsWater', 'in Lava gestorben') }
    if (has('fall_1')) { p.maxDrop = 2; why('maxDrop', 'zu tief gefallen') }
    if (has('food_1')) { p.eatAt = 17; p.foodReserve = 10; why('foodReserve', 'verhungert') }
    if (has('cave_iron')) { p.caveNeedsIron = true; why('caveNeedsIron', 'unter Tage ohne Eisen gestorben') }
    if (has('night_1')) { p.nightShelter = true; p.bedEarly = true; why('nightShelter', 'nachts draußen gestorben') }
    if (has('careful_1')) { p.retreatHp += 2; why('retreatHp', 'mehrere Tode') }
    if (has('careful_2')) { p.retreatHp += 2; p.foodReserve = Math.max(p.foodReserve, 8) }
    // ---- Chat-Tipps (nur Regeln, die es in chat-wisdom.js gibt)
    const t = this.tips
    const by = id => (t[id] && t[id].by ? `Tipp von ${t[id].by}` : 'Tipp aus dem Chat')
    if (t.creeper_distance) { p.creeperCaution = Math.max(p.creeperCaution, 1); why('creeperCaution', by('creeper_distance')) }
    if (t.retreat_early) { p.retreatHp += 2; why('retreatHp', by('retreat_early')) }
    if (t.eat_early) { p.eatAt = Math.max(p.eatAt, 17); p.foodReserve = Math.max(p.foodReserve, 8); why('eatAt', by('eat_early')) }
    if (t.sleep_night) { p.bedEarly = true; why('bedEarly', by('sleep_night')) }
    if (t.bunker_night) { p.nightShelter = true; why('nightShelter', by('bunker_night')) }
    if (t.water_bucket) { p.caveNeedsWater = true; why('caveNeedsWater', by('water_bucket')) }
    if (t.avoid_warden && !p.avoid.includes('warden')) { p.avoid.push('warden'); why('avoid', by('avoid_warden')) }
    if (t.pillar_up) { p.pillarWhenSwarmed = true; why('pillarWhenSwarmed', by('pillar_up')) }
    if (t.iron_first) { p.caveNeedsIron = true; why('caveNeedsIron', by('iron_first')) }
    if (t.careful_drops) { p.maxDrop = 2; why('maxDrop', by('careful_drops')) }
    if (t.shield_use) { p.shieldFirst = true; why('shieldFirst', by('shield_use')) }
    if (t.torches) { p.torchStock = 16; why('torchStock', by('torches')) }
    p.retreatHp = clamp(p.retreatHp, 8, 16)
    this._policy = p
    return p
  }

  /** Rückzugs-Schwelle für den aktuellen Kampf (steigt mit der Vorsicht gegenüber den beteiligten Gegnern). */
  retreatHpFor (mobNames = []) {
    const p = this.policy()
    let extra = 0
    for (const m of new Set(mobNames)) extra = Math.max(extra, p.mobCaution[m] || 0, m === 'creeper' ? p.creeperCaution : 0)
    return clamp(p.retreatHp + extra, 8, 17)
  }

  // ---------------------------------------------------------------- 3. Aufgaben-Ergebnisse, Strategie-Wahl
  /**
   * Ergebnis einer GOAP-Aktion verbuchen.
   * @returns {{rethink: boolean, streak: number}} rethink = jetzt Bunker + neue Strategie
   */
  taskResult (action, ok) {
    const t = this.tasks[action] || (this.tasks[action] = { ok: 0, fail: 0 })
    if (ok) t.ok++; else t.fail++
    // Ergebnis der zuletzt gewählten Strategie zuschreiben
    const strat = this.pending.get(action)
    if (strat) {
      const s = this.strategies[`${action}|${strat}`] || (this.strategies[`${action}|${strat}`] = { tries: 0, wins: 0 })
      s.tries++
      if (ok) s.wins++
      this.pending.delete(action)
    }
    const streak = ok ? 0 : (this.streak.get(action) || 0) + 1
    this.streak.set(action, streak)
    this._changed()
    return { rethink: !ok && streak > 0 && streak % RETHINK_AFTER === 0, streak }
  }

  /**
   * Ausweg wählen: unversuchte zuerst (in der Reihenfolge der Wissensbasis), sonst der mit der
   * besten Erfolgsquote; mit 15 % Wahrscheinlichkeit wird bewusst ein anderer ausprobiert.
   * @param {string} action   Name der GOAP-Aktion
   * @param {string} activity Tätigkeit (mine, wood, hunt …) für die Wissensbasis
   * @param {(name: string) => boolean} [possible] filtert Auswege, die gerade nicht gehen
   */
  chooseStrategy (action, activity, possible = () => true) {
    const options = K.remediesFor(activity).filter(possible)
    if (!options.length) return null
    const stat = name => this.strategies[`${action}|${name}`] || { tries: 0, wins: 0 }
    const fresh = options.find(o => stat(o).tries === 0 && o !== 'skip_for_now')
    let pick = fresh
    if (!pick) {
      // Laplace-geglättete Erfolgsquote, damit ein einzelner Fehlschlag keinen Ausweg für immer abwertet
      const rate = o => (stat(o).wins + 1) / (stat(o).tries + 2)
      const ranked = options.slice().sort((a, b) => rate(b) - rate(a))
      pick = this.random() < 0.15 && ranked.length > 1 ? ranked[1 + Math.floor(this.random() * (ranked.length - 1))] : ranked[0]
    }
    this.pending.set(action, pick)
    return { name: pick, ...K.STRATEGIES[pick], stats: stat(pick) }
  }

  // ---------------------------------------------------------------- 4. Planer-Gewichte
  /** Aufschlag auf die Kosten einer GOAP-Aktion: scheitert sie oft, wird sie teurer (0 bis 12). */
  costPenalty (action) {
    const t = this.tasks[action]
    if (!t || t.ok + t.fail < 3) return 0
    return Math.round(clamp(t.fail / (t.ok + t.fail), 0, 1) * 12)
  }

  /** Zusätzliche Vorbedingungen für eine GOAP-Aktion (aus Lehren und Chat-Tipps). */
  extraPreconditions (action) {
    const p = this.policy()
    const out = []
    const deep = ['MineDiamonds', 'MineObsidian4', 'MineObsidian10', 'MineLapis', 'GetGold']
    if (p.caveNeedsIron && deep.includes(action)) out.push('ironKit')
    if (p.caveNeedsWater && ['MineDiamonds', 'MineLapis', 'GetGold'].includes(action)) out.push('waterBucket')
    return out
  }

  /** Reihenfolge der Ziele anpassen (z. B. Bett früher). */
  progression (base) {
    const p = this.policy()
    const order = base.slice()
    if (p.bedEarly && order.includes('bed')) { order.splice(order.indexOf('bed'), 1); order.splice(Math.min(1, order.length), 0, 'bed') }
    return order
  }

  // ---------------------------------------------------------------- Dashboard
  summary () {
    const p = this.policy()
    const deaths = this.count('death')
    return {
      deaths,
      mistakes: this.mistakes.length,
      lessons: this.lessons.slice(-12).reverse().map(l => ({ id: l.id, text: l.text, at: l.at })),
      recent: this.mistakes.slice(-8).reverse().map(m => ({ at: m.at, text: m.text, kind: m.kind })),
      policy: { retreatHp: p.retreatHp, funnelAt: p.funnelAt, eatAt: p.eatAt, foodReserve: p.foodReserve, creeperCaution: p.creeperCaution, maxDrop: p.maxDrop, avoid: p.avoid, caveNeedsIron: p.caveNeedsIron, caveNeedsWater: p.caveNeedsWater, nightShelter: p.nightShelter, pillarWhenSwarmed: p.pillarWhenSwarmed, shieldFirst: p.shieldFirst, torchStock: p.torchStock, reasons: p.reasons },
      strategies: Object.entries(this.strategies).filter(([, v]) => v.tries).map(([k, v]) => { const [action, name] = k.split('|'); return { action, name, label: (K.STRATEGIES[name] || {}).label || name, tries: v.tries, wins: v.wins } }).sort((a, b) => b.tries - a.tries).slice(0, 12)
    }
  }

  /** Alles vergessen (Dashboard-Knopf). */
  reset () {
    this.mistakes = []; this.signatures = {}; this.strategies = {}; this.tasks = {}; this.lessons = []
    this.streak.clear(); this.pending.clear()
    this._changed()
  }
}

module.exports = { AILearning, describeDeath, BASE_POLICY, RETHINK_AFTER }
