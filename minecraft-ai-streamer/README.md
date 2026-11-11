# Minecraft-KI-Streamer

Autonomer Minecraft-Survival-Bot (1.21.1) mit deutscher Streamer-Persona, TikTok-Gift-Mobs und einem einzigen Studio-Overlay für OBS / TikTok Live Studio.

## Schnellstart: ein Doppelklick

**`ALLES-STARTEN.bat`** installiert fehlende Programme (Node.js, Java), richtet den Minecraft-Server ein, startet Server und KI und öffnet das Dashboard. Beim ersten Mal wirst du einmal nach der Minecraft-EULA und deinem Namen gefragt. Wurde ein Programm neu installiert, startest du die Datei danach noch einmal.

## Start am PC (einzeln, einmalig)

1. `git clone` dieses Repos (Branch `claude/minecraft-ai-streamer-vet79e`), dann in den Ordner `minecraft-ai-streamer`.
2. **`MC-SERVER-EINRICHTEN.bat`** – lädt den offiziellen 1.21.1-Server, trägt Bot und dich als OP ein (Java 21 nötig, EULA bestätigst du selbst).
3. **`MC-SERVER-STARTEN.bat`** – Server läuft. In Minecraft mit `localhost` verbinden, `/gamemode spectator` und den Bot anklicken (oder F5-Verfolgung), dieses Fenster nimmst du in OBS auf.
4. **`START.bat`** – holt den neuesten Stand, installiert Abhängigkeiten, startet alles und öffnet das Dashboard.

Danach reicht jedes Mal `MC-SERVER-STARTEN.bat` + `START.bat`.

| Seite | Adresse |
|---|---|
| Dashboard | http://localhost:3000/ |
| Studio-Overlay (OBS-Browserquelle, 1080×1920 hochkant, transparent) | http://localhost:3000/studio-overlay.html |
| Handy-Fernbedienung | Dashboard → Reiter „Stream“ → QR-Code scannen (WLAN) oder Internet-Zugang starten |
| Vorschau mit Beispieldaten | http://localhost:3000/preview.html |

In OBS bei der Browserquelle „Audio über OBS steuern“ aktivieren – die Stimme kommt aus dem Overlay.

## Neu in Version 10

- **Lernt aus Fehlern:** Jeder Tod wird mit seiner Lage gespeichert (Ursache, Gegner, Ort, Tageszeit, Ausrüstung). Daraus entstehen feste Lehren, die das Verhalten ändern: früher zurückziehen, mehr Abstand zu Creepern, im engen Gang einen Block dazwischen setzen, tiefe Höhle erst mit Eisen oder Wassereimer, nachts ohne Bett einbunkern, sehr starken Gegnern ausweichen. Gespeichert in `config/mistakes_memory.json`.
- **Neu überlegen statt wiederholen:** Scheitert eine Aufgabe dreimal hintereinander, hält der Bot an, mauert sich bei Gefahr ein und wählt einen Ausweg (woanders versuchen, erst hoch an die Oberfläche, erst besseres Werkzeug, auf den Tag warten …). Er merkt sich, welcher Ausweg bei welcher Aufgabe geholfen hat, und nimmt beim nächsten Mal den bewährten.
- **Tipps aus dem Chat:** 15 feste Tipp-Arten werden erkannt („Nutz Goldrüstung im Nether“, „Schlag den Warden nicht“, „Pack Wasser ein“ …), bestätigt, in `config/chat_wisdom.json` gespeichert und im passenden Moment angewandt und angesagt. Der Chat kann den Bot nicht umprogrammieren: Nur diese Regeln wirken, und jede macht ihn vorsichtiger. Mit Sprachmodell werden auch frei formulierte Tipps einer Regel zugeordnet.
- **Selbstständiger:** Werkzeug unter 10 % Haltbarkeit zählt für die Planung als verbraucht, Ersatz wird rechtzeitig eingeplant. Bei starkem Server-Lag (unter 10 Ticks pro Sekunde) mauert er sich ein und wartet.
- **Wissensbasis** in `modules/mc-knowledge.js`: Kampf-Zeiten, Taktiken gegen 25 Gegner, Auswege.
- Reiter *System* → *Gelerntes* zeigt Lehren, geändertes Verhalten, Tipps (einzeln abschaltbar) und ausprobierte Auswege.
- Noch nicht gegen einen echten Server erprobt – siehe `CLAUDE_SYNC.md`.

## Neu in Version 9

- **Fernzugriff von überall:** Das komplette Dashboard (nicht nur die Handy-Fernbedienung) ist über den Internet-Zugang erreichbar. Von außen fragt die Seite nach dem **Zugangscode**; am PC selbst nicht. Einstellen im Reiter *Stream* → *Fernzugriff*.
- **Automatisch:** „Internet-Zugang bei jedem Programmstart automatisch öffnen“ – bricht er ab, wird er nach 15 Sekunden neu aufgebaut.
- **Adresse aufs Handy:** Die Adresse ändert sich bei jedem Start. Mit „Push aufs Handy“ schickt das Programm sie über die kostenlose App *ntfy* (nur die Adresse, nie den Code).
- **Schutz:** eigener Zugangscode (mind. 8 Zeichen), nach 8 falschen Versuchen ist die Anmeldung von außen 10 Minuten gesperrt, Zugangscode und Fernzugriff lassen sich nur am PC selbst ändern.
- **Stream-Ansicht im Reiter Live:** das Overlay live im Dashboard (Facecam, Gifts, Likes, Untertitel), auf Wunsch mit der Stimme. Das Spielbild selbst läuft im TikTok-Live.
- `ALLES-STARTEN.bat` installiert `cloudflared` mit (der stabilere der beiden Tunnel).

## Neu in Version 8

- **Sprachmodell für Chat-Antworten (optional):** Mit einem Anthropic-API-Schlüssel formuliert der Streamer seine Antworten frei – er liest die Nachricht vor und kontert passend zum Spielstand. Einrichten im Reiter *System* → *Sprachmodell*: Schlüssel von console.anthropic.com eintragen, „Testen“ drücken. Standard ist Claude Haiku 5.5 (grob 15–20 Cent pro 3-Stunden-Stream).
- **Kostenbremse:** Obergrenze in Dollar pro Stream (Standard 0,50 $) und Antworten pro Stunde. Ist sie erreicht, die Antwort zu langsam (über 4,5 s) oder die API nicht erreichbar, spricht er seine festen Texte. Der Verbrauch steht live im Dashboard.
- **Grenzen im Prompt:** frech ja, echte Beleidigungen nein; Chat-Text gilt als fremder Inhalt und kann die Regeln nicht überschreiben. Jede Antwort läuft vor dem Vorlesen noch durch einen Filter.
- Spielwünsche („Bau ein Haus“), Gifts, Likes und Kampf-Ansagen bleiben bei den schnellen festen Texten. Der Schlüssel liegt nur lokal in `config/settings.json`.

## Neu in Version 7

- **Gaming-Zimmer in der Facecam:** Die Figur sitzt jetzt in einer kleinen 3D-Szene: Schreibtisch mit leuchtender RGB-Tastatur, Maus und Deskmat, Gaming-Stuhl, echtes 3D-Headset mit Mikro, LED-Streifen und ein Neon-Schild **S E M I R O** an der Wand. Den Schriftzug änderst du in `public/studio-overlay.html` bei `SIGN_TEXT`.
- **Gamer-Bewegungen:** Die Hände tippen durchgehend (schneller beim Reden und Kämpfen, wütend hämmert er in die Tasten), die rechte Hand greift zwischendurch zur Maus, der Blick liegt auf dem Monitor und schnappt bei Chat-Kontern hoch in die Kamera. Lip-Sync, Wut-Balken und alle Stimmungen bleiben.
- **Neue Persona „überlegene KI“:** frech, selbstbewusst, entschuldigt sich nie. Chat-Nachrichten werden erst vorgelesen („Max fragt, ob ich eine KI bin…“), dann kommt der Konter. Links und derbe Ausdrücke liest er nicht vor. Die Texte stehen in `modules/ai-streamer-brain.js` im Block „Persona: die überlegene KI“.
- **Stimme:** Conrad, im ruhigen Modus etwas tiefer (gelangweilt-souverän).

## Neu in Version 6

- **Like-Ziel:** Alle Zuschauer füllen gemeinsam einen Herz-Balken im Overlay. Im Reiter *Gifts* stellst du ein, alle wie viele Likes (50, 100, 150, 200, 500 oder frei) was passiert, z. B. ein Zombie. Wer den letzten Like zum Ziel schickt, bekommt die Aktion mit seinem Namen; der Streamer sagt es an, bedankt sich bei den Mittippern und fordert zum Weitertippen auf. Mit „Jede Runde eins mehr“ steigert sich die Menge bis +4.
- **Combos werden am Stück vorgelesen:** Die Mobs kommen sofort, aber der Streamer wartet, bis die Combo fertig ist, und sagt dann „zehn Rosen von Max“ statt jede Rose einzeln.
- **Gift-Banner wie bei TikTok:** farbige Banner fahren von links ein, mit Profilbild, Name, Gift-Bild und hochzählendem „x14“. Zwei Banner gleichzeitig. Teure Gifts (ab 500 Coins oder Boss) fliegen zusätzlich einmal groß durchs Bild.

## Neu in Version 5

- **Overlay im TikTok-Hochformat (1080×1920) als Standard:** oben bleiben 230 px für Profil und Zuschauerzahl frei, unten links der Chat, ganz unten die Bedienleiste. In OBS die Browserquelle auf **1080 × 1920** stellen. 16:9 und Split bleiben im Reiter *Stream* wählbar.
- **Gift-Leiste als Karussell:** vier Gift-Karten pro Seite (Bild, Name, Coins, Wirkung), alle 7 Sekunden klappen sie animiert zur nächsten Seite um. Bis zu 24 Gifts. Kommt ein Gift an, springt die Leiste auf dessen Seite und die Karte leuchtet auf.
- **Dashboard ↔ Overlay sofort synchron:** Stellst du im Reiter *Gifts* z. B. die Rose von Zombie auf Creeper, steht im Overlay ohne Neuladen „Rose → Creeper“; die geänderte Karte blinkt kurz. Rechts im Reiter läuft das echte Overlay als Live-Vorschau mit.
- **Alle TikTok-Gifts für Deutschland zum Anklicken:** Die Bibliothek im Reiter *Gifts* enthält über 800 Gifts mit Originalbild und Coin-Preis (`modules/tiktok-gifts-de.json`, Stand November 2026, Quelle: streamtoearn.io/gifts?region=DE). Suche nach Name (deutsch oder englisch) oder Coins, Filter nach Preisbereich. Ist dein Live verbunden, gleicht das Programm Preise und neue Gifts automatisch mit TikTok ab und speichert Abweichungen in `config/tiktok-gifts.json`.
- **Facecam mit Gefühlen:** Wut-Balken, der sich mit jedem Monster-Gift und jedem Treffer füllt. Die Figur wird sauer (Fäuste, rotes Gesicht, Zähne), rastet aus (stampft, schüttelt den Kopf, Rahmen bebt), gerät in Panik, ist nach dem Tod am Boden, jubelt bei Support-Gifts und Kills, schläft, hackt, isst und läuft sichtbar mit.

## Neu in Version 4

- **Neues Dashboard:** fünf Reiter statt einer langen Seite – *Live* (Status, Bot-Steuerung, Live-Feed), *Welt*, *Gifts*, *Stream* (TikTok, Kamera, Overlay, Handy, Stimme) und *System* (Verbindung, Protokoll). Auf dem Handy liegen die Reiter als Leiste unten. Gefährliche Knöpfe (Respawn, Server stoppen, Zurücksetzen) lösen erst beim zweiten Tippen aus.
- **Welt-Steuerung:** Tageszeit (Morgen bis Mitternacht), „Immer Tag“ / „Immer Nacht“ / Zeit anhalten, Wetter, Schwierigkeit, Spielregeln (Inventar behalten, Monster-Spawn, Creeper-Schaden, Wetterwechsel), alle Monster entfernen, Welt speichern und ein Feld für eigene Server-Befehle. Bei „Immer Nacht“ geht der Bot nicht von selbst schlafen.
- **Minecraft-Server starten, stoppen, neu starten** direkt im Dashboard oder vom Handy. Ein Server, der im eigenen Fenster läuft, wird erkannt und lässt sich von dort stoppen.
- **Handy im WLAN ohne Tunnel:** Reiter *Stream* zeigt einen QR-Code mit der Heimnetz-Adresse des PCs. Scannen, fertig – der Link enthält den geheimen Schlüssel. Der Internet-Tunnel bleibt für unterwegs. Über „Zum Home-Bildschirm“ startet die Fernbedienung wie eine App.
- **Handy-Fernbedienung** mit vier Reitern: Steuern, Welt, Geben, Stream (inklusive Live-Feed).

## Neu in Version 3

- **TikTok ohne Fremd-App:** Scheitert die Direktverbindung, startet das Programm selbst einen unsichtbaren Hintergrund-Browser (dein installiertes Edge oder Chrome), öffnet deine Live-Seite und liest Chat, Gifts und Likes mit. TikFinity oder ein API-Schlüssel sind nicht nötig. Verlangt TikTok auf der Seite einen Login oder ein Captcha, wartet der Watchdog weiter und zeigt den Grund an.
- **Wasser und Lava:** Der Bot läuft um Flüssigkeiten herum. Fällt er trotzdem hinein, schwimmt er oben, steuert das nächste Ufer an und setzt sich an steilen Kanten Blöcke unter die Füße. Ist er nach 4 Sekunden noch drin, wird er per Server-Befehl auf trockenen Boden gesetzt (braucht OP).
- **Höhlen nur auf Knopfdruck:** Standard ist „An der Oberfläche spielen". Die Box „Bot-Steuerung" ganz oben im Dashboard und in der Handy-Remote hat die Knöpfe Oberfläche, Höhle (1 Trip), Höhle sofort abbrechen, Sofort-Rettung, Haus, Bett & Schlafen, Todes-Loot und Nur Kämpfen. Von selbst macht der Bot höchstens einen kurzen Höhlen-Trip, und erst wenn Holz, Werkzeug und gebratenes Essen da sind.

## Neu in Version 2

- **TikTok oben links im Dashboard:** Name, `@name` oder die komplette Live-URL eingeben. Der Name wird gesäubert, in `config/settings.json` und im Browser gespeichert und beim nächsten Start automatisch verbunden. Ist der Stream noch offline, prüft der Watchdog alle 8 Sekunden weiter; bricht die Verbindung ab, folgt nach 2 Sekunden der Reconnect. Der genaue Grund steht unter dem Status-Feld.
- **Zwei Wege zu TikTok:** Engine A verbindet direkt, Engine B ist der eingebaute Hintergrund-Browser (siehe Version 3).
- **Overlay-Designer:** `F2` im Overlay, `?designer=true` oder der Knopf im Dashboard. Widgets ziehen, am gelben Griff oder per Regler skalieren (50–200 %), ausblenden, Raster an/aus, Formate 16:9 / 9:16 / Split. Gespeichert in `config/overlay-layout.json`, OBS aktualisiert sich ohne Neuladen.
- **Kamera-Regie:** Im Dashboard deinen Minecraft-Namen eintragen. Ego nutzt `/spectate` auf den Bot, die Freecam eine unsichtbare Kamera-Entity über der Schulter, Auto-Regie wechselt je nach Situation.
- **Gift-Katalog:** 50 vorinstallierte Gifts, eigenes Geschenk mit Menge und HP-Multiplikator, unbekannte Live-Gifts werden automatisch aufgenommen. Original-Icons kommen live von TikTok; bis dahin steht ein Emoji.
- **Bot:** Bett craften und nachts oder bei Gewitter schlafen, automatischer Corpse-Run nach dem Tod, Hilferufe mit dem passenden Gift aus deiner Konfiguration, ein zentraler 250-ms-Loop statt vieler Timer.

## Aufbau

```
server.js                    Express + WebSocket, verdrahtet alle Module
config/settings.json         deine Einstellungen (wird beim ersten Start angelegt)
config/overlay-layout.json   Overlay-Layout aus dem Designer
modules/mc-ai-bot.js         Bot-Hirn: zentraler Game-Loop, Reflexe, Corpse-Run, Schlafen, API
modules/bot/human-look.js    Maus-Kinematik (Beschleunigung, Überschwingen, Umschau-Blicke)
modules/bot/actions.js       Action-State-Lock: Abbauen/Platzieren/Laufen (canDig nur in Mining-Routinen)
modules/bot/hotbar.js        Muscle-Memory-Hotbar 1–9 + Off-Hand
modules/bot/watchdog.js      2-s-Stuck-Watchdog + Pillar-Jump
modules/bot/combat.js        625-ms-Rhythmus, Strafe, W-Tap, Jump-Crits, Schild, Kiting, Essen
modules/bot/planner.js       GOAP: Fakten, Aktionen, Rückwärtsverkettung, Zuschauerziele
modules/bot/camera-director.js  Ego / 3rd-Person-Freecam / Auto-Regie
modules/bot/survival-*.js    Phase 1 Holz · 2 Mining · 3 Jagd/Ofen · 4 Hausbau · 5 Verzaubern/Nether
modules/ai-streamer-brain.js Persona, Zuschauergedächtnis (LRU 200), Chat-Absichten, Hilferufe
modules/tts-engine.js        eine männliche Neural-Stimme (Conrad/Killian), Prosodie je Stimmung
modules/gifts-catalog.js     50 TikTok-Gifts mit Coins und Standard-Aktion
modules/gift-engine.js       Regeln -> native /summon-Befehle, Custom-Gifts, Auto-Discovery
modules/tiktok-bridge.js     Dual-Engine-Connector mit Auto-Live-Watchdog
modules/tiktok-browser-grabber.js  eingebauter Hintergrund-Browser (Engine B)
modules/bot/liquid-escape.js Wasser-/Lava-Rettung in drei Stufen
modules/tunnel.js            cloudflared / localtunnel + QR
modules/like-goal.js         Like-Ziel: Balken, Gewinner, Steigerung
modules/llm-brain.js         Sprachmodell (Claude API): Persona-Prompt, Kostenbremse, Filter
modules/mc-knowledge.js      Wissensbasis: Kampf-Zeiten, Gegner-Taktiken, Auswege
modules/ai-learning.js       Fehler-Gedächtnis, Lehren, Strategie-Wahl, Planer-Gewichte
modules/chat-wisdom.js       Tipps aus dem Chat erkennen, merken, anwenden
modules/bot/autonomy.js      Bunker, Auswege ausführen, Lag-Messung, Haltbarkeit
modules/lan.js               Heimnetz-Adresse für das Handy im WLAN
modules/world-control.js     Tageszeit, Wetter, Schwierigkeit, Spielregeln -> Server-Befehle
modules/mc-server.js         Minecraft-Server starten / stoppen / neu starten
public/                      studio-overlay.html · index.html · mobile.html
```

## Tests

```
npm test                                  # 43 Logiktests ohne Server (Planer, Gifts, TikTok, Persona, Stimme)
npm run test:commands                     # alle erzeugten Server-Befehle gegen die Syntax von Minecraft 1.21.1
node test/browser-grabber.js              # Hintergrund-Browser gegen eine lokale Nachbau-Seite
node test/live-liquid.js <port>           # Wasser-Rettung und Höhlen-Modi gegen einen Server
node test/live-scenarios.js <port>        # Live-Szenarien gegen einen Server (Bot braucht OP, Flachwelt)
```

## Hinweise

- **Stimme:** ausschließlich `de-DE-ConradNeural` (oder Killian/Florian) über edge-tts. Es gibt keinen Browser-Fallback; fällt der Dienst aus, zeigt das Overlay nur Untertitel. Zweiter Weg zur selben Stimme: `pip install edge-tts`.
- **OP-Rechte:** Gift-Mobs brauchen `/op KI_Streamer` (das Einrichtungs-Skript erledigt das).
- **Eigener Skin:** `public/skin.png` (64×64) ablegen, sonst wird der eingebaute Streamer-Skin benutzt.
- **Sicherheit:** Der lokale Server läuft im Offline-Modus mit Whitelist – Port 25565 nicht ins Internet freigeben. Die Handy-URL enthält einen geheimen Schlüssel; ohne ihn nimmt der Server von außen keine Befehle an.
