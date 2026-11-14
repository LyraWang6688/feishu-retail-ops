'use strict';

/**
 * #53：飞书事件回调的**拒绝路径行为测试**（2026-11-14）。
 *
 * 现状（实测 SDK 行为，不是猜）：
 *   · 生产环境缺 LARK_AGENT_VERIFICATION_TOKEN ⇒ 建 router 就抛（启动失败，不放行）；
 *   · token 已配 + 事件 token 不对 ⇒ SDK 返回 **200 空响应**，且**不执行业务 handler**
 *     （飞书侧看到成功，但我们这里确实没派发 —— 判据用"handler 没被调用"钉住）；
 *   · challenge 是唯一在 dispatcher 之前回答的分支（URL 验证需要），**当前不做 token 校验**
 *     —— 这里如实钉住现状；加固放进 #51（安全）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createLarkEventsRouter } = require('../src/routes/larkEvents');

const original = {
  token: process.env.LARK_AGENT_VERIFICATION_TOKEN,
  key: process.env.LARK_AGENT_ENCRYPT_KEY,
  nodeEnv: process.env.NODE_ENV,
};

test.afterEach(() => {
  const restore = (name, value) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
  restore('LARK_AGENT_VERIFICATION_TOKEN', original.token);
  restore('LARK_AGENT_ENCRYPT_KEY', original.key);
  restore('NODE_ENV', original.nodeEnv);
});

const post = async (server, body) => {
  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/api/lark/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
};

const listen = (router) => new Promise((resolve) => {
  const app = express();
  app.use(express.json());
  app.use('/api/lark/events', router);
  // 项目哨兵：临时服务器必须绑回环 + keepAliveTimeout=1（避免 ECONNRESET 偶发）
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
  server.keepAliveTimeout = 1;
});

test('AC-LEV-1 生产环境缺 verificationToken ⇒ 启动即失败（不放行）', () => {
  process.env.NODE_ENV = 'production';
  delete process.env.LARK_AGENT_VERIFICATION_TOKEN;
  assert.throws(() => createLarkEventsRouter({ service: {}, heartbeat: fakeHeartbeat() }), /VERIFICATION_TOKEN/);
});

test('AC-LEV-2 事件 token 不对 ⇒ 不执行业务 handler（200 空响应，SDK 行为）', async () => {
  process.env.NODE_ENV = 'production';
  process.env.LARK_AGENT_VERIFICATION_TOKEN = 'tok_ok';
  process.env.LARK_AGENT_ENCRYPT_KEY = 'enc_ok';
  let dispatched = 0;
  // 属性读取不算"派发"（handler 注册时会读方法名）；**调用**才算。
  const service = new Proxy({}, {
    get: () => (..._args) => { dispatched += 1; return Promise.resolve(null); },
  });
  const server = await listen(createLarkEventsRouter({ service, heartbeat: fakeHeartbeat() }));
  try {
    const out = await post(server, { header: { token: 'bad_token', event_type: 'x' }, event: {} });
    assert.equal(out.status, 200);
    assert.equal(out.text, '', '验证失败 = 空响应（不泄露任何业务信息）');
    assert.equal(dispatched, 0, '验证失败必须不派发业务 handler');
  } finally {
    server.close();
  }
});

test('AC-LEV-3 challenge 分支当前不做 token 校验（现状；加固见 #51）', async () => {
  process.env.NODE_ENV = 'production';
  process.env.LARK_AGENT_VERIFICATION_TOKEN = 'tok_ok';
  const server = await listen(createLarkEventsRouter({ service: {}, heartbeat: fakeHeartbeat() }));
  try {
    const out = await post(server, { challenge: 'abc123' });
    assert.equal(out.status, 200);
    assert.deepEqual(JSON.parse(out.text), { challenge: 'abc123' });
  } finally {
    server.close();
  }
});

function fakeHeartbeat() {
  return { recordEvent: () => {}, snapshot: () => ({}) };
}
