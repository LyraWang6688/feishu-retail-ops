'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planReturnSettlement } = require('../src/services/afterSalesSettlementPlan');

test('结算计划：0 元单不退款、不冲销', () => {
  const plan = planReturnSettlement({ detailAmount: 0, paidAmount: 0, unpaidAmount: 0, detailCount: 1 });
  assert.equal(plan.rule, 'zero_amount');
  assert.equal(plan.createRefund, false);
  assert.equal(plan.refundAmount, 0);
  assert.equal(plan.writeOffAmount, 0);
});

test('结算计划：全额已收 ⇒ 退明细金额', () => {
  const plan = planReturnSettlement({ detailAmount: 219, paidAmount: 219, unpaidAmount: 0, detailCount: 1 });
  assert.equal(plan.rule, 'fully_paid');
  assert.equal(plan.createRefund, true);
  assert.equal(plan.refundAmount, 219);
});

test('结算计划：未收款 + 单明细 ⇒ 不退款、冲销全部未收', () => {
  const plan = planReturnSettlement({ detailAmount: 219, paidAmount: 0, unpaidAmount: 219, detailCount: 1 });
  assert.equal(plan.rule, 'unpaid');
  assert.equal(plan.createRefund, false);
  assert.equal(plan.writeOffAmount, 219);
});

test('结算计划：部分收款 + 单明细 ⇒ 退已收、差额冲销', () => {
  const plan = planReturnSettlement({ detailAmount: 219, paidAmount: 100, unpaidAmount: 119, detailCount: 1 });
  assert.equal(plan.rule, 'partial');
  assert.equal(plan.refundAmount, 100);
  assert.equal(plan.writeOffAmount, 119);
});

test('结算计划：部分收款 + 多明细 ⇒ 不冲销其他明细', () => {
  const plan = planReturnSettlement({ detailAmount: 219, paidAmount: 100, unpaidAmount: 119, detailCount: 2 });
  assert.equal(plan.rule, 'partial');
  assert.equal(plan.refundAmount, 100);
  assert.equal(plan.writeOffAmount, 0);
});

test('结算计划：未收款 + 多明细 ⇒ 不冲销其他明细', () => {
  const plan = planReturnSettlement({ detailAmount: 219, paidAmount: 0, unpaidAmount: 219, detailCount: 2 });
  assert.equal(plan.rule, 'unpaid');
  assert.equal(plan.writeOffAmount, 0);
});
