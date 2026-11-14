'use strict';

/**
 * 多维表格「cell / 响应」的纯取值工具（2026-11-14 #48，从 `v1BitableGateway.js` 拆出）。
 *
 * 为什么单独一层：
 *   · 这些函数**不依赖 client / schema / 调度器**，只是"飞书返回体 → 业务可用的值"的纯转换；
 *   · 全仓有二十多处通过网关 re-export 使用 `textValue`（见 `module.exports`），
 *     拆走后**对外 API 不变**，调用方零改动；
 *   · 网关本体继续承担"读写 + 重试 + 调度"，本文件只做 cell 形状识别。
 *
 * ⚠️ 关联字段多形状兼容（issue #1074）**不要**在这里擅自收窄：
 *   `linkedRecordIds` 只认 `record_ids` / `link_record_ids`，收窄前先按 issue 的取证流程确认。
 */
const compact = (value) => {
  const result = {};
  Object.entries(value || {}).forEach(([key, item]) => {
    if (item !== undefined) result[key] = item;
  });
  return result;
};
const recordIdOf = (response) => response?.data?.record?.record_id || response?.data?.record_id || '';
const textValue = (value) => {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(',');
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.value ?? '');
  return '';
};
/** 关联字段 cell → record_id 数组；只认 record_ids / link_record_ids（issue #1074）。 */
const linkedRecordIds = (value) => {
  if (Array.isArray(value)) return value.flatMap(linkedRecordIds);
  if (!value || typeof value !== 'object') return [];
  const nested = [value.record_ids, value.link_record_ids].filter(Array.isArray);
  return nested.length ? nested.flatMap((ids) => ids.flatMap((id) => {
    if (typeof id === 'string') return id ? [id] : [];
    if (Array.isArray(id)) return linkedRecordIds(id);
    if (id && typeof id === 'object') return linkedRecordIds(id);
    return [];
  })) : [];
};
// 单选关联的判定：必须且只能关联到这一条记录。多选或指错记录都不能算匹配，
// 否则幂等比对会把「另一条尺码」或「一次关联多个」误当成同一条业务明细。
const singleLinked = (cell, recordId) => {
  const ids = linkedRecordIds(cell);
  return ids.length === 1 && ids[0] === recordId;
};

module.exports = { compact, recordIdOf, textValue, linkedRecordIds, singleLinked };
