'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createInventoryAdjustmentRouter } = require('../src/routes/workbenchInventoryAdjustment');

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  server.keepAliveTimeout = 1;
});

test('当季扫码接口：202 + 把 changes 交给 service', async () => {
  const calls = [];
  const service = { async submit(input) { calls.push(input); return { ok: true, updated: 1 }; } };
  const jobs = {
    jobIdFor: () => 'job_1',
    enqueue: async () => ({}),
    run: async ({ run }) => { await run(); return { status: 'succeeded' }; },
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.workbenchUser = { open_id: 'ou_a', name: 'A' }; req.requestId = 'req_1'; next(); });
  app.use('/inventory/adjustments', createInventoryAdjustmentRouter({ seasonAdjustment: service, asyncJobs: jobs }));
  const { server, port } = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/inventory/adjustments/season-scan`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'r1', changes: [{ productRecordId: 'p1', size: 39, state: '门盒', currentSeason: false, quantity: 1 }] }),
    });
    assert.equal(res.status, 202);
    assert.equal((await res.json()).job_id, 'job_1');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].operatorOpenId, 'ou_a');
    assert.equal(calls[0].changes[0].quantity, 1);
  } finally { server.close(); }
});
