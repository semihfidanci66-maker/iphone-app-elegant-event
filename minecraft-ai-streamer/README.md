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

## Aufbau

```
server.js                    Express + WebSocket, verdrahtet alle Module
modules/mc-ai-bot.js         Bot-Hirn: Reflexe, Hauptschleife, öffentliche API
modules/bot/human-look.js    Maus-Kinematik (Beschleunigung, Überschwingen, Umschau-Blicke)
modules/bot/actions.js       Action-State-Lock: Abbauen/Platzieren/Laufen (canDig nur in Mining-Routinen)
modules/bot/hotbar.js        Muscle-Memory-Hotbar 1–9 + Off-Hand
modules/bot/watchdog.js      2-s-Stuck-Watchdog + Pillar-Jump
modules/bot/combat.js        625-ms-Rhythmus, Strafe, W-Tap, Jump-Crits, Schild, Kiting, Essen
modules/bot/planner.js       GOAP: Fakten, Aktionen, Rückwärtsverkettung, Zuschauerziele
modules/bot/survival-*.js    Phase 1 Holz · 2 Mining · 3 Jagd/Ofen · 4 Hausbau · 5 Verzaubern/Nether
modules/ai-streamer-brain.js Persona, Zuschauergedächtnis, Chat-Absichten, Cooldowns, Monologe
modules/tts-engine.js        eine männliche Neural-Stimme (Conrad/Killian), Prosodie je Stimmung
modules/gift-engine.js       Gift-Regeln -> native /summon-Befehle (Helm, Namensschild, Bossbar)
modules/tiktok-bridge.js     TikTok-Live-Events, Combo-Streaks
modules/tunnel.js            cloudflared / localtunnel + QR
public/                      studio-overlay.html · index.html · mobile.html
```

## Tests

```
npm test                                  # 16 Logiktests ohne Server (Planer, Gifts, Persona, Stimme)
node test/live-scenarios.js <port>        # Live-Szenarien gegen einen Server (Bot braucht OP, Flachwelt)
```

## Hinweise

- **Stimme:** ausschließlich `de-DE-ConradNeural` (oder Killian/Florian) über edge-tts. Es gibt keinen Browser-Fallback; fällt der Dienst aus, zeigt das Overlay nur Untertitel. Zweiter Weg zur selben Stimme: `pip install edge-tts`.
- **OP-Rechte:** Gift-Mobs brauchen `/op KI_Streamer` (das Einrichtungs-Skript erledigt das).
- **Eigener Skin:** `public/skin.png` (64×64) ablegen, sonst wird der eingebaute Streamer-Skin benutzt.
- **Sicherheit:** Der lokale Server läuft im Offline-Modus mit Whitelist – Port 25565 nicht ins Internet freigeben. Die Handy-URL enthält einen geheimen Schlüssel; ohne ihn nimmt der Server von außen keine Befehle an.
