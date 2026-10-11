@echo off
rem ============================================================================
rem  打印小助手 —— Windows 双击运行
rem  · 检查 Node.js 在不在（没有就给人话提示，别让窗口一闪而过）
rem  · 用同目录的 config.json 启动 helper.js
rem  出现任何错误都 pause，让她能看清那行字（看不到错误等于没有错误）
rem ============================================================================
setlocal
chcp 65001 >nul
title 打印小助手

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [需要先装 Node.js] 这台电脑还没装 Node.js。
  echo.
  echo  1^) 打开 https://nodejs.org/  下载 LTS 版本，一路"下一步"装完
  echo  2^) 装完把本窗口关掉，重新双击 start.bat
  echo.
  pause
  exit /b 2
)

echo 打印小助手启动中……（这个窗口不要关，关了就打不出来）
echo.

node "%~dp0helper.js" --config "%~dp0config.json"
set EXITCODE=%errorlevel%

echo.
echo 打印小助手已退出（代码 %EXITCODE%）。
if not "%EXITCODE%"=="0" echo 请把上面这几行红字/错误行截图发给技术同事。
pause
exit /b %EXITCODE%
