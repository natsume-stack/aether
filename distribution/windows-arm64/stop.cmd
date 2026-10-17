@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".env" (
  echo BOX Local Engine is not configured.
  pause
  exit /b 0
)
docker compose --env-file .env -f docker-compose.yml down
echo.
echo Services stopped. Projects, maps, models, players, and database volumes were preserved.
pause
