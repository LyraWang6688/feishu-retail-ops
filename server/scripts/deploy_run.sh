#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

export PORT=5000
export NODE_ENV=production

# 把「部署的是哪一版」写进环境，/health 会回报出来。
# 打了 tag 的部署回报 tag 名；没打 tag 就回报 commit 短号，便于对账。
export APP_VERSION="$(git describe --tags --abbrev=0 2>/dev/null || echo "untagged")"
export APP_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
export APP_DEPLOYED_AT="$(date -Iseconds)"

echo "Starting server on port $PORT..."
echo "Deploying version $APP_VERSION (commit $APP_COMMIT) at $APP_DEPLOYED_AT"
pm2 start ecosystem.config.js
