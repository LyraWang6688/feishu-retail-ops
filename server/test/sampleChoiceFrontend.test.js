'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sampleChoiceProducts } = require('../public/workbench/features/orders/acceptanceDoc.js');

const row = (id, needs, hasStock) => ({
  product_record_id: id, item_no: 'A1', color: '黑', needs_sample_choice: needs, has_stock: hasStock,
});

test('AC-SAMPLE-FRONT1 只要需要选的编号；候选只来自本次入库行，按尺码排序', () => {
  const products = sampleChoiceProducts({
    rows: [row('p1', true, false), row('p2', true, true), row('p3', false, true)],
    lines: [
      { productRecordId: 'p1', size: 42, quantity: 1 },
      { productRecordId: 'p1', size: 40, quantity: 2 },
      { productRecordId: 'p2', size: 39, quantity: 1 },
      { productRecordId: 'p3', size: 38, quantity: 1 },
    ],
  });
  assert.equal(products.length, 2, 'p3 已有样品 ⇒ 不需要选');
  assert.equal(products[0].productRecordId, 'p1');
  assert.deepEqual(products[0].candidates.map((item) => item.size), [40, 42]);
  assert.equal(products[0].hasStock, false);
  assert.equal(products[1].productRecordId, 'p2');
  assert.equal(products[1].hasStock, true);
});

test('AC-SAMPLE-FRONT2 数量 0 不会进候选；没有需要选的编号返回空', () => {
  assert.deepEqual(sampleChoiceProducts({
    rows: [row('p1', true, false)],
    lines: [{ productRecordId: 'p1', size: 40, quantity: 1 }],
  }).length, 1);
  assert.deepEqual(sampleChoiceProducts({
    rows: [row('p1', false, true)],
    lines: [{ productRecordId: 'p1', size: 40, quantity: 1 }],
  }), []);
});
