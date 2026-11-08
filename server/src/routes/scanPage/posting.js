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
const parseReturnEntries = (body, fields) => {
  // ⭐⭐ 2026-10-29（业务负责人对退货页的 HTML 批注：「这里的框是干啥用的呀？」）：
  //   退货块**不再有勾选框** ⇒ 每行只有一个「退货数量」输入，**不填 / 填 0 = 不退**。
  //   ⇒ 只认 `return_qty_<size>` 这一批字段（数量输入即选择 ✓）。
  //   ⭐ 2026-11-08（业务负责人）：「**不需要做兼容**」⇒ **删掉**老页面 `return_sizes` 兜底分支：
  //     只提交 `return_sizes`（旧形状）⇒ entries 为空 ⇒ 走既有空单校验（400、零写入）。
  //   ⚠️ 这一层**只做形状转换**：尺码/数量**合不合法**仍由 `purchaseEntryViolation`（唯一真源）当场判
  //      ⇒ 非法值**原样往下传**（不许在这里静默吞 ✗）。
  const prefix = String(fields.returnQuantityPrefix || '');
  const entries = [];
  if (!prefix) return entries;
  for (const key of Object.keys(body || {})) {
    if (!key.startsWith(prefix) || key.length <= prefix.length) continue;
    const raw = String(body[key] ?? '').trim();
    if (raw === '') continue;                 // 空 = 这一码不退（不是错 ✓）
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric === 0) continue; // 填 0 = 这一码不退 ✓
    entries.push({ size: key.slice(prefix.length), quantity: raw });
  }
  return entries;
};

module.exports = { parseReplenishEntries, parseReturnEntries };
