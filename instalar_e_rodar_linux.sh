#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

for cmd in git node npm npx; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[ERRO] Comando obrigatorio nao encontrado: $cmd"
    exit 1
  fi
done

echo "[1/4] Atualizando repositorio..."
git pull --rebase

echo "[2/4] Instalando dependencias npm..."
npm install

echo "[3/4] Instalando navegador do Playwright..."
npx playwright install chromium

echo "[4/4] Executando automacao..."
node bom_cemag.js
