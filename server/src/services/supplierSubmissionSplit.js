'use strict';

const crypto = require('node:crypto');

/**
 * 2026-11-27：采购页 / 退货共用的「一次提交按供应商拆独立任务」分组。
 * 纯函数：只分组 + 派生稳定组键，不写库、不取号、不认识飞书。
 */

const supplierGroupKeyOf = (supplierRecordId) => {
  const id = String(supplierRecordId || '').trim();
  if (!id) return 'unassigned';
  return `s_${crypto.createHash('sha256').update(id).digest('hex').slice(0, 12)}`;
};

const supplierRecordIdOf = (item) => String(item?.supplier_record_id ?? item?.supplierRecordId ?? '').trim();

const groupItemsBySupplier = (items = []) => {
  const groups = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const supplierRecordId = supplierRecordIdOf(item);
    const key = supplierGroupKeyOf(supplierRecordId);
    if (!groups.has(key)) groups.set(key, { key, supplierRecordId, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
};

module.exports = { supplierGroupKeyOf, supplierRecordIdOf, groupItemsBySupplier };
