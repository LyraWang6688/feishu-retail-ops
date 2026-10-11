@echo off
rem ============================================================================
rem  把「打印小助手」设成开机自启
rem  做法：在【当前用户的"启动"文件夹】里放一个指向 start.bat 的快捷方式。
rem  取消：Win+R 输入 shell:startup 回车，把里面的「打印小助手」快捷方式删掉即可。
rem ============================================================================
setlocal
chcp 65001 >nul
title 设置开机自启

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "TARGET=%~dp0start.bat"
set "LINK=%STARTUP%\打印小助手.lnk"

if not exist "%TARGET%" (
  echo 找不到 start.bat：%TARGET%
  pause
  exit /b 2
)

powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LINK%'); $s.TargetPath='%TARGET%'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Description='打印小助手'; $s.Save()"

if exist "%LINK%" (
  echo.
  echo  已设置开机自启。
  echo  取消办法：Win+R 输入 shell:startup 回车，删掉里面的「打印小助手」。
  echo.
) else (
  echo.
  echo  没设置成功。也可以手工来：Win+R 输入 shell:startup 回车，
  echo  然后把 start.bat 的快捷方式拖进那个文件夹。
  echo.
)
pause
