# Minecraft-KI-Streamer

Autonomer Minecraft-Survival-Bot (1.21.1) mit deutscher Streamer-Persona, TikTok-Gift-Mobs und einem einzigen Studio-Overlay für OBS / TikTok Live Studio.

## Start am PC (einmalig)

1. `git clone` dieses Repos (Branch `claude/minecraft-ai-streamer-vet79e`), dann in den Ordner `minecraft-ai-streamer`.
2. **`MC-SERVER-EINRICHTEN.bat`** – lädt den offiziellen 1.21.1-Server, trägt Bot und dich als OP ein (Java 21 nötig, EULA bestätigst du selbst).
3. **`MC-SERVER-STARTEN.bat`** – Server läuft. In Minecraft mit `localhost` verbinden, `/gamemode spectator` und den Bot anklicken (oder F5-Verfolgung), dieses Fenster nimmst du in OBS auf.
4. **`START.bat`** – holt den neuesten Stand, installiert Abhängigkeiten, startet alles und öffnet das Dashboard.

Danach reicht jedes Mal `MC-SERVER-STARTEN.bat` + `START.bat`.

| Seite | Adresse |
|---|---|
| Dashboard | http://localhost:3000/ |
| Studio-Overlay (OBS-Browserquelle, 1920×1080, transparent) | http://localhost:3000/studio-overlay.html |
| Handy-Fernbedienung | im Dashboard „Cloud-Tunnel starten“, QR-Code scannen |
| Vorschau mit Beispieldaten | http://localhost:3000/preview.html |

In OBS bei der Browserquelle „Audio über OBS steuern“ aktivieren – die Stimme kommt aus dem Overlay.

## Neu in Version 2

- **TikTok oben links im Dashboard:** Name, `@name` oder die komplette Live-URL eingeben. Der Name wird gesäubert, in `config/settings.json` und im Browser gespeichert und beim nächsten Start automatisch verbunden. Ist der Stream noch offline, prüft der Watchdog alle 8 Sekunden weiter; bricht die Verbindung ab, folgt nach 2 Sekunden der Reconnect. Der genaue Grund steht unter dem Status-Feld.
- **Zwei Wege zu TikTok:** Engine A verbindet direkt. Blockt TikTok die Signatur, übernimmt Engine B ein lokales Relay auf `ws://localhost:21213/` (z. B. TikFinity, muss dafür laufen). Ein kostenloser EulerStream-Schlüssel als Umgebungsvariable `EULERSTREAM_API_KEY` macht Engine A stabiler.
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
modules/tunnel.js            cloudflared / localtunnel + QR
public/                      studio-overlay.html · index.html · mobile.html
```

## Tests

```
npm test                                  # 25 Logiktests ohne Server (Planer, Gifts, TikTok, Persona, Stimme)
node test/live-scenarios.js <port>        # Live-Szenarien gegen einen Server (Bot braucht OP, Flachwelt)
```

## Hinweise

- **Stimme:** ausschließlich `de-DE-ConradNeural` (oder Killian/Florian) über edge-tts. Es gibt keinen Browser-Fallback; fällt der Dienst aus, zeigt das Overlay nur Untertitel. Zweiter Weg zur selben Stimme: `pip install edge-tts`.
- **OP-Rechte:** Gift-Mobs brauchen `/op KI_Streamer` (das Einrichtungs-Skript erledigt das).
- **Eigener Skin:** `public/skin.png` (64×64) ablegen, sonst wird der eingebaute Streamer-Skin benutzt.
- **Sicherheit:** Der lokale Server läuft im Offline-Modus mit Whitelist – Port 25565 nicht ins Internet freigeben. Die Handy-URL enthält einen geheimen Schlüssel; ohne ihn nimmt der Server von außen keine Befehle an.
