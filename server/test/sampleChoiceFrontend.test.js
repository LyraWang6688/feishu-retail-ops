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

test('AC-SAMPLE-FRONT3 验收明细页转换后的 camelCase 字段也能识别', () => {
  const products = sampleChoiceProducts({
    rows: [{
      product_record_id: 'p1', itemNo: 'YA8902', color: '黑色',
      needsSampleChoice: true, hasStock: false, hasSample: false,
    }, {
      product_record_id: 'p2', itemNo: 'A1', color: '黑',
      needsSampleChoice: false, hasStock: true, hasSample: true,
    }],
    lines: [
      { productRecordId: 'p1', size: 39, quantity: 1 },
      { productRecordId: 'p2', size: 40, quantity: 1 },
    ],
  });
  assert.equal(products.length, 1, 'camelCase 的 needsSampleChoice 必须能触发弹窗');
  assert.equal(products[0].productRecordId, 'p1');
  assert.equal(products[0].itemNo, 'YA8902', 'camelCase itemNo 必须显示在弹窗标题');
  assert.equal(products[0].hasStock, false);
  assert.deepEqual(products[0].candidates.map((item) => item.size), [39]);
});

test('AC-SAMPLE-FRONT4 弹窗产品顺序 = 货号 → 颜色 → productId', () => {
  const products = sampleChoiceProducts({
    rows: [
      { product_record_id: 'p-ya', itemNo: 'YA8902', color: '黑色', needsSampleChoice: true },
      { product_record_id: 'p-8905', itemNo: 'A8905', color: '黑色', needsSampleChoice: true },
      { product_record_id: 'p-2601', itemNo: '2601', color: '咖啡色', needsSampleChoice: true },
    ],
    lines: [
      { productRecordId: 'p-ya', size: 40, quantity: 1 },
      { productRecordId: 'p-8905', size: 39, quantity: 1 },
      { productRecordId: 'p-2601', size: 38, quantity: 1 },
    ],
  });
  assert.deepEqual(products.map((item) => item.itemNo), ['2601', 'A8905', 'YA8902']);
});
