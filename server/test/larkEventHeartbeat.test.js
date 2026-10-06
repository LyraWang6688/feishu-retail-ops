const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// 路由文件会 require larkMvpService（模块级 new 客户端时需要凭证）。
// 这里只挂 /health 与 challenge，假的凭证足够让模块加载。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_test_app';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'test_secret';
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const {
  resolveStaleMinutes,
  isAlertEnabled,
  resolveAlertTarget,
  resolveAlertOpenId,
  isMentionAllEnabled,
  resolveCallbackUrl,
  evaluateLarkEventHeartbeat,
  buildLarkEventStaleAlertText,
  DEFAULT_STALE_MINUTES,
  DEFAULT_CALLBACK_URL,
  ALERT_TARGET_OWNER,
  ALERT_TARGET_PURCHASE_GROUP,
} = require('../src/config/larkEventHeartbeat');
const {
  LarkEventHeartbeat,
  readHeartbeatFile,
} = require('../src/infrastructure/larkEventHeartbeat');
const { createLarkEventsRouter, createLarkEventHandlers } = require('../src/routes/larkEvents');

const tempHeartbeatFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lark-heartbeat-')), 'hb.json');

// ── 配置：阈值 / 开关（显式布尔）──────────────────────────────────────────────

test('阈值：默认 180 分钟，配了合法值就用，配错回落默认', () => {
  assert.equal(resolveStaleMinutes({}), DEFAULT_STALE_MINUTES);
  assert.equal(resolveStaleMinutes({ LARK_EVENT_STALE_MINUTES: '60' }), 60);
  assert.equal(resolveStaleMinutes({ LARK_EVENT_STALE_MINUTES: ' 90 ' }), 90);
  // 空串 = 没配（不是 0），配错的值也不该让自检失效。
  assert.equal(resolveStaleMinutes({ LARK_EVENT_STALE_MINUTES: '' }), DEFAULT_STALE_MINUTES);
  assert.equal(resolveStaleMinutes({ LARK_EVENT_STALE_MINUTES: '0' }), DEFAULT_STALE_MINUTES);
  assert.equal(resolveStaleMinutes({ LARK_EVENT_STALE_MINUTES: '-5' }), DEFAULT_STALE_MINUTES);
  assert.equal(resolveStaleMinutes({ LARK_EVENT_STALE_MINUTES: 'abc' }), DEFAULT_STALE_MINUTES);
});

test('告警开关：只有显式 true/1/yes/on 才开，空串与写错的值一律关', () => {
  const key = 'LARK_EVENT_ALERT_ENABLED';
  ['true', 'TRUE', ' true ', '1', 'yes', 'YES', 'on'].forEach((value) => {
    assert.equal(isAlertEnabled({ [key]: value }), true, `${JSON.stringify(value)} 应判定为开`);
  });
  // ⚠️ '' 必须在"关"这一侧：清空环境变量必须能关掉告警（不能用 || 兜底）。
  [undefined, null, '', '   ', 'false', '0', 'no', 'off', 'flase'].forEach((value) => {
    assert.equal(isAlertEnabled({ [key]: value }), false, `${JSON.stringify(value)} 应判定为关`);
  });
  assert.equal(isAlertEnabled({}), false, '键不存在时应判定为关');
});

test('@所有人开关同样是显式布尔，默认关', () => {
  assert.equal(isMentionAllEnabled({}), false);
  assert.equal(isMentionAllEnabled({ LARK_EVENT_ALERT_MENTION_ALL: '' }), false);
  assert.equal(isMentionAllEnabled({ LARK_EVENT_ALERT_MENTION_ALL: 'true' }), true);
});

test('告警目标：默认采购群，只有显式 owner 才走私聊', () => {
  assert.equal(resolveAlertTarget({}), ALERT_TARGET_PURCHASE_GROUP);
  assert.equal(resolveAlertTarget({ LARK_EVENT_ALERT_TARGET: '' }), ALERT_TARGET_PURCHASE_GROUP);
  assert.equal(resolveAlertTarget({ LARK_EVENT_ALERT_TARGET: 'purchase_group' }), ALERT_TARGET_PURCHASE_GROUP);
  assert.equal(resolveAlertTarget({ LARK_EVENT_ALERT_TARGET: 'OWNER' }), ALERT_TARGET_OWNER);
  assert.equal(resolveAlertTarget({ LARK_EVENT_ALERT_TARGET: '写错的值' }), ALERT_TARGET_PURCHASE_GROUP);
  assert.equal(resolveAlertOpenId({}), '');
  assert.equal(resolveAlertOpenId({ LARK_EVENT_ALERT_OPEN_ID: ' ou_x ' }), 'ou_x');
});

test('回调地址：默认是正确那个，可覆盖', () => {
  assert.equal(resolveCallbackUrl({}), DEFAULT_CALLBACK_URL);
  assert.equal(resolveCallbackUrl({ LARK_EVENT_CALLBACK_URL: 'https://example.com/hook' }), 'https://example.com/hook');
});

// ── 判定：纯函数 ────────────────────────────────────────────────────────────

const NOW = new Date('2026-10-06T12:00:00.000Z');
const minutesAgo = (n) => new Date(NOW.getTime() - n * 60 * 1000).toISOString();

test('没有数据：hasData=false，status=ok（不能把"没数据"当"很久没收到"）', () => {
  const result = evaluateLarkEventHeartbeat({}, { staleMinutes: 180, now: NOW });
  assert.equal(result.hasData, false);
  assert.equal(result.status, 'ok');
  assert.equal(result.minutesSinceLastEvent, null);
  assert.equal(result.minutesSinceLastBusinessEvent, null);
});

test('刚收到事件：ok；超过阈值才算 stale（严格大于）', () => {
  const fresh = evaluateLarkEventHeartbeat({ lastEventAt: minutesAgo(5) }, { staleMinutes: 180, now: NOW });
  assert.equal(fresh.hasData, true);
  assert.equal(fresh.status, 'ok');
  assert.equal(fresh.minutesSinceLastEvent, 5);

  // 正好等于阈值不算超（"超过阈值"是严格大于）。
  const boundary = evaluateLarkEventHeartbeat({ lastEventAt: minutesAgo(180) }, { staleMinutes: 180, now: NOW });
  assert.equal(boundary.status, 'ok');

  const stale = evaluateLarkEventHeartbeat({ lastEventAt: minutesAgo(181) }, { staleMinutes: 180, now: NOW });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.minutesSinceLastEvent, 181);
});

test('业务事件只作为线索返回，不参与 stale 判定（夜里没单子不该误报）', () => {
  const result = evaluateLarkEventHeartbeat(
    { lastEventAt: minutesAgo(5), lastBusinessEventAt: minutesAgo(600) },
    { staleMinutes: 180, now: NOW },
  );
  assert.equal(result.status, 'ok', '只要链路还有事件（哪怕只是 challenge）就不算 stale');
  assert.equal(result.minutesSinceLastEvent, 5);
  assert.equal(result.minutesSinceLastBusinessEvent, 600);
});

test('告警文案：写明分钟数 + 正确的回调地址', () => {
  const text = buildLarkEventStaleAlertText({
    minutesSinceLastEvent: 200,
    lastEventAt: minutesAgo(200),
    callbackUrl: DEFAULT_CALLBACK_URL,
  });
  assert.ok(text.includes('200 分钟'), text);
  assert.ok(text.includes('https://api.bamamei.online/api/lark/events'), text);
  assert.ok(text.includes('【事件回调】'), text);
});

// ── 记录器：内存 + 落盘 ─────────────────────────────────────────────────────

test('记录器：recordEvent 立刻更新内存，flush 后落盘；重载不丢', async () => {
  const filePath = tempHeartbeatFile();
  const store = new LarkEventHeartbeat({ filePath, debounceMs: 0, now: () => NOW });
  store.recordEvent({ business: true });
  assert.equal(store.snapshot().lastEventAt, NOW.toISOString());
  assert.equal(store.snapshot().lastBusinessEventAt, NOW.toISOString());
  await store.flush();

  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(onDisk.lastEventAt, NOW.toISOString());
  assert.equal(onDisk.lastBusinessEventAt, NOW.toISOString());

  // 重启：新实例从文件读回，不把"长期没收到"重置成"刚收到"。
  const reloaded = new LarkEventHeartbeat({ filePath, debounceMs: 0, now: () => NOW });
  assert.deepEqual(reloaded.snapshot(), {
    lastEventAt: NOW.toISOString(),
    lastBusinessEventAt: NOW.toISOString(),
  });
});

test('记录器：只有 challenge（非业务）时 lastBusinessEventAt 保持为空', async () => {
  const filePath = tempHeartbeatFile();
  const store = new LarkEventHeartbeat({ filePath, debounceMs: 0, now: () => NOW });
  store.recordEvent();
  await store.flush();
  assert.equal(store.snapshot().lastEventAt, NOW.toISOString());
  assert.equal(store.snapshot().lastBusinessEventAt, null);
  assert.equal(evaluateLarkEventHeartbeat(store.snapshot(), { staleMinutes: 180, now: NOW }).status, 'ok');
});

test('记录器：旧时间不会覆盖新时间（时钟回拨/乱序到达）', () => {
  const store = new LarkEventHeartbeat({ filePath: tempHeartbeatFile(), debounceMs: 0, now: () => NOW });
  store.recordEvent({ at: NOW });
  store.recordEvent({ at: new Date(NOW.getTime() - 60 * 60 * 1000) });
  assert.equal(store.snapshot().lastEventAt, NOW.toISOString());
});

test('心跳文件不存在 / 坏 JSON 都当作"没有数据"，不抛错', () => {
  const missing = readHeartbeatFile(path.join(os.tmpdir(), `nope-${Date.now()}.json`));
  assert.deepEqual(missing, { lastEventAt: null, lastBusinessEventAt: null });

  const broken = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lark-heartbeat-')), 'broken.json');
  fs.writeFileSync(broken, '{ not json');
  assert.deepEqual(readHeartbeatFile(broken), { lastEventAt: null, lastBusinessEventAt: null });
});

// ── 事件入口：记心跳 ────────────────────────────────────────────────────────

test('业务事件处理器会记一次业务心跳；没注入心跳时静默跳过（不影响既有行为）', async () => {
  const calls = [];
  const heartbeat = { recordEvent: (options) => { calls.push(options || {}); } };
  const service = {
    handleCardAction: async () => ({}),
    sendText: async () => undefined,
  };
  const handlers = createLarkEventHandlers(service, { heartbeat });
  handlers['card.action.trigger']({ operator: { operator_id: { open_id: 'ou_1' } }, action: { value: { action: 'x' } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ business: true }]);

  // 不注入心跳：老调用方式必须照常工作（回归）。
  const plain = createLarkEventHandlers(service);
  assert.doesNotThrow(() =>
    plain['card.action.trigger']({ operator: { operator_id: { open_id: 'ou_1' } }, action: { value: { action: 'x' } } }),
  );
  await new Promise((resolve) => setImmediate(resolve));
});

// ── GET /api/lark/events/health ─────────────────────────────────────────────

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const appWithHeartbeat = (heartbeat) => {
  const app = express();
  app.use(express.json());
  app.use('/api/lark/events', createLarkEventsRouter({ service: {}, heartbeat }));
  return app;
};

const fetchJson = async (baseUrl, path, options) => {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { status: response.status, body: await response.json() };
};

test('health 返回心跳字段：没有数据时 hasData=false、status=ok、分钟数为 null', async () => {
  const heartbeat = { snapshot: () => ({ lastEventAt: null, lastBusinessEventAt: null }) };
  await withServer(appWithHeartbeat(heartbeat), async (baseUrl) => {
    const { status, body } = await fetchJson(baseUrl, '/api/lark/events/health');
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.mode, 'p2p+group');
    assert.equal(body.hasData, false);
    assert.equal(body.status, 'ok');
    assert.equal(body.lastEventAt, null);
    assert.equal(body.lastBusinessEventAt, null);
    assert.equal(body.minutesSinceLastEvent, null);
    assert.equal(body.minutesSinceLastBusinessEvent, null);
    assert.ok(Number.isFinite(body.staleMinutes) && body.staleMinutes > 0);
  });
});

test('health 超过阈值时 status=stale，并回带最后一次事件时间', async () => {
  const lastEventAt = new Date(Date.now() - 400 * 60 * 1000).toISOString();
  const heartbeat = { snapshot: () => ({ lastEventAt, lastBusinessEventAt: null }) };
  await withServer(appWithHeartbeat(heartbeat), async (baseUrl) => {
    const { body } = await fetchJson(baseUrl, '/api/lark/events/health');
    assert.equal(body.hasData, true);
    assert.equal(body.status, 'stale');
    assert.equal(body.lastEventAt, lastEventAt);
    assert.ok(body.minutesSinceLastEvent >= 399, String(body.minutesSinceLastEvent));
  });
});

test('challenge 请求也会被记一次心跳（能收到验证 = 链路通）', async () => {
  const recorded = [];
  const heartbeat = {
    recordEvent: (options) => recorded.push(options || {}),
    snapshot: () => ({ lastEventAt: null, lastBusinessEventAt: null }),
  };
  await withServer(appWithHeartbeat(heartbeat), async (baseUrl) => {
    const { status, body } = await fetchJson(baseUrl, '/api/lark/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge: 'c-123', type: 'url_verification' }),
    });
    assert.equal(status, 200);
    assert.equal(body.challenge, 'c-123');
  });
  assert.deepEqual(recorded, [{}], 'challenge 记一条"任何事件"心跳');
});

test('非飞书信封的空 POST 不刷新心跳（公网端点不能被扫描器喂成"正常"）', async () => {
  const recorded = [];
  const heartbeat = {
    recordEvent: (options) => recorded.push(options || {}),
    snapshot: () => ({ lastEventAt: null, lastBusinessEventAt: null }),
  };
  await withServer(appWithHeartbeat(heartbeat), async (baseUrl) => {
    await fetch(`${baseUrl}/api/lark/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    }).catch(() => undefined);
  });
  assert.deepEqual(recorded, []);
});
