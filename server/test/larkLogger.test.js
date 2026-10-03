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

  // 非 Error 的对象一律不序列化——序列化本身就可能把 config 带出来。
  assert.equal(describe({ config: { data: CANARY } }), '[object]');
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
