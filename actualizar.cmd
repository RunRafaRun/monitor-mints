@echo off
REM Doble clic para actualizar el Monitor MINTS y abrir el dashboard.
cd /d "%~dp0scripts"
node update.mjs --open %*
echo.
pause
