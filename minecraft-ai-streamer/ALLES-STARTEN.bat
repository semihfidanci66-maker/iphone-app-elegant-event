@echo off
chcp 65001 >nul
title KI-Streamer - Alles starten
cd /d "%~dp0"
echo.
echo  ===========================================
echo   KI-Streamer: Einrichten und Starten
echo  ===========================================
echo.

rem --- 1. Programme (nur wenn sie fehlen) ---
where winget >nul 2>nul
if errorlevel 1 ( echo  winget fehlt. Bitte "App Installer" im Microsoft Store aktualisieren. & pause & exit /b 1 )
where node >nul 2>nul
if errorlevel 1 (
  echo  Installiere Node.js ...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  echo.
  echo  Node.js ist installiert. Dieses Fenster schliessen und ALLES-STARTEN.bat noch einmal starten.
  pause & exit /b 0
)
where java >nul 2>nul
if errorlevel 1 (
  echo  Installiere Java 21 ...
  winget install -e --id EclipseAdoptium.Temurin.21.JRE --accept-source-agreements --accept-package-agreements
  echo.
  echo  Java ist installiert. Dieses Fenster schliessen und ALLES-STARTEN.bat noch einmal starten.
  pause & exit /b 0
)

rem --- 2. Abhaengigkeiten ---
if not exist node_modules (
  echo  Installiere Abhaengigkeiten ...
  call npm install --no-audit --no-fund
  if errorlevel 1 ( echo  npm install ist fehlgeschlagen. & pause & exit /b 1 )
)

rem --- 3. Minecraft-Server (einmalig, fragt EULA und deinen Namen) ---
if not exist mc-server\server.jar (
  echo  Richte den Minecraft-Server ein ...
  node scripts\setup-mc-server.js
  if not exist mc-server\server.jar ( echo  Server-Einrichtung abgebrochen. & pause & exit /b 1 )
)

rem --- 4. Server und KI starten ---
echo  Starte Minecraft-Server in eigenem Fenster ...
start "Minecraft-Server 1.21.1" /D "%~dp0mc-server" java -Xms2G -Xmx4G -jar server.jar nogui
echo  Warte, bis der Server bereit ist (ca. 40 Sekunden) ...
timeout /t 40 /nobreak >nul

echo.
echo  Starte KI-Streamer. Das Dashboard oeffnet sich im Browser.
echo  Danach in Minecraft (CurseForge, Version 1.21.1) Server "localhost" hinzufuegen.
echo  OBS-Browserquelle: http://localhost:3000/studio-overlay.html  (1080 x 1920, hochkant)
echo.
set OPEN_BROWSER=1
node server.js
pause
