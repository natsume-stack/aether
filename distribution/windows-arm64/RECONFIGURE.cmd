@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
echo Existing projects and database volumes will be preserved.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" -Reconfigure
set "RESULT=%ERRORLEVEL%"
pause
exit /b %RESULT%
