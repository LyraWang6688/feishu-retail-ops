'use strict';

/**
 * ⭐ 2026-10-18（埋点第 4 刀）：5 条链路请求耗时。
 *   · `config/timing.js` 登记：订单列表 / 库存调整 / 标签打印入队 / 到货验收 / 扫码补货·退货
 *   · 只对登记链路打 `perf.request.completed`（`duration_ms` + `slow`），其余请求零多余日志
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { REQUEST_TIMING, resolveTimingChain } = require('../src/config/timing');
const { requestTiming } = require('../src/utils/requestTiming');
const { SCAN_WRITE } = require('../src/config/scanWrite');

test('5 条链路都登记了（且能按 method/path/action 解析）', () => {
  assert.equal(REQUEST_TIMING.enabled, true);
  assert.equal(REQUEST_TIMING.slowMs, 1500);
  const cases = [
    [{ method: 'GET', path: '/api/workbench/sales/orders' }, 'orders.list'],
    [{ method: 'POST', path: '/api/workbench/inventory/adjustments/apply' }, 'inventory.adjust'],
    [{ method: 'POST', path: '/api/workbench/label-print/jobs' }, 'label.print.enqueue'],
    [{ method: 'POST', path: '/api/workbench/purchase/arrivals/accept' }, 'purchase.arrival.accept'],
    [{ method: 'POST', path: '/r/rec123', body: { action: SCAN_WRITE.actions.replenish } }, 'scan.replenish'],
    [{ method: 'POST', path: '/r/rec123', body: { action: SCAN_WRITE.actions.purchaseReturn } }, 'scan.purchase_return'],
  ];
  for (const [input, expected] of cases) assert.equal(resolveTimingChain(input), expected, JSON.stringify(input));
  assert.equal(resolveTimingChain({ method: 'GET', path: '/health' }), null, '未登记路径不打点');
  assert.equal(resolveTimingChain({ method: 'POST', path: '/r/rec123', body: { action: 'other' } }), null);
});

test('中间件：登记链路打 perf.request.completed（含 duration/slow）', () => {
  const logs = [];
  const orig = console.log;
  console.log = (line) => logs.push(line);
  try {
    const req = { method: 'GET', path: '/api/workbench/sales/orders', body: {} };
    const res = new EventEmitter();
    res.statusCode = 200;
    let calledNext = false;
    requestTiming()(req, res, () => { calledNext = true; });
    assert.equal(calledNext, true, '必须放行');
    res.emit('finish');
  } finally { console.log = orig; }
  assert.equal(logs.length, 1);
  const payload = JSON.parse(logs[0]);
  assert.equal(payload.event, 'perf.request.completed');
  assert.equal(payload.chain, 'orders.list');
  assert.equal(payload.method, 'GET');
  assert.equal(payload.status, 200);
  assert.ok(Number.isInteger(payload.duration_ms));
  assert.equal(typeof payload.slow, 'boolean');
});

test('未登记请求：一条 perf 日志都不打（不刷屏）', () => {
  const logs = [];
  const orig = console.log;
  console.log = (line) => logs.push(line);
  try {
    const req = { method: 'GET', path: '/health', body: {} };
    const res = new EventEmitter();
    requestTiming()(req, res, () => {});
    res.emit('finish');
  } finally { console.log = orig; }
  assert.equal(logs.length, 0);
});

test('app 已挂载 + 事件目录已登记（源码哨兵）', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.match(app, /requestTiming\(\)\.requestTiming\(\)\),|require\('\.\/utils\/requestTiming'\)\.requestTiming\(\)\)/, 'app 必须挂载耗时中间件');
  const events = require('../src/config/events');
  assert.equal(events.isRegisteredEvent('perf.request.completed'), true, '事件目录必须包含 perf.request.completed');
});
