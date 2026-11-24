'use strict';

/**
 * 人员字段统一配置（2026-11-24 业务负责人确认）。
 *
 * 只登记这 7 个字段；值只能是真实操作人的 open_id。
 * 历史数据不回填，配置只约束以后的新写入。
 *
 * mode:
 *   set    = 覆盖当前人员
 *   append = 保留历史人员，追加当前操作人（去重）
 *
 * source 只作文档/调用方约束，不在此处远程查人：
 *   inventory_operator / sales_actor / after_sales_actor /
 *   purchase_actor / acceptance_actor / label_print_actor
 */
const PERSON_FIELDS = Object.freeze({
  inventoryLedger: Object.freeze({
    operator: Object.freeze({ field: 'operator', mode: 'set', source: 'inventory_operator' }),
  }),
  labelPrintRequest: Object.freeze({
    printedBy: Object.freeze({ field: 'printedBy', mode: 'set', source: 'label_print_actor' }),
  }),
  salesEntry: Object.freeze({
    sender: Object.freeze({ field: 'sender', mode: 'set', source: 'sales_actor' }),
    afterSalesBy: Object.freeze({ field: 'afterSalesBy', mode: 'append', source: 'after_sales_actor' }),
  }),
  purchaseOrderBatch: Object.freeze({
    reportedBy: Object.freeze({ field: 'reportedBy', mode: 'set', source: 'purchase_actor' }),
    acceptedBy: Object.freeze({ field: 'acceptedBy', mode: 'set', source: 'acceptance_actor' }),
  }),
  liveInventory: Object.freeze({
    warehouseStaff: Object.freeze({ field: 'warehouseStaff', mode: 'set', source: 'inventory_operator' }),
  }),
});

/**
 * 生产「来财」工作台/应用身份。业务代码不得判断姓名，只按 open_id 拦截。
 * 可用 PERSON_FIELD_BLOCKED_OPEN_IDS（逗号分隔）追加/覆盖同一份禁止名单。
 */
const DEFAULT_BLOCKED_OPEN_IDS = Object.freeze([
  'ou_dc362967efb60353902b7d7f43756c84',
]);

const envBlockedOpenIds = () => String(process.env.PERSON_FIELD_BLOCKED_OPEN_IDS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const blockedOpenIds = () => new Set([...DEFAULT_BLOCKED_OPEN_IDS, ...envBlockedOpenIds()]);

const personFieldPolicy = (tableKey, fieldKey) => {
  const table = PERSON_FIELDS[tableKey];
  if (!table) return null;
  return table[fieldKey] || null;
};

module.exports = {
  PERSON_FIELDS,
  DEFAULT_BLOCKED_OPEN_IDS,
  blockedOpenIds,
  personFieldPolicy,
};
