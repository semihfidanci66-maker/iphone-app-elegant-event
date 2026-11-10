@echo off
chcp 65001 >nul
cd /d "%~dp0"
where java >nul 2>nul
if errorlevel 1 (
  echo Java 21 fehlt. Installiere es mit:  winget install EclipseAdoptium.Temurin.21.JRE
  pause
  exit /b 1
)
node scripts\setup-mc-server.js
pause
