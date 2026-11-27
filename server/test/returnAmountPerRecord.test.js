'use strict';

/**
 * 2026-11-27：多货品退货金额按 record ID（货号+颜色）汇总。
 *   一个 record ID = 一个页面 = 一笔金额；同 record ID 多尺码只算一次。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { sumReturnAmountCents } = require('../src/routes/scanPage/multiItem');
const { multiItemPayloadJson } = require('../src/views/scanPageRenderer');

test('按唯一 record ID 求和：100 + 200 = 300，同 record 多尺码不翻倍', () => {
  const groups = [
    { product_record_id: 'rec_A', amount_cents: 10000, entries: [{ size: '40', quantity: 1 }, { size: '41', quantity: 1 }] },
    { product_record_id: 'rec_B', amount_cents: 20000, entries: [{ size: '40', quantity: 1 }] },
  ];
  const result = sumReturnAmountCents(groups, '100');
  assert.equal(result.ok, true);
  assert.equal(result.totalCents, 30000, '当前页 100 覆盖 A；B 200；合计 300');
});

test('同一 record ID 重复出现只算一次（取第一次），不因重复行翻倍', () => {
  const result = sumReturnAmountCents([
    { product_record_id: 'rec_A', amount_cents: 10000, entries: [{ size: '40', quantity: 1 }] },
    { product_record_id: 'rec_A', amount_cents: 10000, entries: [{ size: '41', quantity: 1 }] },
  ], '100');
  assert.equal(result.ok, true);
  assert.equal(result.totalCents, 10000);
});

test('缺一件金额 ⇒ not ok（调用方 400，不按 0）', () => {
  const result = sumReturnAmountCents([
    { product_record_id: 'rec_A', amount_cents: 10000 },
    { product_record_id: 'rec_B' },
  ], '100');
  assert.equal(result.ok, false);
  assert.equal(result.missing.product_record_id, 'rec_B');
});

test('退货载荷带 amount_cents；补货/缺省不带（形状不变）', () => {
  const items = [{ product_record_id: 'rec_A', number: 'K1', amount_cents: 46800, entries: [] }];
  const ret = JSON.parse(multiItemPayloadJson(items, 'return'));
  assert.equal(ret[0].amount_cents, 46800);
  const plain = JSON.parse(multiItemPayloadJson(items));
  assert.equal('amount_cents' in plain[0], false);
  const replenish = JSON.parse(multiItemPayloadJson(items, 'replenish'));
  assert.equal('amount_cents' in replenish[0], false);
});
