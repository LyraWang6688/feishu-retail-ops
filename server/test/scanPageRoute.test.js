/**
 * `GET /s/:number`（扫码页）的**路由与准入**用例。
 *
 * 钉住四件事：
 *   ① **挂载点**：真 `app.js` 里就有 `/s` 这一条 —— 不是只在测试里拼出来的；
 *      而且它**不在 `API_KEY` 保护的 `/api/*` 之下**（扫码的人是手机浏览器直接打开，没有 `x-api-key`）；
 *   ② **准入**：与工作台**同一道**闸门（`routes/workbench.js` 导出的
 *      `requireWorkbenchAccess`，两处是**同一个函数**）—— 未启用认证 503 /
 *      白名单外 403（`/api/workbench/*` 那一侧也一并回归了）。
 *      ⚠️ **未登录**这一种在扫码页是**例外**（2026-10-08「扫码即用」）：
 *      扫码的人是在手机浏览器上打开的，没登录时 **302 去飞书登录**（登录完自动回来），
 *      不再是 401 JSON。共享闸门本身一个字没改 —— 逐条用例见 `scanPageAuthRedirect.test.js`。
 *   ③ **页面**：200 出库存表；没找到 404 一张人话页；编号读不出来 400；远端出错 500 不回显内部细节；
 *      飞书没准备好 503 + `Retry-After`；
 *   ④ **只读**：整条链路上 `create/update/delete` 一次都没被调用（假网关一碰就抛）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

// app.js 在 require 阶段就会构造飞书客户端（取凭证，缺了当场抛）——给一对**假凭证**，
// 本用例不打飞书（与 labelPrintRoute.test.js 同一做法）。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_page_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_page_test_secret';

const { createScanPageRouter } = require('../src/routes/scanPage');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const SESSION_SECRET = 'scan_page_test_session_secret';
const NUMBER = 'YD6693-2|黑色|A';
const ENCODED = encodeURIComponent(NUMBER);

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};

// 与 `routes/feishuWebAuth.js` 的 encodeSession 同一套签名（"造一个已登录的会话"）。
const sessionCookie = (openId = 'ou_scan_user') => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const view = (overrides = {}) => ({
  found: true,
  number: NUMBER,
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 3,
  columns: [{ key: '门盒', label: '门盒' }, { key: '样品', label: '样品' }, { key: '仓库', label: '仓库' }],
  rows: [
    { size_text: '40', cells: [{ count: 1 }, { count: 0 }, { count: 0 }], total: 1, missing: false },
    { size_text: '41', cells: [{ count: 0 }, { count: 0 }, { count: 0 }], total: 0, missing: true },
    { size_text: '42', cells: [{ count: 1 }, { count: 1 }, { count: 0 }], total: 2, missing: false },
  ],
  missing_count: 1,
  sizes_degraded: false,
  notes: [SCAN_PAGE.missingSize.hint],
  updated_at_text: '2026-10-08 20:30',
  ...overrides,
});

// ⚠️ 用**真的**扫码路由（准入闸门是它的第一层），只把 service 换成桩 ——
//    这样"这一页在不在闸门里"是被真正验证的，而不是被绕过。
const appFor = (lookup) => {
  const calls = [];
  const app = express();
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async (input) => { calls.push(input); return lookup(input); } },
  }));
  app.calls = calls;
  return app;
};

test('页面：200 出库存表（含缺码高亮、0 用「—」、单价与身份区），且不缓存', async () => {
  login();
  const app = appFor(async () => view());
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/s/${ENCODED}`, { headers: { cookie: sessionCookie() } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(String(response.headers.get('cache-control')), /no-store/);
    const html = await response.text();
    assert.match(html, /YD6693-2/);              // 身份区：货号
    assert.match(html, /黑色 · 休闲鞋/);          // 颜色 · 品类
    assert.match(html, /¥399/);                  // 单价
    assert.match(html, /库存（共 3 双）/);         // 汇总
    assert.match(html, /<th>门盒<\/th><th>样品<\/th><th>仓库<\/th>/);
    assert.match(html, /class="missing"/);        // 缺码整行高亮
    assert.match(html, /⚠️ 缺/);                  // 缺码徽标
    assert.match(html, /<td class="zero">—<\/td>/); // 0 → 「—」
  });
  // 编号**解码后**才交给 service（Express 解一次，service 再解一次也不怕）
  assert.equal(app.calls[0].number, NUMBER);
});

test('没找到这个编号 → 404 + 一张说清楚的页面（不白屏、不 500）', async () => {
  login();
  await withServer(appFor(async () => ({ found: false, number: 'NOPE|黑色|A', reason: 'unknown' })), async (base) => {
    const response = await fetch(`${base}/s/NOPE%7C%E9%BB%91%E8%89%B2%7CA`, { headers: { cookie: sessionCookie() } });
    assert.equal(response.status, 404);
    const html = await response.text();
    assert.match(html, /没找到这个编号/);
    assert.match(html, /可能已删除、或编号变了/);
    assert.match(html, /NOPE\|黑色\|A/); // 把她扫到的编号原样回显，便于核对
  });
});

test('编号读不出来（空 / 只有空格 / 解码失败）→ 400 + 人话页，不是 Express 那行 Bad Request', async () => {
  login();
  const app = appFor(async () => ({ found: false, number: '', reason: 'empty' }));
  await withServer(app, async (base) => {
    for (const path of ['/s/', '/s/%20']) {
      const response = await fetch(`${base}${path}`, { headers: { cookie: sessionCookie() } });
      assert.equal(response.status, 400, path);
      assert.match(await response.text(), /这个链接不对/);
    }
    // `%zz` 在**进入 handler 之前**就被 Express 拒了（Failed to decode param）——
    // 由 router 级错误中间件接住，回的还是我们那张页
    const malformed = await fetch(`${base}/s/%zz`, { headers: { cookie: sessionCookie() } });
    assert.equal(malformed.status, 400);
    assert.match(await malformed.text(), /这个链接不对/);
    // `50%OFF`：Express 解不开、handler 里也解不开 → 照样一张人话页
    const literal = await fetch(`${base}/s/50%OFF`, { headers: { cookie: sessionCookie() } });
    assert.equal(literal.status, 400);
    assert.match(await literal.text(), /这个链接不对/);
  });
});

test('远端出错 → 500 不回显内部细节；飞书没准备好 → 503 + Retry-After', async () => {
  login();
  await withServer(appFor(async () => { throw new Error('App token 不合法（内部细节）'); }), async (base) => {
    const response = await fetch(`${base}/s/${ENCODED}`, { headers: { cookie: sessionCookie() } });
    assert.equal(response.status, 500);
    const html = await response.text();
    assert.match(html, /暂时打不开，请稍后再试/);
    assert.equal(html.includes('App token'), false, '内部细节不许回显到页面');
  });

  await withServer(appFor(async () => { throw new Error('飞书 1254607 data not ready'); }), async (base) => {
    const response = await fetch(`${base}/s/${ENCODED}`, { headers: { cookie: sessionCookie() } });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
    assert.match(await response.text(), /库存数据正在准备中/);
  });

  const limit = Object.assign(new Error('超过本页本次可读上限'), { scanLimitExceeded: true });
  await withServer(appFor(async () => { throw limit; }), async (base) => {
    const response = await fetch(`${base}/s/${ENCODED}`, { headers: { cookie: sessionCookie() } });
    assert.equal(response.status, 503);
    assert.match(await response.text(), /这次读的库存太多了/);
  });
});

test('准入（与工作台同一道闸门）：未启用认证 503、未登录 302 去登录、白名单外 403 —— 且不碰 service', async () => {
  const app = appFor(async () => { throw new Error('闸门没过时不许查数据'); });

  process.env.LARK_WEB_AUTH_ENABLED = 'false';
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/s/${ENCODED}`, { headers: { cookie: sessionCookie() } });
    assert.equal(response.status, 503, '认证没启用时必须拒绝，即使带着会话 cookie');
  });

  login();
  await withServer(app, async (base) => {
    // ⚠️ 2026-10-08「扫码即用」：**扫码页**未登录不再回 401 JSON，而是 302 去飞书登录
    //    （`next` = 刚才那一页，登录完自动回来）。共享闸门 `requireWorkbenchAccess`
    //    的语义没动，只是这一种情况在扫码页被提前接住了；工作台那一侧仍是 401 JSON
    //    （见下面最后一段与 `scanPageAuthRedirect.test.js`）。
    const response = await fetch(`${base}/s/${ENCODED}`, { redirect: 'manual' });
    assert.equal(response.status, 302, '没登录时必须去登录');
    assert.match(response.headers.get('location'), /^\/api\/auth\/feishu\/start\?next=/, '目标是登录入口');
  });

  process.env.WORKBENCH_ALLOWED_OPEN_IDS = 'ou_allowed';
  try {
    await withServer(app, async (base) => {
      const response = await fetch(`${base}/s/${ENCODED}`, { headers: { cookie: sessionCookie('ou_other') } });
      assert.equal(response.status, 403);
    });
    // 白名单内的人照常打开（换一个会正常返回的 service）
    await withServer(appFor(async () => view()), async (base) => {
      const response = await fetch(`${base}/s/${ENCODED}`, { headers: { cookie: sessionCookie('ou_allowed') } });
      assert.equal(response.status, 200, '白名单内的人照常打开');
    });
  } finally {
    delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
  }
  assert.equal(app.calls.length, 0, '闸门没过时 service 一次都不该被调用');
});

// ── 真 app.js：挂载点 + 不在 API_KEY 之下 + 只读 ─────────────────────────────
const SIZE_RECORDS = [
  { record_id: 'size_40', fields: { 尺码: 40, 类别: 'A' } },
  { record_id: 'size_41', fields: { 尺码: 41, 类别: 'A' } },
];
const PRODUCTS = [{
  record_id: 'prod_1',
  fields: { 编号: NUMBER, 货号: 'YD6693-2', 颜色: { text: '黑色' }, 类别: 'A', 品类: { text: '休闲鞋' }, 单价: 399 },
}];
const INVENTORY = [
  { record_id: 'inv_1', fields: { 编号: ['prod_1'], 尺码: ['size_40'], 所属状态: '门盒', 库存键: `${NUMBER}|40`, 品类: '休闲鞋', 更新时间: Date.UTC(2026, 9, 8, 12, 30) } },
];

test('真 app.js：`/s/:number` 确实挂上了、不要 API_KEY、走同一道工作台闸门，且一次写调用都没有', async () => {
  login();
  const gateway = require('../src/services/v1BitableGateway');
  const writes = [];
  const original = {
    listAll: gateway.V1BitableGateway.prototype.listAll,
    create: gateway.V1BitableGateway.prototype.create,
    update: gateway.V1BitableGateway.prototype.update,
    delete: gateway.V1BitableGateway.prototype.delete,
  };
  // 只替换"读"；写方法一被碰就抛（"这条链路只读"最硬的证据）。
  gateway.V1BitableGateway.prototype.listAll = async (tableKey) => (
    { product: PRODUCTS, liveInventory: INVENTORY, sizeManagement: SIZE_RECORDS }[tableKey] || []
  );
  for (const method of ['create', 'update', 'delete']) {
    gateway.V1BitableGateway.prototype[method] = async () => {
      writes.push(method);
      throw new Error(`扫码链路不许调用 ${method}`);
    };
  }

  let app;
  try {
    app = require('../src/app'); // 真的入口：所有挂载都在里面
    await withServer(app, async (base) => {
      const response = await fetch(`${base}/s/${ENCODED}`, { headers: { cookie: sessionCookie() } });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/html/);
      const html = await response.text();
      assert.match(html, /YD6693-2/);
      assert.match(html, /库存（共 1 双）/);
      assert.match(html, /class="missing"/, '41 码在「尺码管理」里有、库存为 0 ⇒ 缺码');
      assert.match(html, /2026-10-08 20:30/, '库存更新时间按上海 +8 显示');

      // 闸门还在：不带会话时**扫码页** 302 去登录（"扫码即用"）；
      // 工作台那一侧仍是 401 JSON（下面两行，逐字不变）
      const anonymous = await fetch(`${base}/s/${ENCODED}`, { redirect: 'manual' });
      assert.equal(anonymous.status, 302);
      assert.match(anonymous.headers.get('location'), /^\/api\/auth\/feishu\/start\?next=/);

      // 扫码页与工作台共用同一个闸门函数：工作台自己的接口照旧（回归）
      const workbench = await fetch(`${base}/api/workbench/inventory`);
      assert.equal(workbench.status, 401);
      assert.equal((await workbench.json()).auth_required, true);
    });
  } finally {
    for (const [method, fn] of Object.entries(original)) gateway.V1BitableGateway.prototype[method] = fn;
  }
  assert.deepEqual(writes, [], '扫码页整条链路一次写调用都没有');
  // 挂载点在 config 里（app.js 用的是同一个常量，不许各写一份）
  assert.equal(SCAN_PAGE.route.basePath, '/s');
  assert.equal(V1_BITABLE_SCHEMA.tables.liveInventory.fields.state, '所属状态');
});
