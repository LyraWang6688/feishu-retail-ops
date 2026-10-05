// 销售记录查询（退换货第一期）的配置。
//
// 两个数字都做成环境变量可配，是因为「最近几天算有效」和「候选列表存多久」是
// 门店运营节奏决定的，不该写死在代码里。默认值就是产品负责人定的：5 天、10 分钟。
const DAY_MS = 24 * 60 * 60 * 1000;

const SALE_LOOKUP_DEFAULTS = Object.freeze({
  days: 5,
  ttlMs: 10 * 60 * 1000,
});

// 「排除已经退过货的单」的两个判据。值来自飞书表的**当前字段值**，
// 集中在这里是为了字段取值文案变化时只有一个地方要改：
//   · 销售主表.订单状态 = 已退货 / 部分退货
//   · 销售明细.交易类型 = 销售退货
// 两个都查（双保险），任一命中即整单排除，防止重复退货。
const RETURNED_ORDER_STATUSES = Object.freeze(['已退货', '部分退货']);
const RETURN_DETAIL_TRADE_TYPES = Object.freeze(['销售退货']);

// 环境变量可能是空串、非数字、0 或负数：这些一律回落到默认值，
// 不让一个写坏的变量把查询窗口变成 0 天或负数。
const readPositiveInt = (value, fallback) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const readSaleLookupConfig = (env = process.env) => ({
  days: readPositiveInt(env.SALE_LOOKUP_DAYS, SALE_LOOKUP_DEFAULTS.days),
  ttlMs: readPositiveInt(env.SALE_LOOKUP_TTL_MS, SALE_LOOKUP_DEFAULTS.ttlMs),
});

const normalizeLabel = (value) => String(value ?? '').trim().replace(/\s+/g, '');

const matchesAnyLabel = (value, labels) => {
  const normalized = normalizeLabel(value);
  return Boolean(normalized) && labels.some((label) => normalizeLabel(label) === normalized);
};

const isReturnedOrderStatus = (value) => matchesAnyLabel(value, RETURNED_ORDER_STATUSES);
const isReturnTradeType = (value) => matchesAnyLabel(value, RETURN_DETAIL_TRADE_TYPES);

module.exports = {
  DAY_MS,
  SALE_LOOKUP_DEFAULTS,
  RETURNED_ORDER_STATUSES,
  RETURN_DETAIL_TRADE_TYPES,
  readSaleLookupConfig,
  readPositiveInt,
  isReturnedOrderStatus,
  isReturnTradeType,
};
