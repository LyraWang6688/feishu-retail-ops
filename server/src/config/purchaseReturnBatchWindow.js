/**
 * 「采购退货」的归批窗口（毫秒）—— **2026-10-06 起它不再是"到点就发图"的触发条件**。
 *
 * 为什么曾经需要它：飞书把一次表单提交的多条记录推过来时**有时打包推、有时分条推**。
 * 2026-10-06 生产实测：同一次提交的 2 条采购退货记录**分成两次推送、相隔 16 秒**
 *（`action_count: 1` + `action_count: 1`），于是出了 2 张退货单、发了 2 次群。
 *
 * 最终口径（业务负责人 2026-10-06）：「到齐 ＋ 重试 3 次」「不要兜底」「不考虑拆包」。
 * 现在**决定什么时候出图的是「到齐」**：这一包里进了链路的每一条都处理完
 *（成功 / 跳过 / 重试 3 次读不到都算）就立刻整批处理一次（见 purchaseWebhookService
 * 的 recordPackageDone / flushReturnBatch）。**不再有"窗口到点就发"**。
 *
 * ⚠️ 这个值仍然保留（业务负责人的「配置先行」），用途变成：
 *   · 「同一批已经在处理、过一会儿再试」的重试间隔下限（至少 1 秒，避免空转刷日志）；
 *   · PM2 重启恢复时记在日志里，便于排查。
 * 改它**不会再影响"什么时候发图"**。
 *
 * ⚠️ 与报货链路**各自一份配置、各自一套状态**（AGENTS.md《底层工程原则》的「解耦」）：
 * 改一边不会动到另一边；两条链路在服务里也是两套 Map / 两把锁，不共用状态。
 *
 * 取值风格沿用 reportBatchWindow：只接受**非负数字**，空白串 / 负数 / 非数字一律
 * 当成"没写"回落到默认值（**不写 `process.env.X || fallback`** —— `||` 会把"清空变量"
 * 变成"回落默认值"，于是阈值根本改不动，属于静默失效）。
 */

const DEFAULT_PURCHASE_RETURN_BATCH_WINDOW_MS = 30_000;
const PURCHASE_RETURN_BATCH_WINDOW_ENV_KEY = 'PURCHASE_RETURN_BATCH_WINDOW_MS';

/**
 * 允许 0（立即处理），但不接受负数/非数字——那两种只可能是写错了，
 * 当"没写"回落到默认值，免得把窗口变成"永远不等"或"永远不处理"。
 */
const nonNegativeNumber = (value) => {
  if (value === undefined || value === null) return undefined;
  // ⚠️ 空白串必须在这里挡掉：`Number(' ')` 在 JS 里是 0，会让"没写/手滑打个空格"
  // 变成"不等待"，与"写错就回落默认值"的意图相反。
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

/**
 * 取值优先级：构造入参 > 环境变量 > 默认值。
 * 纯函数、env 可注入，便于单测钉住环境变量名与默认值。
 */
const resolvePurchaseReturnBatchWindowMs = (options = {}, env = process.env) => (
  nonNegativeNumber(options.purchaseReturnBatchWindowMs)
  ?? nonNegativeNumber(env ? env[PURCHASE_RETURN_BATCH_WINDOW_ENV_KEY] : undefined)
  ?? DEFAULT_PURCHASE_RETURN_BATCH_WINDOW_MS
);

module.exports = {
  DEFAULT_PURCHASE_RETURN_BATCH_WINDOW_MS,
  PURCHASE_RETURN_BATCH_WINDOW_ENV_KEY,
  resolvePurchaseReturnBatchWindowMs,
};
