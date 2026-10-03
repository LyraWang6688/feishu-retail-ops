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

  // 这些输入曾被怀疑可以绕过校验（`/\evil.com` 确实能绕过最初那版：
  // WHATWG URL 把反斜杠按正斜杠处理，于是它解析成 host=evil.com）。
  // 现在必须一律退回站点根路径。
  const mustFallBack = [
    '/\\evil.com', '\\\\evil.com', '/\\\\evil.com', '//evil.com', '///evil.com',
    '/\\/evil.com', '\\/evil.com', 'https://evil.com', 'http:evil.com',
    'javascript:alert(1)', 'data:text/html,x', '', '//',
    123, null, undefined,
  ];
  mustFallBack.forEach((value) => {
    assert.equal(safeReturnTo(value), '/', `应当退回 /：${JSON.stringify(value)}`);
  });

  // 判定标准不是字符串长什么样，而是“浏览器最终解析出的 host 是不是本站”。
  // 百分号编码的反斜杠/斜杠不会在解析阶段被还原成分隔符，因此原样放行——
  // 但即使放行，它们也必须留在本站。
  const ORIGIN = 'https://workbench.bamamei.online';
  const mustStayOnSite = [
    '/%5Cevil.com', '/%2f%2fevil.com', '/..//evil.com', '/%2e%2e//evil.com',
    '/@evil.com', '/%09/evil.com', '/ evil.com',
  ];
  mustStayOnSite.forEach((value) => {
    assert.equal(new URL(safeReturnTo(value), ORIGIN).origin, ORIGIN, `不应跳出本站：${value}`);
  });
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

test('OAuth 回调不回显 req.query.error，只写结构化日志', async () => {
  await withServer(async (base) => {
    // 这条分支在 state 有效时即可到达，而攻击者可以自己先请求 /start 拿到一个
    // 合法 state，再构造链接诱导他人点击——所以它不是不可达的死分支。
    const start = await fetch(`${base}/api/auth/feishu/start`, { redirect: 'manual' });
    const location = start.headers.get('location');
    assert.ok(location, '/start 应当重定向到飞书授权页');
    const state = new URL(location).searchParams.get('state');
    assert.ok(state, '/start 应当带上 state');

    const payload = '<script>alert(1)</script>';
    const captured = [];
    const originalWarn = console.warn;
    console.warn = (line) => captured.push(String(line));
    let response;
    let body;
    try {
      response = await fetch(
        `${base}/api/auth/feishu/callback?state=${encodeURIComponent(state)}&error=${encodeURIComponent(payload)}`,
      );
      body = await response.text();
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(response.status, 400);
    assert.doesNotMatch(response.headers.get('content-type') || '', /text\/html/);
    // 关键断言：响应体里完全不出现调用方提供的值，CodeQL 的 taint flow 因此不存在。
    assert.ok(!body.includes(payload), `响应体不应回显用户输入，实际为：${body}`);
    assert.match(body, /飞书登录未完成/);

    // 但诊断信息不能丢：原始错误进了结构化日志，按 request_id 可查。
    const logged = captured
      .map((line) => JSON.parse(line))
      .find((entry) => entry.event === 'workbench.auth.provider_error');
    assert.ok(logged, '应当记录 workbench.auth.provider_error');
    assert.equal(logged.error, payload);
  });
});

test('OAuth 回调拒绝已使用或过期的 state', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/auth/feishu/callback?state=not-a-real-state`);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /状态已过期/);
  });
});
