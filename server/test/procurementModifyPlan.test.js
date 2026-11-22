'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planModification } = require('../src/services/procurementModifyPlan');

test('修改批次对账：更新 / 新增 / 删除 / 合计', () => {
  const plan = planModification({
    currentItems: [
      { record_id: 'd1', product_record_id: 'p1', size: 40, quantity: 2 },
      { record_id: 'd2', product_record_id: 'p1', size: 41, quantity: 1 },
      { record_id: 'd3', product_record_id: 'p2', size: 39, quantity: 3 },
    ],
    finalItems: [
      { productRecordId: 'p1', entries: [{ size: 40, quantity: 1 }, { size: 41, quantity: 1 }] },
      { productRecordId: 'p2', entries: [{ size: 40, quantity: 2 }] },
      { productRecordId: 'p3', entries: [{ size: 38, quantity: 1 }] },
    ],
  });
  assert.deepEqual(plan.updates.map((row) => [row.recordId, row.quantity]), [['d1', 1]]);
  assert.deepEqual(plan.deletes.map((row) => row.recordId), ['d3']);
  assert.equal(plan.creates.length, 2);
  assert.equal(plan.totalQuantity, 5);
});

test('修改批次对账：最终数量为 0/负数不保留，重复条目合并', () => {
  const plan = planModification({
    currentItems: [{ record_id: 'd1', product_record_id: 'p1', size: 40, quantity: 2 }],
    finalItems: [
      { productRecordId: 'p1', entries: [{ size: 40, quantity: 1 }, { size: 40, quantity: 2 }] },
      { productRecordId: 'p1', entries: [{ size: 41, quantity: 0 }] },
    ],
  });
  assert.equal(plan.updates[0].quantity, 3);
  assert.equal(plan.deletes.length, 0);
});
