'use strict';

/**
 * 2026-11-19：验收「逐码实际到货」的纯计划函数（从 purchaseArrivalConversationService 拆出）。
 * 保留原有校验：货品必须在申请行里；自定义尺码只允许本批已有的货品。
 * 返回形状与 buildPlan 的扫码分支逐字一致。
 */
const keyOf = (productRecordId, size) => `${productRecordId}|${Number(size)}`;

const buildScanPlan = (rows, scanLines) => {
  const byKey = new Map();
  for (const row of rows) {
    const key = keyOf(row.product_record_id, row.size);
    if (byKey.has(key)) return { ok: false, reason: 'duplicate_request_rows' };
    byKey.set(key, row);
  }
  const actualById = new Map(rows.map((row) => [row.request_record_id, 0]));
  const hit = new Set();
  const customSeen = new Set();
  const extras = [];
  for (const scan of scanLines) {
    const row = byKey.get(keyOf(scan?.product_record_id, scan?.size));
    if (!row) {
      const productRecordId = String(scan?.product_record_id || '').trim();
      const base = rows.find((item) => String(item?.product_record_id || '').trim() === productRecordId);
      if (!base) return { ok: false, reason: 'scan_not_in_batch' };
      const size = Number(scan?.size);
      const customKey = keyOf(productRecordId, size);
      if (customSeen.has(customKey)) return { ok: false, reason: 'scan_duplicated' };
      const quantity = Number(scan?.quantity);
      if (!Number.isSafeInteger(quantity) || quantity < 0) {
        return { ok: false, reason: 'actual_not_positive' };
      }
      customSeen.add(customKey);
      extras.push({ ...base, request_record_id: `custom:${productRecordId}|${size}`, size, quantity: 0, actual: quantity, custom: true });
      continue;
    }
    if (hit.has(row.request_record_id)) return { ok: false, reason: 'scan_duplicated' };
    const quantity = Number(scan?.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      return { ok: false, reason: 'actual_not_positive' };
    }
    hit.add(row.request_record_id);
    actualById.set(row.request_record_id, quantity);
  }
  const scanned = rows.map((row) => ({ ...row, actual: actualById.get(row.request_record_id) }));
  if (scanned.some((row) => !Number.isSafeInteger(row.actual) || row.actual < 0)) {
    return { ok: false, reason: 'actual_not_positive' };
  }
  return { ok: true, rows: [...scanned, ...extras], differences: [] };
};

module.exports = { buildScanPlan };
