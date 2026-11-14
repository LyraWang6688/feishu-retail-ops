'use strict';

/**
 * 安全中间件配置（2026-11-14，#51）。
 *
 * 两个入口的防护（**配置先行**，不写死在中间件里）：
 *   · 扫码页 POST（`/r/*` 的表单提交）—— **来源校验**（Origin / Sec-Fetch-Site）；
 *   · 扫码页 + 飞书事件回调 —— **IP 限流**（内存滑动窗口；单实例够用）。
 *
 * ⚠️ 限流是"防误伤"的粗粒度保护，不是 WAF：阈值故意给得宽，正常业务打不到。
 */
const { readFlag, readInt, readList } = require('./envValue');

const SECURITY = Object.freeze({
  // 扫码页 POST 允许的来源（逗号分隔）；默认只放行生产域名。
  scanPostAllowedOrigins: Object.freeze(
    readList(process.env, 'SCAN_POST_ALLOWED_ORIGINS') ?? ['https://hm.bamamei.online'],
  ),
  rateLimit: Object.freeze({
    enabled: readFlag(process.env, 'RATE_LIMIT_ENABLED', true),
    windowMs: readInt(process.env, 'RATE_LIMIT_WINDOW_MS', 60 * 1000, { min: 1000, max: 60 * 60 * 1000 }),
    scanMax: readInt(process.env, 'RATE_LIMIT_SCAN_MAX', 120, { min: 1, max: 100000 }),
    eventMax: readInt(process.env, 'RATE_LIMIT_EVENT_MAX', 300, { min: 1, max: 100000 }),
  }),
});

module.exports = { SECURITY };
