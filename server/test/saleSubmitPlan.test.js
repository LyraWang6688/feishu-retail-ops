'use strict';

/**
 * 2026-11-18：整单实收全 0 ⇒ 不跳资金页，直接异步销售。
 * 判据只看配置规则，不在入口写 `if (金额 === 0)`。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { resolveSaleSubmitPlan, saleSubmitFacts } = require('../src/services/scanWrite/saleSubmitPlan');

test('AC-ZERO-PLAN1 全 0 + 异步可用 ⇒ async_sale', () => {
  const plan = resolveSaleSubmitPlan({
    lineAmounts: ['0', '0.00'],
    salesAsyncEnabled: true,
    config: SCAN_WRITE,
  });
  assert.equal(plan.action, 'async_sale');
  assert.equal(plan.id, 'free_order');
});

test('AC-ZERO-PLAN2 混合单（0 + 有金额）⇒ 仍走资金页', () => {
  const plan = resolveSaleSubmitPlan({
    lineAmounts: ['0', '399'],
    salesAsyncEnabled: true,
    config: SCAN_WRITE,
  });
  assert.equal(plan.action, 'payment_step');
});

test('AC-ZERO-PLAN3 异步关 / 空金额 / 空单 ⇒ 回落资金页', () => {
  for (const input of [
    { lineAmounts: ['0'], salesAsyncEnabled: false },
    { lineAmounts: [''], salesAsyncEnabled: true },
    { lineAmounts: [], salesAsyncEnabled: true },
  ]) {
    assert.equal(resolveSaleSubmitPlan({ ...input, config: SCAN_WRITE }).action, 'payment_step');
  }
});

test('AC-ZERO-PLAN4 事实：0 必须是显式填的，空行不算 0', () => {
  assert.deepEqual(saleSubmitFacts({ lineAmounts: ['0', '0.00'], salesAsyncEnabled: true }), {
    allLineAmountsZero: true,
    salesAsyncEnabled: true,
  });
  assert.equal(saleSubmitFacts({ lineAmounts: ['0', ''], salesAsyncEnabled: true }).allLineAmountsZero, false);
  assert.equal(saleSubmitFacts({ lineAmounts: ['0', 'abc'], salesAsyncEnabled: true }).allLineAmountsZero, false);
});
