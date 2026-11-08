'use strict';

/**
 * 抖音来客只读客户端的契约（假 fetch，不联网）。
 *
 * AC（对应真实踩坑）：
 *   AC-DY1 ⭐ token 缓存：TTL 内多次调用 ⇒ **只换一次 client_token**；
 *   AC-DY2 ⭐ 没配凭证 ⇒ `not_configured`，**一个请求都不发**；
 *   AC-DY3 ⭐ client_token 报 10013 ⇒ `creds_error` + 人话（**不缓存坏 token**）；
 *   AC-DY4 ⭐ 验券历史把 `account_id/start_time/end_time/cursor/size` 放上 query，
 *            并把 token 放在 `access-token` 头（**不放 URL**）；
 *   AC-DY5 ⭐ 时间传字符串 ⇒ `param_invalid`（真实错误 2100005「时间必须是 int 秒」）；
 *   AC-DY6 ⭐ 分账明细把 `certificate_ids` 拼成逗号串；
 *   AC-DY7 ⭐ 订单详情带 `account_id + order_id`（列表不可靠，按单号查）；
 *   AC-DY8 ⭐ HTTP 500 ⇒ `upstream_failed`（不抛异常、不把 body 当数据）；
 *   AC-DY9 ⭐ 业务错误码 ⇒ `errorCode` + `logId` 一起带回（排查靠这个）；
 *   AC-DY10 ⭐ `expires_in` 控制 TTL：过期后**会重新换** token；
 *   AC-DY11 ⭐ 返回值里**不含 token**（只给 data / logId）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createLaikeClient } = require('../src/services/douyin/laikeClient');
const { createDouyinLaikeConfig, TOKEN_SAFETY_MS } = require('../src/config/douyinLaike');

const ENV = {
  DOUYIN_LAIKE_CLIENT_KEY: 'aw_test_key',
  DOUYIN_LAIKE_CLIENT_SECRET: 'secret_test_key',
};

const okJson = (body) => ({ ok: true, status: 200, json: async () => body, headers: { get: () => '' } });

const tokenBody = (accessToken = 'tok_live', expiresIn = 7200) => ({
  data: { access_token: accessToken, expires_in: expiresIn, error_code: 0, description: 'success' },
});

/** 假 fetch：记下每次调用，按 URL 分派。 */
const makeFetch = (handler) => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls);
  };
  return { calls, fetch };
};

const buildService = ({ handler, now = () => 1700000000000, env = ENV } = {}) => {
  const { calls, fetch } = makeFetch(handler);
  const service = createLaikeClient({
    env,
    fetch,
    now,
    config: createDouyinLaikeConfig(env),
  });
  return { service, calls };
};

test('AC-DY1 ⭐ token 缓存：两次验券只换一次 client_token', async () => {
  let tokenCalls = 0;
  const { service, calls } = buildService({
    handler: (url) => {
      if (url.includes('/oauth/client_token/')) { tokenCalls += 1; return okJson(tokenBody()); }
      return okJson({ data: { records: [], total: 0, error_code: 0 } });
    },
  });
  const args = { accountId: '7365018427183990825', startTime: 1791622704, endTime: 1794134303 };
  const first = await service.verifyRecords(args);
  const second = await service.verifyRecords(args);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(tokenCalls, 1, 'TTL 内必须复用 token');
  assert.equal(calls.filter((item) => item.url.includes('verify_record')).length, 2);
});

test('AC-DY2 ⭐ 没配凭证 ⇒ not_configured，且不发请求', async () => {
  const { service, calls } = buildService({ env: {}, handler: () => okJson({}) });
  const out = await service.verifyRecords({ accountId: 'a', startTime: 1, endTime: 2 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'not_configured');
  assert.equal(calls.length, 0);
});

test('AC-DY3 ⭐ 10013 ⇒ creds_error + 人话，且坏 token 不进缓存', async () => {
  let tokenCalls = 0;
  const { service } = buildService({
    handler: (url) => {
      if (url.includes('/oauth/client_token/')) {
        tokenCalls += 1;
        return okJson({ data: { error_code: 10013, description: 'client_key 或者client_secret 错误' } });
      }
      return okJson({ data: { error_code: 0 } });
    },
  });
  const first = await service.verifyRecords({ accountId: 'a', startTime: 1, endTime: 2 });
  assert.equal(first.ok, false);
  assert.equal(first.reason, 'creds_error');
  assert.match(first.message, /client_key/);
  await service.verifyRecords({ accountId: 'a', startTime: 1, endTime: 2 });
  assert.equal(tokenCalls, 2, '失败不许缓存，下次必须重试');
});

test('AC-DY4 ⭐ 验券历史参数上 query、token 只进头', async () => {
  const { service, calls } = buildService({
    handler: (url) => (url.includes('client_token') ? okJson(tokenBody()) : okJson({ data: { records: [{ certificate_id: 'c1' }], error_code: 0 } })),
  });
  const out = await service.verifyRecords({
    accountId: '7365018427183990825',
    startTime: 1791622704,
    endTime: 1794134303,
    cursor: 10,
    size: 5,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  const call = calls.find((item) => item.url.includes('verify_record'));
  assert.ok(call, '必须请求验券历史');
  assert.match(call.url, /account_id=7365018427183990825/);
  assert.match(call.url, /start_time=1791622704/);
  assert.match(call.url, /end_time=1794134303/);
  assert.match(call.url, /cursor=10/);
  assert.match(call.url, /size=5/);
  assert.equal(call.options.headers['access-token'], 'tok_live');
  assert.ok(!call.url.includes('tok_live'), 'token 不许出现在 URL');
});

test('AC-DY5 ⭐ 时间传字符串 ⇒ param_invalid，且不发请求', async () => {
  const { service, calls } = buildService({ handler: () => okJson({}) });
  const out = await service.verifyRecords({ accountId: 'a', startTime: '2026-11-01', endTime: 1794134303 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'param_invalid');
  assert.equal(calls.length, 0);
});

test('AC-DY6 ⭐ 分账明细把 certificate_ids 拼成逗号串', async () => {
  const { service, calls } = buildService({
    handler: (url) => (url.includes('client_token') ? okJson(tokenBody()) : okJson({ data: { records: [], error_code: 0 } })),
  });
  const out = await service.settleLedger({ certificateIds: ['7694960812306350109', '7694975597806796828'] });
  assert.equal(out.ok, true, JSON.stringify(out));
  const call = calls.find((item) => item.url.includes('settle/ledger'));
  assert.match(call.url, /certificate_ids=7694960812306350109%2C7694975597806796828|certificate_ids=7694960812306350109,7694975597806796828/);
});

test('AC-DY7 ⭐ 订单详情带 account_id + order_id', async () => {
  const { service, calls } = buildService({
    handler: (url) => (url.includes('client_token') ? okJson(tokenBody()) : okJson({ data: { orders: [{ order_id: '1114035240404856477' }], error_code: 0 } })),
  });
  const out = await service.orderDetail({ accountId: '7365018427183990825', orderId: '1114035240404856477' });
  assert.equal(out.ok, true, JSON.stringify(out));
  const call = calls.find((item) => item.url.includes('hermes/trade/order/query'));
  assert.match(call.url, /account_id=7365018427183990825/);
  assert.match(call.url, /order_id=1114035240404856477/);
});

test('AC-DY8 ⭐ HTTP 500 ⇒ upstream_failed', async () => {
  const { service } = buildService({
    handler: () => ({ ok: false, status: 500, json: async () => ({ message: 'boom' }), headers: { get: () => '' } }),
  });
  const out = await service.verifyRecords({ accountId: 'a', startTime: 1, endTime: 2 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'upstream_failed');
});

test('AC-DY9 ⭐ 业务错误码带回 errorCode + logId', async () => {
  const { service } = buildService({
    handler: (url) => (url.includes('client_token')
      ? okJson(tokenBody())
      : okJson({ data: { error_code: 2100005, description: '参数不合法' }, extra: { logid: 'LOG123' } })),
  });
  const out = await service.orderDetail({ accountId: 'a', orderId: 'b' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'param_invalid');
  assert.equal(out.errorCode, 2100005);
  assert.equal(out.logId, 'LOG123');
});

test('AC-DY10 ⭐ expires_in 控制 TTL：过期后重新换 token', async () => {
  let nowMs = 1700000000000;
  let tokenCalls = 0;
  const { service } = buildService({
    now: () => nowMs,
    handler: (url) => {
      if (url.includes('/oauth/client_token/')) { tokenCalls += 1; return okJson(tokenBody(`tok_${tokenCalls}`, 7200)); }
      return okJson({ data: { records: [], error_code: 0 } });
    },
  });
  await service.verifyRecords({ accountId: 'a', startTime: 1, endTime: 2 });
  assert.equal(tokenCalls, 1);
  nowMs += 7200 * 1000 - TOKEN_SAFETY_MS - 1000; // 还在有效期内
  await service.verifyRecords({ accountId: 'a', startTime: 1, endTime: 2 });
  assert.equal(tokenCalls, 1, '安全余量内必须复用');
  nowMs += 2000; // 越过安全余量
  await service.verifyRecords({ accountId: 'a', startTime: 1, endTime: 2 });
  assert.equal(tokenCalls, 2, '临过期必须重换');
});

test('AC-DY11 ⭐ 返回值里不含 token', async () => {
  const { service } = buildService({
    handler: (url) => (url.includes('client_token')
      ? okJson(tokenBody('tok_secret_value'))
      : okJson({ data: { records: [{ certificate_id: 'c1' }], error_code: 0 } })),
  });
  const out = await service.verifyRecords({ accountId: 'a', startTime: 1, endTime: 2 });
  assert.equal(out.ok, true);
  assert.ok(!JSON.stringify(out).includes('tok_secret_value'), 'token 不许出现在返回值里');
});

test('AC-DY15 ⭐ 账单详情按 bill_date 查（金额在 amount.goods）', async () => {
  const { service, calls } = buildService({
    handler: (url) => (url.includes('client_token')
      ? okJson(tokenBody())
      : okJson({ data: { ledger_records: [{ amount: { goods: 8540 } }], error_code: 0 } })),
  });
  const out = await service.settleBill({ accountId: '7365018427183990825', billDate: '2026-10-26' });
  assert.equal(out.ok, true, JSON.stringify(out));
  const call = calls.find((item) => item.url.includes('settle/bill/composite_query'));
  assert.ok(call, '必须请求账单详情');
  assert.match(call.url, /account_id=7365018427183990825/);
  assert.match(call.url, /bill_date=2026-10-26/);
  assert.match(call.url, /cursor=0/);
});

test('AC-DY16 ⭐ 提现记录按日期区间查', async () => {
  const { service, calls } = buildService({
    handler: (url) => (url.includes('client_token')
      ? okJson(tokenBody())
      : okJson({ data: { bill_withdraw_records: [{ amount: 8540, settle_account: '中国农业银行 (5418)' }], error_code: 0 } })),
  });
  const out = await service.settleWithdraw({ accountId: 'a', startDate: '2026-10-31', endDate: '2026-10-31' });
  assert.equal(out.ok, true, JSON.stringify(out));
  const call = calls.find((item) => item.url.includes('settle/withdraw/composite_query'));
  assert.match(call.url, /start_date=2026-10-31/);
  assert.match(call.url, /end_date=2026-10-31/);
});

test('AC-DY17 ⭐ 日期格式非法 ⇒ param_invalid，不发请求', async () => {
  const { service, calls } = buildService({ handler: () => okJson({}) });
  const bill = await service.settleBill({ accountId: 'a', billDate: '2026/10/26' });
  assert.equal(bill.ok, false);
  assert.equal(bill.reason, 'param_invalid');
  const withdraw = await service.settleWithdraw({ accountId: 'a', startDate: '20261031', endDate: '2026-10-31' });
  assert.equal(withdraw.ok, false);
  assert.equal(withdraw.reason, 'param_invalid');
  assert.equal(calls.length, 0);
});

test('AC-DY12 ⭐ HTTP 200 但正文不是 JSON ⇒ invalid_response（不再当成成功空数据）', async () => {
  const { service } = buildService({
    handler: (url) => (url.includes('client_token')
      ? okJson(tokenBody())
      : {
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
        headers: { get: () => '' },
      }),
  });
  const out = await service.verifyRecords({ accountId: 'a', startTime: 1, endTime: 2 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'invalid_response');
  assert.match(out.message, /无法解析/);
});

test('AC-DY13 ⭐ 成功响应缺 data 对象 ⇒ invalid_response（不返回 ok:true + 空数据）', async () => {
  const { service } = buildService({
    handler: (url) => (url.includes('client_token') ? okJson(tokenBody()) : okJson({ data: null })),
  });
  const out = await service.verifyRecords({ accountId: 'a', startTime: 1, endTime: 2 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'invalid_response');
});

test('AC-DY14 ⭐ 正文坏但响应头有 logid ⇒ 仍带回排查用 logId', async () => {
  const { service } = buildService({
    handler: (url) => (url.includes('client_token')
      ? okJson(tokenBody())
      : {
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError('bad'); },
        headers: { get: (name) => (name === 'x-tt-logid' ? 'LOG_BAD_BODY' : '') },
      }),
  });
  const out = await service.verifyRecords({ accountId: 'a', startTime: 1, endTime: 2 });
  assert.equal(out.ok, false);
  assert.equal(out.logId, 'LOG_BAD_BODY');
});
