@echo off
rem ===========================================================================
rem  Print Helper - double click this file to start.
rem  NOTE: this file is intentionally ASCII + CRLF only (Chinese text lives in
rem  README.md and is printed by helper.js in UTF-8, which is why we set 65001).
rem ===========================================================================
chcp 65001 >nul
title Print Helper - DO NOT CLOSE THIS WINDOW
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [!] Node.js is not installed on this computer.
  echo.
  echo      1^) Open https://nodejs.org/ and install the LTS version
  echo      2^) Close this window, then double click start.bat again
  echo.
  echo      ^(The Chinese steps are in README.md - please show this to your family.^)
  echo.
  pause
  exit /b 2
)

node "%~dp0helper.js" --config "%~dp0config.json"
set EXITCODE=%errorlevel%

echo.
if not "%EXITCODE%"=="0" (
  echo  [!] The helper stopped with error code %EXITCODE%.
  echo      Please take a photo of this window and send it to your family.
  echo.
)
echo  Press any key to close this window.
pause >nul
exit /b %EXITCODE%
