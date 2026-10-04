const test = require('node:test');
const assert = require('node:assert/strict');
const { findVoucher, voucherKey } = require('../src/config/groupBuyVouchers');

// 券目录来自「团购券管理」表。两档券的面值都是 100——只看面值会把它们混成一张。
const CATALOG = [
  { purchasePrice: 89.9, faceValue: 100, settlementAmount: 85.4 },
  { purchasePrice: 49.9, faceValue: 100, settlementAmount: 47.4 },
];

test('按「售价 + 面值」找券：同样面值的两档不能混', () => {
  assert.equal(findVoucher(CATALOG, { purchasePrice: 89.9, faceValue: 100 }).settlementAmount, 85.4);
  assert.equal(findVoucher(CATALOG, { purchasePrice: 49.9, faceValue: 100 }).settlementAmount, 47.4);
});

test('小数用分比较，浮点误差不会让券匹配不上', () => {
  assert.equal(voucherKey({ purchasePrice: 89.9, faceValue: 100 }), '8990|10000');
  assert.equal(voucherKey({ purchasePrice: 89.90000001, faceValue: 100 }), '8990|10000');
});

test('表里没有这种券就返回 undefined——不拿别的券顶替', () => {
  assert.equal(findVoucher(CATALOG, { purchasePrice: 79.9, faceValue: 100 }), undefined);
  assert.equal(findVoucher(CATALOG, { purchasePrice: 89.9, faceValue: 200 }), undefined);
  assert.equal(findVoucher([], { purchasePrice: 89.9, faceValue: 100 }), undefined);
  assert.equal(findVoucher(undefined, { purchasePrice: 89.9, faceValue: 100 }), undefined);
});
