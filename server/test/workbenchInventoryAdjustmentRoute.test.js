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
    const instance = app.listen(0, () => resolve(instance));
  });
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

test('换季调整接口：targets / toState 一路传到 service', async () => {
  const calls = [];
  const service = { adjustSeason: async (input) => { calls.push(input); return { succeeded: 1, failed: 0, to_state: '样品' }; } };
  await withServer(appFor(service), async (base) => {
    const response = await post(base, '/api/workbench/inventory/adjustments/season', {
      action: 'season_release', toState: '样品',
      targets: [{ productRecordId: 'p_1', size: 42, state: '仓库', quantity: 2 }], requestId: 'req-2',
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).to_state, '样品');
  });
  assert.deepEqual(calls[0].targets, [{ productRecordId: 'p_1', size: 42, state: '仓库', quantity: 2 }]);
  assert.equal(calls[0].action, 'season_release');
  assert.equal(calls[0].toState, '样品');
  assert.equal(calls[0].operatorOpenId, 'ou_test_user');
});

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
