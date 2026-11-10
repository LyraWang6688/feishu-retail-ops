'use strict';

/**
 * 关联字段 cell → record_id 数组：**只认有真实接口证据的形状**（issue #1074）。
 *
 * 证据（2026-11-10，测试 Base，项目代码 + 官方 SDK `appTableField.list`）：
 *   · `listAll` / `get`：`[{ record_ids: ['rec…'], table_id, text, text_arr, type }]`
 *     （SingleLink 18 / DuplexLink 21 同形；空关联没有 record_ids 键）；
 *   · `search` / `getBatch`：`[{ link_record_ids: ['rec…'] }]`。
 *
 * 🔴 不认无证据的 `{ id }` / `{ record_id }` / `{ recordId }` / 裸字符串数组。
 *   那是历史 permissive helper 的"猜兼容"，会掩盖写错表/写错字段
 *   （2026-11-10 售后退货把明细 id 写进指向销售主表的关联字段就是这样被掩盖的）。
 *
 * 用法：按条线切流（inventory → sales → …），都切完后全局 helper 再收窄（#1074）。
 */
const strictLinkedRecordIds = (value) => {
  if (Array.isArray(value)) return value.flatMap(strictLinkedRecordIds);
  if (!value || typeof value !== 'object') return [];
  const nested = [value.record_ids, value.link_record_ids].filter(Array.isArray);
  return nested.length ? nested.flatMap((ids) => ids.flatMap((id) => {
    if (typeof id === 'string') return id ? [id] : [];
    if (Array.isArray(id)) return strictLinkedRecordIds(id);
    if (id && typeof id === 'object') return strictLinkedRecordIds(id);
    return [];
  })) : [];
};

module.exports = { strictLinkedRecordIds };
