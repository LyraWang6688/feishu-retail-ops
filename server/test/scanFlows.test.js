'use strict';

/**
 * 扫码页「流程配置」的验收标准（业务负责人 2026-10-29 定的方向：**配置化，不写大量 if-else**）。
 *
 * AC-FLOW1 `sales` flow = 现状（货品 → 资金 → 提交 salesWrite；允许"加一双"）—— 先跑、行为不变。
 * AC-FLOW2 `afterSalesExchange` flow = 售后换款式（货品 → 差价(有差价才显示) → 提交 afterSalesExchange；
 *          不允许"加一双"、**没有资金页**）。
 * AC-FLOW3 解释器纯查表：认不出的 flow ⇒ 400；缺省 ⇒ sales。
 * AC-FLOW4 `shouldShowStep` 是声明式条件（差价 0 不显示、非 0 显示）—— 页面不写 if。
 * AC-FLOW5 `pickContext` 只带 flow 声明的上下文（售后换款式：requestId / 原单 / 原明细 / 原金额）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SCAN_FLOWS, STEP_TYPES, SUBMIT_HANDLERS,
} = require('../src/config/scanFlows');
const {
  getFlow, resolveFlowFromQuery, stepsOf, allowsAddLine, hasStep,
  shouldShowStep, submitHandlerOf, submitEndpointOf, submitPayloadOf, pickContext,
} = require('../src/services/scanFlowService');

test('AC-FLOW1 sales flow = 现状（货品 → 资金 → 提交 salesWrite；可以加一双）', () => {
  const flow = getFlow('sales');
  assert.deepEqual(stepsOf(flow).map((step) => step.type),
    [STEP_TYPES.GOODS, STEP_TYPES.FUNDS, STEP_TYPES.SUBMIT]);
  assert.equal(allowsAddLine(flow), true);
  assert.equal(hasStep(flow, STEP_TYPES.FUNDS), true);
  assert.equal(submitHandlerOf(flow), SUBMIT_HANDLERS.SALES_WRITE);
  assert.deepEqual(flow.context, []);
});

test('AC-FLOW2 afterSalesExchange flow：无资金页、不加一双、差价步骤条件显示、提交售后', () => {
  const flow = getFlow('afterSalesExchange');
  assert.deepEqual(stepsOf(flow).map((step) => step.type),
    [STEP_TYPES.GOODS, STEP_TYPES.DIFF, STEP_TYPES.SUBMIT]);
  assert.equal(allowsAddLine(flow), false);
  assert.equal(hasStep(flow, STEP_TYPES.FUNDS), false, '换款式不跳资金页：steps 里根本没有 funds');
  assert.equal(submitHandlerOf(flow), SUBMIT_HANDLERS.AFTER_SALES_EXCHANGE);
  assert.equal(submitEndpointOf(flow), '/api/workbench/sales/after-sales/exchange/submit');
  assert.deepEqual(submitPayloadOf(flow), [
    'requestId', 'salesEntryRecordId', 'detailRecordId',
    'newProductRecordId', 'newSize', 'newAmount', 'diffPaymentMethod',
  ]);
  assert.deepEqual(flow.context, ['requestId', 'salesEntryRecordId', 'detailRecordId', 'originalAmount']);
});

test('AC-FLOW3 解释器纯查表：认不出的 flow ⇒ 400；缺省 ⇒ sales', () => {
  assert.equal(getFlow('sales').id, 'sales');
  assert.equal(resolveFlowFromQuery({}).id, 'sales');
  assert.equal(resolveFlowFromQuery({ flow: 'afterSalesExchange' }).id, 'afterSalesExchange');
  assert.throws(() => getFlow('no_such_flow'), (error) => error.statusCode === 400
    && /未声明的扫码流程/.test(error.message));
  assert.throws(() => resolveFlowFromQuery({ flow: 'nope' }), (error) => error.statusCode === 400);
  // 配置表里两条 flow 都在（以后加新流程只加配置）
  assert.deepEqual(Object.keys(SCAN_FLOWS).sort(), ['afterSalesExchange', 'sales']);
});

test('AC-FLOW4 shouldShowStep：差价 0 不显示、非 0 显示（页面不写 if）', () => {
  const flow = getFlow('afterSalesExchange');
  assert.equal(shouldShowStep(flow, STEP_TYPES.DIFF, { diffAmount: 0 }), false);
  assert.equal(shouldShowStep(flow, STEP_TYPES.DIFF, { diffAmount: 10 }), true);
  assert.equal(shouldShowStep(flow, STEP_TYPES.DIFF, {}), true, '没给事实 ⇒ 不显示条件不成立？(undefined != 0 ⇒ true)');
  // 没有 when 的步骤一律显示
  assert.equal(shouldShowStep(flow, STEP_TYPES.GOODS, {}), true);
  // 不存在的步骤 ⇒ 永远不显示
  assert.equal(shouldShowStep(flow, STEP_TYPES.FUNDS, {}), false);
});

test('AC-FLOW5 pickContext 只带 flow 声明的上下文', () => {
  const flow = getFlow('afterSalesExchange');
  const picked = pickContext(flow, {
    requestId: 'r1', salesEntryRecordId: 'e1', detailRecordId: 'd1', originalAmount: 199, extra: 'x',
  });
  assert.deepEqual(picked, { requestId: 'r1', salesEntryRecordId: 'e1', detailRecordId: 'd1', originalAmount: 199 });
  assert.equal('extra' in picked, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-FLOW6：换尺码的尺码分组 —— **复用销售扫码页视图模型**，不在售后侧另写一份规则
// ═══════════════════════════════════════════════════════════════════════════
const fs = require('node:fs');
const path = require('node:path');

test('AC-FLOW6 尺码分组：路由走 scanPageService.lookup + saleSizeGroups；售后页只消费 groups', () => {
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/workbenchOrderActions.js'), 'utf8');
  assert.match(route, /createScanPageService/, '路由要复用销售扫码页的 service');
  assert.match(route, /saleSizeGroups\(/, '分组必须用销售扫码页那一个解释器（saleSizeGroups）');
  assert.match(route, /'\/sales\/after-sales\/stock-sizes'/);
  // 售后侧**不许**再写一份"现货/预订/特殊码"规则（出现这些标记 ⇒ 说明复制了实现）
  assert.equal(/specialSizesOf|expandRange|specialSizes/.test(route), false, '不许复制尺码规则');

  const page = fs.readFileSync(path.join(__dirname, '../public/workbench/features/after-sales/index.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.match(page, /stockSizesApi/);
  assert.match(page, /data\?\.groups/, '页面吃共享视图模型的 groups');
  // 页面里不许自己判"有货/特殊码"（注释不算）
  assert.equal(/特殊码/.test(page), false);
  assert.equal(/inStock.*count\s*>|count\s*>\s*0/.test(page), false);
});
