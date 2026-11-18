'use strict';

/**
 * 2026-11-18：货品页整单 0 元 ⇒ 不跳资金页，直接异步入队。
 * 判据：响应 303 回工作台；salesAsync.enqueue 收到 payments=[]；没有渲染资金页。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_zero_free_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'zero_free_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = 'zero_free_session_secret';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { createScanPageRouter } = require('../src/routes/scanPage');

const cookie = (() => {
  const crypto = require('node:crypto');
  const payload = Buffer.from(JSON.stringify({ open_id: 'ou_zero_free', name: '测试', exp: Date.now() + 3600 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', 'zero_free_session_secret').update(payload).digest('base64url');
  return `workbench_session=${payload}.${sig}`;
})();

const view = () => ({
  found: true,
  product_record_id: 'prod_zero',
  number: '6606-373|黑色|女',
  item_no: '6606-373',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: '女',
  price_text: '¥210',
  total: 1,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '40', cells: [{ count: 1 }], total: 1, missing: false }],
  missing_count: 0,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-11-18 11:00',
});

const fakeSession = () => ({
  sale: { lines: [], order_no: '', key: 'scan_sale:test:1' },
  status: 'draft',
});

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const i = app.listen(0, '127.0.0.1', () => resolve(i)); });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const buildApp = ({ enqueued, completed }) => {
  const session = fakeSession();
  const writeService = {
    sessions: {
      async get() { return session; },
      async saveDraftLines(_openId, patch) { Object.assign(session.sale, patch); return session; },
      async addLine(_openId, line) { session.sale.lines.push(line); return { ok: true, session }; },
      async saveSaleProgress(_openId, patch) { Object.assign(session.sale, patch); return session; },
      async completeSale(openId, input) { completed.push({ openId, input }); },
      async submitKeyFor() { return 'scan_sale:test:1'; },
    },
  };
  const salesAsync = {
    async enqueue(input) {
      enqueued.push(input);
      return { ok: true, created: true, job: { job_id: 'sale_job_zero_route_1' } };
    },
  };
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.recordBasePath, createScanPageRouter({
    service: { lookup: async () => view() },
    gateway: {},
    writeService,
    salesAsync,
    asyncJobs: null,
    salesOrderNoCache: { next: async () => ({ orderNo: 'XSD-20261118-0009' }) },
  }));
  return app;
};

test('AC-ZERO-ROUTE1 全 0 ⇒ 不跳资金页，直接入队（payments=[]）', async () => {
  const enqueued = [];
  const completed = [];
  await withServer(buildApp({ enqueued, completed }), async (base) => {
    const response = await fetch(`${base}/r/rec_zero_route?from=sales`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        [SCAN_WRITE.fields.action]: SCAN_WRITE.actions.submitOrder,
        [SCAN_WRITE.fields.submitKey]: 'scan_sale:test:1',
        [SCAN_WRITE.fields.size]: '40',
        [SCAN_WRITE.fields.amount]: '0',
        [SCAN_WRITE.fields.gift]: '',
      }).toString(),
    });
    assert.equal(response.status, 303);
    // 业务负责人选择：0 元单也先出「是否打印」轻页；没有可打印货品时回 toast。
    assert.match(response.headers.get('location') || '', /^(\/workbench\/\?|\/print-prompt\?token=)/);
    assert.equal(enqueued.length, 1, '只入队一次');
    const payload = enqueued[0].payload;
    assert.deepEqual(payload.payments, [], '0 元单不写 S交易明细');
    assert.equal(payload.lines.length, 1);
    assert.equal(payload.lines[0].actual_amount, 0);
    assert.equal(payload.derived.total_amount, 0);
    assert.equal(payload.derived.owed_amount, 0);
    assert.equal(payload.order_no, 'XSD-20261118-0009');
    assert.equal(completed.length, 1, 'completeSale 轮换提交键');
  });
});
