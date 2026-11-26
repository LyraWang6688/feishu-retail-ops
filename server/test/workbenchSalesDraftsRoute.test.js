'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createWorkbenchSalesDraftRoutes } = require('../src/routes/workbench/salesDrafts');

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  server.keepAliveTimeout = 1;
  try { await run('http://127.0.0.1:' + server.address().port); } finally { await new Promise((resolve) => server.close(resolve)); }
};
const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('销售草稿接口：保存 / 列表 / 打开 / 删除', async () => {
  const calls = [];
  const fake = {
    save: async (input) => { calls.push(['save', input]); return { ok: true, draft: { draft_id: 'd1', step: 'payment', updated_at: 'now' } }; },
    list: async (input) => { calls.push(['list', input]); return [{ draftId: 'd1' }]; },
    get: async (input) => { calls.push(['get', input]); return input.draftId === 'd1' ? { draft_id: 'd1', lines: [1] } : null; },
    remove: async (input) => { calls.push(['remove', input]); return input.draftId === 'd1'; },
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.workbenchUser = { open_id: 'ou_a' }; next(); });
  app.use('/api/workbench', createWorkbenchSalesDraftRoutes({ options: { salesDraft: fake } }));
  await withServer(app, async (base) => {
    const saved = await post(base, '/api/workbench/sales/drafts', { step: 'payment', snapshot: { lines: [{ size: 40 }] } });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).draft.draftId, 'd1');
    const empty = await post(base, '/api/workbench/sales/drafts', { snapshot: { lines: [] } });
    assert.equal(empty.status, 400);
    assert.equal((await (await fetch(base + '/api/workbench/sales/drafts')).json()).drafts.length, 1);
    assert.equal((await (await fetch(base + '/api/workbench/sales/drafts/d1')).json()).draft.draft_id, 'd1');
    assert.equal((await fetch(base + '/api/workbench/sales/drafts/d1', { method: 'DELETE' })).status, 200);
  });
  assert.equal(calls[0][1].openId, 'ou_a');
  assert.equal(calls[0][1].step, 'payment');
});

test('销售草稿删除是幂等的：目标已不在也返回成功', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.workbenchUser = { open_id: 'ou_a' }; next(); });
  app.use('/api/workbench', createWorkbenchSalesDraftRoutes({
    options: { salesDraft: { remove: async () => false, get: async () => null, list: async () => [], save: async () => ({ ok: false }) } },
  }));
  await withServer(app, async (base) => {
    const response = await fetch(base + '/api/workbench/sales/drafts/gone', { method: 'DELETE' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.removed, false);
  });
});

test('工作台草稿接口：没有 lines 但有 currentForm 也允许保存', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.workbenchUser = { open_id: 'ou_a' }; next(); });
  app.use('/api/workbench', createWorkbenchSalesDraftRoutes({
    options: { salesDraft: { save: async () => ({ ok: true, draft: { draft_id: 'd1', step: 'goods', updated_at: 'now' } }) } },
  }));
  await withServer(app, async (base) => {
    const response = await post(base, '/api/workbench/sales/drafts', {
      step: 'goods', snapshot: { lines: [], currentForm: { size: '40', amount: '149' } },
    });
    assert.equal(response.status, 200);
  });
});
