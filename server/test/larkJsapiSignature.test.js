/**
 * 飞书 JSAPI 签名（「扫一扫」原生扫码用）—— 2026-10-13 业务负责人批准后新增。
 * ⚠️ 全部**注入假票据、零网络** ✓；并带一条"**这条 AC 有牙齿**"的自证（见 AC7）✓
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { createLarkJsapiSignatureService, signJsapiTicket } = require('../src/services/larkJsapiSignatureService');
const { isAllowedSignatureUrl, JSSDK_SIGNATURE_PATH } = require('../src/config/jsapiSignature');

const APP_ID = 'cli_test_only';
const APP_SECRET = 'secret-must-never-leak';
const TICKET = 'ticket-must-never-leak';

/** 假飞书：记账 + 返回票据（**过期时间可调**，用来测刷新） */
function fakeLark({ ttlSeconds = 7200 } = {}) {
  const calls = { token: 0, ticket: 0 };
  const fetchImpl = async (url) => {
    if (url.includes('tenant_access_token')) {
      calls.token += 1;
      return { json: async () => ({ code: 0, tenant_access_token: 'tok-1', expire: ttlSeconds }) };
    }
    calls.ticket += 1;
    return { json: async () => ({ code: 0, data: { ticket: TICKET, expires_in: ttlSeconds } }) };
  };
  return { calls, fetchImpl };
}

function serviceWith(overrides = {}) {
  const clock = { t: 1_700_000_000_000 };
  const fake = fakeLark(overrides.lark);
  const service = createLarkJsapiSignatureService({
    fetchImpl: fake.fetchImpl,
    now: () => clock.t,
    credentials: () => ({ appId: APP_ID, appSecret: APP_SECRET }),
    makeNonce: () => 'nonce-fixed',
    ...overrides.service,
  });
  return { service, calls: fake.calls, clock };
}

test('AC1 ⭐ signature 与**本地独立重算**的 sha1 一致（用假 ticket，零网络）', async () => {
  const { service } = serviceWith();
  const url = 'https://hm.example.com/workbench/';
  const payload = await service.getSignature(url);
  const expected = crypto.createHash('sha1')
    .update(`jsapi_ticket=${TICKET}&noncestr=${payload.nonceStr}&timestamp=${payload.timestamp}&url=${url}`, 'utf8')
    .digest('hex');
  assert.equal(payload.appId, APP_ID);
  assert.equal(payload.signature, expected, '签名必须 = sha1(jsapi_ticket&noncestr&timestamp&url)');
  assert.equal(payload.nonceStr, 'nonce-fixed');
});

test('AC2 ⭐ ticket 命中缓存 ⇒ **不再请求飞书**（计数断言）', async () => {
  const { service, calls } = serviceWith();
  await service.getSignature('https://hm.example.com/workbench/');
  await service.getSignature('https://hm.example.com/workbench/');
  await service.getSignature('https://hm.example.com/workbench/');
  assert.equal(calls.token, 1, 'tenant_access_token 只取一次');
  assert.equal(calls.ticket, 1, 'jsapi_ticket 只取一次（缓存命中）');
});

test('AC3 ⭐ 票据过期 ⇒ **自动刷新**（假时钟推进）', async () => {
  const { service, calls, clock } = serviceWith();
  await service.getSignature('https://hm.example.com/workbench/');
  clock.t += 2 * 60 * 60 * 1000 + 1000; // 推进 2 小时
  await service.getSignature('https://hm.example.com/workbench/');
  assert.equal(calls.ticket, 2, '过期后必须重新取 ticket');
});

test('AC4 ⭐ 响应只有四项，且**不含** secret / ticket 原文（逐字哨兵）', async () => {
  const { service } = serviceWith();
  const payload = await service.getSignature('https://hm.example.com/workbench/');
  assert.deepEqual(Object.keys(payload).sort(), ['appId', 'nonceStr', 'signature', 'timestamp']);
  const text = JSON.stringify(payload);
  assert.equal(text.includes(APP_SECRET), false, '不许回显 app_secret');
  assert.equal(text.includes(TICKET), false, '不许回显 jsapi_ticket 原文');
  assert.equal(text.includes('tok-1'), false, '不许回显 tenant_access_token');
});

test('AC5 ⭐ url 白名单：只有**本站**能签（别家 ⇒ false ⇒ 路由给 400）', () => {
  const host = 'hm.example.com';
  assert.equal(isAllowedSignatureUrl('https://hm.example.com/workbench/', host), true, '本站 https ⇒ 允许');
  assert.equal(isAllowedSignatureUrl('http://hm.example.com/s/66133-17', host), true, '本站 http（本地调试）⇒ 允许');
  assert.equal(isAllowedSignatureUrl('https://evil.example.com/x', host), false, '⭐ 别家 ⇒ 拒绝（不当签名机）');
  assert.equal(isAllowedSignatureUrl('https://hm.example.com.evil.com/x', host), false, '相似域名也要拒');
  assert.equal(isAllowedSignatureUrl('not-a-url', host), false, '非法 url ⇒ 拒绝');
  assert.equal(isAllowedSignatureUrl('', host), false, '空 ⇒ 拒绝');
});

test('AC6 ⭐ 接口挂在**工作台准入闸门内**（未登录 401 ✓，路径在配置里唯一）', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/workbench.js'), 'utf8');
  assert.equal(JSSDK_SIGNATURE_PATH, '/api/workbench/lark/jsapi-signature');
  const line = source.split('\n').find((l) => l.includes('JSSDK_SIGNATURE_PATH.replace'));
  assert.ok(line, '路由要用配置里的路径');
  assert.match(source, /router\.get\(JSSDK_SIGNATURE_PATH\.replace\([^)]*\), requireWorkbenchAccess,/, '必须过 requireWorkbenchAccess');
});

test('AC7 ⭐ 这条 AC **有牙齿**：让票据**立即过期** ⇒ AC2 的"只取一次"必须不再成立', async () => {
  // ⚠️ 一开始我写的是 `ticketTtlMs: 0`，但那被假票据返回的 `expires_in` 覆盖了、测不出东西 ✗
  //    ⇒ 改成让**假飞书**返回 0 秒有效期（真的会过期）✓
  const { service, calls } = serviceWith({ lark: { ttlSeconds: 0 } });
  await service.getSignature('https://hm.example.com/workbench/');
  await service.getSignature('https://hm.example.com/workbench/');
  assert.equal(calls.ticket > 1, true, '票据一过期就必须重取 ⇒ 证明 AC2 测的是"真的缓存命中"而不是巧合');
});
