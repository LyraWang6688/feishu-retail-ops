'use strict';

/**
 * 修改已提交采购批次的纯对账逻辑：
 *   - 同一 product + size 存在 ⇒ 更新数量
 *   - 当前批次有、最新版没有 ⇒ 删除
 *   - 最新版有、当前批次没有 ⇒ 新增
 *
 * 不读写飞书、不生成单据；只把“当前明细 vs 最新版明细”算成计划。
 */
const keyOf = (productRecordId, size) => String(productRecordId || '').trim() + '|' + String(size ?? '').trim();

const flattenEntries = (items = []) => {
  const rows = [];
  for (const item of Array.isArray(items) ? items : []) {
    const productRecordId = String(item?.productRecordId ?? item?.product_record_id ?? '').trim();
    if (!productRecordId) continue;
    for (const entry of Array.isArray(item?.entries) ? item.entries : []) {
      const size = Number(entry?.size);
      const quantity = Number(entry?.quantity);
      if (!Number.isInteger(size) || !Number.isFinite(quantity) || quantity <= 0) continue;
      rows.push({
        productRecordId, size, quantity,
        source: item?.source === 'new' ? 'new' : 'replenish',
      });
    }
  }
  return rows;
};

const normalizeCurrent = (rows = []) => (Array.isArray(rows) ? rows : [])
  .map((row) => ({
    recordId: String(row.record_id || row.recordId || ''),
    productRecordId: String(row.product_record_id || row.productRecordId || '').trim(),
    size: Number(row.size),
    quantity: Number(row.quantity) || 0,
  }))
  .filter((row) => row.recordId && row.productRecordId && Number.isInteger(row.size) && row.quantity > 0);

const planModification = ({ currentItems = [], finalItems = [] } = {}) => {
  const current = normalizeCurrent(currentItems);
  const finalMap = new Map();
  for (const row of flattenEntries(finalItems)) {
    const key = keyOf(row.productRecordId, row.size);
    const previous = finalMap.get(key);
    finalMap.set(key, previous ? { ...previous, quantity: previous.quantity + row.quantity } : row);
  }
  const currentMap = new Map(current.map((row) => [keyOf(row.productRecordId, row.size), row]));
  const updates = [];
  const creates = [];
  const deletes = [];
  for (const [key, row] of finalMap) {
    const existing = currentMap.get(key);
    if (!existing) creates.push(row);
    else if (existing.quantity !== row.quantity) updates.push({ ...existing, quantity: row.quantity, source: row.source });
  }
  for (const [key, row] of currentMap) {
    if (!finalMap.has(key)) deletes.push(row);
  }
  const totalQuantity = [...finalMap.values()].reduce((sum, row) => sum + row.quantity, 0);
  return { current, final: [...finalMap.values()], updates, creates, deletes, totalQuantity };
};

module.exports = { keyOf, flattenEntries, planModification };
