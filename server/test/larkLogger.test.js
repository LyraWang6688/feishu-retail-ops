const test = require('node:test');
const assert = require('node:assert/strict');
const lark = require('@larksuiteoapi/node-sdk');
const { larkLogger, redact, describe } = require('../src/utils/larkLogger');

const CANARY = 'CANARY_APP_SECRET_9f3a7b21';

test('redact 会把密钥值替换掉', () => {
  assert.equal(
    redact('data: \'{"app_id":"cli_x","app_secret":"CANARY_APP_SECRET_9f3a7b21"}\''),
    'data: \'{"app_id":"cli_x","app_secret":"***"}\'',
  );
  assert.equal(redact('{"appSecret":"abcdef123456"}'), '{"appSecret":"***"}');
  assert.equal(redact('Authorization: Bearer abcdef123456'), 'Authorization: Bearer ***');
  // 不含密钥的文本原样保留
  assert.equal(redact('connect ECONNREFUSED 127.0.0.1:9'), 'connect ECONNREFUSED 127.0.0.1:9');
});

test('describe 不会带出 error.config.data（密钥就在这里）', () => {
  const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), {
    code: 'ECONNREFUSED',
    config: {
      method: 'post',
      url: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      data: JSON.stringify({ app_id: 'cli_x', app_secret: CANARY }),
    },
  });
  const described = describe(error);
  assert.equal(described.code, 'ECONNREFUSED');
  assert.equal(described.method, 'post');
  assert.ok(!JSON.stringify(described).includes(CANARY));

  // 非 Error 的对象：**不再**是 '[object]'（那等于什么都没说），而是白名单投影 ——
  // 但同样一个密钥字节都不能带出来。
  // ⚠️ 2026-10-08 口径变更：业务负责人点名的 ①（`lark.sdk.error detail:[["[object]","[object]"]]`）。
  const describedObject = describe({ config: { data: CANARY } });
  assert.notEqual(describedObject, '[object]');
  assert.ok(!JSON.stringify(describedObject).includes(CANARY));
});

// ─────────────────────────────────────────────────────────────────────────────
// ① 日志真实错误：SDK 传进来的**两个普通对象**也要打出真实 code / msg / log_id / method_id
// ─────────────────────────────────────────────────────────────────────────────

// `@larksuiteoapi/node-sdk` 的 `formatErrors(e)` 的形状（真机 `[object]` 那一条的来源）：
//   [ {message, config:{data,url,params,method}, request, response:{data,status,statusText}},
//     {…response.data 摊平后的那份（含真实 code / msg / log_id）} ]
const sdkErrorPair = () => ([
  {
    message: 'Request failed with status code 400',
    config: { data: JSON.stringify({ app_secret: CANARY }), url: 'https://open.feishu.cn/open-apis/bitable/v1/apps/x', method: 'get' },
    request: { protocol: 'https:', host: 'open.feishu.cn', path: '/open-apis/bitable/v1/apps/x', method: 'GET' },
    response: {
      status: 400,
      statusText: 'Bad Request',
      data: { code: 1254607, msg: 'Data not ready, please try again later', log_id: 'log-real-1' },
    },
  },
  { code: 1254607, msg: 'Data not ready, please try again later', log_id: 'log-real-1', error: { method_id: 'method-real-1' } },
]);

test('① 普通对象（SDK 那个形状）也打出真实四项，且绝不出现 [object]、绝不带 App Secret', () => {
  const described = describe(sdkErrorPair());
  const joined = JSON.stringify(described);
  assert.ok(!joined.includes('[object]'), joined);
  assert.ok(!joined.includes(CANARY), joined);
  assert.equal(described[0].code, 1254607);
  assert.equal(described[0].msg, 'Data not ready, please try again later');
  assert.equal(described[0].log_id, 'log-real-1');
  assert.equal(described[0].status, 400);
  assert.equal(described[0].method, 'get');
  assert.equal(described[1].method_id, 'method-real-1', '真实错误嵌在 data.error 里也要取到');
});

test('① lark.sdk.error 落盘的那一行就是真实四项（不是 [object]）', () => {
  const captured = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  console.error = (...args) => captured.push(args.map((value) => String(value)).join(' '));
  try {
    larkLogger.error(sdkErrorPair());
  } finally {
    console.error = originals.error;
    console.log = originals.log;
    console.warn = originals.warn;
  }
  const line = captured.join('\n');
  assert.ok(line.includes('lark.sdk.error'), line);
  assert.ok(!line.includes('[object]'), line);
  assert.ok(!line.includes(CANARY), line);
  const payload = JSON.parse(captured[0]);
  assert.equal(payload.detail[0].code, 1254607);
  assert.equal(payload.detail[0].msg, 'Data not ready, please try again later');
  assert.equal(payload.detail[0].log_id, 'log-real-1');
  assert.equal(payload.detail[1].method_id, 'method-real-1');
});


test('真实的 SDK 网络失败不会把 App Secret 写进日志', async () => {
  const captured = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => captured.push(args.map((value) => String(value)).join(' '));
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    // 复现生产服务的构造方式，但把 domain 指向一个必定拒绝连接的端口，
    // 触发 SDK 打印 axios error 的那条路径。
    const client = new lark.Client({
      appId: 'cli_canary_fake',
      appSecret: CANARY,
      domain: 'https://127.0.0.1:9',
      logger: larkLogger,
    });
    try {
      await client.bitable.appTableRecord.list({ path: { app_token: 't', table_id: 'tb' } });
    } catch (_) {
      // 连接失败是预期的
    }
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }

  const joined = captured.join('\n');
  assert.ok(captured.length > 0, 'SDK 的错误应当被记录下来，而不是被完全吞掉');
  assert.ok(!joined.includes(CANARY), `日志中不应出现 App Secret：${joined.slice(0, 400)}`);
  // 排查能力不能丢：仍然要能看出是哪次请求、失败在哪
  assert.match(joined, /ECONNREFUSED|127\.0\.0\.1:9/);
});
