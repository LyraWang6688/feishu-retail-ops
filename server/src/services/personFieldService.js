'use strict';

/**
 * 人员字段统一写入 helper。
 *
 * 统一规则：
 *   · 只写真实操作人 open_id；
 *   · 应用/工作台机器人（PERSON_FIELD_BLOCKED_OPEN_IDS）一律跳过；
 *   · 没有操作人 → 不写；
 *   · afterSalesBy 这类多人字段按配置追加，不覆盖历史。
 */
const { person } = require('./v1ReferenceResolver');
const { blockedOpenIds, personFieldPolicy } = require('../config/personFields');

const normalizeOpenId = (value) => {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') return String(value.open_id || value.openId || value.id || '').trim();
  return String(value || '').trim();
};

const existingIds = (value) => {
  const ids = [];
  for (const item of Array.isArray(value) ? value : []) {
    const id = normalizeOpenId(item);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
};

/** 追加人员并去重；保留历史人员顺序。 */
const appendPerson = (existing, operatorOpenId) => {
  const id = normalizeOpenId(operatorOpenId);
  const ids = existingIds(existing);
  if (!id) return ids.map((value) => ({ id: value }));
  if (!ids.includes(id)) ids.push(id);
  return ids.map((value) => ({ id: value }));
};

const isPersonOpenId = (operatorOpenId) => /^ou_[A-Za-z0-9]+$/i.test(normalizeOpenId(operatorOpenId));

const isBlockedOperator = (operatorOpenId, blocked = blockedOpenIds()) => {
  const id = normalizeOpenId(operatorOpenId);
  return Boolean(id && blocked.has(id));
};

/**
 * 生成某个字段的人员 patch。
 * 返回空对象 = 该字段不写（未配置 / 无操作人 / 被禁止名单拦截）。
 */
const personPatch = ({
  tableKey,
  fieldKey,
  operatorOpenId,
  existing,
  blocked = blockedOpenIds(),
} = {}) => {
  const policy = personFieldPolicy(tableKey, fieldKey);
  if (!policy) return {};
  const id = normalizeOpenId(operatorOpenId);
  // 只接受飞书人员 open_id；设备 ID / 任务 ID / 空值一律不写。
  if (!id || !isPersonOpenId(id) || blocked.has(id)) return {};
  if (policy.mode === 'append') return { [fieldKey]: appendPerson(existing, id) };
  return { [fieldKey]: person(id) };
};

module.exports = {
  normalizeOpenId,
  appendPerson,
  isPersonOpenId,
  isBlockedOperator,
  personPatch,
};
