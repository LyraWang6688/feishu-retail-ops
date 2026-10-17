'use strict';

/**
 * 观测（埋点第 2 刀）：日志轮转 + 每日汇总的**配置先行**入口。
 *
 * ⚠️ 这里只放"能改的值"，不放业务逻辑：
 *   · `daily.*`     —— `scripts/observability-daily.mjs` 读它（默认时区 +8、Top 20、慢事件阈值 3s）；
 *   · `logrotate.*` —— `scripts/setup-pm2-logrotate.sh` 读同名环境变量（脚本在服务器上跑，不经 node）。
 * 两者都**无默认读取点**（后台脚本用），所以不会影响主服务启动。
 */
const { readFlag, readInt, readString } = require('./envValue');

const OBSERVABILITY = Object.freeze({
  daily: Object.freeze({
    enabled: readFlag(process.env, 'OBSERVABILITY_DAILY_ENABLED', true),
    timeZone: readString(process.env, 'OBSERVABILITY_DAILY_TZ', 'Asia/Shanghai'),
    topN: readInt(process.env, 'OBSERVABILITY_DAILY_TOP_N', 20, { min: 1, max: 200 }),
    slowMs: readInt(process.env, 'OBSERVABILITY_DAILY_SLOW_MS', 3000, { min: 0, max: 600000 }),
    // 服务器上的 PM2 日志（逗号分隔可多个；支持 `~` 与 `*`）
    logGlob: readString(process.env, 'OBSERVABILITY_LOG_GLOB', ''),
    // 留空 = 仓库根 `docs/reports/`（脚本里算绝对路径）
    outputDir: readString(process.env, 'OBSERVABILITY_DAILY_OUTPUT_DIR', ''),
  }),
  logrotate: Object.freeze({
    maxSize: readString(process.env, 'PM2_LOGROTATE_MAX_SIZE', '10M'),
    retain: readInt(process.env, 'PM2_LOGROTATE_RETAIN', 14, { min: 1, max: 365 }),
    compress: readFlag(process.env, 'PM2_LOGROTATE_COMPRESS', true),
    rotateInterval: readString(process.env, 'PM2_LOGROTATE_INTERVAL', '0 0 * * *'),
  }),
});

module.exports = { OBSERVABILITY };
