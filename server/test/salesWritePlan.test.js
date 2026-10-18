'use strict';

/**
 * 配置先行：现货 / 预定各有一份**写计划**（步骤 / 表 / 字段 / 成功判据）。
 * 这一份是写链路唯一的分叉来源；业务 service 不许再散写 `if (现货)`。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SALES_WRITE_PLANS, planForTradeType, planForStock, plansForItems,
  requiresInventory, successRequiresFor, initialFulfillmentStatusFor, deliversOnSubmitFor,
} = require('../src/config/salesWritePlan');

test('现货计划：动库存 + 履约，成功判据含 inventory/fulfillment', () => {
  const plan = planForTradeType('SALE_CASH');
  assert.equal(plan.id, 'spot');
  assert.equal(plan.writesInventory, true);
  assert.deepEqual([...plan.successRequires],
    ['main', 'children', 'inventory', 'fulfillment', 'finalize']);
  assert.deepEqual(plan.steps.map((step) => step.key),
    ['main', 'children', 'inventory', 'fulfillment', 'finalize']);
  assert.equal(plan.deliverOnSubmit, true);
  assert.equal(plan.initialFulfillmentStatus, '未交付');
  assert.equal(plan.deliveredFulfillmentStatus, '已交付');
});

test('预定计划：不动库存，成功判据只有 main/children/finalize', () => {
  const plan = planForTradeType('SALE_PREPAID');
  assert.equal(plan.id, 'preorder');
  assert.equal(plan.writesInventory, false);
  assert.deepEqual(plan.steps.map((step) => step.key), ['main', 'children', 'finalize']);
  assert.deepEqual([...plan.successRequires], ['main', 'children', 'finalize']);
  assert.equal(plan.deliverOnSubmit, false);
  assert.equal(plan.initialFulfillmentStatus, '未交付');
});

test('混合单：逐行取计划，有现货行就要求库存步骤', () => {
  const items = [{ tradeTypeCode: 'SALE_CASH' }, { tradeTypeCode: 'SALE_PREPAID' }];
  assert.deepEqual(plansForItems(items).map((plan) => plan.id), ['spot', 'preorder']);
  assert.equal(requiresInventory(items), true);
  assert.deepEqual([...successRequiresFor(items)],
    ['main', 'children', 'inventory', 'fulfillment', 'finalize']);
  assert.equal(requiresInventory([{ tradeTypeCode: 'SALE_PREPAID' }]), false);
});

test('认不出的编码 ⇒ null / 不猜（不交付、初始未交付）', () => {
  assert.equal(planForTradeType(''), null);
  assert.equal(planForTradeType('SALE_UNKNOWN'), null);
  assert.equal(deliversOnSubmitFor(''), false);
  assert.equal(initialFulfillmentStatusFor(''), '未交付');
  assert.deepEqual(successRequiresFor([{ tradeTypeCode: '' }]), []);
  assert.equal(requiresInventory([{ tradeTypeCode: '' }]), false);
});

test('按库存判据取计划：有货 ⇒ 现货；没货 ⇒ 预定（唯一判据复用既有 policy）', () => {
  assert.equal(planForStock(true)?.id, 'spot');
  assert.equal(planForStock(false)?.id, 'preorder');
  // 既有 policy 对"没传 inStock"的兜底就是预定（不猜成现货）⇒ 计划跟随 policy，不另立一套。
  assert.equal(planForStock(undefined)?.id, 'preorder');
});

test('计划与销售行为注册表同源（不另写一套现货/预定编码）', () => {
  const { SALES_MOVEMENTS } = require('../src/config/salesMovements');
  for (const [code, plan] of Object.entries(SALES_WRITE_PLANS)) {
    assert.equal(plan.tradeTypeCode, code);
    assert.equal(plan.delivery, SALES_MOVEMENTS[code].delivery);
    assert.equal(plan.deliverOnSubmit, SALES_MOVEMENTS[code].deliverOnSubmit);
  }
});

test('源码哨兵：写链路按计划走，不再散写现货/预定分支', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  // ⚠️ 2026-10-18 成对迁移（第 4 步提速 · 文件大小门禁）：交付判据那一段**原样搬进**
  //   `src/services/sales/deliveryStep.js` ⇒ 源码哨兵把那个文件也算进"写链路"一起扫（判据不变）。
  const scan = read('src/services/scanWriteService.js') + '\n'
    + read('src/services/sales/deliveryStep.js');
  const order = read('src/services/salesOrderService.js');
  assert.match(scan, /plansOfOrder\(items\)/, 'scanWriteService 必须从计划取"这一单怎么走"');
  assert.match(scan, /successRequiresFor\(items\)/, '成功判据必须来自计划');
  assert.match(scan, /deliversOnSubmitFor\(/, '提交即交付判据必须来自计划');
  assert.equal(/if\s*\(\s*[^)]*SALE_CASH[^)]*\)/.test(scan), false,
    'scanWriteService 不许按现货编码写 if 分支');
  assert.match(order, /initialFulfillmentStatusFor\(/, '明细初始履约状态必须来自计划');
  assert.equal(/if\s*\(\s*[^)]*SALE_CASH[^)]*\)/.test(order), false,
    'salesOrderService 不许按现货编码写 if 分支');
});
