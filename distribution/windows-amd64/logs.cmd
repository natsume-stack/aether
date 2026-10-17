@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".env" (
  echo [ERROR] Not configured. Run ONE-CLICK-DEPLOY.cmd first.
  pause
  exit /b 1
)
docker compose --env-file .env -f docker-compose.yml logs --tail 300
pause
