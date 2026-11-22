'use strict';

/**
 * 售后换款式 = 销售扫码页 + 一条 flow 配置（业务负责人 2026-10-29 确认的方向）。
 *
 * AC-FEP1 换款式 flow 的货品页：**不显示金额输入**、**不出现"再加一双"**、提交按钮文案来自配置、
 *         顶部出一句 flow 提示、售后上下文用隐藏字段原样带进 POST。
 * AC-FEP2 销售 flow 的货品页**一个字都不变**（金额输入、加一双按钮、既有提交文案都在）。
 * AC-FEP3 路由接线：GET 把 flow/上下文传给渲染层；POST 换款式货品页提交 **不跳资金页、
 *         不写库**（保留 flow；原生 POST 303 回原页）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { saleFormHtml } = require('../src/views/scanPage/paymentBlock');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { getFlow, postContextQuery } = require('../src/services/scanFlowService');
const { handlePendingExchangeSubmit } = require('../src/routes/scanPage/exchangeFlow');
const { hasProgressSubmit } = require('../src/views/scanPage/submitProgress');

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
  assert.doesNotMatch(html, /<button[^>]*data-progress-submit="1"/, '换款式不能被通用提交进度脚本先拦截');
  assert.doesNotMatch(html, /<button[^>]*data-submit-feedback=/, '换款式由差价脚本负责提交反馈，不能被通用反馈脚本置灰');
  assert.equal(hasProgressSubmit(html), false, '换款式页面不注入通用提交进度脚本');
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
  assert.match(html, /data-progress-submit="1"/, '销售提交仍走通用提交进度');
});

test('AC-FEP3 路由接线：GET 传 flow；POST 保留 flow/上下文，不落普通销售', () => {
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/scanPage/index.js'), 'utf8');
  const helpers = fs.readFileSync(path.join(__dirname, '../src/routes/scanPage/flowHelpers.js'), 'utf8');
  const thin = fs.readFileSync(path.join(__dirname, '../src/routes/scanPage/exchangeFlow.js'), 'utf8');
  assert.match(route, /renderFlowOf/, 'GET 要把 flow + 上下文交给渲染层（薄模块）');
  assert.match(helpers, /postContextQuery/, '货品页 form action 要保留 flow + 上下文');
  assert.match(helpers, /postActionFor/, '仍从原货品页地址生成');
  assert.match(thin, /res\.redirect\(303/, '原生 POST 兜底回同一页，不写库');
  assert.doesNotMatch(thin, /flow_next_step_pending/, '不再走“下一步未接”的人话页');
});

test('AC-FEP4 原生 POST 带售后上下文时 303 回原页，绝不建普通销售', () => {
  let status = 0;
  let location = '';
  const res = { redirect(code, url) { status = code; location = url; } };
  const handled = handlePendingExchangeSubmit({
    req: {
      query: { from: 'sales' },
      body: {
        ctx_requestId: 'r1', ctx_salesEntryRecordId: 'e1',
        ctx_detailRecordId: 'd1', ctx_originalAmount: '79',
      },
      originalUrl: '/r/rec1?from=sales&flow=afterSalesExchange&requestId=r1',
    },
    res,
    requestId: 'req1',
    action: 'submit_order',
    actions: { submitOrder: 'submit_order' },
  });
  assert.equal(handled, true);
  assert.equal(status, 303);
  assert.match(location, /flow=afterSalesExchange/);
});

test('AC-FEP5 flow 上下文查询串只对非销售 flow 生成', () => {
  const query = postContextQuery({
    flow: 'afterSalesExchange', requestId: 'r1', salesEntryRecordId: 'e1',
    detailRecordId: 'd1', originalAmount: '79', productRecordId: 'p1', other: 'x',
  });
  assert.match(query, /flow=afterSalesExchange/);
  assert.match(query, /requestId=r1/);
  assert.match(query, /originalAmount=79/);
  assert.equal(query.includes('other='), false, '不把无关参数带进 POST');
  assert.equal(postContextQuery({ flow: 'sales', requestId: 'r1' }), '', '普通销售 action 不变');
});
