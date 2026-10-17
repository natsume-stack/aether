@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%POWERSHELL%" (
  echo [ERROR] Windows PowerShell was not found.
  pause
  exit /b 1
)

"%POWERSHELL%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"
set "RESULT=%ERRORLEVEL%"
echo.
if "%RESULT%"=="0" (
  echo Deployment finished successfully.
) else (
  echo Deployment did not finish. Read the message above and retry.
)
pause
exit /b %RESULT%
