'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { PRODUCT_LIFECYCLE } = require('../src/config/productLifecycle');
const {
  isDelistedFields, isDelistedRecord, filterActiveProducts, filterActiveProductsFor,
} = require('../src/services/productLifecycle');

const F = V1_BITABLE_SCHEMA.tables.product.fields;

test('货品下架标记：只有复选框 true 才算已下架，空/false 都算未下架', () => {
  assert.equal(isDelistedFields({ [F.delisted]: true }), true);
  assert.equal(isDelistedFields({ [F.delisted]: false }), false);
  assert.equal(isDelistedFields({}), false);
  assert.equal(isDelistedRecord({ fields: { [F.delisted]: true } }), true);
  assert.equal(isDelistedRecord({ fields: { [F.delisted]: '' } }), false);
});

test('可见性配置：新业务排除已下架，历史上下文保留', () => {
  const rows = [
    { record_id: 'a', fields: { [F.delisted]: false } },
    { record_id: 'b', fields: { [F.delisted]: true } },
    { record_id: 'c', fields: {} },
  ];
  assert.deepEqual(filterActiveProducts(rows).map((row) => row.record_id), ['a', 'c']);
  assert.deepEqual(filterActiveProductsFor(rows, 'productSearch').map((row) => row.record_id), ['a', 'c']);
  assert.deepEqual(filterActiveProductsFor(rows, 'salesHistory').map((row) => row.record_id), ['a', 'b', 'c']);
  assert.ok(PRODUCT_LIFECYCLE.visibility.exclude.includes('productSearch'));
  assert.ok(PRODUCT_LIFECYCLE.visibility.annotate.includes('salesHistory'));
});
