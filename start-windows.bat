@echo off
REM Double-click this to run the draft board on Windows.
REM If Node.js isn't installed it falls back to the standalone HTML file, which
REM needs nothing at all -- so this should always get you a working board.
setlocal
cd /d "%~dp0"

if "%PORT%"=="" set PORT=8787

where node >nul 2>nul
if errorlevel 1 goto nonode

echo.
echo   Starting the draft board...
echo   Your browser will open at http://localhost:%PORT%
echo.
echo   Keep this window open during the draft. Close it to stop.
echo.

REM Give the server a moment to bind before the browser opens.
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:%PORT%"
node server.js
goto end

:nonode
echo.
echo   Node.js isn't installed on this computer.
echo.
if exist "DraftBoard-offline.html" (
  echo   That's fine - opening the standalone version instead.
  echo   It does everything except copy picks to a Google Sheet.
  echo.
  start "" "DraftBoard-offline.html"
) else (
  echo   Open DraftBoard-offline.html in your browser, or install Node.js
  echo   from https://nodejs.org if you want the Google Sheet backup.
)
echo.
pause

:end
endlocal
