'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProcurementModifyService } = require('../src/services/procurementModifyService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

test('修改批次：更新数量 / 删除明细 / 新增明细 / 重算录入数量 / 进入出单回调', async () => {
  const calls = { updates: [], deletes: [], creates: [], deliveries: [] };
  const current = [
    { record_id: 'd1', product_record_id: 'p1', product_item_no: 'A1', product_color: '黑', size: 40, quantity: 2, supplier_record_id: 's1', supplier_name: '供应商A', behavior_code: 'PURCHASE_ORDER' },
    { record_id: 'd2', product_record_id: 'p1', product_item_no: 'A1', product_color: '黑', size: 41, quantity: 1, supplier_record_id: 's1', supplier_name: '供应商A', behavior_code: 'PURCHASE_ORDER' },
  ];
  const gateway = {
    table: (key) => ({ ...(V1_BITABLE_SCHEMA.tables[key] || {}), tableName: key, fields: { ...(V1_BITABLE_SCHEMA.tables[key]?.fields || {}), idempotencyKey: '幂等键' } }),
    listAll: async () => [],
    create: async (table, values) => { calls.creates.push({ table, values }); return { recordId: 'new1' }; },
    update: async (table, id, values) => { calls.updates.push({ table, id, values }); return { ok: true }; },
    delete: async (table, id) => { calls.deletes.push({ table, id }); return true; },
    get: async () => ({ fields: { '销售明细': [] } }),
    getBatch: async (table) => (table === 'product' ? [{ record_id: 'p2', fields: {
      [V1_BITABLE_SCHEMA.tables.product.fields.number]: 'B2',
      [V1_BITABLE_SCHEMA.tables.product.fields.itemNo]: 'B2',
      [V1_BITABLE_SCHEMA.tables.product.fields.color]: '白',
      [V1_BITABLE_SCHEMA.tables.product.fields.supplier]: [{ record_ids: ['s1'] }],
    } }] : []),
  };
  const service = createProcurementModifyService({
    gateway,
    schema: V1_BITABLE_SCHEMA,
    submissionIndex: { listToday: async () => [{ batch_no: 'CGD-1' }] },
    purchaseQuery: { listPurchaseRequestsForBatch: async () => current },
    orderBatches: { findByBatchNo: async () => ({ record_id: 'b1', fields: {} }) },
    sizeReferences: { resolveByNumber: async (size) => ({ recordId: 'sz' + size }) },
    deliverRevision: async (payload) => { calls.deliveries.push(payload); return { sent: ['供应商A'] }; },
  });
  const result = await service.modify({
    openId: 'ou_a', batchNo: 'CGD-1', submitKey: 'k1',
    items: [
      { productRecordId: 'p1', entries: [{ size: 40, quantity: 3 }, { size: 41, quantity: 0 }] },
      { productRecordId: 'p2', entries: [{ size: 38, quantity: 2 }] },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.updates.map((row) => [row.table, row.id, row.values]), [
    ['purchaseRequest', 'd1', { quantity: 3 }],
    ['purchaseOrderBatch', 'b1', { quantity: 5 }],
  ]);
  assert.deepEqual(calls.deletes, [{ table: 'purchaseRequest', id: 'd2' }]);
  assert.equal(calls.creates.length, 1);
  assert.equal(calls.creates[0].values.quantity, 2);
  assert.equal(calls.creates[0].values.detailId, 'CGD-1-01', '新增明细必须续排采购明细ID');
  assert.equal(calls.deliveries[0].batchNo, 'CGD-1');
  assert.equal(calls.deliveries[0].items[1].product_item_no, 'B2', '新增明细展示字段必须走归一化');
  assert.equal(calls.deliveries[0].totalQuantity, 5);
  assert.equal(calls.deliveries[0].items.length, 2);
});

test('修改批次：非今天归属 / 空批次 / 跨供应商都拒绝', async () => {
  const base = {
    gateway: { get: async () => ({ fields: { '销售明细': [] } }), getBatch: async () => [] },
    schema: V1_BITABLE_SCHEMA,
    submissionIndex: { listToday: async () => [] },
    purchaseQuery: { listPurchaseRequestsForBatch: async () => [] },
    orderBatches: { findByBatchNo: async () => null },
    sizeReferences: {},
  };
  const service = createProcurementModifyService(base);
  assert.equal((await service.modify({ openId: 'ou_a', batchNo: 'x', items: [] })).code, 'not_modifiable');
});
