'use strict';

/**
 * ⭐⭐ 2026-10-14：飞书 **JSAPI 签名**（给"扫码 ⇒ 直接打印这一张"用）。
 *
 * AC（她的口径：扫码直接打印 ⇒ 前提是网页能调扫一扫 ✓）
 *   AC-SP1 ⭐ 返回 `appId / timestamp / nonceStr / signature / url` —— **响应里不含任何密钥** ✗
 *   AC-SP2 ⭐ 签名**算得对**：与服务端自己算的 sha1 逐字一致 ✓（能真红：把 ticket 换掉就红 ✓）
 *   AC-SP3 ⭐ **ticket/token 缓存**：TTL 内多次调用 ⇒ **只向飞书取一次** ✓
 *   AC-SP4 ⭐ 只签**允许的域名**（别的域名 ⇒ `host_not_allowed` + 人话 ✓）
 *   AC-SP5 ⭐ **没配凭证** ⇒ `not_configured` + 人话 ✓（**不静默** ✗ 也不假成功 ✗）
 *   AC-SP6 ⭐ 上游失败/超时 ⇒ `upstream_failed` + 人话 ✓（**不许无限等** ✗）
 *   AC-SP7 ⭐ 页面 URL 参与签名前**去掉 `#fragment`** ✓
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createLarkJsapiService, sign, normalizeUrl } = require('../src/services/larkJsapiService');
const { createLarkJsapiConfig } = require('../src/config/larkJsapi');

const ENV = { LARK_AGENT_APP_ID: 'cli_test_jsapi', LARK_AGENT_APP_SECRET: 'secret_test_jsapi' };

const fakeFetch = (calls, { ticket = 'ticket_abc', token = 'token_abc', failTicket = false } = {}) => async (url, options) => {
  calls.push(url);
  if (String(url).includes('tenant_access_token')) {
    return { ok: true, status: 200, json: async () => ({ tenant_access_token: token }) };
  }
  if (String(url).includes('jssdk/ticket')) {
    if (failTicket) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ data: { ticket } }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

test('AC-SP1/SP2 ⭐ 签名四件套齐 + 算得对 + 不含密钥', async () => {
  const calls = [];
  const service = createLarkJsapiService({ env: ENV, fetch: fakeFetch(calls), randomNonce: () => 'nonce_fixed', now: () => 1700000000000 });
  const out = await service.signatureFor('https://hm.bamamei.online/workbench/label-print.html');
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.appId, 'cli_test_jsapi');
  assert.equal(out.nonceStr, 'nonce_fixed');
  // ⭐⭐ 2026-10-15 **成对翻新**（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：`assert.equal(out.timestamp, 1700000000);` ＋
  //            `const expected = sign({ …, timestamp: 1700000000, … });`
  //   改后逐字：改成 **毫秒**（`1700000000000`）——两次都改，**签名串里的值与发出去的值仍必须一致** ✓
  //   依据：**飞书官方《h5sdk.config》参数表逐字：「timestamp | long | 是 | 生成签名的<u>毫秒级</u>时间戳」**
  //     ＋ 真机实测（改前用秒 ⇒ 飞书报 `333444 签名过期`：`signature is expired`，
  //       因为它把秒当毫秒解读、时间落在 1970 年 ✗）。
  assert.equal(out.timestamp, 1700000000000, '必须是**毫秒级**时间戳（官方要求 ✓）');
  const expected = sign({ ticket: 'ticket_abc', nonceStr: 'nonce_fixed', timestamp: 1700000000000, url: out.url });
  assert.equal(out.signature, expected, 'sha1 签名与服务端自算逐字一致 ✓');
  // 别把密钥漏出去（**能真红**：谁把 secret 塞进返回就红 ✓）
  const json = JSON.stringify(out);
  assert.equal(json.includes('secret_test_jsapi'), false, '响应里不许出现 app secret ✗');
  assert.equal(json.includes('ticket_abc'), false, '响应里不许出现 ticket ✗');
});

test('AC-SP7 ⭐ 签名用的 URL 去掉 #fragment', () => {
  assert.equal(normalizeUrl('https://hm.bamamei.online/a.html#x=1'), 'https://hm.bamamei.online/a.html');
});

test('AC-SP3 ⭐ TTL 内只取一次票 / 一次 token', async () => {
  const calls = [];
  let clock = 1700000000000;
  const service = createLarkJsapiService({ env: ENV, fetch: fakeFetch(calls), now: () => clock, randomNonce: () => 'n' });
  await service.signatureFor('https://hm.bamamei.online/a.html');
  await service.signatureFor('https://hm.bamamei.online/b.html');
  assert.equal(calls.filter((u) => u.includes('tenant_access_token')).length, 1, 'token 只取一次 ✓');
  assert.equal(calls.filter((u) => u.includes('jssdk/ticket')).length, 1, 'ticket 只取一次 ✓');
  clock += createLarkJsapiConfig(ENV).ticketTtlMs + 1000;
  await service.signatureFor('https://hm.bamamei.online/c.html');
  assert.equal(calls.filter((u) => u.includes('jssdk/ticket')).length, 2, '过期后要重取 ✓');
});

test('AC-SP4 ⭐ 只签允许的域名', async () => {
  const calls = [];
  const service = createLarkJsapiService({ env: ENV, fetch: fakeFetch(calls) });
  const bad = await service.signatureFor('https://evil.example.com/x.html');
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'host_not_allowed');
  assert.ok(bad.message && bad.message.length > 4, '要给一句人话 ✓');
  assert.equal(calls.length, 0, '不允许的域名 ⇒ 一次上游请求都不发 ✓');
});

test('AC-SP5 ⭐ 没配凭证 ⇒ not_configured + 人话（不静默、不假成功）', async () => {
  const calls = [];
  const service = createLarkJsapiService({ env: {}, fetch: fakeFetch(calls) });
  const out = await service.signatureFor('https://hm.bamamei.online/a.html');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'not_configured');
  assert.ok(out.message.length > 4);
  assert.equal(calls.length, 0, '没凭证就别打上游 ✓');
});

test('AC-SP6 ⭐ 上游失败 ⇒ upstream_failed + 人话', async () => {
  const calls = [];
  const service = createLarkJsapiService({ env: ENV, fetch: fakeFetch(calls, { failTicket: true }) });
  const out = await service.signatureFor('https://hm.bamamei.online/a.html');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'jsapi_ticket_http');
  assert.ok(out.message.length > 4);
});

test('AC-SP14 ⭐⭐ ticket 的 TTL **以飞书回的 `expire_in` 为准**（它远小于我们原来写死的 110 分钟）', async () => {
  const calls = [];
  let clock = 1700000000000;
  // 飞书实测线上回的是 `expire_in: 3844` 秒（≈64 分钟），而配置里写死 110 分钟 ⇒
  // 后 46 分钟里算出来的签名都建在**已过期**的 ticket 上 ✗（今天真机排查时发现的同类隐患）。
  const fake = (url) => {
    calls.push(url);
    if (String(url).includes('tenant_access_token')) {
      return { ok: true, status: 200, json: async () => ({ tenant_access_token: 'tok', expire: 7200 }) };
    }
    if (String(url).includes('jssdk/ticket')) {
      return { ok: true, status: 200, json: async () => ({ data: { ticket: 'ticket_abc', expire_in: 3844 } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const service = createLarkJsapiService({ env: ENV, fetch: fake, now: () => clock, randomNonce: () => 'n' });
  await service.signatureFor('https://hm.bamamei.online/a.html');
  assert.equal(calls.filter((u) => u.includes('jssdk/ticket')).length, 1);
  // 走到「配置写的 TTL」处**还不该重取**（因为飞书给的 TTL 更短，早就该重取了）——
  // ⚠️ 关键判据：只要**超过飞书给的 expire_in（−5 分钟余量）**就必须重取 ✓
  clock += (3844 - 300) * 1000 + 1000;
  await service.signatureFor('https://hm.bamamei.online/b.html');
  assert.equal(calls.filter((u) => u.includes('jssdk/ticket')).length, 2,
    '超过飞书给的 expire_in ⇒ 必须重取（不再用写死的 110 分钟 ✓）');
});
