'use strict';

/**
 * #53：鉴权/回调的**行为测试**（2026-11-14）。
 * 原来只有"源码字符串"哨兵，没有任何 401/403/拒绝对断言 —— 这里直接跑中间件。
 *
 *   AC-AUTH-1 生产环境没配 API_KEY ⇒ 500（服务端鉴权未配置，不是放行）
 *   AC-AUTH-2 非生产没配 API_KEY ⇒ 放行（本地开发）
 *   AC-AUTH-3 缺 x-api-key / 值不对 ⇒ 401；正确 ⇒ next()
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const requireApiKey = require('../src/middleware/auth');

const original = { apiKey: process.env.API_KEY, nodeEnv: process.env.NODE_ENV };
test.after(() => {
  if (original.apiKey === undefined) delete process.env.API_KEY; else process.env.API_KEY = original.apiKey;
  if (original.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original.nodeEnv;
});

const run = ({ env = {}, headers = {} } = {}) => new Promise((resolve) => {
  if (env.apiKey === undefined) delete process.env.API_KEY; else process.env.API_KEY = env.apiKey;
  if (env.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env.nodeEnv;
  const req = { headers, path: '/api/test' };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { resolve({ kind: 'json', status: this.statusCode, body }); return this; },
  };
  requireApiKey(req, res, () => resolve({ kind: 'next' }));
});

test('AC-AUTH-1 生产环境缺 API_KEY ⇒ 500（不放行）', async () => {
  const out = await run({ env: { apiKey: undefined, nodeEnv: 'production' } });
  assert.equal(out.kind, 'json');
  assert.equal(out.status, 500);
  assert.match(String(out.body.error), /鉴权未配置/);
});

test('AC-AUTH-2 非生产缺 API_KEY ⇒ 放行', async () => {
  const out = await run({ env: { apiKey: undefined, nodeEnv: 'development' } });
  assert.equal(out.kind, 'next');
});

test('AC-AUTH-3 缺头 / 错值 ⇒ 401，正确 ⇒ next', async () => {
  const env = { apiKey: 'k_test', nodeEnv: 'production' };
  assert.equal((await run({ env })).kind, 'json');
  assert.equal((await run({ env })).status, 401);
  const wrong = await run({ env, headers: { 'x-api-key': 'nope' } });
  assert.equal(wrong.status, 401);
  const ok = await run({ env, headers: { 'x-api-key': 'k_test' } });
  assert.equal(ok.kind, 'next');
});
