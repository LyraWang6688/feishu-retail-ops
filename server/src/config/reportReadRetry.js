/**
 * 「读一条报单记录」的重试配置（次数 + 间隔，毫秒）。
 *
 * 为什么需要它：飞书多维表格的写入是**最终一致**的——记录变更事件先到、记录内容
 * 后到（`Data not ready` / 1254607）。报货链路要读这条记录才能分流（采购申请还是
 * 采购退货）、才能读出「报货批次号」归批。第一枪读不到，后面整条链路就都走不动。
 *
 * 业务负责人 2026-10-06 定的最终口径：
 *   「到齐 ＋ 重试 3 次」「重试了 3 次之后还是读不到，就算处理完了」。
 * 所以这里**只重试读**（不重试写——写重试可能写两遍），最多 3 次，
 * 间隔 1 秒 → 2 秒（共约 3 秒），用完就放弃、按「处理完了」继续。
 *
 * 两个值都可配（配置先行，她要能自己调）：
 *   REPORT_READ_MAX_RETRIES      默认 3
 *   REPORT_READ_RETRY_DELAY_MS   默认 1000（第 n 次失败后等 delay × n 毫秒）
 *
 * ⚠️ 取值风格沿用 reportBatchWindow：只接受合法数字，空白串 / 负数 / 非数字一律
 * 当成"没写"回落到默认值——**不写 `process.env.X || fallback`**（`||` 会把"清空变量"
 * 变成"回落默认值"，阈值根本改不动，属于静默失效）。
 */

const DEFAULT_REPORT_READ_MAX_RETRIES = 3;
const DEFAULT_REPORT_READ_RETRY_DELAY_MS = 1_000;
const REPORT_READ_MAX_RETRIES_ENV_KEY = 'REPORT_READ_MAX_RETRIES';
const REPORT_READ_RETRY_DELAY_ENV_KEY = 'REPORT_READ_RETRY_DELAY_MS';

/**
 * 正整数（次数）——0 次重试没有意义（等于不读），当"没写"处理。
 */
const positiveInteger = (value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

/**
 * 非负整数（间隔）——0 是合法值（测试/沙箱里"不等待"），负数/非数字回落默认。
 */
const nonNegativeInteger = (value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

/**
 * 取值优先级：构造入参 > 环境变量 > 默认值。
 * 纯函数、env 可注入，便于单测钉住环境变量名与默认值。
 */
const resolveReportReadRetry = (options = {}, env = process.env) => ({
  maxRetries: positiveInteger(options.batchReadMaxRetries)
    ?? positiveInteger(env ? env[REPORT_READ_MAX_RETRIES_ENV_KEY] : undefined)
    ?? DEFAULT_REPORT_READ_MAX_RETRIES,
  retryDelayMs: nonNegativeInteger(options.batchReadRetryDelay)
    ?? nonNegativeInteger(env ? env[REPORT_READ_RETRY_DELAY_ENV_KEY] : undefined)
    ?? DEFAULT_REPORT_READ_RETRY_DELAY_MS,
});

module.exports = {
  DEFAULT_REPORT_READ_MAX_RETRIES,
  DEFAULT_REPORT_READ_RETRY_DELAY_MS,
  REPORT_READ_MAX_RETRIES_ENV_KEY,
  REPORT_READ_RETRY_DELAY_ENV_KEY,
  resolveReportReadRetry,
};
