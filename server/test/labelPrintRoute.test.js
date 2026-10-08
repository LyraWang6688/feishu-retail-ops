/**
 * `GET /api/workbench/labels` 的路由护栏（鞋盒标签打印）。
 *
 * 只钉两件事（其余行为在 `labelPrintService.test.js` 与 `labelPrintRender.test.js`）：
 *   ① **鉴权**：这条只读接口必须挂在**现有**工作台身份闸门之内（认证没启用 503 / 未登录 401），
 *      —— 没有另开一套鉴权，也没有匿名读库存的口子；
 *   ② **请求/响应映射**：query 参数原样交给 service（`recentDays` 转成驼峰），
 *      她填错 → 400 并原样回显；远端出错 → 500 且不回显内部细节（复用控制器那一份失败口径）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

// 这个路由文件模块级就 new 了一个 V1BitableGateway（构造时读飞书凭证）。
// 给一对**假凭证**只为让模块能加载：本用例不打飞书（与 workbenchInventoryAdjustmentRoute.test.js 同一做法）。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_test_app';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'test_secret';

const { createWorkbenchRouter } = require('../src/routes/workbench');

const SESSION_SECRET = 'label_print_test_secret';
// 与 `routes/feishuWebAuth.js` 的 encodeSession 同一套签名（测试里"造一个已登录的会话"）。
const sessionCookie = (openId = 'ou_test_user') => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

// ⚠️ 用**真的** workbench 路由（身份闸门是它的第一层），只把标签 service 换成桩 ——
//    这样"这条接口在不在闸门里"是被真正验证的，而不是被绕过。
const appFor = (labelPrint) => {
  const app = express();
  app.use('/api/workbench', createWorkbenchRouter({
    gateway: {},
    followup: { gateway: {}, listOrders: async () => ({ orders: [] }) },
    labelPrint,
  }));
  return app;
};

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};

test('标签接口：query 参数一路交给 service，返回体把 service 的结果摊平在 success 之外', async () => {
  login();
  const calls = [];
  const labelPrint = {
    listLabels: async (input) => {
      calls.push(input);
      return { total_matched: 2, total_returned: 2, labels: [{ key: 'r1' }, { key: 'r2' }] };
    },
  };
  await withServer(appFor(labelPrint), async (base) => {
    const response = await fetch(`${base}/api/workbench/labels?keyword=XHB8095&state=门盒&category=休闲鞋&size=42&recentDays=7&sort=recent`,
      { headers: { cookie: sessionCookie() } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.total_matched, 2);
    assert.equal(body.labels.length, 2);
  });
  assert.deepEqual(calls[0], {
    keyword: 'XHB8095', state: '门盒', category: '休闲鞋', size: '42', recentDays: '7', sort: 'recent',
  });
});

test('标签接口：她填错 → 400 原样回显；远端出错 → 500 且不回显内部细节', async () => {
  login();
  const inputError = Object.assign(new Error('尺码必须是整数'), { statusCode: 400 });
  await withServer(appFor({ listLabels: async () => { throw inputError; } }), async (base) => {
    const response = await fetch(`${base}/api/workbench/labels?size=42码`, { headers: { cookie: sessionCookie() } });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, '尺码必须是整数');
  });

  await withServer(appFor({ listLabels: async () => { throw new Error('App token 不合法（内部细节）'); } }), async (base) => {
    const response = await fetch(`${base}/api/workbench/labels`, { headers: { cookie: sessionCookie() } });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error, '标签数据读取失败');
    assert.ok(!body.error.includes('App token'), '内部细节不许回显给页面');
  });
});

test('标签接口在现有飞书身份闸门之内：未启用认证 503、未登录 401（不新开鉴权）', async () => {
  const app = appFor({ listLabels: async () => { throw new Error('不该被调用'); } });

  delete process.env.LARK_WEB_AUTH_ENABLED;
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/workbench/labels`, { headers: { cookie: sessionCookie() } });
    assert.equal(response.status, 503, '认证没启用时必须拒绝，即使带着会话 cookie');
  });

  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/workbench/labels`);
    assert.equal(response.status, 401, '没登录时必须 401');
    assert.equal((await response.json()).auth_required, true);
  });
  delete process.env.LARK_WEB_AUTH_ENABLED;
});

test('标签接口：白名单外的飞书账号 → 403（沿用既有白名单，不另开一套）', async () => {
  login();
  process.env.WORKBENCH_ALLOWED_OPEN_IDS = 'ou_allowed';
  try {
    await withServer(appFor({ listLabels: async () => ({ labels: [] }) }), async (base) => {
      const response = await fetch(`${base}/api/workbench/labels`, { headers: { cookie: sessionCookie('ou_other') } });
      assert.equal(response.status, 403);
    });
  } finally {
    delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
  }
});
