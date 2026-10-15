'use strict';

/**
 * ⭐⭐ 2026-10-15（业务负责人逐字：「**需要加上**」）：**工作台订单列表的"读表瞬时错误自动重试"**配置。
 *
 * 起因（她真机）：`GET /api/workbench/sales/orders` 内部读飞书时，飞书回了
 *   **`1254607 Data not ready, please try again later`**（瞬时错误）⇒ 路由落 502 ⇒ 页面把内部 400 显示出来 ✗。
 *
 * 🔴 三条口径：
 *   ① **只重试可重试的瞬时错误** —— 判据**不在这里另写一套** ✗：直接借
 *      `config/pushRetry` 的 `isTransientLarkError`（飞书 `1254607` / HTTP 429 / 5xx / 网络类）；
 *      `401 / 403 / 404` 这类**确定性错误一次都不重试** ✓
 *   ② **次数与退避可配**（配置先行 ✓ 不写死 ✗）：默认 **1 次**（共 2 次尝试）+ **300ms** 线性退避
 *      （比推送那条"2 次 / 1s 起"更轻 —— 这是**用户正对着的页面**，宁可快失败也别让她干等 ✗）
 *   ③ **如实**：命中重试记一条（`workbench.sales.orders.read_retry`）；重试用完仍失败 ⇒
 *      **抛原错** ⇒ 路由照旧 `workbench.sales.orders.failed` + **502**（**绝不把失败吞成成功** ✗）
 *
 * ⚠️ 与扫码页 `services/liveInventorySnapshot.js` 那条重试是**同一套思路**（`reason: 'read_retry'`、
 *   逐次 attempt、线性退避、最后抛原错）—— 那边是"后台拉快照"，这边是"她要读的那一页"，
 *   所以**次数/退避各配各的**，但**瞬时判据共用同一份实现** ✓（本仓最怕的静默漂移 ✗）。
 *
 * 取值规则沿用 `config/envValue`：**没设 → 默认值**；**设了（含空串）→ 显式取值**；
 *   认不出来的值**当场抛错**（不猜）。单测直接传 env 进来（不碰全局 process.env）✓
 */
const { readInt } = require('./envValue');
const { isTransientLarkError, resolveTransientRetryConfig } = require('./pushRetry');

const WORKBENCH_ORDERS_RETRY_MAX_ENV_KEY = 'WORKBENCH_ORDERS_RETRY_MAX';
const WORKBENCH_ORDERS_RETRY_DELAY_MS_ENV_KEY = 'WORKBENCH_ORDERS_RETRY_DELAY_MS';

/** 默认重试 **1 次**（共 2 次尝试）。上限 5 —— 页面不能因为重试把她拖住 ✗。 */
const DEFAULT_ORDERS_RETRY_MAX = 1;
/** 默认退避 **300ms**（线性：第 1 次 300ms、第 2 次 600ms…）。 */
const DEFAULT_ORDERS_RETRY_DELAY_MS = 300;

/** 解析订单列表的重试配置（次数 / 退避；两个都是显式整数、越界当场抛 ✗）。 */
const resolveOrderReadRetryConfig = (env = process.env) => ({
  maxRetries: readInt(env, WORKBENCH_ORDERS_RETRY_MAX_ENV_KEY, DEFAULT_ORDERS_RETRY_MAX,
    { min: 0, max: 5 }),
  delayMs: readInt(env, WORKBENCH_ORDERS_RETRY_DELAY_MS_ENV_KEY, DEFAULT_ORDERS_RETRY_DELAY_MS,
    { min: 0, max: 5_000 }),
});

/**
 * 「这个错值不值得再读一次」——**只有一份实现**（借 `config/pushRetry` 的判据 ✓ 不抄第二份 ✗）。
 * ⚠️ 用的是**推送那一份的默认值**（`larkCodes = ['1254607']` ＋ HTTP 429 / 5xx ＋ 网络类），
 *   也就是 `PUSH_TRANSIENT_RETRY_LARK_CODES` 那一处配置的口径（真要加码只改那一处 ✓）。
 * 🔴 `401 / 403 / 404` 这类**一律 false** ⇒ 一次都不重试 ✓
 */
const isRetriableOrderReadError = (error) => isTransientLarkError(error, resolveTransientRetryConfig());

module.exports = {
  WORKBENCH_ORDERS_RETRY_MAX_ENV_KEY,
  WORKBENCH_ORDERS_RETRY_DELAY_MS_ENV_KEY,
  DEFAULT_ORDERS_RETRY_MAX,
  DEFAULT_ORDERS_RETRY_DELAY_MS,
  resolveOrderReadRetryConfig,
  isRetriableOrderReadError,
};
