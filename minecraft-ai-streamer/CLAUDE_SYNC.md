# CLAUDE_SYNC – Arbeitsstand

> **Aktueller Stand liegt jetzt auf `claude/minecraft-ai-streamer-vet79e`** (enthält alles von `claude/affectionate-cray-d9cvu6` bis `403bbad` plus die Korrekturen unten). Bitte dort weitermachen bzw. diesen Branch vorher einmischen.

Branch: `claude/affectionate-cray-d9cvu6` · Ordner: `minecraft-ai-streamer/` · Tests: `npm test` (53 Logiktests)

## Auftrag (11.11.2026)

Der Bot soll selbstständig besser werden: Wissensbasis, Lernen aus Fehlern, Tipps aus dem Chat, mehr Selbstständigkeit.

## Fertig (V10)

- `modules/mc-knowledge.js` – Kampf-Zeiten, Gegner-Taktiken, Wege, Auswege (STRATEGIES / REMEDIES)
- `modules/ai-learning.js` – Fehler-Gedächtnis (`config/mistakes_memory.json`), Lehren -> Policy, Strategie-Wahl nach Erfolgsquote, Planer-Gewichte
- `modules/chat-wisdom.js` – 15 feste Tipp-Regeln, Speicher in `config/chat_wisdom.json`, Anwenden im passenden Moment
- `modules/bot/autonomy.js` – Todes-Lage, Bunker (1x1x2), Auswege ausführen, Lag-Messung (TPS), Werkzeug-Haltbarkeit, Block zwischen sich und Creeper
- Eingehängt in: `mc-ai-bot.js` (Tod, Hauptschleife, Lag-Pause, Nacht-Bunker, drei Fehlschläge -> neu überlegen), `bot/combat.js` (Rückzugs-Schwelle, Creeper-Abstand, Ausweichen, Hochbauen), `bot/planner.js` (Kosten, Vorbedingungen, Reihenfolge, Vorrat), `bot/gear.js` + `bot/actions.js` (verbrauchtes Werkzeug zählt nicht, Schild zuerst, Sprungtiefe), `bot/survival-food.js` (früher essen), `bot/survival-mining.js` (Fackelvorrat)
- `server.js` – Persistenz, Chat -> Tipp -> Ansage, Tipp-Erinnerung bei Spielmomenten, Zustand fürs Dashboard
- `ai-streamer-brain.js` – Ansagen für Tipps, Lehren, neue Strategie, Werkzeug, Lag, Bunker
- `llm-brain.js` – `classifyTip`: unbekannte Tipps einer festen Regel zuordnen
- Dashboard Reiter System -> Karte „Gelerntes“

## Befehls-Prüfung (neu)

- `test/commands.js` prüft alle 104 Befehlsformen (Gifts, Welt-Steuerung, Kamera, Rettung) gegen Syntax und Register von Minecraft 1.21.1. Daten in `test/fixtures/` aus github.com/sya-ri/minecraft-skills (MIT). Ergebnis: 0 Fehler. Prüft die Schreibweise, nicht die Ausführung.

## Nicht getestet

- **Gegen einen echten Minecraft-Server lief noch nichts von dem Bot-Verhalten** (Bunker bauen, Hochbauen im Kampf, Block gegen Creeper, Ausweichen, Lag-Pause). Getestet sind die Logik (Unit-Tests) und der Weg Chat -> Tipp -> Policy -> Dashboard im laufenden Programm ohne Spielwelt.
- Für einen Servertest muss die Minecraft-EULA bestätigt werden – das macht der Besitzer selbst (`MC-SERVER-EINRICHTEN.bat`).

## Bewusst nicht gebaut

- Feldbau (Weizen/Karotten): Essen kommt weiter aus Jagd und Ofen
- Wassereimer-Landung (MLG), Boote als Falle, Wasser gegen Endermen: stehen in der Wissensbasis, haben aber keine Ausführung
- „Lernen“ ist ein nachvollziehbares Erfahrungs-Gedächtnis mit festen Regeln, kein neuronales Netz

## Nächste sinnvolle Schritte

1. Echter Servertest zu Hause: Bot sterben lassen (Creeper, Sturz, Nacht) und in „Gelerntes“ prüfen, ob Lehre und Verhalten stimmen
2. Danach die Stellen nachziehen, die im echten Spiel haken (am ehesten Bunker-Platzierung und Hochbauen im Kampf)
3. Offen vom Nutzer: ElevenLabs-Stimme (Kostenfrage geklärt? Schlüssel nötig), 3D-Live-Ansicht der Spielwelt im Dashboard

## Korrekturen (11.11.2026, zweiter Account)

- `llm-brain.js` – Nachdenk-Einstellung je Modell (`thinkingParams`): Haiku 5.5 `disabled`, Sonnet 5.5 `between_tools`, Opus 5.5 Feld weglassen. Vorher bekamen Sonnet 5.5 und Opus 5.5 auf jede Anfrage einen 400-Fehler (beide lehnen `disabled` ab), der Streamer fiel immer auf Textbausteine zurück.
- `llm-brain.js` – `setConfig` übernimmt nur gesetzte Felder. Vorher schaltete z. B. ein Modellwechsel im Dashboard das Sprachmodell aus und setzte Budget/Limit auf die Standardwerte zurück.
- `server.js` – `LLM_SET`: API-Schlüssel, Modell, Budget und Anfragen-Limit nur am PC selbst (wie `REMOTE_SET`). Von außen nur ein/aus und Monologe.
- `test/unit.js` – zwei Tests dafür. Sperre von außen zusätzlich im laufenden Server geprüft.

## Rückmeldung aus dem ersten echten Stream (11.11.2026)

Gemeldet: sagt ständig „tot“, antwortet nur auf 1–2 Chat-Nachrichten, wiederholt sich, Lukas' Rosen mehrfach angesagt, geht immer wieder in dieselbe Höhle, „geh zurück an Land“ wirkt nicht, läuft Gift-Zombies quer durch die Höhle hinterher.

- **Ursache „tot“ + Höhlen-Schleife:** Loot-Lauf startete nach jeder Unterbrechung neu (`tried = false`) und sagte jedes Mal „Ich bin gestorben“ (cd 3 s, Prio 6). Jetzt: höchstens 2 Versuche, der zweite ohne Ansage; Tod + Aufbruch teilen einen Cooldown (30 s). Kein Loot-Lauf in eine Todesfalle (zweiter Tod < 24 Blöcke in 15 min), nicht in Lava, nicht unter Tage im Oberflächen-Modus (Chat „Hol deinen Loot“ darf Letzteres). `_corpseSkipReason` in `mc-ai-bot.js`.
- **Chat:** eigene Warteschlange `chatQueue` in `ai-streamer-brain.js` (vorher teilte Chat sich 4 Plätze mit Ereignissen, verfiel nach 10 s, einfache Nachrichten wurden absichtlich übersprungen). Jetzt verfällt nichts vor 3 min; ab 3 wartenden Nachrichten werden sie gebündelt vorgelesen. Sprachmodell wird gefragt, wenn die Nachricht dran ist.
- **Wiederholungen:** neues `modules/speech-memory.js` (gespeichert in `config/speech_memory.json`): jeder gesprochene Satz, exakt gleich 45 min gesperrt, ≥ 75 % gleiche Wörter 12 min. Ereignis-Ansagen ohne frische Formulierung entfallen. Zuschauer-Nachrichten werden pro Person gemerkt (Rückkehrer-Begrüßung, Spam-Erkennung, frühere Nachrichten gehen ans Sprachmodell).
- **Gifts:** pro Zuschauer höchstens eine Ansage alle 25 s, Rest wird gesammelt und einmal zusammengefasst (`_flushGiftMore`).
- **Chat-Befehle:** neu `surface` („geh zurück an Land“, „raus aus der Höhle“, „geh hoch“) – steht vor `mine`, weil „geh … Höhle“ vorher als Mine erkannt wurde. Neu `village` („geh ein Dorf suchen“) -> `_findVillage`: an der Oberfläche erkunden, Dorfbewohner/Glocke/Dorfblöcke suchen, bis ~600 Blöcke.
- **Oberflächen-Modus:** Reflex „> 10 s tief unter Tage (6 Blöcke unter gemerkter Oberfläche, wenig Himmelslicht) -> raus“; Wegfindung verteuert Wege tief unter Tage (`exclusionAreasStep`).
- **Gift-Mobs:** Spawnpunkt 2,5–4 Blöcke, gleiche Höhe ±1, nur mit freier Sichtlinie (`_canSee`). Kampf: Gift-Mobs nur noch in Sichtweite/16 Blöcken, wie alle anderen (vorher 40 Blöcke durch Wände).
- Tests: 8 neue in `test/unit.js`, `test/live-spawn.js` (live: 20/20 Spawnpunkte nah und sichtbar, 0 hinter einer Wand).
- **Offen:** Live-Test `live-liquid.js` schwankt auf dem Test-Server (flying-squid) schon vor diesen Änderungen; „Höhlen-Abbruch wurde angesagt“ schlug dort auch vorher fehl. Dorfsuche und Höhlen-Reflex sind nicht live getestet (Test-Server hat keine Dörfer und überall volles Himmelslicht).
