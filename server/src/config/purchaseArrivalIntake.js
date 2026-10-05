// 「采购到货 → 拍照识别 → 入库」链路的显式开关（配置先行）。
//
// 为什么要有它：业务负责人确认这条链路是**临时的、随时可能停掉**。
// 停掉的动作必须是"改一个环境变量"，而不是"改代码 + 重新部署"——
// 后者来不及，也没法在半夜停。
//
// ⚠️ 为什么判定必须显式，不能写成 `process.env.X || fallback`：
// 本仓库里 getEnv（src/config/v1BitableSchema.js）就是 `process.env[key] || fallback`，
// `||` 会把**空字符串**当成"没配"而回落到默认值。于是"把环境变量清空"根本关不掉、
// 却让人以为已经关了——链路还在偷偷跑，属于最危险的静默失效。
// 这里反过来：只有拿到**显式**的关闭信号才关，取不到值一律按现状（开启）跑。
//
// ⚠️ 为什么不能拿表 ID 当开关：FEISHU_V1_PURCHASE_ARRIVAL_TABLE_ID 有硬编码默认值
// （v1BitableSchema.js 里 getEnv(..., 'tblvLOXKESNTbZ7v')），清空同样会回落到写死的表 ID，
// 一样关不掉。开关必须是独立、语义明确的布尔量，不复用任何带兜底的取值函数。
//
// 判定规则只有一条（见 isPurchaseArrivalIntakeEnabled）：
//   · 去掉首尾空白、忽略大小写后**恰好等于 'false'** → 关闭
//   · 其它一切（undefined / '' / 'true' / '1' / 写错的值 / 手滑多打的空格之外的内容）→ 开启
// 即：默认开启（保持现状），且"配错"的方向是保守的——宁可继续按现状跑，
// 也不会因为一个笔误把到货入库悄悄停掉。
const PURCHASE_ARRIVAL_INTAKE_ENV_KEY = 'PURCHASE_ARRIVAL_INTAKE_ENABLED';

// 唯一的关闭信号。只认这一个字面量，不做 `||` 兜底、不做"假值"推断。
const PURCHASE_ARRIVAL_INTAKE_DISABLED_VALUE = 'false';

/**
 * 「采购到货」链路是否启用。纯函数，env 可注入，便于单测与将来按租户/门店配置。
 *
 * @param {Record<string, unknown>} [env] 默认 process.env
 * @returns {boolean} true = 启用（默认）；false = 显式关闭
 */
const isPurchaseArrivalIntakeEnabled = (env = process.env) => {
  const raw = env ? env[PURCHASE_ARRIVAL_INTAKE_ENV_KEY] : undefined;
  // 取不到（undefined / null / env 传了假值）视为未配置 → 开启。
  if (raw === undefined || raw === null) return true;
  // ⚠️ 关键：空字符串 '' 走这里，既不等于 'false' 也不做假值判断 → 开启。
  // 这正是"不能用 || 兜底"的反面：'' 是"没写"而不是"关"。
  return String(raw).trim().toLowerCase() !== PURCHASE_ARRIVAL_INTAKE_DISABLED_VALUE;
};

module.exports = {
  PURCHASE_ARRIVAL_INTAKE_ENV_KEY,
  PURCHASE_ARRIVAL_INTAKE_DISABLED_VALUE,
  isPurchaseArrivalIntakeEnabled,
};
