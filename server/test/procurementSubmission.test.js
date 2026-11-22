'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { createProcurementSubmissionIndex } = require('../src/services/procurementSubmissionIndex');
const { createProcurementSubmittedService } = require('../src/services/procurementSubmittedService');
const { PURCHASE_BEHAVIORS } = require('../src/config/purchaseBehaviors');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'proc-submission-'));
const NOW = Date.parse('2026-11-22T09:00:00Z');

test('提交归属索引：按当前用户、今天过滤，重复记录幂等', async () => {
  const dir = tempDir();
  const store = new JsonTaskStore({ dir, idField: 'submission_id' });
  const index = createProcurementSubmissionIndex({ store, now: () => NOW, offsetMinutes: 480 });
  await index.record({ openId: 'ou_a', batchNo: 'CGD-1', submittedAt: '2026-11-22T08:10:00Z', requestIds: ['r1'] });
  await index.record({ openId: 'ou_a', batchNo: 'CGD-2', submittedAt: '2026-11-21T08:10:00Z' });
  await index.record({ openId: 'ou_b', batchNo: 'CGD-3', submittedAt: '2026-11-22T08:10:00Z' });
  await index.record({ openId: 'ou_a', batchNo: 'CGD-1', submittedAt: '2026-11-22T08:11:00Z' });
  const rows = await index.listToday('ou_a');
  assert.deepEqual(rows.map((row) => row.batch_no), ['CGD-1']);
  assert.equal(rows[0].request_ids[0], 'r1');
  assert.equal((await store.list()).length, 3);
});

test('旧采购任务回补：只补当前用户、今天、采购页任务', async () => {
  const dir = tempDir();
  const store = new JsonTaskStore({ dir, idField: 'submission_id' });
  const tasks = [
    { task_id: 'scan_replenish_procurement_a', status: 'posted', batch_no: 'CGD-OLD-1', updated_at: '2026-11-22T08:25:30Z', draft: { operator_open_id: 'ou_a' } },
    { task_id: 'scan_replenish_other', status: 'posted', batch_no: 'CGD-OLD-2', updated_at: '2026-11-22T08:25:30Z', draft: { operator_open_id: 'ou_a' } },
    { task_id: 'scan_replenish_procurement_b', status: 'posted', batch_no: 'CGD-OLD-3', updated_at: '2026-11-22T08:25:30Z', draft: { operator_open_id: 'ou_b' } },
  ];
  const index = createProcurementSubmissionIndex({ store, replenishTaskStore: { list: async () => tasks }, now: () => NOW, offsetMinutes: 480 });
  const rows = await index.listToday('ou_a');
  assert.deepEqual(rows.map((row) => row.batch_no), ['CGD-OLD-1']);
});

test('今日已提交：只返回发生行为=报货的批次，并按货品合并尺码', async () => {
  const rows = [
    { batch_no: 'CGD-1', behavior_code: PURCHASE_BEHAVIORS.order, product_record_id: 'p1', product_item_no: 'A1', product_color: '黑色', size: 40, quantity: 2, supplier_record_id: 's1', supplier_name: '供应商A' },
    { batch_no: 'CGD-1', behavior_code: PURCHASE_BEHAVIORS.order, product_record_id: 'p1', product_item_no: 'A1', product_color: '黑色', size: 39, quantity: 1, supplier_record_id: 's1', supplier_name: '供应商A' },
    { batch_no: 'CGD-1', behavior_code: PURCHASE_BEHAVIORS.order, product_record_id: 'p2', product_item_no: 'A2', product_color: '白色', size: 41, quantity: 1, supplier_record_id: 's1', supplier_name: '供应商A' },
    { batch_no: 'CGD-2', behavior_code: PURCHASE_BEHAVIORS.inbound, product_record_id: 'p3', size: 42, quantity: 9 },
  ];
  const service = createProcurementSubmittedService({
    submissionIndex: { listToday: async () => [
      { batch_no: 'CGD-1', submitted_at: '2026-11-22T08:10:00Z' },
      { batch_no: 'CGD-2', submitted_at: '2026-11-22T08:20:00Z' },
    ] },
    purchaseQuery: { listPurchaseRequestsForBatch: async ({ batchNo }) => rows.filter((row) => row.batch_no === batchNo) },
  });
  const batches = await service.listToday({ openId: 'ou_a' });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].batch_no, 'CGD-1');
  assert.equal(batches[0].product_count, 2);
  assert.equal(batches[0].total_quantity, 4);
  assert.deepEqual(batches[0].products[0].entries, [{ size: 39, quantity: 1 }, { size: 40, quantity: 2 }]);
});
