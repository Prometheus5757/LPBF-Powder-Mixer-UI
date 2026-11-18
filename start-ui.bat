@echo off
rem LPBF Powder Mixer - one-click launcher.
rem  1. Starts the local web server (minimised window) unless it is already running.
rem  2. Waits until it answers, then opens the UI as its own maximised app window (Chrome, else Edge).
rem The server only listens on this computer. Close the "LPBF Mixer server" window to stop it.
rem Web Serial (USB to the Mega) needs Chrome or Edge, which is why the app window uses them.
setlocal
title LPBF Powder Mixer
cd /d "%~dp0"
set "URL=http://localhost:8765/ui/"

curl -s -o nul --max-time 1 "%URL%" && goto open

where python >nul 2>nul || (
  echo Python was not found. Install it from python.org and tick "Add python.exe to PATH".
  pause
  exit /b 1
)
start "LPBF Mixer server - close this window to stop the UI" /min python tools\serve.py 8765
echo Starting the LPBF Mixer server...
for /l %%i in (1,1,20) do (
  curl -s -o nul --max-time 1 "%URL%" && goto open
  timeout /t 1 /nobreak >nul
)
echo The server did not start. Another program may be using port 8765.
pause
exit /b 1

:open
if /i "%~1"=="--check" (
  echo Server is up at %URL%
  exit /b 0
)
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%CHROME%" (
  start "" "%CHROME%" --app=%URL% --start-maximized
) else if exist "%EDGE%" (
  start "" "%EDGE%" --app=%URL% --start-maximized
) else (
  start "" %URL%
)
exit /b 0
