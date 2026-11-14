'use strict';

/**
 * #48：资金页「按金额自动定档 → 结算校验」纯计算（2026-11-14 从 handler 搬出）。
 *   AC-PS-1 全付（金额相等）⇒ 不 block，档位映射成中文取值
 *   AC-PS-2 全付但金额不等 ⇒ block amount_mismatch（不新编文案）
 *   AC-PS-3 「本次已收」= 收款行合计（元）；无收款行 ⇒ 沿用旧值
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { resolvePaymentSettlement } = require('../src/services/scanWrite/paymentSettlement');
const { PAYMENT_STATUS } = require('../src/config/scanWrite');

test('AC-PS-1 金额相等 ⇒ 全付、不 block，档位中文映射', () => {
  const out = resolvePaymentSettlement({
    effectiveLineAmounts: ['100'], paidPayments: [{ amount: '100' }], pendingPaidAmount: '',
  });
  assert.equal(out.itemsCents, 10000);
  assert.equal(out.paymentsCents, 10000);
  assert.equal(out.pendingMode, 'full');
  assert.equal(out.effectivePaymentStatus, PAYMENT_STATUS.full);
  assert.equal(out.settlement.action !== 'block', true);
  assert.equal(out.effectivePaidAmount, '100');
});

test('AC-PS-2 收多了 ⇒ block amount_mismatch（少收则按部分付放行）', () => {
  const over = resolvePaymentSettlement({
    effectiveLineAmounts: ['50'], paidPayments: [{ amount: '100' }], pendingPaidAmount: '',
  });
  assert.equal(over.settlement.action, 'block');
  assert.equal(over.settlement.code, 'amount_mismatch');
  assert.equal(over.effectivePaidAmount, '100');
  const under = resolvePaymentSettlement({
    effectiveLineAmounts: ['100'], paidPayments: [{ amount: '50' }], pendingPaidAmount: '',
  });
  assert.equal(under.pendingMode, 'partial');
  assert.equal(under.settlement.action, 'allow');
});

test('AC-PS-3 无收款行 ⇒ 沿用旧值、按金额推未付/全付', () => {
  const out = resolvePaymentSettlement({
    effectiveLineAmounts: ['100'], paidPayments: [], pendingPaidAmount: '',
  });
  assert.equal(out.paymentsCents, 0);
  assert.equal(out.effectivePaidAmount, '');
  assert.equal(out.pendingMode, 'unpaid');
  assert.equal(out.effectivePaymentStatus, PAYMENT_STATUS.unpaid);
});
