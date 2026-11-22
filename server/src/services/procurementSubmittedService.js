'use strict';

/**
 * 采购页「今日已提交」只读服务。
 *
 * 归属来自本地 procurementSubmissionIndex（飞书供应主表没有提交人字段）；
 * 明细从既有 PurchaseQueryService 按批次回读，不新造第二套采购查询。
 */
const { PURCHASE_BEHAVIORS } = require('../config/purchaseBehaviors');

const groupProducts = (rows) => {
  const products = new Map();
  for (const row of rows || []) {
    const key = String(row.product_record_id || '');
    if (!key) continue;
    if (!products.has(key)) {
      products.set(key, {
        product_record_id: key,
        item_no: row.product_item_no || '',
        number: row.product_number || '',
        color: row.product_color || '',
        entries: [],
      });
    }
    products.get(key).entries.push({ size: Number(row.size), quantity: Number(row.quantity) || 0 });
  }
  return [...products.values()]
    .map((product) => ({
      ...product,
      entries: product.entries
        .filter((entry) => Number.isFinite(entry.size) && entry.quantity > 0)
        .sort((a, b) => a.size - b.size),
    }))
    .filter((product) => product.entries.length)
    .sort((a, b) => String(a.item_no || a.number).localeCompare(String(b.item_no || b.number), 'zh-Hans-CN', { numeric: true }));
};

const createProcurementSubmittedService = ({ submissionIndex, purchaseQuery }) => {
  if (!submissionIndex) throw new Error('procurementSubmittedService 需要 submissionIndex');
  if (!purchaseQuery) throw new Error('procurementSubmittedService 需要 purchaseQuery');

  const listToday = async ({ openId } = {}) => {
    const records = await submissionIndex.listToday(openId);
    const batches = [];
    for (const record of records) {
      const batchNo = String(record?.batch_no || '').trim();
      if (!batchNo) continue;
      const rows = await purchaseQuery.listPurchaseRequestsForBatch({ batchNo });
      const orderRows = rows.filter((row) => row.behavior_code === PURCHASE_BEHAVIORS.order);
      if (!orderRows.length) continue;
      const products = groupProducts(orderRows);
      if (!products.length) continue;
      const first = orderRows[0];
      batches.push({
        batch_no: batchNo,
        submitted_at: record.submitted_at,
        supplier_record_id: first.supplier_record_id || '',
        supplier_name: first.supplier_name || '',
        product_count: products.length,
        total_quantity: products.reduce((sum, product) => sum + product.entries.reduce((n, entry) => n + entry.quantity, 0), 0),
        products,
      });
    }
    return batches.sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)));
  };

  return { listToday };
};

module.exports = { createProcurementSubmittedService };
