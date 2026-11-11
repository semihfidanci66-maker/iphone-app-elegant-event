@echo off
chcp 65001 >nul
title KI-Streamer
cd /d "%~dp0"
echo.
echo  === Minecraft-KI-Streamer: 1-Klick-Start ===
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js fehlt. Installiere es mit:  winget install OpenJS.NodeJS.LTS
  echo  Danach dieses Fenster schliessen und START.bat erneut starten.
  pause
  exit /b 1
)
where git >nul 2>nul
if not errorlevel 1 (
  echo  Hole den neuesten Stand ...
  git pull --ff-only
)
echo  Pruefe Abhaengigkeiten ...
call npm install --no-audit --no-fund
if errorlevel 1 ( echo  npm install ist fehlgeschlagen. & pause & exit /b 1 )
echo.
echo  Starte Server. Das Dashboard oeffnet sich im Browser.
set OPEN_BROWSER=1
node server.js
pause
