'use strict'
/**
 * world-control.js – Welt-Steuerung für Dashboard und Handy: Tageszeit, Wetter, Schwierigkeit, Spielregeln.
 *
 * Reine Übersetzung "Knopf -> Server-Befehle". Jede Eingabe wird gegen feste Listen geprüft; freier Text
 * landet nie in einem Befehl. Die Befehle laufen über die Server-Konsole (wenn der Server vom Programm
 * gestartet wurde) oder über den Bot (braucht OP).
 */
const TIMES = { sunrise: 23000, day: 1000, noon: 6000, sunset: 12000, night: 13000, midnight: 18000 }
const TIME_LABEL = { sunrise: 'Sonnenaufgang', day: 'Tag', noon: 'Mittag', sunset: 'Sonnenuntergang', night: 'Nacht', midnight: 'Mitternacht' }
const WEATHER = { clear: 'Sonne', rain: 'Regen', thunder: 'Gewitter' }
const DIFFICULTY = { peaceful: 'Friedlich', easy: 'Einfach', normal: 'Normal', hard: 'Schwer' }
/** Schalter im Dashboard -> Gamerule (Minecraft 1.21.1). */
const RULES = {
  keepInventory: { rule: 'keepInventory', label: 'Inventar nach Tod behalten' },
  mobSpawning: { rule: 'doMobSpawning', label: 'Monster spawnen von selbst' },
  mobGriefing: { rule: 'mobGriefing', label: 'Creeper zerstören Blöcke' },
  weatherCycle: { rule: 'doWeatherCycle', label: 'Wetter wechselt von selbst' }
}
const LOCKS = { off: 'Normaler Tag-Nacht-Wechsel', day: 'Dauer-Tag', night: 'Dauer-Nacht', freeze: 'Zeit eingefroren' }

const defaultWorld = () => ({ timeLock: 'off', rules: {} })

/** Gespeicherte Welt-Einstellungen säubern (unbekannte Schlüssel fliegen raus). */
function sanitizeWorld (w) {
  const out = defaultWorld()
  if (!w || typeof w !== 'object') return out
  if (Object.hasOwn(LOCKS, w.timeLock)) out.timeLock = w.timeLock
  for (const k of Object.keys(RULES)) if (w.rules && typeof w.rules[k] === 'boolean') out.rules[k] = w.rules[k]
  return out
}

/**
 * Übersetzt einen Welt-Befehl in Server-Befehle (ohne führenden Slash).
 * @param {{op: string, value?: any, name?: string}} m
 * @param {{timeLock: string, rules: object}} world  wird bei Erfolg angepasst
 * @returns {{cmds: string[], label: string}|null}  null = ungültige Eingabe
 */
function worldCommands (m, world) {
  if (!m || typeof m.op !== 'string') return null
  const v = String(m.value ?? '')
  switch (m.op) {
    case 'time':
      if (!Object.hasOwn(TIMES, v)) return null
      return { cmds: [`time set ${TIMES[v]}`], label: 'Zeit: ' + TIME_LABEL[v] }
    case 'timelock':
      if (!Object.hasOwn(LOCKS, v)) return null
      world.timeLock = v
      if (v === 'off') return { cmds: ['gamerule doDaylightCycle true'], label: LOCKS.off }
      if (v === 'freeze') return { cmds: ['gamerule doDaylightCycle false'], label: LOCKS.freeze }
      return { cmds: [`time set ${v === 'day' ? TIMES.noon : TIMES.midnight}`, 'gamerule doDaylightCycle false'], label: LOCKS[v] }
    case 'weather':
      if (!Object.hasOwn(WEATHER, v)) return null
      return { cmds: [`weather ${v}`], label: 'Wetter: ' + WEATHER[v] }
    case 'difficulty':
      if (!Object.hasOwn(DIFFICULTY, v)) return null
      return { cmds: [`difficulty ${v}`], label: 'Schwierigkeit: ' + DIFFICULTY[v] }
    case 'rule': {
      const def = Object.hasOwn(RULES, m.name) ? RULES[m.name] : null
      if (!def) return null
      const on = !!m.value
      world.rules[m.name] = on
      return { cmds: [`gamerule ${def.rule} ${on}`], label: `${def.label}: ${on ? 'an' : 'aus'}` }
    }
    case 'save': return { cmds: ['save-all'], label: 'Welt gespeichert' }
    default: return null
  }
}

/** Freier Konsolen-Befehl aus dem Dashboard: eine Zeile, ohne Slash, höchstens 255 Zeichen. */
function cleanCommand (text) {
  const s = String(text || '').replace(/[\r\n\u0000-\u001f]+/g, ' ').trim().replace(/^\/+/, '').slice(0, 255)
  return s || null
}

/** Minecraft-Ticks (0–23999) -> Uhrzeit "HH:MM" (Tick 0 = 06:00). */
function clock (ticks) {
  const t = ((Number(ticks) || 0) % 24000 + 24000) % 24000
  const mins = Math.floor(((t + 6000) % 24000) * 0.06)
  return `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
}

module.exports = { worldCommands, sanitizeWorld, defaultWorld, cleanCommand, clock, TIMES, WEATHER, DIFFICULTY, RULES, LOCKS }
