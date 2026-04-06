#!/usr/bin/env bash
# Usage: ./deploy.sh
# Run on the Synology after pushing to GitHub.
# Requires: nvm-managed Node 22, pm2 installed globally.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Pulling latest changes..."
git pull

echo "==> Installing backend dependencies..."
npm --prefix backend install --omit=dev

echo "==> Installing frontend dependencies and building..."
npm --prefix frontend install
npm --prefix frontend run build

echo "==> Ensuring log directory exists..."
mkdir -p logs

echo "==> Restarting PM2 process..."
pm2 restart ecosystem.config.cjs --env production 2>/dev/null \
  || pm2 start ecosystem.config.cjs --env production

echo "==> Done. Status:"
pm2 show memoryarchiver
