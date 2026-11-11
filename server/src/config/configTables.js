'use strict';

/**
 * 配置表统一注册表（2026-11-08）。
 *
 * 解决三件事：
 *   1. 飞书 record_changed 要失效哪些表 —— 不再把 key 数组写死在 `routes/larkEvents.js`；
 *   2. 每张配置表的 TTL —— 不再由各调用方自己传；
 *   3. `configTableCache` 的默认 TTL 也从这里取，避免各表漂移。
 *
 * 新增配置表：只改这里（+ schema），路由/缓存自动认识。
 *
 * ⚠️ TTL 是“懒刷新”的过期时间，不是后台定时刷新：
 *    过期后下一次读取重读；读失败用 lastGood（并告警）。
 */
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// ⭐ 2026-11-11（业务负责人）：配置表缓存以 record_changed 即时失效为主；TTL 只做极端兜底，统一 24 小时。
const CONFIG_TTL_MS = 24 * HOUR;

const CONFIG_TABLES = Object.freeze({
  paymentMethod: Object.freeze({ ttlMs: CONFIG_TTL_MS, label: '支付方式管理' }),
  sizeManagement: Object.freeze({ ttlMs: CONFIG_TTL_MS, label: '尺码管理' }),
  behavior: Object.freeze({ ttlMs: CONFIG_TTL_MS, label: '行为管理' }),
  accessory: Object.freeze({ ttlMs: CONFIG_TTL_MS, label: '其他配品' }),
  supplier: Object.freeze({ ttlMs: CONFIG_TTL_MS, label: '供应商管理' }),
  groupBuyVoucher: Object.freeze({ ttlMs: CONFIG_TTL_MS, label: '团购券管理' }),
  product: Object.freeze({ ttlMs: CONFIG_TTL_MS, label: '货品信息' }),
  color: Object.freeze({ ttlMs: CONFIG_TTL_MS, label: '颜色管理' }),
  category: Object.freeze({ ttlMs: CONFIG_TTL_MS, label: '品类管理' }),
  // 实时库存是业务数据，不走 24h 配置 TTL；只给工作台批量调整做 5 分钟短快照，
  // 但复用同一套缓存/失效/lastGood 机制（写库存的 record_changed 会失效）。
  liveInventory: Object.freeze({ ttlMs: 5 * MINUTE, label: '实时库存' }),
  // 不是独立 Base 表：只缓存「其他配品」里 配品=true 的候选（资金页赠品下拉）。
  giftAccessory: Object.freeze({ ttlMs: CONFIG_TTL_MS, label: '其他配品（赠品候选）' }),
});

/** record_changed 需要失效的表（顺序稳定，日志/测试可读）。 */
const CONFIG_TABLE_KEYS = Object.freeze(Object.keys(CONFIG_TABLES));

/** 未知表（测试/未来扩展）用默认 30 分钟；生产配置表应显式登记。 */
const DEFAULT_CONFIG_TTL_MS = CONFIG_TTL_MS;

const configTableOf = (tableKey) => CONFIG_TABLES[String(tableKey || '')] || null;
const configTableTtlMs = (tableKey) => {
  const table = configTableOf(tableKey);
  return table ? table.ttlMs : DEFAULT_CONFIG_TTL_MS;
};

module.exports = {
  CONFIG_TABLES,
  CONFIG_TABLE_KEYS,
  DEFAULT_CONFIG_TTL_MS,
  configTableOf,
  configTableTtlMs,
};
