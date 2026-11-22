#!/usr/bin/env node
'use strict';

/**
 * 采购批次只读体检：重复明细 / 缺失采购明细ID / 我方单据残留。
 * 只读，不写任何表。确认后再另写修复脚本。
 *
 * 用法：node scripts/audit_procurement_batch.js --batch CGD-20261122-0002
 */
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
const { V1BitableGateway } = require('../src/services/v1BitableGateway');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { textValue } = require('../src/services/v1BitableGateway');
const { strictLinkedRecordIds } = require('../src/services/strictLinkIds');

const argOf = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
};

(async () => {
  const batchNo = argOf('--batch');
  if (!batchNo) throw new Error('缺少 --batch，例如 --batch CGD-20261122-0002');
  const gateway = new V1BitableGateway();
  const batchFields = V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields;
  const requestFields = V1_BITABLE_SCHEMA.tables.purchaseRequest.fields;
  const batches = await gateway.listAll('purchaseOrderBatch', { refresh: true });
  const batch = (batches || []).find((row) => textValue(row.fields?.[batchFields.batchNo]).trim() === batchNo);
  if (!batch) throw new Error('找不到采购批次：' + batchNo);
  const requests = await gateway.listAll('purchaseRequest', { refresh: true });
  const rows = (requests || []).filter((row) => strictLinkedRecordIds(row.fields?.[requestFields.batchNo]).includes(batch.record_id));
  const counts = new Map();
  for (const row of rows) {
    const key = [strictLinkedRecordIds(row.fields?.[requestFields.product])[0] || '', strictLinkedRecordIds(row.fields?.[requestFields.size])[0] || ''].join('|');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const report = {
    batch_no: batchNo,
    batch_record_id: batch.record_id,
    batch_quantity: textValue(batch.fields?.[batchFields.quantity]),
    document_names: (Array.isArray(batch.fields?.[batchFields.document]) ? batch.fields[batchFields.document] : []).map((item) => item?.name || item?.file_name || ''),
    detail_count: rows.length,
    missing_detail_id: rows.filter((row) => !textValue(row.fields?.[requestFields.detailId]).trim()).map((row) => row.record_id),
    duplicate_groups: [...counts.entries()].filter(([, count]) => count > 1).map(([key, count]) => ({ product_size: key, count })),
    rows: rows.map((row) => ({
      record_id: row.record_id,
      detail_id: textValue(row.fields?.[requestFields.detailId]).trim(),
      product_record_id: strictLinkedRecordIds(row.fields?.[requestFields.product])[0] || '',
      size_record_id: strictLinkedRecordIds(row.fields?.[requestFields.size])[0] || '',
      quantity: textValue(row.fields?.[requestFields.quantity]),
      idempotency_key: textValue(row.fields?.[requestFields.idempotencyKey]).trim(),
    })),
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.missing_detail_id.length || report.duplicate_groups.length) process.exitCode = 2;
})().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
