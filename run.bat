@echo off
chcp 65001 >nul
cd /d "%~dp0"
node tools\check_fresh.cjs
if errorlevel 2 goto build
echo Backend up-to-date - starting Electron directly (no build)...
call node_modules\.bin\electron.cmd .
goto end
:build
echo Backend source changed - building then starting...
call npm start
:end