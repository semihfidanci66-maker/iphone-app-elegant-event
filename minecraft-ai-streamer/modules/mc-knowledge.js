'use strict'
/**
 * mc-knowledge.js – fest hinterlegtes Minecraft-Wissen (Java 1.21), auf das Bot, Lern-Gedächtnis
 * und Chat-Tipps zugreifen. Reine Daten und kleine Nachschlage-Funktionen, kein Spielzugriff.
 *
 * Zeiten in Millisekunden, Strecken in Blöcken, Schaden in halben Herzen (20 = volle Leiste).
 */

// ---------------------------------------------------------------- Kampf
const COMBAT = {
  // Abklingzeit bis zum vollen Schaden: 1000 ms / Angriffsgeschwindigkeit
  cooldownMs: { sword: 625, wooden_axe: 1250, stone_axe: 1250, iron_axe: 1111, golden_axe: 1000, diamond_axe: 1000, netherite_axe: 1000, pickaxe: 833, shovel: 1000, trident: 909, mace: 1667, hand: 250 },
  // Kritischer Treffer: im Fallen (nicht sprintend, nicht im Wasser, nicht an Leitern), Cooldown über 84,8 % -> 150 % Schaden
  crit: { multiplier: 1.5, minCharge: 0.848, needs: ['fallend', 'nicht sprintend', 'nicht im Wasser'] },
  // Rundumschlag nur mit Schwert, am Boden, ohne Sprint, voller Cooldown
  sweep: { needs: ['Schwert', 'am Boden', 'nicht sprintend', 'voller Cooldown'] },
  // W-Tap: Sprint kurz loslassen und neu antippen -> jeder Treffer zählt als Sprint-Treffer (mehr Rückstoß)
  wTap: { releaseMs: 80, extraKnockback: 1 },
  // Axt-Treffer auf ein erhobenes Schild schaltet es für 5 Sekunden aus
  shieldDisableMs: 5000,
  // Schild blockt erst 250 ms nach dem Hochnehmen (5 Ticks)
  shieldRaiseMs: 250,
  reach: 3.0,
  // Fallschaden: (Höhe - 3) halbe Herzen; ab 23 Blöcken ohne Rüstung tödlich
  safeFall: 3,
  // Wassereimer-Landung: Wasser 1–2 Ticks vor dem Aufprall auf den Zielblock setzen, danach wieder aufnehmen
  mlgWater: { placeAtBlocksAbove: 3, needs: 'water_bucket' }
}

// ---------------------------------------------------------------- Gegner
// danger 1–5 · keep = Abstand, den man halten sollte · tactic = was ein guter Spieler tut
const THREATS = {
  zombie: { danger: 1, hp: 20, dmg: 3, tactic: 'Rückwärts laufen und im Rhythmus zuschlagen; Babys sind schneller, zuerst erledigen.' },
  husk: { danger: 1, hp: 20, dmg: 3, tactic: 'Wie Zombie; Treffer macht Hunger.' },
  drowned: { danger: 2, hp: 20, dmg: 3, ranged: true, tactic: 'Mit Dreizack gefährlich: Schild hoch, an Land locken.' },
  skeleton: { danger: 2, hp: 20, dmg: 4, ranged: true, tactic: 'Schild hoch und im Zickzack ran; nach dem Schuss zuschlagen.' },
  stray: { danger: 2, hp: 20, dmg: 4, ranged: true, tactic: 'Wie Skelett; Pfeile verlangsamen, also Schild hoch.' },
  spider: { danger: 2, hp: 16, dmg: 2, tactic: 'Springt an: nach dem Sprung treffen, nicht in engen Gängen kämpfen.' },
  cave_spider: { danger: 3, hp: 12, dmg: 2, tactic: 'Giftig: schnell töten, bei Gift zurückziehen und essen.' },
  creeper: { danger: 4, hp: 20, dmg: 43, keep: 4, fuseMs: 1500, blast: 3, tactic: 'Treffen und sofort zurück (über 3 Blöcke weg bricht die Zündung ab). Schild blockt die Explosion. In engen Gängen einen Block dazwischen setzen statt kämpfen.', counter: ['shield', 'block_line_of_sight'] },
  witch: { danger: 3, hp: 26, dmg: 6, ranged: true, tactic: 'Schnell ran und dauerhaft zuschlagen, sie heilt sich sonst; Tränke kommen im Bogen.' },
  enderman: { danger: 3, hp: 40, dmg: 7, neutral: true, tactic: 'Nicht ins Gesicht schauen. Greift er an: unter eine 2 Block hohe Decke stellen oder ins Wasser gehen, Wasser schadet ihm.', counter: ['water_bucket', 'low_ceiling'] },
  phantom: { danger: 2, hp: 20, dmg: 2, tactic: 'Kommt nach drei Nächten ohne Schlaf: schlafen verhindert sie. Im Sturzflug treffen.', counter: ['sleep'] },
  slime: { danger: 1, hp: 16, dmg: 4, tactic: 'Große zuerst; teilen sich in kleinere.' },
  silverfish: { danger: 1, hp: 8, dmg: 1, tactic: 'Schnell töten, sie rufen weitere aus dem Stein.' },
  pillager: { danger: 2, hp: 24, dmg: 4, ranged: true, tactic: 'Armbrust lädt langsam: nach dem Schuss ran.' },
  vindicator: { danger: 4, hp: 24, dmg: 13, tactic: 'Axt schaltet das Schild aus: nicht blocken, sondern Abstand halten und nach seinem Schlag treffen.', counter: ['kite'] },
  ravager: { danger: 5, hp: 100, dmg: 12, tactic: 'Brüllt nach geblocktem Angriff: dann Abstand. Hochbauen und von oben treffen.', counter: ['pillar', 'shield'] },
  blaze: { danger: 3, hp: 20, dmg: 6, ranged: true, tactic: 'Feuerbälle mit Schild blocken, zwischen den Salven angreifen.' },
  wither_skeleton: { danger: 4, hp: 20, dmg: 8, tactic: 'Macht Wither: Abstand, unter 2 Block hoher Decke kommt es nicht durch.', counter: ['low_ceiling'] },
  piglin: { danger: 2, hp: 16, dmg: 5, neutral: true, tactic: 'Ein Teil Goldrüstung tragen, dann bleiben sie friedlich. Keine Truhen in ihrer Nähe öffnen.', counter: ['gold_armor'] },
  piglin_brute: { danger: 5, hp: 50, dmg: 13, tactic: 'Ignoriert Gold. Abstand halten, hochbauen.', counter: ['pillar', 'kite'] },
  zombified_piglin: { danger: 2, hp: 20, dmg: 5, neutral: true, tactic: 'Niemals zuerst schlagen: alle in der Nähe werden wütend.' },
  hoglin: { danger: 4, hp: 40, dmg: 6, tactic: 'Wirft hoch: nicht an Kanten kämpfen. Meidet Wirrpilze.' },
  ghast: { danger: 3, hp: 10, dmg: 6, ranged: true, tactic: 'Feuerball zurückschlagen oder hinter Blöcke gehen.' },
  iron_golem: { danger: 4, hp: 100, dmg: 21, neutral: true, tactic: 'Nie am Boden kämpfen: 3 Blöcke hochbauen und von oben schlagen, dort erreicht er einen nicht.', counter: ['pillar'] },
  warden: { danger: 5, hp: 500, dmg: 30, tactic: 'Nicht kämpfen. Schleichen, keine Geräusche, weg aus dem Bereich. Sein Schallangriff geht durch Wände und Schilde.', counter: ['sneak', 'flee'] },
  wither: { danger: 5, hp: 300, dmg: 8, tactic: 'Nur mit voller Ausrüstung unter der Erde bekämpfen.' }
}
const DEFAULT_THREAT = { danger: 2, hp: 20, dmg: 4, tactic: 'Abstand prüfen, im Rhythmus zuschlagen, bei wenig Leben zurückziehen.' }

// ---------------------------------------------------------------- Wege & Umgebung
const PATHING = {
  neverDigStraightDown: 'Nie gerade nach unten graben (Lava, Höhlenfall): immer als Treppe.',
  sprintJumpGap: 4, // mit Sprint-Sprung schafft man 4 Blöcke Lücke, ohne Sprint 3 (jeweils auf gleicher Höhe)
  walkJumpGap: 3,
  torchSpacing: 8, // Lichtlevel hält Monster fern; alle 8 Blöcke eine Fackel
  lava: 'Vor Lava einen Block setzen; beim Abbau in der Tiefe immer Wassereimer in der Hotbar.',
  bedSetsSpawn: 'Schlafen setzt den Spawnpunkt und überspringt die Nacht.',
  lootDespawnMs: 300000
}

// ---------------------------------------------------------------- Auswege, wenn etwas wiederholt scheitert
// Jede Strategie hat einen Namen, den der Bot ausführen kann (siehe mc-ai-bot.js -> _applyStrategy).
const STRATEGIES = {
  relocate: { label: 'woanders versuchen', say: 'Hier wird das nichts. Ich geh ein Stück weiter und probier es an einer anderen Stelle.' },
  surface_first: { label: 'erst an die Oberfläche', say: 'Ich geh erst mal hoch an die Oberfläche und fang von dort sauber neu an.' },
  staircase_up: { label: 'Treppe nach oben graben', say: 'Der Weg nach oben ist dicht. Dann grab ich mir eben eine eigene Treppe.' },
  pillar_up: { label: 'hochbauen', say: 'Dann bau ich mich eben nach oben raus.' },
  better_tools: { label: 'erst besseres Werkzeug', say: 'Mit dem Werkzeug wird das nichts. Erst aufrüsten, dann noch mal.' },
  more_food: { label: 'erst Essen besorgen', say: 'Ich brauch erst was zu essen, sonst geh ich dabei drauf.' },
  wait_for_day: { label: 'auf den Tag warten', say: 'Nachts ist mir das zu heiß. Ich warte im Bunker, bis es hell wird.' },
  more_wood: { label: 'erst Holz holen', say: 'Mir fehlt Material. Erst Holz, dann geht es weiter.' },
  skip_for_now: { label: 'später noch mal', say: 'Das stell ich zurück und mach erst was anderes. Ich komm darauf zurück.' }
}
// Welche Auswege passen zu welcher Aufgabe (Reihenfolge = erster Versuch zuerst)
const REMEDIES = {
  mine: ['relocate', 'surface_first', 'better_tools', 'more_food', 'skip_for_now'],
  wood: ['relocate', 'skip_for_now'],
  hunt: ['relocate', 'wait_for_day', 'skip_for_now'],
  craft: ['more_wood', 'better_tools', 'skip_for_now'],
  smelt: ['more_wood', 'relocate', 'skip_for_now'],
  build: ['relocate', 'more_wood', 'wait_for_day', 'skip_for_now'],
  explore: ['relocate', 'wait_for_day', 'skip_for_now'],
  exit_cave: ['staircase_up', 'pillar_up', 'skip_for_now'],
  nether: ['more_food', 'better_tools', 'skip_for_now'],
  enchant: ['relocate', 'skip_for_now'],
  portal: ['relocate', 'better_tools', 'skip_for_now'],
  default: ['relocate', 'better_tools', 'skip_for_now']
}

function threatInfo (mob) { return { name: mob, ...(Object.hasOwn(THREATS, mob) ? THREATS[mob] : DEFAULT_THREAT) } }
function cooldownFor (itemName) {
  const n = String(itemName || '')
  if (n.endsWith('_sword')) return COMBAT.cooldownMs.sword
  if (n.endsWith('_axe')) return COMBAT.cooldownMs[n] || 1000
  if (n.endsWith('_pickaxe')) return COMBAT.cooldownMs.pickaxe
  if (n.endsWith('_shovel')) return COMBAT.cooldownMs.shovel
  if (n === 'trident') return COMBAT.cooldownMs.trident
  if (n === 'mace') return COMBAT.cooldownMs.mace
  return COMBAT.cooldownMs.hand
}
/** Auswege für eine Tätigkeit (activity des GOAP-Schritts). */
function remediesFor (activity) { return (Object.hasOwn(REMEDIES, activity) ? REMEDIES[activity] : REMEDIES.default).slice() }
/** Fallschaden in halben Herzen ohne Rüstung/Federfall. */
function fallDamage (blocks) { return Math.max(0, Math.ceil(blocks - COMBAT.safeFall)) }
/** Bricht die Creeper-Zündung ab? (weiter als 3 Blöcke weg, bevor die 1,5 s um sind) */
function creeperSafe (distance) { return distance > THREATS.creeper.blast }

module.exports = { COMBAT, THREATS, PATHING, STRATEGIES, REMEDIES, threatInfo, cooldownFor, remediesFor, fallDamage, creeperSafe }
