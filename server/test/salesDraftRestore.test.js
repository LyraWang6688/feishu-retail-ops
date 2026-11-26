'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_draft_restore';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'draft_restore_secret';
const { SCAN_PAGE } = require('../src/config/scanPage');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { setSalesDraftServiceForTests } = require('../src/services/salesDraftRuntime');
const SECRET = 'draft_restore_session_secret';
const cookie = () => {
  const payload = Buffer.from(JSON.stringify({ open_id: 'ou_draft_restore', name: '测试', exp: Date.now() + 3600e3 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return 'workbench_session=' + payload + '.' + sig;
};
const view = () => ({
  found: true, number: '89975|黑色|男', item_no: '89975', color: '黑色', category_name: '棉鞋', category_code: '男',
  price_text: '¥149', total: 1, columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '40', cells: [{ count: 1 }], total: 1, missing: false }],
  missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: '2026-11-26 13:28', product_record_id: 'rec_draft',
});
const draft = {
  draft_id: 'd1', step: 'payment', number: '89975|黑色|男', item_no: '89975', color: '黑色',
  lines: [{ product_record_id: 'rec_draft', number: '89975|黑色|男', item_no: '89975', color: '黑色', size: 40, amount: '149' }],
  payment: { lineAmounts: ['149'], paymentRows: [{ method: '微信扫码', amount: '100' }] },
};
test('打开资金页草稿：仍停留在资金页，并恢复付款状态', async () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
  let session = { session_id: 's1', sale: { lines: [], status: 'draft' } };
  const sessions = {
    ensure: async () => session,
    get: async () => session,
    submitKeyFor: () => 'scan_sale:test:1',
    saveDraftLines: async () => {},
    store: { update: async (id, mutator) => { session = mutator(session); return session; } },
  };
  setSalesDraftServiceForTests({ get: async () => draft });
  const app = express();
  app.use(SCAN_PAGE.route.recordBasePath, createScanPageRouter({
    service: { lookup: async () => view() }, gateway: {}, writeService: { sessions }, startSnapshot: false,
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  server.keepAliveTimeout = 1;
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const response = await fetch(base + '/r/rec_draft?from=sales&draft=d1', { headers: { cookie: cookie() } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /data-view="payment-pay"/, '必须是资金页表单');
    assert.match(html, /data-view="payment-step-total"[^>]*>[^<]*149/, '恢复总金额');
    assert.match(html, /name="[^"]*payment_amount"[^>]*value="100"/, '恢复已填收款金额');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    setSalesDraftServiceForTests(null);
  }
});

test('打开货品页草稿：仍停留在货品页', async () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
  const goodsDraft = { ...draft, draft_id: 'd2', step: 'goods', payment: {} };
  let session2 = { session_id: 's2', sale: { lines: [], status: 'draft' } };
  const sessions2 = {
    ensure: async () => session2,
    get: async () => session2,
    submitKeyFor: () => 'scan_sale:test:2',
    saveDraftLines: async () => {},
    store: { update: async (id, mutator) => { session2 = mutator(session2); return session2; } },
  };
  setSalesDraftServiceForTests({ get: async () => goodsDraft });
  const app = express();
  app.use(SCAN_PAGE.route.recordBasePath, createScanPageRouter({
    service: { lookup: async () => view() }, gateway: {}, writeService: { sessions: sessions2 }, startSnapshot: false,
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  server.keepAliveTimeout = 1;
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const response = await fetch(base + '/r/rec_draft?from=sales&draft=d2', { headers: { cookie: cookie() } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /data-draft-step="goods"/, '必须仍渲染货品页的保存草稿按钮');
    assert.doesNotMatch(html, /data-view="payment-pay"/, '不能跳去资金页');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    setSalesDraftServiceForTests(null);
  }
});
