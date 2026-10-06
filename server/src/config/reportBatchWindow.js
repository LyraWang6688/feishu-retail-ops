/**
 * 供应商报货的「归批窗口」（毫秒）—— **2026-10-06 起它不再是"到点就发图"的触发条件**。
 *
 * 业务负责人 2026-10-06 定的最终口径：「到齐 ＋ 重试 3 次」「不要兜底」「不考虑拆包」。
 * 所以现在**决定什么时候出图的是「到齐」**：这一包里进了链路的每一条都处理完
 *（成功 / 跳过 / 重试 3 次读不到都算）就立刻整批处理一次（见 purchaseWebhookService
 * 的 recordPackageDone / flushReportBatch）。
 *
 * 这个值仍然保留，是因为它还有用途（都不改变上面的判据）：
 *   · 「同一批已经在处理、过一会儿再试」的重试间隔下限（至少 1 秒，避免空转刷日志）；
 *   · 运维排查时能一眼看到"这一批重试时用的间隔是多少"。
 *
 * ⚠️ 它**不再**是"窗口内到的记录算一批、窗口到点处理一次"那个机制——那个机制随
 * 「到齐就发」一起退场了。改这个值不会再影响"什么时候发图"。
 *
 * 取值风格沿用原样：只接受**非负数字**，空白串 / 负数 / 非数字一律当成"没写"回落
 * 默认值（**不写 `process.env.X || fallback`** —— `||` 会把"清空变量"变成"回落默认值"，
 * 于是阈值根本改不动，属于静默失效）。
 */

const DEFAULT_REPORT_BATCH_WINDOW_MS = 4_000;
const REPORT_BATCH_WINDOW_ENV_KEY = 'REPORT_BATCH_WINDOW_MS';

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
const resolveReportBatchWindowMs = (options = {}, env = process.env) => (
  nonNegativeNumber(options.reportBatchWindowMs)
  ?? nonNegativeNumber(env ? env[REPORT_BATCH_WINDOW_ENV_KEY] : undefined)
  ?? DEFAULT_REPORT_BATCH_WINDOW_MS
);

module.exports = {
  DEFAULT_REPORT_BATCH_WINDOW_MS,
  REPORT_BATCH_WINDOW_ENV_KEY,
  resolveReportBatchWindowMs,
};
