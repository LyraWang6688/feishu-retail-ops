'use strict';

/**
 * ⭐ 2026-10-13（验收提速 ②）：**「待验收批次」列表的短缓存**（配置先行）。
 *
 * 为什么要有它：真账量出 `batches_ms ≈ 2981`（`batch_count: 0`）——列表是空的都还要 ~3 秒，
 * 那 3 秒 = **1 次飞书整表读**本身（本机单次 RT ≈ 2.4~3.2s）。她真机 4.8~7.4 秒
 * （「点 4、5 次才跳过去」）⇒ 冷读优化不掉那一次 RT，**热读（TTL 内）才是解药**。
 *
 * ⚠️ 口径（与 `afterSales.resolveAfterSalesReturnFundsMode` 同一条纪律）：
 *   · 没设 / 空串 ⇒ **默认 45 秒**；
 *   · 认不出的取值 ⇒ **抛错**（不静默回默认 —— 否则"我明明配了 5 秒"却按 45 秒跑，
 *     排查时会指向错的方向）；
 *   · `0` = **关掉缓存**（每次都真读，供排查/回归用）。
 */
const TTL_ENV_KEY = 'SCAN_ACCEPT_PENDING_CACHE_TTL_MS';
// 30~60 秒是业务口径给的范围；默认取中间值 45 秒。
const DEFAULT_TTL_MS = 45000;

const resolvePendingCacheTtlMs = (env = process.env) => {
  const raw = env ? env[TTL_ENV_KEY] : undefined;
  const value = String(raw ?? '').trim();
  if (!value) return DEFAULT_TTL_MS;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(
      `${TTL_ENV_KEY} 只接受非负毫秒数（0 = 关掉缓存），当前取值认不出：${value}`,
    );
  }
  return ms;
};

module.exports = { resolvePendingCacheTtlMs, TTL_ENV_KEY, DEFAULT_TTL_MS };
