#!/usr/bin/env bash
# 观测（埋点第 2 刀）：PM2 日志轮转 —— 幂等；全部取值可用环境变量覆盖。
#   PM2_LOGROTATE_MAX_SIZE  单文件上限（默认 10M）
#   PM2_LOGROTATE_RETAIN    保留多少个（默认 14）
#   PM2_LOGROTATE_COMPRESS  是否压缩（默认 true）
#   PM2_LOGROTATE_INTERVAL  轮转周期（默认每天 0 点；也可用 pm2-logrotate:max_size 触发）
set -euo pipefail

MAX_SIZE="${PM2_LOGROTATE_MAX_SIZE:-10M}"
RETAIN="${PM2_LOGROTATE_RETAIN:-14}"
COMPRESS="${PM2_LOGROTATE_COMPRESS:-true}"
INTERVAL="${PM2_LOGROTATE_INTERVAL:-0 0 * * *}"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "⛔ 找不到 pm2（先在服务器上装好 pm2 并确认 PATH）" >&2
  exit 1
fi

if pm2 list 2>/dev/null | grep -q 'pm2-logrotate'; then
  echo "pm2-logrotate 已安装，只更新配置"
else
  echo "安装 pm2-logrotate …"
  pm2 install pm2-logrotate
fi

pm2 set pm2-logrotate:max_size "$MAX_SIZE"
pm2 set pm2-logrotate:retain "$RETAIN"
pm2 set pm2-logrotate:compress "$COMPRESS"
pm2 set pm2-logrotate:rotateInterval "$INTERVAL"
pm2 save >/dev/null 2>&1 || true

echo "✅ pm2-logrotate 配置：max_size=${MAX_SIZE} retain=${RETAIN} compress=${COMPRESS} rotateInterval='${INTERVAL}'"
