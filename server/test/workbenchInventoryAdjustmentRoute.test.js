const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// 这个路由文件会连带加载 workbench 路由，而它模块级就 new 了一个 V1BitableGateway
//（构造时读飞书凭证）。这里给一对**假凭证**，只为了让模块能加载：
// 本用例不打飞书，网关一次都用不到（与 feishuWebAuth.test.js 同一个做法）。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_test_app';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'test_secret';

// 这两个接口是**真写库存**的（新建/删除实时库存 + 写库存流水），
// 所以这里锁两件事：
//   ① 它们必须挂在飞书身份闸门**之内**（匿名调不到）；
//   ② 请求/响应映射正确：她填错 → 400 并原样回显；远端出错 → 502。
const { createInventoryAdjustmentRouter } = require('../src/routes/workbenchInventoryAdjustment');

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const appFor = (service) => {
  const app = express();
  app.use(express.json());
  // 外层的 requireWorkbenchAccess 负责把登录用户放进 req.workbenchUser；
  // 这里模拟那一层，验证「谁调的」会一路传到 service。
  app.use((req, res, next) => { req.workbenchUser = { open_id: 'ou_test_user' }; next(); });
  app.use('/api/workbench/inventory/adjustments', createInventoryAdjustmentRouter({ service }));
  app.use((error, req, res, next) => res.status(500).json({ success: false, error: error.message }));
  return app;
};

const post = (base, path, body) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('盘点调整接口：入参原样交给 service，并把登录用户的 open_id 一起带上', async () => {
  const calls = [];
  const service = {
    adjustCount: async (input) => { calls.push(input); return { action: 'count_increase', after_quantity: 4 }; },
  };
  await withServer(appFor(service), async (base) => {
    const response = await post(base, '/api/workbench/inventory/adjustments/count', {
      productRecordId: 'p_1', size: 42, state: '门盒', mode: 'counted', countedQuantity: 4, requestId: 'req-1',
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.after_quantity, 4);
  });
  const call = calls[0];
  assert.equal(call.productRecordId, 'p_1');
  assert.equal(call.size, 42);
  assert.equal(call.state, '门盒');
  assert.equal(call.mode, 'counted');
  assert.equal(call.countedQuantity, 4);
  assert.equal(call.requestId, 'req-1');
  assert.equal(call.operatorOpenId, 'ou_test_user', '「谁调的」必须一路传到 service');
});

;

test('入参错误回 400 并原样说她哪里填错了；系统/业务错误回 502', async () => {
  const inputError = Object.assign(new Error('尺码必须是整数'), { statusCode: 400 });
  await withServer(appFor({ adjustCount: async () => { throw inputError; } }), async (base) => {
    const response = await post(base, '/api/workbench/inventory/adjustments/count', { requestId: 'r' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, '尺码必须是整数');
  });

  await withServer(appFor({ adjustCount: async () => { throw new Error('门盒库存不足：需 2 双，现有 1 双'); } }), async (base) => {
    const response = await post(base, '/api/workbench/inventory/adjustments/count', { requestId: 'r' });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /库存不足/);
  });
});

test('两个接口都在飞书身份闸门之内：未启用认证 503、未登录 401', async () => {
  // 用真实的 workbench 路由（auth 中间件是它的第一层），只把两个依赖换成桩。
  const { createWorkbenchRouter } = require('../src/routes/workbench');
  const app = express();
  app.use(express.json());
  app.use('/api/workbench', createWorkbenchRouter({
    gateway: {},
    followup: { gateway: {}, listOrders: async () => ({ orders: [] }) },
    inventoryAdjustment: { service: { adjustCount: async () => { throw new Error('不该被调用'); } } },
  }));

  delete process.env.LARK_WEB_AUTH_ENABLED;
  await withServer(app, async (base) => {
    const response = await post(base, '/api/workbench/inventory/adjustments/count', { requestId: 'r' });
    assert.equal(response.status, 503, '认证没启用时必须拒绝，不能放行到写库存');
  });

  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = 'test_session_secret';
  await withServer(app, async (base) => {
    const response = await post(base, '/api/workbench/inventory/adjustments/count', { requestId: 'r' });
    assert.equal(response.status, 401, '没登录时必须 401，不能匿名写库存');
    assert.equal((await response.json()).auth_required, true);
  });
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
