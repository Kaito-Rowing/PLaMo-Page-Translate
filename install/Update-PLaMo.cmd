@echo off
setlocal
set "PLAMO_UPDATER=%~dp0Update-PLaMo.ps1"
cd /d "%TEMP%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PLAMO_UPDATER%"
if errorlevel 1 (
  echo Update failed. See the message above.
  pause
  exit /b 1
)
pause
