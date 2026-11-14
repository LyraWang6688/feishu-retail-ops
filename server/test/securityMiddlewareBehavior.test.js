'use strict';

/**
 * #51：入口安全中间件行为测试（2026-11-14）。
 *
 *   AC-SEC-1 扫码页写请求：允许来源放行、外来源 403、无 Origin 放行、
 *            `Sec-Fetch-Site: cross-site` 且无 Origin ⇒ 403；GET 不拦
 *   AC-SEC-2 IP 限流：窗口内超配额 ⇒ 429 + Retry-After；窗口滚动后恢复；不同 IP 独立
 *   AC-SEC-3 飞书回调：生产缺 encryptKey 也启动失败（原来只校验 token）；challenge 带 token 才回显
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createOriginGuard, createRateLimit } = require('../src/middleware/security');

const run = (middleware, req = {}) => new Promise((resolve) => {
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { resolve({ kind: 'json', status: this.statusCode, body, headers: this.headers }); return this; },
  };
  middleware({ method: 'POST', headers: {}, ...req }, res, () => resolve({ kind: 'next' }));
});

test('AC-SEC-1 来源校验：允许 / 拒绝 / 无 Origin / cross-site / GET', async () => {
  const guard = createOriginGuard({ allowedOrigins: ['https://hm.bamamei.online'] });
  assert.equal((await run(guard, { method: 'GET' })).kind, 'next', 'GET 不拦');
  assert.equal((await run(guard, { method: 'POST' })).kind, 'next', '无 Origin（curl/服务端）放行');
  assert.equal((await run(guard, { method: 'POST', headers: { origin: 'https://hm.bamamei.online' } })).kind, 'next');
  assert.equal((await run(guard, { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403);
  const cross = await run(guard, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(cross.status, 403);
});

test('AC-SEC-2 IP 限流：超配额 429、窗口滚动恢复、不同 IP 独立', async () => {
  let now = 1_000;
  const limiter = createRateLimit({ windowMs: 1000, max: 2, now: () => now });
  const hit = (ip) => run(limiter, { headers: { 'x-forwarded-for': ip } });
  assert.equal((await hit('1.1.1.1')).kind, 'next');
  assert.equal((await hit('1.1.1.1')).kind, 'next');
  const blocked = await hit('1.1.1.1');
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['retry-after']) >= 1);
  assert.equal((await hit('2.2.2.2')).kind, 'next', '另一个 IP 不受影响');
  now += 1001;
  assert.equal((await hit('1.1.1.1')).kind, 'next', '窗口滚动后恢复');
});

test('AC-SEC-3 生产缺 encryptKey 也启动失败（双空即拒）', () => {
  const original = {
    nodeEnv: process.env.NODE_ENV,
    token: process.env.LARK_AGENT_VERIFICATION_TOKEN,
    key: process.env.LARK_AGENT_ENCRYPT_KEY,
  };
  try {
    process.env.NODE_ENV = 'production';
    process.env.LARK_AGENT_VERIFICATION_TOKEN = 'tok_ok';
    delete process.env.LARK_AGENT_ENCRYPT_KEY;
    const { createLarkEventsRouter } = require('../src/routes/larkEvents');
    assert.throws(() => createLarkEventsRouter({ service: {}, heartbeat: { recordEvent() {}, snapshot: () => ({}) } }),
      /ENCRYPT_KEY/);
  } finally {
    if (original.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original.nodeEnv;
    if (original.token === undefined) delete process.env.LARK_AGENT_VERIFICATION_TOKEN; else process.env.LARK_AGENT_VERIFICATION_TOKEN = original.token;
    if (original.key === undefined) delete process.env.LARK_AGENT_ENCRYPT_KEY; else process.env.LARK_AGENT_ENCRYPT_KEY = original.key;
  }
});
