/**
 * 采购页端点判据（AC-P10 / P11 / P18 的接口面）：4 个端点契约 + 错误口径 + 只读/写边界。
 *
 * 路由挂在**既有** `src/routes/workbench/purchase.js`（父 router 已挂载）⇒ 不改共享文件、
 * 自动带既有准入闸门 / no-store / ui-tap 结果事件。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// 路由/服务 require 链会在模块级构造飞书网关（本文件一次飞书都不打）
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_procurement_routes';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'procurement_routes_secret';
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_procurement_routes';

const { createWorkbenchPurchaseRoutes } = require('../src/routes/workbench/purchase');
const { PROCUREMENT_PAGE } = require('../src/config/procurementPage');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

const makeApp = ({ page, submit } = {}) => {
  const calls = { page: [], submit: [] };
  const fakePage = {
    async loadReplenish(input) { calls.page.push(['replenish', input]); return { range: {}, stats: {}, groups: [] }; },
    async loadNewProducts(input) { calls.page.push(['newProducts', input]); return { range: {}, stats: {}, groups: [] }; },
  };
  const fakeSubmit = {
    async submit(input) { calls.submit.push(input); return { ok: true, reused: false, message: PROCUREMENT_PAGE.texts.submitAccepted }; },
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.workbenchUser = { open_id: 'ou_test' }; req.requestId = 'req_test'; next(); });
  app.use(createWorkbenchPurchaseRoutes({ options: { arrival: {}, procurementPage: page || fakePage, procurementSubmit: submit || fakeSubmit } }));
  return { app, calls };
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};
const getJson = async (base, pathName) => {
  const response = await fetch(`${base}${pathName}`);
  return { status: response.status, body: await response.json() };
};
const postJson = async (base, pathName, payload) => {
  const response = await fetch(`${base}${pathName}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
};

test('AC-P10 端点契约：补货 / 上新 / 提交（配置里的路径 = 路由里的路径）', () => {
  assert.equal(PROCUREMENT_PAGE.endpoints.replenish, '/procurement/replenish');
  assert.equal(PROCUREMENT_PAGE.endpoints.newProducts, '/procurement/new-products');
  assert.equal(PROCUREMENT_PAGE.endpoints.submit, '/procurement/submit');
  const source = read('src/routes/workbench/purchase.js');
  assert.match(source, /router\.get\(PROCUREMENT_PAGE\.endpoints\.replenish/);
  assert.match(source, /router\.get\(PROCUREMENT_PAGE\.endpoints\.newProducts/);
  assert.match(source, /router\.post\(PROCUREMENT_PAGE\.endpoints\.submit/);
  // 父 router 已挂载本文件（不改共享文件就能生效）
  assert.match(read('src/routes/workbench.js'), /createWorkbenchPurchaseRoutes/);
});

test('AC-P10 GET /procurement/replenish 返回 success + 服务端读模型结果', async () => {
  const { app, calls } = makeApp();
  await withServer(app, async (base) => {
    const { status, body } = await getJson(base, '/procurement/replenish');
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.deepEqual(body.groups, []);
    assert.equal(calls.page.length, 1);
    assert.equal(calls.page[0][0], 'replenish');
  });
});

test('AC-P10 GET /procurement/new-products 返回 success（统计口径由服务端给）', async () => {
  const { app, calls } = makeApp();
  await withServer(app, async (base) => {
    const { status, body } = await getJson(base, '/procurement/new-products');
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(calls.page[0][0], 'newProducts');
  });
});

test('读模型抛错 ⇒ 502 + 人话（不 500、不空对象冒充成功）', async () => {
  const failing = {
    async loadReplenish() { throw new Error('bitable down'); },
    async loadNewProducts() { throw new Error('bitable down'); },
  };
  const { app } = makeApp({ page: failing });
  await withServer(app, async (base) => {
    for (const pathName of ['/procurement/replenish', '/procurement/new-products']) {
      const { status, body } = await getJson(base, pathName);
      assert.equal(status, 502);
      assert.equal(body.success, false);
      assert.equal(body.error, PROCUREMENT_PAGE.texts.loadFailed);
    }
  });
});

test('AC-P10/P14 POST /procurement/submit：通过 ⇒ accepted + 统一文案；openId 来自登录态', async () => {
  const { app, calls } = makeApp();
  await withServer(app, async (base) => {
    const { status, body } = await postJson(base, '/procurement/submit', {
      submitKey: 'procurement_test_key_0001', items: [{ productRecordId: 'recA', entries: [{ size: 39, quantity: 1 }] }],
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.accepted, true);
    assert.equal(body.message, PROCUREMENT_PAGE.texts.submitAccepted);
    assert.equal(calls.submit[0].openId, 'ou_test');
    assert.equal(calls.submit[0].submitKey, 'procurement_test_key_0001');
    assert.equal(calls.submit[0].requestId, 'req_test');
  });
});

test('AC-P12 提交被拒 ⇒ 400 + code + 人话；行为解析不到 ⇒ 502', async () => {
  const rejected = makeApp({
    submit: { async submit() { return { ok: false, code: 'duplicate_line', message: '重复了' }; } },
  });
  await withServer(rejected.app, async (base) => {
    const { status, body } = await postJson(base, '/procurement/submit', { submitKey: 'k', items: [] });
    assert.equal(status, 400);
    assert.equal(body.success, false);
    assert.equal(body.code, 'duplicate_line');
  });
  const broken = makeApp({ submit: { async submit() { return { ok: false, code: 'behavior_missing', message: 'x' }; } } });
  await withServer(broken.app, async (base) => {
    const { status } = await postJson(base, '/procurement/submit', { submitKey: 'k', items: [] });
    assert.equal(status, 502);
  });
});

test('AC-P13 源码哨兵：本域不直连写业务表（只调既有引擎 / 写入件）', () => {
  const source = read('src/services/procurementPageSubmitService.js');
  assert.equal(/gateway\.create\(/.test(source), false, '提交服务不许自己写业务表');
  assert.equal(/gateway\.update\(/.test(source), false);
  assert.match(source, /createMultiItemOrderService/);
  assert.match(source, /scheduleCustomRest/);
});
