'use strict';

/**
 * 售后换款式 = 销售扫码页 + 一条 flow 配置（业务负责人 2026-10-29 确认的方向）。
 *
 * AC-FEP1 换款式 flow 的货品页：**不显示金额输入**、**不出现"再加一双"**、提交按钮文案来自配置、
 *         顶部出一句 flow 提示、售后上下文用隐藏字段原样带进 POST。
 * AC-FEP2 销售 flow 的货品页**一个字都不变**（金额输入、加一双按钮、既有提交文案都在）。
 * AC-FEP3 路由接线：GET 把 flow/上下文传给渲染层；POST 换款式货品页提交 **不跳资金页、
 *         不写库**（下一步未接 ⇒ 人话页，标记 flow_next_step_pending）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { saleFormHtml } = require('../src/views/scanPage/paymentBlock');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { getFlow } = require('../src/services/scanFlowService');

const VIEW = {
  number: 'XHB1|黑|男', item_no: 'XHB1', color: '黑',
  rows: [{ size_text: '38', count: 1, missing: false }], columns: [], total: 1, price_text: '¥100',
};
const writeOf = () => ({ ...SCAN_WRITE, draft: { lines: [] }, postAction: '/r/rec1', saleKey: 'k' });
const render = (flow, flowContext) => saleFormHtml(VIEW, writeOf(), { flow, flowContext });

test('AC-FEP1 换款式货品页：要显示实收金额 / 无加一双 / 提交文案与提示来自 flow / 上下文隐藏字段', () => {
  const flow = getFlow('afterSalesExchange');
  const html = render(flow, {
    requestId: 'r1', salesEntryRecordId: 'e1', detailRecordId: 'd1', originalAmount: 100, productRecordId: 'p1',
  });
  assert.equal(html.includes('name="amount"'), true, '2026-11-11：换款式要显示「这一双的实收金额」输入');
  assert.equal(html.includes('value="add_line"'), false, '换货固定 1 双 ⇒ 不出现"再加一双"');
  assert.match(html, /提交换货/, '提交按钮文案来自 flow 配置');
  assert.match(html, /售后换款式/, '顶部提示来自 flow 配置');
  assert.match(html, /data-exchange-form="1"/, '换款式表单带差价弹窗钩子');
  assert.match(html, /data-view="exchange-diff"/, '换款式页要带「差价弹窗」脚本');
  for (const key of ['requestId', 'salesEntryRecordId', 'detailRecordId', 'originalAmount', 'productRecordId']) {
    assert.match(html, new RegExp(`name="ctx_${key}"`), `上下文 ${key} 要用隐藏字段带进 POST`);
  }
});

test('AC-FEP2 销售 flow 的货品页一个字都不变（金额输入 / 加一双 / 既有提交文案都在）', () => {
  const html = render(getFlow('sales'), {});
  assert.match(html, /name="amount"/, '销售页仍有"这一双的金额"输入');
  assert.match(html, /value="add_line"/, '销售页仍可以"再加一双"');
  assert.equal(html.includes('ctx_'), false, '销售 flow 没有上下文隐藏字段');
  assert.match(html, /value="submit_order"/, '销售提交按钮照旧');
});

test('AC-FEP3 路由接线：GET 传 flow；POST 换款式提交不跳资金页、不写库（下一步未接）', () => {
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/scanPage/index.js'), 'utf8');
  const thin = fs.readFileSync(path.join(__dirname, '../src/routes/scanPage/exchangeFlow.js'), 'utf8');
  assert.match(route, /renderFlowOf/, 'GET 要把 flow + 上下文交给渲染层（薄模块）');
  assert.match(route, /handlePendingExchangeSubmit/, 'POST 换款式提交走薄模块');
  assert.match(thin, /flow_next_step_pending/, 'POST 换款式提交要有独立标记（下一步未接）');
  assert.match(thin, /sendHuman/, '不写库：只渲染人话页');
  assert.match(thin, /flow\.id === 'sales'+/, '只对非销售 flow 生效');
});
