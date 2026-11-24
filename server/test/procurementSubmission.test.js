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
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

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

test('已报货：按报货人 + 发生行为=报货筛选，不限日期；摘要不读明细，明细懒加载', async () => {
  const batchFields = V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields;
  const behaviorFields = V1_BITABLE_SCHEMA.tables.behavior.fields;
  const batches = [
    { record_id: 'b1', fields: {
      [batchFields.batchNo]: 'CGD-1', [batchFields.behavior]: [{ record_ids: ['bh_order'] }],
      [batchFields.reportedBy]: [{ id: 'ou_a', name: '赵瑞玲' }],
      [batchFields.createdAt]: Date.parse('2026-11-22T08:10:00Z'), [batchFields.supplier]: '供应商A',
    } },
    { record_id: 'b2', fields: {
      [batchFields.batchNo]: 'CGD-2', [batchFields.behavior]: [{ record_ids: ['bh_in'] }],
      [batchFields.reportedBy]: [{ id: 'ou_a' }],
      [batchFields.createdAt]: Date.parse('2026-11-22T08:20:00Z'), [batchFields.supplier]: '供应商A',
    } },
    { record_id: 'b3', fields: {
      [batchFields.batchNo]: 'CGD-3', [batchFields.behavior]: [{ record_ids: ['bh_order'] }],
      [batchFields.reportedBy]: [{ id: 'ou_a' }],
      [batchFields.createdAt]: Date.parse('2026-11-21T08:10:00Z'), [batchFields.supplier]: '供应商B',
    } },
    { record_id: 'b4', fields: {
      [batchFields.batchNo]: 'CGD-4', [batchFields.behavior]: [{ record_ids: ['bh_order'] }],
      [batchFields.reportedBy]: [{ id: 'ou_b' }],
      [batchFields.createdAt]: Date.parse('2026-11-22T08:30:00Z'), [batchFields.supplier]: '供应商C',
    } },
    { record_id: 'b5', fields: {
      [batchFields.batchNo]: 'CGD-5', [batchFields.behavior]: [{ record_ids: ['bh_order'] }],
      [batchFields.reportedBy]: [], [batchFields.createdAt]: Date.parse('2026-11-22T08:40:00Z'), [batchFields.supplier]: '供应商D',
    } },
  ];
  const detailRows = [
    { batch_no: 'CGD-1', behavior_code: PURCHASE_BEHAVIORS.order, product_record_id: 'p1', product_item_no: 'A1', product_color: '黑色', size: 40, quantity: 2, supplier_record_id: 's1', supplier_name: '供应商A' },
    { batch_no: 'CGD-1', behavior_code: PURCHASE_BEHAVIORS.order, product_record_id: 'p1', product_item_no: 'A1', product_color: '黑色', size: 39, quantity: 1, supplier_record_id: 's1', supplier_name: '供应商A' },
    { batch_no: 'CGD-1', behavior_code: PURCHASE_BEHAVIORS.order, product_record_id: 'p2', product_item_no: 'A2', product_color: '白色', size: 41, quantity: 1, supplier_record_id: 's1', supplier_name: '供应商A' },
  ];
  let detailCalls = 0;
  const gateway = {
    async listAll(key) {
      if (key === 'purchaseOrderBatch') return batches;
      if (key === 'behavior') return [
        { record_id: 'bh_order', fields: { [behaviorFields.code]: PURCHASE_BEHAVIORS.order } },
        { record_id: 'bh_in', fields: { [behaviorFields.code]: PURCHASE_BEHAVIORS.inbound } },
      ];
      return [];
    },
  };
  const service = createProcurementSubmittedService({
    gateway,
    purchaseQuery: { listPurchaseRequestsForBatch: async ({ batchNo }) => { detailCalls += 1; return detailRows.filter((row) => row.batch_no === batchNo); } },
    now: () => NOW,
  });
  const out = await service.listSubmitted({ openId: 'ou_a', limit: 20 });
  assert.equal(out.total, 2);
  assert.deepEqual(out.batches.map((row) => row.batch_no), ['CGD-1', 'CGD-3']);
  assert.equal(out.batches[0].is_today, true);
  assert.equal(out.batches[1].is_today, false);
  assert.equal(detailCalls, 0, '摘要列表不允许读明细');
  const detail = await service.getBatchDetail({ openId: 'ou_a', batchNo: 'CGD-1' });
  assert.equal(detail.product_count, 2);
  assert.equal(detail.total_quantity, 4);
  assert.deepEqual(detail.products[0].entries, [{ size: 39, quantity: 1 }, { size: 40, quantity: 2 }]);
  assert.equal(await service.getBatchDetail({ openId: 'ou_b', batchNo: 'CGD-1' }), null, '不是报货人不能读明细');
});
