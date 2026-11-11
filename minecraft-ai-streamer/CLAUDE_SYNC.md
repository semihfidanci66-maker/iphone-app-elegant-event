# CLAUDE_SYNC – Arbeitsstand

Branch: `claude/affectionate-cray-d9cvu6` · Ordner: `minecraft-ai-streamer/` · Tests: `npm test` (43 Logiktests)

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
