'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createWorkbenchProcurementDraftRoutes } = require('../src/routes/workbench/procurementDraft');

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

test('采购草稿接口：GET / POST / DELETE 走当前登录人', async () => {
  const calls = [];
  let draft = null;
  const service = {
    async get({ openId }) { calls.push(['get', openId]); return draft; },
    async save({ openId, snapshot }) { calls.push(['save', openId]); draft = { saved_at: '2026-11-25T02:00:00.000Z', snapshot }; return { ok: true, draft }; },
    async remove({ openId }) { calls.push(['remove', openId]); draft = null; return true; },
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.workbenchUser = { open_id: 'ou_a' }; req.requestId = 'req_1'; next(); });
  app.use(createWorkbenchProcurementDraftRoutes({ options: { procurementDraft: service } }));
  const { server, port } = await listen(app);
  try {
    const base = `http://127.0.0.1:${port}/procurement/draft`;
    const saved = await (await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshot: { products: { a: { entries: { 39: 2 } } } } }) })).json();
    assert.equal(saved.success, true);
    assert.equal(saved.draft.savedAt, '2026-11-25T02:00:00.000Z');
    const got = await (await fetch(base)).json();
    assert.equal(got.draft.snapshot.products.a.entries['39'], 2);
    assert.equal((await (await fetch(base, { method: 'DELETE' })).json()).success, true);
    assert.equal((await (await fetch(base)).json()).draft, null);
    assert.deepEqual(calls, [['save', 'ou_a'], ['get', 'ou_a'], ['remove', 'ou_a'], ['get', 'ou_a']]);
  } finally { server.close(); }
});
