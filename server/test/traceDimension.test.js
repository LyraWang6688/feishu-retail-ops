'use strict';

/**
 * ⭐ 2026-10-18（埋点收尾刀）：统一 `trace_id` ＋ 入口 / 角色维度。
 *   · 每个请求一个 `trace_id`（`x-trace-id` 优先，其次 `x-request-id`，否则生成）
 *   · `entry` 按路径枚举（scan/workbench/lark/api）
 *   · `role` 在身份确定后补（owner/operator；**不记 open_id**）
 *   · **没有上下文 ⇒ 日志不附加任何字段**（不破坏既有断言）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { entryOfPath, roleOf } = require('../src/config/trace');
const { traceMiddleware } = require('../src/utils/traceMiddleware');
const { setTraceFields } = require('../src/utils/traceContext');
const { logInfo } = require('../src/utils/logger');

const capture = async (run) => {
  const logs = [];
  const orig = console.log;
  console.log = (line) => logs.push(JSON.parse(line));
  try { await run(); } finally { console.log = orig; }
  return logs;
};

test('entry 枚举：只认入口名，不回显 URL', () => {
  assert.equal(entryOfPath('/r/ABC'), 'scan');
  assert.equal(entryOfPath('/r/rec1'), 'scan');
  assert.equal(entryOfPath('/api/workbench/sales/orders'), 'workbench');
  assert.equal(entryOfPath('/api/lark/events'), 'lark');
  assert.equal(entryOfPath('/api/other'), 'api');
  assert.equal(entryOfPath('/health'), 'api');
});

test('role：owner 按白名单判，空 open_id 不编', () => {
  const prev = process.env.LARK_OWNER_OPEN_IDS;
  process.env.LARK_OWNER_OPEN_IDS = 'ou_owner,ou_second';
  try {
    assert.equal(roleOf('ou_owner'), 'owner');
    assert.equal(roleOf('ou_other'), 'operator');
    assert.equal(roleOf(''), '');
  } finally {
    if (prev === undefined) delete process.env.LARK_OWNER_OPEN_IDS; else process.env.LARK_OWNER_OPEN_IDS = prev;
  }
});

test('中间件：trace_id 进响应头；日志带 trace_id/entry；身份后可补 role', async () => {
  const req = { get: (name) => (name === 'x-trace-id' ? 'trace-123' : ''), requestId: 'req-1', path: '/r/ABC' };
  const res = { headers: {}, set(name, value) { this.headers[name] = value; } };
  let nextCalled = false;
  const logs = [];
  const orig = console.log;
  console.log = (line) => logs.push(JSON.parse(line));
  try {
    await new Promise((resolve) => {
      traceMiddleware()(req, res, () => {
        nextCalled = true;
        setTraceFields({ role: 'owner' });
        logInfo('scan.page.rendered', { page: 'goods' });
        resolve();
      });
    });
  } finally { console.log = orig; }
  assert.equal(nextCalled, true);
  assert.equal(req.traceId, 'trace-123');
  assert.equal(res.headers['x-trace-id'], 'trace-123');
  assert.equal(logs[0].trace_id, 'trace-123');
  assert.equal(logs[0].entry, 'scan');
  assert.equal(logs[0].role, 'owner');
});

test('没有上下文 ⇒ 日志一个 trace 字段都不多（不破坏既有断言）', async () => {
  const logs = await capture(async () => { logInfo('scan.page.rendered', { page: 'goods' }); });
  assert.equal('trace_id' in logs[0], false);
  assert.equal('entry' in logs[0], false);
  assert.equal('role' in logs[0], false);
});

test('并发隔离：两个请求各自的 trace 不串', async () => {
  const run = (traceId) => traceMiddleware()(
    { get: (name) => (name === 'x-trace-id' ? traceId : ''), requestId: 'r', path: '/api/workbench/x' },
    { set() {} },
    async () => {
      await new Promise((r) => setTimeout(r, 5));
      setTraceFields({ role: 'operator' });
      logInfo('workbench.test', { trace: traceId });
    },
  );
  const logs = await capture(() => Promise.all([run('trace-A'), run('trace-B')]));
  assert.deepEqual(logs.map((l) => l.trace_id).sort(), ['trace-A', 'trace-B']);
});

test('接线哨兵：app 挂在 requestId 之后；扫码/工作台都补 role；日志不记 open_id', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.ok(app.indexOf('x-request-id') < app.indexOf('traceMiddleware'), 'trace 中间件必须在 requestId 之后');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'logger.js'), 'utf8'), /traceLogFields\(\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'workbench.js'), 'utf8'), /setTraceFields\(\{ role: roleOf/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage', 'index.js'), 'utf8'), /setTraceFields\(\{ role: roleOf/);
});
