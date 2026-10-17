# 观测日报与日志轮转（埋点第 2 刀）

> 第 1 刀（事件目录/运行时校验/文档）见 [observability-events.md](observability-events.md)。

## 1. 日志轮转（服务器）

```bash
cd /opt/box2bitable
PM2_LOGROTATE_MAX_SIZE=10M PM2_LOGROTATE_RETAIN=14 PM2_LOGROTATE_COMPRESS=true \
  bash server/scripts/setup-pm2-logrotate.sh
pm2 conf pm2-logrotate   # 查看生效配置
```

- 幂等：已安装则只更新配置；`pm2 install pm2-logrotate` 需要服务器能访问 npm。
- 默认：单文件 10M、保留 14 个、压缩、每天 0 点轮转（也受 `max_size` 提前触发）。

## 2. 每日汇总（服务器 cron）

```bash
cd /opt/box2bitable
APP_DIR=/opt/box2bitable OBSERVABILITY_DAILY_AT=09:00 \
  bash server/scripts/setup-observability-cron.sh
```

- 幂等：同一标记行只保留一条；`OBSERVABILITY_DAILY_AT` 必须是 `HH:MM`。
- 产物：`docs/reports/observability-YYYY-MM-DD.md` / `.json`（时区默认 `Asia/Shanghai`）。
- 手动补跑：`cd server && node scripts/observability-daily.mjs --date 2026-10-17`。
- 可配（环境变量，见 `src/config/observability.js`）：
  `OBSERVABILITY_DAILY_ENABLED` / `OBSERVABILITY_DAILY_TZ` / `OBSERVABILITY_DAILY_TOP_N` /
  `OBSERVABILITY_DAILY_SLOW_MS` / `OBSERVABILITY_LOG_GLOB` / `OBSERVABILITY_DAILY_OUTPUT_DIR`。

## 3. 日报里看什么

- **未登记事件**：`event` 带 `unregistered: true` 的条数（动态拼接事件名的收敛清单）。
- **错误**：level=error 的事件与 `error` 字段（最多 50 条）。
- **慢事件**：`duration_ms ≥ OBSERVABILITY_DAILY_SLOW_MS`（默认 3000ms）。
- **Top 事件**：按出现次数排序（默认 Top 20）。

## 4. 边界（如实）

- 日报读的是**PM2 当前日志文件**；轮转后的 `.gz` 不解析（跨天补历史请用未压缩日志或先解压）。
- 非 JSON 行（PM2 自身输出）忽略。
- 本刀不包含告警（第 3 刀）与 trace_id / 入口维度（后续刀）。
