@echo off
chcp 65001 >nul
title Minecraft-Server 1.21.1
cd /d "%~dp0mc-server"
if not exist server.jar ( echo Erst MC-SERVER-EINRICHTEN.bat ausfuehren. & pause & exit /b 1 )
java -Xms2G -Xmx4G -jar server.jar nogui
pause
