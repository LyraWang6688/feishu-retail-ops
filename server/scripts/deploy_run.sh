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
# ⚠️ 必须用 startOrReload + --update-env：
#   应用【已在运行】时，`pm2 start` 不会更新进程的 env —— 上面 export 的
#   APP_VERSION / APP_COMMIT / APP_DEPLOYED_AT 就不会生效，/health 会一直回报
#   上一次启动时的旧版本号（2026-10-07 实测：部署到 f0a2f3f 后 /health 仍显示
#   v0.2.0 / 7563537，对账会误导成"线上跑的是旧代码"）。
#   --update-env 让 pm2 重新读取当前 shell 的环境变量。
pm2 startOrReload ecosystem.config.js --update-env
