'use strict';

/**
 * 售后链路**专用**的关联字段解析：只认 `{ record_ids: ['rec…'] }`（issue #1074）。
 *
 * 为什么单独一个函数（而不是用全局 `linkedRecordIds()`）：
 *   · 全局 helper 还兼容 `{ id }` / `{ record_id }` / 裸字符串数组——那些分支没有证据；
 *   · 2026-11-23 售后候选改为 `getBatch` 读销售主表 / 收款明细，真实返回是
 *     `{ link_record_ids: ["rec…"] }`（与 `get` / `listAll` 的 `[{ record_ids }]` 不同形）；
 *   · 2026-11-10 只读取证（测试 Base，项目代码 + 官方 SDK `appTableField.list`），
 *     SingleLink(18) 与 DuplexLink(21) **同形**：
 *
 *       [{ "record_ids": ["rec…"], "table_id": "tbl…", "text": "…", "text_arr": ["…"], "type": "text" }]
 *
 *     空关联 = `[{ "table_id": "tbl…", "text_arr": [], "type": "text" }]`（没有 record_ids 键）。
 *   · 售后**不使用** `search` / `getBatch`；所以连 `link_record_ids` 都不收。
 *
 * 先例：`services/acceptanceSupplierProgress.js` 的关联字段读取也曾采用同样的窄形状口径。
 *
 * 收益：2026-11-10 那个真 bug（退货流水把**明细 id** 写进指向销售主表的关联字段）
 * 正是 permissive helper 掩盖出来的——严格解析能让"写错表/写错字段"更早暴露。
 */
const salesLinkRecordIds = (value) => {
  if (Array.isArray(value)) return value.flatMap(salesLinkRecordIds);
  if (!value || typeof value !== 'object') return [];
  const ids = [
    ...(Array.isArray(value.record_ids) ? value.record_ids : []),
    ...(Array.isArray(value.link_record_ids) ? value.link_record_ids : []),
  ];
  if (!ids.length) return [];
  return ids.flatMap((id) => {
    if (typeof id === 'string') return id ? [id] : [];
    if (Array.isArray(id)) return salesLinkRecordIds(id);
    return [];
  });
};

module.exports = { salesLinkRecordIds };
