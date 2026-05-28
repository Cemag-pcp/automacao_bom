@echo off
setlocal

cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Git nao encontrado no PATH.
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado no PATH.
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERRO] npm nao encontrado no PATH.
  exit /b 1
)

echo [1/4] Atualizando repositorio...
git pull --rebase
if errorlevel 1 exit /b 1

echo [2/4] Instalando dependencias npm...
npm install
if errorlevel 1 exit /b 1

echo [3/4] Instalando navegador do Playwright...
npx playwright install chromium
if errorlevel 1 exit /b 1

echo [4/4] Executando automacao...
rem Evita que variaveis de ambiente herdadas do Windows sobrescrevam o .env do projeto.
set "DB_HOST="
set "DB_PORT="
set "DB_NAME="
set "DB_USER="
set "DB_PASSWORD="
set "BASE_PROD="
set "CARRETAS_EXPLODIDAS_TABLE="
set "ITENS_EXPLODIDOS_TABLE="
node bom_cemag.js
set EXIT_CODE=%ERRORLEVEL%

if not "%EXIT_CODE%"=="0" (
  echo [ERRO] A automacao terminou com codigo %EXIT_CODE%.
)

exit /b %EXIT_CODE%
