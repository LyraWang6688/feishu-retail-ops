'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_draft_current_form';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'draft_current_form_secret';
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { setSalesDraftServiceForTests } = require('../src/services/salesDraftRuntime');
const SECRET = 'draft_current_form_secret';
const cookie = () => {
  const payload = Buffer.from(JSON.stringify({ open_id: 'ou_current_form', name: '测试', exp: Date.now() + 3600e3 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return 'workbench_session=' + payload + '.' + sig;
};
const view = () => ({
  found: true, number: '89975|黑色|男', item_no: '89975', color: '黑色', category_name: '棉鞋', category_code: '男',
  price_text: '¥149', total: 1, columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '40', cells: [{ count: 1 }], total: 1, missing: false }],
  missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: '2026-11-26 13:28', product_record_id: 'rec_draft',
});
const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  server.keepAliveTimeout = 1;
  try { return await run('http://127.0.0.1:' + server.address().port); } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

test('第一双未加入本单也能保存 currentForm，并在打开时回填尺码/金额', async () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
  let session = { session_id: 's1', open_id: 'ou_current_form', sale: { lines: [], status: 'draft' } };
  let savedSnapshot = null;
  const sessions = {
    ensure: async () => session,
    get: async () => session,
    submitKeyFor: () => 'scan_sale:test:1',
    saveDraftLines: async () => {},
    store: { update: async (id, mutator) => { session = mutator(session); return session; } },
  };
  setSalesDraftServiceForTests({
    save: async (input) => {
      savedSnapshot = input.snapshot;
      return { ok: true, draft: { draft_id: 'd3', step: 'goods', updated_at: 'now' } };
    },
    get: async () => ({ draft_id: 'd3', step: 'goods', currentForm: savedSnapshot.currentForm, lines: [] }),
    remove: async () => true,
  });
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.recordBasePath, createScanPageRouter({
    service: { lookup: async () => view() }, gateway: {}, writeService: { sessions }, startSnapshot: false,
  }));
  await withServer(app, async (base) => {
    const body = new URLSearchParams({
      draft_step: 'goods', draft_number: '89975|黑色|男', draft_item_no: '89975', draft_color: '黑色',
      [SCAN_WRITE.fields.size]: '40', [SCAN_WRITE.fields.amount]: '149',
    });
    const saved = await fetch(base + '/r/rec_draft/draft?from=sales', {
      method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(),
    });
    assert.equal(saved.status, 200, await saved.text());
    assert.deepEqual(savedSnapshot.lines, [], '第一双还没加入本单，lines 仍为空');
    assert.equal(savedSnapshot.currentForm.size, '40');
    assert.equal(savedSnapshot.currentForm.amount, '149');

    const opened = await fetch(base + '/r/rec_draft?from=sales&draft=d3', { headers: { cookie: cookie() } });
    const html = await opened.text();
    assert.equal(opened.status, 200);
    assert.match(html, /data-draft-step="goods"/);
    assert.match(html, /name="size" value="40" required checked/);
    assert.match(html, /name="amount"[^>]*value="149"/);
  });
  setSalesDraftServiceForTests(null);
});
