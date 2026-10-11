@echo off
rem ===========================================================================
rem  Put a "Print Helper" icon on the Desktop (one click to start).
rem  ASCII + CRLF only - all Chinese text is printed by helper.js.
rem ===========================================================================
chcp 65001 >nul
title Install Print Helper desktop shortcut
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [!] Node.js is not installed on this computer.
  echo      Install Node.js LTS from https://nodejs.org/ first, then run this again.
  echo.
  pause
  exit /b 2
)

node "%~dp0helper.js" --install-shortcut

echo.
echo  Press any key to close this window.
pause >nul
exit /b 0
