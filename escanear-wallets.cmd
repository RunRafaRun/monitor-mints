@echo off
REM Doble clic para escanear tus wallets (data/wallets.json) y volcar las llaves al dashboard.
cd /d "%~dp0scripts"
node scan-wallets.mjs --write %*
echo.
pause
