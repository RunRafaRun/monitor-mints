@echo off
REM Dashboard interactivo: los checkboxes de "Tengo" se guardan en el fichero.
REM Deja esta ventana abierta mientras lo uses. Ctrl+C para parar.
cd /d "%~dp0scripts"
node serve.mjs
pause
