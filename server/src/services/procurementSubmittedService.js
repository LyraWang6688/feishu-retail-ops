'use strict';

/**
 * 采购页「已报货」只读服务。
 *
 * 归属来自「供应主表.报货人」；可见/可修改判据：
 *   · 报货人包含当前登录人 open_id
 *   · 发生行为 = 报货（PURCHASE_ORDER）
 *   · 不限日期
 *
 * 列表只返回批次摘要；采购明细在用户展开某个批次时才读取，
 * 避免历史批次全量展示时的 N+1 查询。
 */
const { PURCHASE_BEHAVIORS } = require('../config/purchaseBehaviors');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { textValue, linkedRecordIds } = require('./v1BitableGateway');
const { dayStart } = require('./procurementPageData');

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

/** 人员字段的生产形状是 [{ id, name, ... }]；不要只认关联字段的 record_ids。 */
const personIdsOf = (value) => {
  if (Array.isArray(value)) return value.flatMap(personIdsOf);
  if (!value || typeof value !== 'object') return [];
  return typeof value.id === 'string' && value.id ? [value.id] : [];
};

const createProcurementSubmittedService = ({
  gateway, purchaseQuery, now = () => Date.now(),
} = {}) => {
  if (!gateway) throw new Error('procurementSubmittedService 需要 gateway');
  if (!purchaseQuery) throw new Error('procurementSubmittedService 需要 purchaseQuery');

  const batchFields = () => V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields;
  const behaviorFields = () => V1_BITABLE_SCHEMA.tables.behavior.fields;

  const behaviorCodeById = async () => {
    const codes = new Map();
    for (const row of (await gateway.listAll('behavior')) || []) {
      const code = textValue(row?.fields?.[behaviorFields().code]).trim();
      if (row?.record_id && code) codes.set(String(row.record_id), code);
    }
    return codes;
  };

  const summaryOf = (batch, codes) => {
    const fields = batchFields();
    const behaviorCodes = linkedRecordIds(batch?.fields?.[fields.behavior])
      .map((id) => codes.get(String(id)))
      .filter(Boolean);
    return {
      batch_no: textValue(batch?.fields?.[fields.batchNo]).trim(),
      supplier_name: textValue(batch?.fields?.[fields.supplier]).trim(),
      submitted_at: Number(batch?.fields?.[fields.createdAt]) || null,
      is_order: behaviorCodes.includes(PURCHASE_BEHAVIORS.order),
      is_reporter: personIdsOf(batch?.fields?.[fields.reportedBy]),
      record_id: batch?.record_id || '',
    };
  };

  const findBatch = async (batchNo) => {
    const wanted = String(batchNo || '').trim();
    if (!wanted) return null;
    const rows = (await gateway.listAll('purchaseOrderBatch')) || [];
    return rows.find((row) => textValue(row?.fields?.[batchFields().batchNo]).trim() === wanted) || null;
  };

  const listSubmitted = async ({ openId, offset = 0, limit = 20 } = {}) => {
    const open = String(openId || '').trim();
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    if (!open) return { batches: [], total: 0, offset: safeOffset, limit: safeLimit };

    const [batches, codes] = await Promise.all([
      gateway.listAll('purchaseOrderBatch'),
      behaviorCodeById(),
    ]);
    const todayStart = dayStart(now(), 480);
    const todayEnd = todayStart + 24 * 60 * 60 * 1000;
    const rows = (batches || [])
      .map((batch) => summaryOf(batch, codes))
      .filter((row) => row.batch_no && row.is_order && row.is_reporter.includes(open))
      .map(({ is_order, is_reporter, ...row }) => ({
        ...row,
        is_today: row.submitted_at != null && row.submitted_at >= todayStart && row.submitted_at < todayEnd,
      }))
      .sort((a, b) => (Number(b.submitted_at) || 0) - (Number(a.submitted_at) || 0)
        || String(b.batch_no).localeCompare(String(a.batch_no), 'zh-Hans-CN', { numeric: true }));

    return {
      batches: rows.slice(safeOffset, safeOffset + safeLimit),
      total: rows.length,
      offset: safeOffset,
      limit: safeLimit,
    };
  };

  const getBatchDetail = async ({ openId, batchNo } = {}) => {
    const open = String(openId || '').trim();
    const batch = await findBatch(batchNo);
    if (!batch || !open) return null;
    const codes = await behaviorCodeById();
    const summary = summaryOf(batch, codes);
    if (!summary.batch_no || !summary.is_order || !summary.is_reporter.includes(open)) return null;

    const rows = await purchaseQuery.listPurchaseRequestsForBatch({ batchNo: summary.batch_no });
    const orderRows = (rows || []).filter((row) => row.behavior_code === PURCHASE_BEHAVIORS.order);
    const products = groupProducts(orderRows);
    return {
      batch_no: summary.batch_no,
      supplier_record_id: orderRows[0]?.supplier_record_id || '',
      supplier_name: summary.supplier_name || orderRows[0]?.supplier_name || '',
      submitted_at: summary.submitted_at,
      product_count: products.length,
      total_quantity: products.reduce((sum, product) => sum + product.entries.reduce((n, entry) => n + entry.quantity, 0), 0),
      products,
    };
  };

  return { listSubmitted, getBatchDetail };
};

module.exports = { createProcurementSubmittedService };
