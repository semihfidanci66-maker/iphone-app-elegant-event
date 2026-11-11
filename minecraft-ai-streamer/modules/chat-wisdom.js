'use strict'
/**
 * chat-wisdom.js – Tipps aus dem TikTok-Chat erkennen, merken und anwenden.
 *
 * Sicherheit zuerst: Der Chat kann den Bot nicht frei umprogrammieren. Ein Tipp wirkt nur, wenn er
 * auf eine der festen Regeln unten passt – und jede dieser Regeln macht den Bot vorsichtiger oder
 * besser, nie schlechter. Alles andere wird nur als "nicht verstanden" notiert.
 *
 * Gespeichert in config/chat_wisdom.json. Reine Logik, testbar ohne Server.
 */

// id · label (fürs Dashboard) · re (Erkennung) · effect (was sich ändert) · ack (Bestätigung) · recall (Satz beim Anwenden)
// context: wann der Tipp "angewandt" wird (Ereignis aus dem Bot)
const RULES = [
  { id: 'gold_nether', label: 'Goldrüstung im Nether', context: 'nether', effect: 'Zieht vor dem Nether ein Teil Goldrüstung an, damit Piglins friedlich bleiben.',
    re: /gold(r[üu]stung|helm|stiefel|schuhe|hose|sachen|teil)?.*(nether|piglin)|(nether|piglin).*gold/i,
    ack: 'Goldrüstung im Nether, damit die Piglins Ruhe geben', recall: 'Goldrüstung im Nether. Zieh ich an, dann lassen mich die Piglins in Ruhe.' },
  { id: 'avoid_warden', label: 'Warden nicht bekämpfen', context: 'warden', effect: 'Weicht einem natürlichen Wärter aus, statt zu kämpfen.',
    re: /(warden|w[äa]rter).*(schleich|sneak|nicht (schlagen|k[äa]mpfen|angreifen|hauen)|weglaufen|lauf weg|hau ab|abhauen|fl[üu]cht|meiden|leise)|(schleich|sneak|leise).*(warden|w[äa]rter)/i,
    ack: 'beim Wärter schleichen statt kämpfen', recall: 'beim Wärter nicht kämpfen, sondern leise weg. Genau das mach ich jetzt.' },
  { id: 'water_bucket', label: 'Wassereimer dabeihaben', context: 'deep', effect: 'Geht erst mit Wassereimer in die Tiefe (gegen Lava und Stürze).',
    re: /wasser(eimer)?.*(off-?hand|zweithand|dabei|mitnehmen|mit nehmen|hotbar|einpacken|hand|immer)|\bmlg\b|eimer wasser|(pack|nimm|hol).*wasser(eimer)?/i,
    ack: 'immer einen Wassereimer dabeihaben', recall: 'Wassereimer mitnehmen. Ohne geh ich nicht mehr in die Tiefe.' },
  { id: 'sleep_night', label: 'Nachts schlafen', context: 'night', effect: 'Besorgt das Bett früher und schläft jede Nacht.',
    re: /(schlaf|penn|bett).*(nacht|nachts|dunkel|abend)|(nacht|nachts|dunkel).*(schlaf|penn|bett)/i,
    ack: 'nachts schlafen und früh ein Bett besorgen', recall: 'nachts schlafen. Bett steht ganz oben auf der Liste.' },
  { id: 'bunker_night', label: 'Nachts einbunkern', context: 'night', effect: 'Bunkert sich nachts ohne Bett ein, statt herumzulaufen.',
    re: /(grab|bau|bunker|mauer|buddel)\w* (dich|sich) (ein|zu)\b|(nachts?|dunkel).*(einbuddeln|eingraben|einbunkern|einmauern|verstecken|versteck dich)|(einbuddeln|eingraben|einbunkern|einmauern).*(nachts?|dunkel)/i,
    ack: 'nachts ohne Bett einbunkern', recall: 'nachts einbunkern. Mach ich, bis es hell wird.' },
  { id: 'creeper_distance', label: 'Abstand zu Creepern', context: 'creeper', effect: 'Hält mehr Abstand zu Creepern: treffen und sofort zurück.',
    re: /creeper.*(abstand|weg(laufen|rennen)?|zur[üu]ck|nicht (zu )?(nah|ran)|distanz|hit and run|schlagen und (weg|zur[üu]ck)|block|explod)|(abstand|weg) .*creeper/i,
    ack: 'beim Creeper Abstand halten: schlagen und sofort zurück', recall: 'Abstand zum Creeper. Schlagen, zurück, schlagen.' },
  { id: 'retreat_early', label: 'Früher zurückziehen', context: 'low_hp', effect: 'Zieht sich bei mehr Leben zurück (zwei halbe Herzen früher).',
    re: /(lauf|renn|geh|zieh|hau).{0,10}(weg|zur[üu]ck|ab)\b.*(wenig|low|kaum|halb).*(leben|herzen|hp)|(wenig|low|kaum).*(leben|herzen|hp).*(lauf|renn|weg|zur[üu]ck|r[üu]ckzug|abhauen)|r[üu]ckzug|nicht so lange k[äa]mpfen/i,
    ack: 'bei wenig Leben früher abhauen', recall: 'bei wenig Leben früher zurückziehen. Bin schon weg.' },
  { id: 'eat_early', label: 'Früher essen', context: 'hungry', effect: 'Isst früher und nimmt mehr Vorrat mit.',
    re: /(iss|ess|essen|futter|mampf).{0,25}(fr[üu]her|mehr|rechtzeitig|vorher|öfter|oefter|nicht vergessen|regelm)|(hunger|essen).*(nicht vergessen|aufpassen|achten)|mehr (essen|futter|steaks?) (mitnehmen|dabei|einpacken)/i,
    ack: 'früher essen und mehr Vorrat mitnehmen', recall: 'früher essen. Ich schieb mir jetzt was rein.' },
  { id: 'pillar_up', label: 'Bei Übermacht hochbauen', context: 'swarm', effect: 'Baut sich bei vielen Gegnern und wenig Leben nach oben in Sicherheit.',
    re: /(bau|t[üu]rm|stapel|pillar).{0,15}(dich|sich)? ?(hoch|nach oben|rauf)|hochbauen|(turm|s[äa]ule) bauen|nach oben bauen/i,
    ack: 'bei zu vielen Gegnern hochbauen', recall: 'hochbauen, wenn es zu viele werden. Bin gleich oben.' },
  { id: 'iron_first', label: 'Erst Eisen, dann Höhle', context: 'deep', effect: 'Geht erst mit Eisenausrüstung in tiefe Höhlen.',
    re: /(erst|zuerst|vorher).{0,20}(eisen|r[üu]stung|ausr[üu]stung|schild).{0,30}(h[öo]hle|mine|runter|diamant|tief)|ohne (eisen|r[üu]stung|schild).{0,20}(nicht|nie).{0,20}(h[öo]hle|mine|runter)|(h[öo]hle|mine).{0,25}(nur|erst) mit (eisen|r[üu]stung)/i,
    ack: 'erst Eisenausrüstung, dann Höhle', recall: 'erst Eisen, dann Höhle. Ohne Rüstung geh ich nicht runter.' },
  { id: 'careful_drops', label: 'Nicht tief springen', context: 'fall', effect: 'Springt nicht mehr tiefer als zwei Blöcke.',
    re: /(nicht|nie|kein).{0,15}(so )?(tief|hoch|weit)?.{0,6}(runter)?(springen|spring|fallen|h[üu]pfen)|fallschaden|vorsicht.{0,15}(kante|klippe|abgrund|schlucht)|pass.{0,15}(kante|klippe|abgrund)/i,
    ack: 'nicht mehr so tief runterspringen', recall: 'nicht tief springen. Ich nehm den langen Weg.' },
  { id: 'shield_use', label: 'Schild benutzen', context: 'ranged', effect: 'Baut das Schild vor Schwert und Spitzhacke aus Eisen.',
    re: /schild.{0,25}(benutz|nimm|nutz|hoch|block|craft|bau|mach|hol)|(block|benutz|nimm).{0,15}schild/i,
    ack: 'das Schild benutzen und früh bauen', recall: 'Schild hoch. Hab ich mir gemerkt.' },
  { id: 'torches', label: 'Mehr Fackeln', context: 'cave', effect: 'Nimmt mehr Fackeln mit in die Höhle.',
    re: /fackeln?.{0,25}(setz|stell|platz|benutz|mitnehm|craft|mach|mehr|licht)|(setz|stell|platz|benutz|nimm|mach|craft)\w*.{0,14}fackeln?|(mach|mehr) licht|beleucht/i,
    ack: 'mehr Fackeln setzen', recall: 'mehr Fackeln. Dann spawnt hier auch nichts mehr.' },
  // ---- Tipps, die er schon befolgt: nur bestätigen, damit sich der Zuschauer gehört fühlt
  { id: 'no_dig_down', label: 'Nie gerade nach unten graben', context: null, already: true, effect: 'Macht er bereits: gräbt immer Treppen.',
    re: /(nicht|nie|niemals).{0,15}(gerade |direkt |senkrecht )?(nach unten|runter).{0,8}(graben|buddeln|hacken)|treppe.{0,15}(graben|bauen)/i,
    ack: 'nie gerade nach unten graben', recall: 'nie gerade runter graben.' },
  { id: 'crit', label: 'Kritische Treffer', context: null, already: true, effect: 'Macht er bereits: springt für kritische Treffer.',
    re: /(spring|jump|h[üu]pf).{0,20}(schlag|hau|angriff|hit|crit|krit)|krit\w* (treffer|hit|schlag)|(mach|nutz|benutz)\w*.{0,10}(crits?\b|krit)/i,
    ack: 'beim Schlagen springen für kritische Treffer', recall: 'kritische Treffer.' }
]
const BY_ID = Object.fromEntries(RULES.map(r => [r.id, r]))

// Sieht die Nachricht überhaupt wie ein Ratschlag aus? (Aufforderung + Minecraft-Bezug)
const ADVICE_HINT = /\b(du (musst|solltest|sollst|kannst)|musst du|solltest du|mach(e)? (mal|lieber|besser)|nimm|benutz(e)?|nutz(e)?|pack|bau|craft(e)?|geh(e)? (nicht|nie|lieber)|pass auf|vorsicht|achte|vergiss nicht|tipp:?|pro ?tipp|besser (ist|wäre)|lieber|niemals|immer|nicht vergessen|am besten)\b/i
const MC_HINT = /\b(creeper|zombie|skelett|spinne|enderman|warden|w[äa]rter|piglin|nether|lava|wasser|eimer|schild|schwert|axt|spitzhacke|r[üu]stung|helm|bett|fackel|h[öo]hle|mine|diamant|eisen|gold|holz|essen|steak|hunger|herzen|leben|bogen|pfeil|block|tnt|truhe|ofen|werkbank|verzauber|portal|dorf|golem|hexe|phantom|schlaf|nacht|kämpf|k[äa]mpfen|springen|bauen|graben|farm|weizen|karotte|kuh|schaf|schwein|tier)\w*/i

/** Passt die Nachricht auf eine feste Regel? */
function matchRule (text) {
  const t = String(text || '').toLowerCase()
  if (t.length < 3 || t.length > 200) return null
  return RULES.find(r => r.re.test(t)) || null
}
/** Klingt wie ein Ratschlag, passt aber auf keine Regel. */
function looksLikeAdvice (text) {
  const t = String(text || '')
  return t.length >= 12 && t.length <= 200 && !/\?\s*$/.test(t) && ADVICE_HINT.test(t) && MC_HINT.test(t)
}

class ChatWisdom {
  /**
   * @param {object|null} saved Inhalt von chat_wisdom.json
   * @param {{onChange?: () => void, now?: () => number}} [opts]
   */
  constructor (saved, opts = {}) {
    this.onChange = opts.onChange || (() => {})
    this.now = opts.now || Date.now
    const s = saved && typeof saved === 'object' ? saved : {}
    this.tips = {} // Regel-Id -> { by, text, at, count, supporters[], enabled, applied }
    for (const [id, t] of Object.entries(s.tips || {})) if (BY_ID[id] && t) this.tips[id] = { by: String(t.by || 'Chat').slice(0, 30), text: String(t.text || '').slice(0, 160), at: Number(t.at) || 0, count: Number(t.count) || 1, supporters: Array.isArray(t.supporters) ? t.supporters.slice(0, 8) : [], enabled: t.enabled !== false, applied: Number(t.applied) || 0 }
    this.unknown = Array.isArray(s.unknown) ? s.unknown.slice(-60) : [] // { by, text, at }
    this.lastRecall = new Map() // Regel-Id -> Zeitpunkt (nur diese Sitzung)
  }

  toJSON () { return { version: 1, tips: this.tips, unknown: this.unknown } }

  /**
   * Chat-Nachricht prüfen.
   * @returns {null | {kind: 'new'|'known'|'already', rule: object, by: string} | {kind: 'unknown'}}
   */
  consider (viewerName, text) {
    const rule = matchRule(text)
    const by = String(viewerName || 'Chat').slice(0, 30)
    if (!rule) {
      if (!looksLikeAdvice(text)) return null
      this.unknown.push({ by, text: String(text).slice(0, 160), at: this.now() })
      if (this.unknown.length > 60) this.unknown.shift()
      this.onChange()
      return { kind: 'unknown' }
    }
    return this.learn(rule.id, by, text)
  }

  /** Tipp unter einer Regel ablegen (auch vom Sprachmodell zugeordnete Tipps landen hier). */
  learn (ruleId, by, text) {
    const rule = BY_ID[ruleId]
    if (!rule) return null
    const have = this.tips[rule.id]
    if (have) {
      have.count++
      if (by !== have.by && !have.supporters.includes(by) && have.supporters.length < 8) have.supporters.push(by)
      this.onChange()
      return { kind: rule.already ? 'already' : 'known', rule, by, first: have.by }
    }
    this.tips[rule.id] = { by, text: String(text || '').slice(0, 160), at: this.now(), count: 1, supporters: [], enabled: true, applied: 0 }
    this.onChange()
    return { kind: rule.already ? 'already' : 'new', rule, by }
  }

  /** Aktive Tipps für die Policy: Regel-Id -> { by }. */
  active () {
    const out = {}
    for (const [id, t] of Object.entries(this.tips)) if (t.enabled && !BY_ID[id].already) out[id] = { by: t.by }
    return out
  }

  /**
   * Ein Spielmoment tritt ein (Nether betreten, Wärter gesehen, Nacht …): gibt es dazu einen Tipp?
   * Höchstens alle 10 Minuten pro Tipp, damit er sich nicht wiederholt.
   * @returns {{rule: object, by: string}[]}
   */
  recall (context) {
    const out = []
    const now = this.now()
    for (const [id, t] of Object.entries(this.tips)) {
      const rule = BY_ID[id]
      if (!t.enabled || rule.context !== context) continue
      if (this.lastRecall.has(id) && now - this.lastRecall.get(id) < 600000) continue
      this.lastRecall.set(id, now)
      t.applied++
      out.push({ rule, by: t.by })
    }
    if (out.length) this.onChange()
    return out
  }

  setEnabled (id, on) { if (this.tips[id]) { this.tips[id].enabled = !!on; this.onChange(); return true } return false }
  remove (id) { if (this.tips[id]) { delete this.tips[id]; this.onChange(); return true } return false }
  reset () { this.tips = {}; this.unknown = []; this.lastRecall.clear(); this.onChange() }

  summary () {
    return {
      tips: Object.entries(this.tips).map(([id, t]) => ({ id, label: BY_ID[id].label, effect: BY_ID[id].effect, already: !!BY_ID[id].already, by: t.by, text: t.text, count: t.count, supporters: t.supporters, enabled: t.enabled, applied: t.applied, at: t.at })).sort((a, b) => b.at - a.at),
      unknown: this.unknown.slice(-8).reverse(),
      rules: RULES.length
    }
  }
}

module.exports = { ChatWisdom, RULES, matchRule, looksLikeAdvice }
