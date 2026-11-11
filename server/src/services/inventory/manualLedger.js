'use strict';

/**
 * 人工调整写「库存流水」。
 *
 * 口径（业务负责人 2026-11-12）：
 *   · 所有手工调整都要同时改「实时库存」和「库存流水」；
 *   · 状态调整的「变动数量」= 0；
 *   · 当季调整只改 liveInventory.当季，不改所属状态；流水行为用
 *     当季=true → STOCK_RELEASE，当季=false → STOCK_FREEZE；
 *   · 状态调整按**最终状态**选行为：
 *     最终门盒 → STOCK_TO_DOORBOX；最终样品 → STOCK_TO_SAMPLE
 *     （包括空状态改成门盒/样品）。
 */
const { relation } = require('../v1ReferenceResolver');

const writeManualLedger = async ({
  inventory, changes = [], operatorOpenId = '', correlation,
} = {}) => {
  const list = (Array.isArray(changes) ? changes : []).filter((item) => item?.record_id && item?.behaviorCode);
  if (!list.length) return [];
  const gateway = inventory.gateway;
  const behaviorIds = new Map();
  for (const code of new Set(list.map((item) => item.behaviorCode))) {
    const behavior = await inventory.resolveStockBehavior(code);
    behaviorIds.set(code, behavior.recordId);
  }
  const fields = gateway.table('liveInventory').fields;
  const rows = list.map((item) => ({
    product: relation(item.productRecordId),
    size: relation(item.sizeRecordId),
    quantityChange: 0,
    behavior: relation(behaviorIds.get(item.behaviorCode)),
    ...(operatorOpenId ? { operator: [{ id: operatorOpenId }] } : {}),
  }));
  const table = gateway.table('inventoryLedger');
  const fieldNames = table?.fields || {};
  // 只写确实映射过的语义字段；operator 只在 schema 有映射时写。
  for (const row of rows) {
    if (!fieldNames.operator) delete row.operator;
  }
  const options = correlation ? { correlation } : undefined;
  if (typeof gateway.createBatch === 'function') {
    const created = await gateway.createBatch('inventoryLedger', rows, options);
    return Array.isArray(created) ? created : [];
  }
  const created = [];
  for (const row of rows) created.push(await gateway.create('inventoryLedger', row, options));
  return created;
};

module.exports = { writeManualLedger };
