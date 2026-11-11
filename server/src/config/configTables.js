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

const CONFIG_TABLES = Object.freeze({
  paymentMethod: Object.freeze({ ttlMs: 30 * MINUTE, label: '支付方式管理' }),
  sizeManagement: Object.freeze({ ttlMs: 30 * 1000, label: '尺码管理' }),
  behavior: Object.freeze({ ttlMs: 30 * MINUTE, label: '行为管理' }),
  accessory: Object.freeze({ ttlMs: 30 * MINUTE, label: '其他配品' }),
  supplier: Object.freeze({ ttlMs: 30 * MINUTE, label: '供应商管理' }),
  groupBuyVoucher: Object.freeze({ ttlMs: 30 * MINUTE, label: '团购券管理' }),
  product: Object.freeze({ ttlMs: 30 * MINUTE, label: '货品信息' }),
  color: Object.freeze({ ttlMs: 30 * MINUTE, label: '颜色管理' }),
  category: Object.freeze({ ttlMs: 30 * MINUTE, label: '品类管理' }),
});

/** record_changed 需要失效的表（顺序稳定，日志/测试可读）。 */
const CONFIG_TABLE_KEYS = Object.freeze(Object.keys(CONFIG_TABLES));

/** 未知表（测试/未来扩展）用默认 30 分钟；生产配置表应显式登记。 */
const DEFAULT_CONFIG_TTL_MS = 30 * MINUTE;

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
