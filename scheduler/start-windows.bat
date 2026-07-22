@echo off
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel%==0 (
  python serve.py
  goto :eof
)

where py >nul 2>nul
if %errorlevel%==0 (
  py serve.py
  goto :eof
)

where node >nul 2>nul
if %errorlevel%==0 (
  node serve.js
  goto :eof
)

echo Neither Python nor Node.js was found on this PC.
echo Install one of them (python.org or nodejs.org), then double-click this file again.
pause
