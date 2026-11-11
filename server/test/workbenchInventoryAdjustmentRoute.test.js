const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// 路由模块 load 链路会读飞书凭证；本用例一次飞书都不打。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_test_app';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'test_secret';

const { createInventoryAdjustmentRouter } = require('../src/routes/workbenchInventoryAdjustment');

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const post = (base, path, body) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('单双调整保存：先本地校验 → 入队 → 立即 202（后台再写库存）', async () => {
  const calls = [];
  const asyncJobs = {
    jobIdFor: (type, key) => `${type}_${key}`,
    enqueue: async (input) => { calls.push({ kind: 'enqueue', input }); },
    run: ({ jobId, run }) => { calls.push({ kind: 'run', jobId }); return run().catch(() => {}); },
  };
  const pairService = { adjustPairs: async (input) => { calls.push({ kind: 'adjust', input }); return { changed: 1 }; } };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.workbenchUser = { open_id: 'ou_test' }; next(); });
  app.use('/api/workbench/inventory/adjustments', createInventoryAdjustmentRouter({ asyncJobs, pairService }));
  await withServer(app, async (base) => {
    const response = await post(base, '/api/workbench/inventory/adjustments/pairs', {
      productRecordId: 'p1', requestId: 'req-1',
      rows: [{ size: 42, state: '门盒', quantity: 1 }],
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.queued, true);
    assert.ok(body.job_id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(calls.some((call) => call.kind === 'enqueue'));
    assert.ok(calls.some((call) => call.kind === 'adjust'));
  });
});

test('单双调整保存：本地行不合法 ⇒ 400，不入队', async () => {
  const calls = [];
  const asyncJobs = { jobIdFor: () => 'job', enqueue: async () => { calls.push('enqueue'); }, run: async () => {} };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.workbenchUser = { open_id: 'ou_test' }; next(); });
  app.use('/api/workbench/inventory/adjustments', createInventoryAdjustmentRouter({ asyncJobs, pairService: { adjustPairs: async () => ({}) } }));
  await withServer(app, async (base) => {
    const response = await post(base, '/api/workbench/inventory/adjustments/pairs', {
      productRecordId: 'p1', requestId: 'req-1', rows: [{ size: 0, state: '仓库', quantity: 1 }],
    });
    assert.equal(response.status, 400);
  });
  assert.equal(calls.length, 0);
});

test('单双调整在飞书身份闸门之内：未启用认证 503、未登录 401', async () => {
  const { createWorkbenchRouter } = require('../src/routes/workbench');
  const app = express();
  app.use(express.json());
  app.use('/api/workbench', createWorkbenchRouter({
    gateway: {},
    followup: { gateway: {}, listOrders: async () => ({ orders: [] }) },
    inventoryAdjustment: { pairService: { adjustPairs: async () => ({}) } },
  }));

  delete process.env.LARK_WEB_AUTH_ENABLED;
  await withServer(app, async (base) => {
    const response = await post(base, '/api/workbench/inventory/adjustments/pairs', {
      productRecordId: 'p1', requestId: 'r', rows: [{ size: 42, state: '门盒', quantity: 1 }],
    });
    assert.equal(response.status, 503, '认证没启用时必须拒绝，不能放行到写库存');
  });

  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = 'test_session_secret';
  await withServer(app, async (base) => {
    const response = await post(base, '/api/workbench/inventory/adjustments/pairs', {
      productRecordId: 'p1', requestId: 'r', rows: [{ size: 42, state: '门盒', quantity: 1 }],
    });
    assert.equal(response.status, 401, '没登录时必须 401，不能匿名写库存');
    assert.equal((await response.json()).auth_required, true);
  });
});
