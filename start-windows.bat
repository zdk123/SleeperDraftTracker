@echo off
REM Double-click this file to run the draft board locally.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo   Install it from https://nodejs.org ^(choose the LTS version^), then run this again.
  echo.
  pause
  exit /b 1
)

if "%PORT%"=="" set PORT=8787

start "" "http://localhost:%PORT%"
echo.
echo   Close this window to stop the draft board.
node server.js
pause
