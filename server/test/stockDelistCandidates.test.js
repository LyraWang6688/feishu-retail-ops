'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { stockTotalsOf, delistCandidatesOf, printableProductsOf } = require('../src/services/stockDelistCandidates');

const productField = V1_BITABLE_SCHEMA.tables.liveInventory.fields.product;
const live = (id, productId) => ({ record_id: id, fields: { [productField]: [{ record_ids: [productId] }] } });

test('库存清零候选：按整个货品所有尺码/状态汇总，扣到 0 才算', () => {
  const records = [live('l1', 'p1'), live('l2', 'p1'), live('l3', 'p2')];
  assert.deepEqual([...stockTotalsOf(records)], [['p1', 2], ['p2', 1]]);
  const out = delistCandidatesOf({
    liveRecords: records,
    items: [{ productRecordId: 'p1', quantity: 2 }, { productRecordId: 'p2', quantity: 1 }],
  });
  assert.deepEqual(out.map((item) => item.productRecordId), ['p1', 'p2']);
  assert.equal(out[0].currentStock, 2);
  assert.equal(out[0].remaining, 0);
});

test('库存清零候选：还有库存 / 已下架 / 数量超出都不算', () => {
  const records = [live('l1', 'p1'), live('l2', 'p1')];
  assert.deepEqual(delistCandidatesOf({ liveRecords: records, items: [{ productRecordId: 'p1', quantity: 1 }] }), []);
  assert.deepEqual(delistCandidatesOf({
    liveRecords: records, items: [{ productRecordId: 'p1', quantity: 2 }], delistedProductIds: ['p1'],
  }), []);
  assert.deepEqual(delistCandidatesOf({ liveRecords: records, items: [{ productRecordId: 'p1', quantity: 3 }] }), []);
});

test('打印候选：下架 / 无库存不打印', () => {
  const products = [{ recordId: 'p1' }, { recordId: 'p2' }, { recordId: 'p3' }];
  const stock = new Map([['p1', 1], ['p2', 0], ['p3', 2]]);
  assert.deepEqual(printableProductsOf({ products, stock, delistedProductIds: ['p3'] }), [{ recordId: 'p1' }]);
});
