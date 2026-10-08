/**
 * 扫码页「扫码即用」：**未登录 → 302 去飞书登录 → 登录成功后自动回到刚才那一页**。
 *
 * 背景（业务负责人在手机飞书上扫标签二维码）：手机浏览器里没有 `hm.bamamei.online`
 * 的登录 cookie，原来扫开看到的是工作台那套 401 JSON
 * （`{"success":false,"error":"请先通过飞书身份登录工作台","auth_required":true}`）。
 *
 * 本文件钉住五件事：
 *   ① 未登录 `GET /s/:编号` → **302**，Location = `/api/auth/feishu/start?next=<编码后的原 path + 原 query>`；
 *   ② 登录回跳：`/start?next=...` 存下的 state，callback 成功后 **302 到 next**（真跑一遍 OAuth 回调，
 *      飞书那三个接口用桩顶掉 —— 测的是**仓库里那份路由代码**，不是手拼结果）；
 *   ③ **防开放重定向**：非法 next（`//evil.com` / `https://evil.com` / `/a//b` / `/\evil.com`
 *      / `/s/../api/...` …）一律**回落到工作台首页**；白名单只放行扫码页自己（`/s/...`）；
 *   ④ 未带 next 时**与改动前逐字一致**（回工作台首页；`return_to` 既有语义不变，工作台前端照旧）；
 *   ⑤ **共享闸门的语义不变**：工作台接口未登录仍是 **401 JSON**；认证没启用仍是 503；
 *      白名单外仍是 403。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

// 与 scanPageRoute.test.js 同一做法：app.js 在 require 阶段就要一对凭证。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_redirect_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_redirect_test_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = 'scan_redirect_test_session_secret';
process.env.LARK_WEB_REDIRECT_URI = 'https://hm.bamamei.online/api/auth/feishu/callback';

const { createScanPageRouter } = require('../src/routes/scanPage');
const { createFeishuWebAuthRouter } = require('../src/routes/feishuWebAuth');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_AUTH_REDIRECT } = require('../src/config/scanAuthRedirect');

const SESSION_SECRET = 'scan_redirect_test_session_secret';
const NUMBER = 'YD6693-2|黑色|A';
const ENCODED = encodeURIComponent(NUMBER);
const PAGE = `/s/${ENCODED}`;
const START = SCAN_AUTH_REDIRECT.login.startPath;
const NEXT_PARAM = SCAN_AUTH_REDIRECT.returnPath.paramName;
const HOME = SCAN_AUTH_REDIRECT.returnPath.defaultPath;

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};

const sessionCookie = (openId = 'ou_scan_user') => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};

const view = () => ({
  found: true,
  number: NUMBER,
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 1,
  columns: [{ key: '门仓', label: '门仓' }],
  rows: [{ size_text: '40', cells: [{ count: 1 }], total: 1, missing: false }],
  missing_count: 0,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-08 20:30',
});

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

// 扫码页 + 登录路由（都挂在与 app.js 相同的位置上）。
const scanApp = () => {
  const calls = [];
  const app = express();
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async (input) => { calls.push(input); return view(); } },
  }));
  app.use('/api/auth/feishu', createFeishuWebAuthRouter());
  app.calls = calls;
  return app;
};

// 飞书那三个接口的桩（OAuth 回调里会真去调它们）；本站请求照旧走真 fetch。
const fakeJson = (body) => ({ ok: true, status: 200, json: async () => body });
const withFeishuStub = async (run) => {
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, options) => {
    const href = String(url);
    if (href.startsWith('https://open.feishu.cn/')) {
      seen.push(href);
      if (href.includes('/auth/v3/app_access_token/internal')) return fakeJson({ app_access_token: 'app_tok' });
      if (href.includes('/authen/v1/access_token')) return fakeJson({ access_token: 'user_tok' });
      if (href.includes('/authen/v1/user_info')) return fakeJson({ open_id: 'ou_scan_user', name: '扫码的人' });
      throw new Error(`用例没预料到的飞书调用：${href}`);
    }
    return realFetch(url, options);
  };
  try { return await run(seen); } finally { global.fetch = realFetch; }
};

// 走一遍 `/start` 拿 state（= 真链路里飞书回跳时带回来的那个）。
const startState = async (base, query = '') => {
  const response = await fetch(`${base}${START}${query}`, { redirect: 'manual' });
  assert.equal(response.status, 302, '/start 应当 302 到飞书授权页');
  const location = response.headers.get('location');
  assert.match(location, /^https:\/\/open\.feishu\.cn\/open-apis\/authen\/v1\/authorize\?/);
  const state = new URL(location).searchParams.get('state');
  assert.ok(state, '/start 应当带上 state');
  return state;
};

const callback = (base, state, extra = '') => fetch(
  `${base}/api/auth/feishu/callback?state=${encodeURIComponent(state)}${extra}`,
  { redirect: 'manual' },
);

test('① 未登录 GET /s/:编号 → 302 去登录，Location 带 next（原 path + 原 query，编码正确）', async () => {
  login();
  const app = scanApp();
  await withServer(app, async (base) => {
    const response = await fetch(`${base}${PAGE}?from=tag&x=1`, { redirect: 'manual' });
    assert.equal(response.status, 302, '未登录时不再是 401 JSON，而是 302 去登录');

    const location = response.headers.get('location');
    assert.ok(location.startsWith(`${START}?${NEXT_PARAM}=`), `Location 应当是登录入口：${location}`);
    const raw = location.slice(`${START}?${NEXT_PARAM}=`.length);
    // ⚠️ 整段 next 只编码一次：原查询串里的 `&` 必须变成 `%26`，否则会被当成 start 自己的参数
    assert.equal(raw.includes('&'), false, 'next 必须整体 encodeURIComponent');
    assert.equal(decodeURIComponent(raw), `${PAGE}?from=tag&x=1`, 'next = 原 path + 原 query');

    // `/s/`（没有编号）也是"扫码页"：一样先去登录，回来再看那张"链接不对"的人话页
    const bare = await fetch(`${base}${SCAN_PAGE.route.basePath}/`, { redirect: 'manual' });
    assert.equal(bare.status, 302);
    assert.equal(
      decodeURIComponent(bare.headers.get('location').slice(`${START}?${NEXT_PARAM}=`.length)),
      `${SCAN_PAGE.route.basePath}/`,
    );
  });
  assert.deepEqual(app.calls, [], '还没登录，一次数据都不该查');
});

test('② 登录回跳：/start?next=... 存下的 state，callback 成功后 302 到 next（真跑一遍回调）', async () => {
  login();
  const app = scanApp();
  await withFeishuStub(async () => {
    await withServer(app, async (base) => {
      const target = `${PAGE}?from=tag`;
      const state = await startState(base, `?${NEXT_PARAM}=${encodeURIComponent(target)}`);
      const response = await callback(base, state, '&code=test_code');
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), target, '登录完要回到刚才那一页');
      assert.match(String(response.headers.get('set-cookie')), /workbench_session=/, '回跳时已经种上会话');

      // state 一次性：同一个 state 再用一次必须被拒（CSRF 语义没动）
      const replay = await callback(base, state, '&code=test_code');
      assert.equal(replay.status, 400, 'state 用过即废');
    });
  });
});

test('③ callback 直连带合法 next → 302 到 next（仍先验 state）', async () => {
  login();
  const app = scanApp();
  await withFeishuStub(async () => {
    await withServer(app, async (base) => {
      const state = await startState(base); // 不带 next：state 里存的是工作台首页
      const target = `${PAGE}?a=b`;
      const response = await callback(base, state, `&${NEXT_PARAM}=${encodeURIComponent(target)}`);
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), target);
    });
  });
});

test('④ 防开放重定向：非法 / 白名单外的 next 一律回落工作台首页', async () => {
  login();
  const app = scanApp();
  const illegal = [
    '//evil.com', '///evil.com', 'https://evil.com', 'http:evil.com',
    '/\\evil.com', '\\\\evil.com', 'javascript:alert(1)', 'data:text/html,x',
    '/a//b', '/s/../api/workbench/inventory', '/s/%2e%2e/api/workbench/inventory',
    '/%2F%2Fevil.com', '/workbench/index.html?tab=sales', '', '   ',
  ];
  await withFeishuStub(async () => {
    await withServer(app, async (base) => {
      for (const value of illegal) {
        // (a) 经 /start 存进 state 那一份
        const stateA = await startState(base, `?${NEXT_PARAM}=${encodeURIComponent(value)}`);
        const viaStart = await callback(base, stateA, '&code=c');
        assert.equal(viaStart.status, 302, `应当 302：${JSON.stringify(value)}`);
        assert.equal(viaStart.headers.get('location'), HOME, `必须回落工作台首页：${JSON.stringify(value)}`);

        // (b) callback 上直连带的那一份（走同一套白名单）
        const stateB = await startState(base);
        const viaCallback = await callback(base, stateB, `&${NEXT_PARAM}=${encodeURIComponent(value)}&code=c`);
        assert.equal(viaCallback.status, 302, `应当 302：${JSON.stringify(value)}`);
        assert.equal(viaCallback.headers.get('location'), HOME, `必须回落工作台首页：${JSON.stringify(value)}`);
      }
      // 合法的那一份照常放行（对照，证明上面的断言不是"永远回落"）
      const ok = await startState(base, `?${NEXT_PARAM}=${encodeURIComponent(`${PAGE}?x=1`)}`);
      assert.equal((await callback(base, ok, '&code=c')).headers.get('location'), `${PAGE}?x=1`);
    });
  });
});

test('⑤ 未带 next：与改动前逐字一致（工作台首页）；return_to 既有语义不变', async () => {
  login();
  const app = scanApp();
  await withFeishuStub(async () => {
    await withServer(app, async (base) => {
      // 什么都不带 → 工作台首页（改动前的默认落点，`app.js` 的 `GET /` 就是工作台 index.html）
      const bare = await startState(base);
      assert.equal((await callback(base, bare, '&code=c')).headers.get('location'), HOME);

      // 工作台前端 `public/workbench/core/auth.js` 用的 `return_to`：回工作台任意站内页，逐字不变
      const legacy = '/workbench/index.html?tab=sales';
      const state = await startState(base, `?return_to=${encodeURIComponent(legacy)}`);
      assert.equal((await callback(base, state, '&code=c')).headers.get('location'), legacy);

      // return_to 照样过 safeReturnTo（`//host` 仍然回不去）
      const evil = await startState(base, `?return_to=${encodeURIComponent('//evil.com')}`);
      assert.equal((await callback(base, evil, '&code=c')).headers.get('location'), HOME);
    });
  });
});

test('⑥ 共享闸门语义不变：认证没启用 503、白名单外 403、工作台未登录 401 JSON', async () => {
  // 真 app.js：所有挂载都在里面（也顺带验证 `/s` 与 `/api/workbench` 用的是同一道闸门）。
  const app = require('../src/app');
  const guard = async (run) => withServer(app, run);

  process.env.LARK_WEB_AUTH_ENABLED = 'false';
  await guard(async (base) => {
    const scan = await fetch(`${base}${PAGE}`, { redirect: 'manual' });
    assert.equal(scan.status, 503, '认证没启用时扫码页照旧 503（不是 302）');
    assert.equal((await scan.json()).success, false);
    const workbench = await fetch(`${base}/api/workbench/inventory`);
    assert.equal(workbench.status, 503, '工作台接口一字不变');
  });

  login();
  process.env.WORKBENCH_ALLOWED_OPEN_IDS = 'ou_allowed';
  try {
    await guard(async (base) => {
      const scan = await fetch(`${base}${PAGE}`, {
        redirect: 'manual', headers: { cookie: sessionCookie('ou_other') },
      });
      assert.equal(scan.status, 403, '已登录但白名单外：保持原样（不是 302、也不是 200）');
      const workbench = await fetch(`${base}/api/workbench/inventory`, {
        headers: { cookie: sessionCookie('ou_other') },
      });
      assert.equal(workbench.status, 403, '工作台接口一字不变');
    });
  } finally {
    delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
  }

  await guard(async (base) => {
    const scan = await fetch(`${base}${PAGE}`, { redirect: 'manual' });
    assert.equal(scan.status, 302, '未登录的扫码页：302 去登录');
    // 🔴 工作台那套 401 JSON 一个字都不许变（她的 fetch 接口与既有哨兵都钉着它）
    const workbench = await fetch(`${base}/api/workbench/inventory`);
    assert.equal(workbench.status, 401);
    assert.equal(workbench.headers.get('content-type').includes('application/json'), true);
    assert.deepEqual(await workbench.json(), {
      success: false, error: '请先通过飞书身份登录工作台', auth_required: true,
    });
    // `/api/auth/feishu/me` 同样是既有语义
    const me = await fetch(`${base}/api/auth/feishu/me`);
    assert.equal(me.status, 401);
    assert.equal((await me.json()).auth_required, true);
  });
});

test('⑦ 已登录且白名单内：扫码页照常 200（页面行为一个字没变）', async () => {
  login();
  const app = scanApp();
  await withServer(app, async (base) => {
    const response = await fetch(`${base}${PAGE}`, { headers: { cookie: sessionCookie() } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /YD6693-2/);
  });
  assert.equal(app.calls.length, 1, '登录了就该真去查数据');
});
