/**
 * 「采购退货」的归批窗口（毫秒）—— 业务负责人 2026-10-06 拍板：**30 秒**。
 *
 * 为什么需要它：飞书把一次表单提交的多条记录推过来时**有时打包推、有时分条推**。
 * 2026-10-06 生产实测：同一次提交的 2 条采购退货记录**分成两次推送、相隔 16 秒**
 * （`action_count: 1` + `action_count: 1`），于是出了 2 张退货单、发了 2 次群。
 * 按「报货批次号」归批 + 一个足够长的窗口，才能把同一次提交认成一批。
 *
 * 为什么是 30 秒而不是报货链路的 4 秒：报货的 4 秒是产品负责人要的"别让人干等"
 * （一次提交的记录是同一个事务写进去的，拆包只会在毫秒级拆开）；但**退货实测被拆到
 * 了 16 秒**，4 秒兜不住。30 秒是业务负责人亲口定的值——代价是她要多等 30 秒才看到图，
 * 她**已知情并接受**。
 *
 * ⚠️ 与报货链路**各自一份配置、各自一个窗口**（AGENTS.md《底层工程原则》的「解耦」）：
 * `reportBatchWindow` 管报货（4 秒，行为一个字都不改），这个文件管退货。
 * 改一边不会动到另一边；两条链路在服务里也是两套 Map / 两把锁，不共用状态。
 *
 * 默认 30000，可用 PURCHASE_RETURN_BATCH_WINDOW_MS 覆盖。0 表示"窗口一开就到点"
 *（不等待）——0 仍然安全：窗口到点会重读整批记录，且同一批次号有串行锁 +
 * 单据幂等键，不会写两遍；只是她看不到"等一批"的效果。
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
