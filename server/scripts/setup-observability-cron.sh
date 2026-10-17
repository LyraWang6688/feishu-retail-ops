#!/usr/bin/env bash
# 观测（埋点第 2 刀）：每日汇总的 crontab 安装（幂等：同一标记行只保留一条）。
#   APP_DIR              项目目录（默认 /opt/box2bitable）
#   OBSERVABILITY_DAILY_AT 几点跑（默认 09:00，服务器本地时区）
#   OBSERVABILITY_CRON_LOG 追加日志（默认 /var/log/box2bitable-observability-cron.log）
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/box2bitable}"
DAILY_AT="${OBSERVABILITY_DAILY_AT:-09:00}"
CRON_LOG="${OBSERVABILITY_CRON_LOG:-/var/log/box2bitable-observability-cron.log}"
MARK="# box2bitable-observability-daily"
NODE_BIN="$(command -v node || true)"

if [ -z "$NODE_BIN" ]; then echo "⛔ 找不到 node（PATH 里没有）" >&2; exit 1; fi
if [ ! -d "$APP_DIR/server" ]; then echo "⛔ 目录不存在：$APP_DIR/server" >&2; exit 1; fi

HOUR="${DAILY_AT%:*}"
MIN="${DAILY_AT#*:}"
case "$HOUR" in ''|*[!0-9]*) echo "⛔ OBSERVABILITY_DAILY_AT 必须是 HH:MM（当前 $DAILY_AT）" >&2; exit 1;; esac
case "$MIN" in ''|*[!0-9]*) echo "⛔ OBSERVABILITY_DAILY_AT 必须是 HH:MM（当前 $DAILY_AT）" >&2; exit 1;; esac
if [ "$HOUR" -gt 23 ] || [ "$MIN" -gt 59 ]; then echo "⛔ OBSERVABILITY_DAILY_AT 越界（当前 $DAILY_AT）" >&2; exit 1; fi

LINE="$MIN $HOUR * * * cd $APP_DIR/server && $NODE_BIN scripts/observability-daily.mjs >> $CRON_LOG 2>&1 $MARK"
CURRENT="$(crontab -l 2>/dev/null || true)"
NEXT="$(printf '%s\n' "$CURRENT" | grep -vF "$MARK" || true)"
printf '%s\n%s\n' "$NEXT" "$LINE" | sed '/^$/d' | crontab -

echo "✅ 已安装每日汇总 crontab：${DAILY_AT}（${APP_DIR}/server → ${CRON_LOG}）"
echo "   查看：crontab -l | grep box2bitable-observability-daily"
