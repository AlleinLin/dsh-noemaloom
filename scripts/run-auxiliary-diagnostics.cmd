@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0collect-auxiliary-diagnostics.ps1"
echo.
pause
