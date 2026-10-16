'use strict';

/**
 * ⭐⭐ 2026-10-16 拆分（阶段二 · 纯搬运 ✓）：写库入口相关的纯函数。
 *   本轮先落补货／退货的表单解析（后续层：submitOrder／replenish／purchaseReturn ＋ 拦截页 ✓）。
 */

// ===== 以下为原文逐字切片（聚合用；勿改 ✗）=====


/**
 * 补货表单 → `[{ size, quantity }]`。
 * 表单里：勾了哪个尺码（`sizes` 多选）就在 `qty_<尺码>` 里填数量；
 * 勾了不填 ⇒ 交给写服务按配置的默认值（1 双）算 —— 这里**不替她决定**。
 * ⚠️ 本函数**只做形状转换**（不判合法性 ✗）；三类校验走
 *   `config/scanPurchaseEntryRules.js` 的 `purchaseEntryViolation`（与写层
 *   `services/scanWriteService.js:1397-1426` 逐字同源 ✓）—— 判据**不许**在这里再抄一份 ✗。
 */
const parseReplenishEntries = (body, fields, writeConfig) => {
  const rawSizes = body[fields.replenishSizes];
  const sizes = Array.isArray(rawSizes) ? rawSizes : (rawSizes === undefined || rawSizes === '' ? [] : [rawSizes]);
  return sizes.map((size) => ({
    size,
    quantity: body[`${fields.replenishQuantityPrefix}${size}`] ?? writeConfig.replenish.defaultQuantity,
  }));
};

/**
 * ⭐ 2026-10-11：**退货**表单 → `[{ size, quantity }]`（与补货那条**同一个形状**，
 * 只是字段名换成配置里的 `return_sizes` / `return_qty_<尺码>`）。
 * 勾了不填数量 ⇒ 交给写服务按配置的默认值算 —— 这里**不替她决定**。
 * ⚠️ 与补货那条同一条口径：**只做形状转换**；三类校验走
 *   `purchaseEntryViolation`（与写层 `services/scanWriteService.js:1556-1585` 逐字同源 ✓）。
 */
const parseReturnEntries = (body, fields, writeConfig) => {
  const rawSizes = body[fields.returnSizes];
  const sizes = Array.isArray(rawSizes) ? rawSizes : (rawSizes === undefined || rawSizes === '' ? [] : [rawSizes]);
  return sizes.map((size) => ({
    size,
    quantity: body[`${fields.returnQuantityPrefix}${size}`] ?? writeConfig.purchaseReturn.defaultQuantity,
  }));
};
module.exports = { parseReplenishEntries, parseReturnEntries };
