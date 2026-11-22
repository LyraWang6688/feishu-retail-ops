'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProcurementModifySalesLinks } = require('../src/services/procurementModifySalesLinks');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { PROCUREMENT_PAGE } = require('../src/config/procurementPage');

test('补销售关联：只取未关联、按销售日旧到新、按需补足', async () => {
  const calls = [];
  const gateway = {
    listByFilter: async () => [
      { record_id: 's1', fields: { 编号: [{ record_ids: ['p1'] }], 尺码: 40, 销售日: 3, 采购明细: [] } },
      { record_id: 's2', fields: { 编号: [{ record_ids: ['p1'] }], 尺码: 40, 销售日: 1, 采购明细: [] } },
      { record_id: 's3', fields: { 编号: [{ record_ids: ['p1'] }], 尺码: 40, 销售日: 2, 采购明细: [] } },
      { record_id: 's4', fields: { 编号: [{ record_ids: ['p1'] }], 尺码: 40, 销售日: 0, 采购明细: [{ record_ids: ['d0'] }] } },
    ],
    update: async (table, id, values) => { calls.push({ table, id, values }); },
  };
  const helper = createProcurementModifySalesLinks({ gateway, schema: V1_BITABLE_SCHEMA, config: PROCUREMENT_PAGE });
  const result = await helper.apply([{ recordId: 'd1', productRecordId: 'p1', size: 40, quantity: 2, source: 'replenish' }]);
  assert.equal(result.linked, 2);
  assert.deepEqual(calls.map((row) => row.id), ['s2', 's3']);
  assert.deepEqual(calls[0].values, { purchaseDetail: ['d1'] });
});

test('补销售关联：上新跳过、已有足量不重复', async () => {
  const calls = [];
  const gateway = { listByFilter: async () => [], update: async (...args) => calls.push(args) };
  const helper = createProcurementModifySalesLinks({ gateway, schema: V1_BITABLE_SCHEMA, config: PROCUREMENT_PAGE });
  const result = await helper.apply([{ recordId: 'd1', productRecordId: 'p1', size: 40, quantity: 2, source: 'new' }]);
  assert.equal(result.linked, 0);
  assert.equal(calls.length, 0);
});
