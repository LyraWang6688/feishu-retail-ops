'use strict';

/**
 * ⭐ 2026-11-12（业务负责人）：验收时上传的「验收单」→ 主表「对方单据」附件列。
 * 追加、不覆盖；同一 file_token 重试幂等。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { PurchaseOrderBatchService } = require('../src/services/purchaseOrderBatchService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const table = (key) => V1_BITABLE_SCHEMA.tables[key];

test('AC-DOC1 ⭐ 验收单追加进「对方单据」：保留已有附件、重复 token 不重复写', async () => {
  const writes = [];
  let batch = {
    record_id: 'batch_1',
    fields: {
      报货批次号: 'CGD-DOC-0001',
      对方单据: [{ file_token: 'old_token', name: '旧验收单.jpg' }],
    },
  };
  const gateway = {
    table,
    listAll: async () => [batch],
    get: async () => batch,
    update: async (tableKey, recordId, values) => {
      writes.push({ tableKey, recordId, values });
      const field = table(tableKey).fields.counterpartyDocument;
      batch = { ...batch, fields: { ...batch.fields, [field]: values.counterpartyDocument } };
      return {};
    },
  };
  const service = new PurchaseOrderBatchService({ gateway });

  const first = await service.writeCounterpartyDocument({
    batchNo: 'CGD-DOC-0001',
    documents: [{ fileToken: 'new_token', fileName: '验收单1.jpg' }],
  });
  assert.equal(first.written, true);
  assert.equal(first.document_count, 2);
  assert.deepEqual(writes[0].values.counterpartyDocument, [
    { file_token: 'old_token' },
    { file_token: 'new_token' },
  ], '已有附件原样保留 + 追加新验收单 ✓');
  assert.equal(table('purchaseOrderBatch').fields.counterpartyDocument, '对方单据', '语义映射 = 对方单据 ✓');

  const repeat = await service.writeCounterpartyDocument({
    batchNo: 'CGD-DOC-0001',
    documents: [{ fileToken: 'new_token', fileName: '验收单1.jpg' }],
  });
  assert.equal(repeat.written, false);
  assert.equal(repeat.skipped, true, '同一 file_token 重试 ⇒ 幂等跳过 ✓');
  assert.equal(writes.length, 1, '重试不重复写库 ✓');
});
