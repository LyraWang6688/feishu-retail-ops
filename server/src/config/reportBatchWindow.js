/**
 * 供应商报货的「归批窗口」（毫秒）。
 *
 * 为什么需要它：飞书的一次表单提交会写成**同一张表的多条记录**，推送过来是
 * 一个 action_list 里的多个 record_added。逐条处理会出 N 张采购申请图 —— 必须把
 * 同一次提交的几条认成一批。首选靠"同一包"（一次推送里的多条 action），
 * 但"一包就是一次提交"这件事**还没有真机验证过**，所以必须有兜底：
 * 按「报货批次号」归集 + 一个短窗口，窗口到点就处理。
 *
 * 为什么是 3~5 秒而不是以前那个 30 秒：产品负责人明确批评过"等 30 秒"的体感。
 * 一次表单提交的记录是同一个事务写进去的，拆包也只会在毫秒级拆开，
 * 4 秒足够兜住；30 秒只是让人干等。
 *
 * 默认 4000，可用 REPORT_BATCH_WINDOW_MS 覆盖。0 表示"窗口一开就到点"（不等待）——
 * 只有在真机验证过"一包就是一次提交"之后才建议这么配；即便配成 0，同一批次也不会
 * 被写两遍（窗口到点会重读整批记录，且同一批次号有串行锁）。
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
