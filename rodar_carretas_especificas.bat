@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

if "%~1"=="" (
  echo [ERRO] Nenhuma carreta informada. Uso: rodar_carretas_especificas.bat CODIGO1 CODIGO2 ...
  pause
  exit /b 1
)

where git >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Git nao encontrado no PATH.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado no PATH.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERRO] npm nao encontrado no PATH.
  pause
  exit /b 1
)

echo [1/4] Atualizando repositorio...
git pull --rebase
if errorlevel 1 (
  echo [ERRO] git pull --rebase falhou.
  pause
  exit /b 1
)

echo [2/4] Instalando dependencias npm...
call npm install
if errorlevel 1 (
  echo [ERRO] npm install falhou.
  pause
  exit /b 1
)

echo [3/4] Instalando navegador do Playwright...
call npx playwright install chromium
if errorlevel 1 (
  echo [ERRO] npx playwright install chromium falhou.
  pause
  exit /b 1
)

set "ARGS="
:loop
if "%~1"=="" goto executar
set "ARGS=!ARGS! --carreta "%~1""
shift
goto loop

:executar
echo [4/4] Executando automacao (carretas especificas: %*)...
rem Evita que variaveis de ambiente herdadas do Windows sobrescrevam o .env do projeto.
set "DB_HOST="
set "DB_PORT="
set "DB_NAME="
set "DB_USER="
set "DB_PASSWORD="
set "BASE_PROD="
set "CARRETAS_EXPLODIDAS_TABLE="
set "ITENS_EXPLODIDOS_TABLE="
node bom_cemag.js !ARGS!
set EXIT_CODE=%ERRORLEVEL%

if not "%EXIT_CODE%"=="0" (
  echo [ERRO] A automacao terminou com codigo %EXIT_CODE%.
)

pause
exit /b %EXIT_CODE%
