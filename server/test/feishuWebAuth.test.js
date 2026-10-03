const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// 这个路由的 enabled()/sessionSecret() 等都是调用时才读 env，
// 所以先声明再 require 即可，不会影响其它测试文件（node --test 每个文件独立进程）。
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_AGENT_APP_ID = 'cli_test_app';
process.env.LARK_AGENT_APP_SECRET = 'test_secret';
process.env.LARK_WEB_SESSION_SECRET = 'test_session_secret';
process.env.LARK_WEB_REDIRECT_URI = 'https://workbench.example.test/api/auth/feishu/callback';

const { createFeishuWebAuthRouter, safeReturnTo } = require('../src/routes/feishuWebAuth');

test('safeReturnTo 只接受站内相对路径', () => {
  assert.equal(safeReturnTo('/workbench'), '/workbench');
  assert.equal(safeReturnTo('/workbench?tab=sales#row-3'), '/workbench?tab=sales#row-3');

  // 以下输入都曾能绕过原先的 `startsWith('/') && !startsWith('//')` 检查：
  // WHATWG URL 把反斜杠按正斜杠处理，于是 `/\evil.com` 会解析成 host=evil.com。
  assert.equal(safeReturnTo('/\\evil.com'), '/');
  assert.equal(safeReturnTo('\\\\evil.com'), '/');
  assert.equal(safeReturnTo('/\\\\evil.com'), '/');
  assert.equal(safeReturnTo('//evil.com'), '/');
  assert.equal(safeReturnTo('https://evil.com'), '/');
  assert.equal(safeReturnTo(undefined), '/');
  assert.equal(safeReturnTo(''), '/');
  assert.equal(safeReturnTo(123), '/');
});

const withServer = async (run) => {
  const app = express();
  app.use('/api/auth/feishu', createFeishuWebAuthRouter());
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

test('OAuth 回调不会把 req.query.error 当作 HTML 反射', async () => {
  await withServer(async (base) => {
    // 这条分支在 state 有效时即可到达，而攻击者可以自己先请求 /start 拿到一个
    // 合法 state，再构造链接诱导他人点击——所以它不是不可达的死分支。
    const start = await fetch(`${base}/api/auth/feishu/start`, { redirect: 'manual' });
    const location = start.headers.get('location');
    assert.ok(location, '/start 应当重定向到飞书授权页');
    const state = new URL(location).searchParams.get('state');
    assert.ok(state, '/start 应当带上 state');

    const payload = '<script>alert(1)</script>';
    const response = await fetch(
      `${base}/api/auth/feishu/callback?state=${encodeURIComponent(state)}&error=${encodeURIComponent(payload)}`,
    );
    const body = await response.text();

    assert.equal(response.status, 400);
    assert.doesNotMatch(response.headers.get('content-type') || '', /text\/html/);
    // 信息本身仍然保留，便于排查；只是不再以 HTML 交付给浏览器执行。
    assert.match(body, /飞书登录未完成/);
    assert.ok(body.includes(payload));
  });
});

test('OAuth 回调拒绝已使用或过期的 state', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/auth/feishu/callback?state=not-a-real-state`);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /状态已过期/);
  });
});
