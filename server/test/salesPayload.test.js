'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSalePayload } = require('../src/services/salesPayload');

const line = (over = {}) => ({ productRecordId: 'rec_p', size: 41, tradeTypeCode: 'SPOT', actualAmount: 99, number: 'A|黑色|A', itemNo: 'A', color: '黑色', ...over });

test('一单一货：金额/尺码必填，计算总额与已收齐', () => {
  const out = buildSalePayload({ openId: 'ou_1', lines: [line()], payments: [{ method: '微信扫码', amount: 99 }] });
  assert.equal(out.ok, true);
  assert.equal(out.payload.derived.total_amount, 99);
  assert.equal(out.payload.derived.payment_status, '已收齐');
  assert.equal(out.payload.lines[0].trade_type, 'SPOT');
});

test('一单多货：多行合计；部分收款 => 未收齐 + 欠款', () => {
  const out = buildSalePayload({
    openId: 'ou_1',
    lines: [line(), line({ size: 37, tradeTypeCode: 'PREORDER', actualAmount: 200 })],
    payments: [{ method: '微信扫码', amount: 100 }],
  });
  assert.equal(out.ok, true);
  assert.equal(out.payload.derived.total_amount, 299);
  assert.equal(out.payload.derived.paid_amount, 100);
  assert.equal(out.payload.derived.owed_amount, 199);
  assert.equal(out.payload.derived.payment_status, '未收齐');
  assert.equal(out.payload.lines.length, 2);
});

test('多支付：逐行保留方式+金额；0 金额行忽略', () => {
  const out = buildSalePayload({
    openId: 'ou_1',
    lines: [line({ actualAmount: 249 })],
    payments: [{ method: '微信扫码', amount: 200 }, { method: '现金', amount: 49 }, { method: '支付宝', amount: 0 }],
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.payload.payments, [
    { method: '微信扫码', amount: 200 },
    { method: '现金', amount: 49 },
  ]);
  assert.equal(out.payload.derived.payment_status, '已收齐');
});

test('缺尺码/缺金额/收款超过总额 => 拒绝', () => {
  const missing = buildSalePayload({ openId: 'ou_1', lines: [line({ size: '' })], payments: [] });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.code === 'line_size_missing'));
  const noAmount = buildSalePayload({ openId: 'ou_1', lines: [line({ actualAmount: '' })], payments: [] });
  assert.equal(noAmount.ok, false);
  assert.ok(noAmount.errors.some((e) => e.code === 'line_amount_missing'));
  const over = buildSalePayload({ openId: 'ou_1', lines: [line()], payments: [{ method: '微信扫码', amount: 100 }] });
  assert.equal(over.ok, false);
  assert.ok(over.errors.some((e) => e.code === 'payment_over_total'));
});
