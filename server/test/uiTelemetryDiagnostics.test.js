'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { handleUiTap } = require('../src/utils/uiTapReport');

const run = (query) => {
  const logs = [];
  const original = console.log;
  console.log = (line) => logs.push(JSON.parse(line));
  try {
    let status = 0;
    const res = {
      status(code) { status = code; return this; },
      type() { return this; },
      send() { return this; },
      end() { return this; },
    };
    handleUiTap({ req: { requestId: 'r1', query, originalUrl: '/api/workbench/ui-tap' }, res, scope: 'workbench' });
    return { status, logs };
  } finally { console.log = original; }
};

test('scan.launch：合法 realm/result 记录耗时，未知值 400', () => {
  const ok = run({ kind: 'scan_launch', realm: 'purchase_return', result: 'cancelled', duration_ms: '1234', page: 'workbench' });
  assert.equal(ok.status, 204);
  assert.equal(ok.logs[0].event, 'scan.launch');
  assert.equal(ok.logs[0].realm, 'purchase_return');
  assert.equal(ok.logs[0].result, 'cancelled');
  assert.equal(ok.logs[0].duration_ms, 1234);
  assert.equal(run({ kind: 'scan_launch', realm: 'other', result: 'opened' }).status, 400);
});

test('client.resource.failed：去掉 URL query，保留事件类型与错误', () => {
  const out = run({ kind: 'client_error', event_type: 'resource', page: 'workbench', url: 'https://hm.example/a.js?token=secret', status: '404', error: 'load_failed' });
  assert.equal(out.status, 204);
  assert.equal(out.logs[0].event, 'client.resource.failed');
  assert.equal(out.logs[0].url, 'https://hm.example/a.js');
  assert.equal(out.logs[0].status, 404);
  assert.equal(out.logs[0].event_type, 'resource');
});

test('ui.action：订单卡渲染 / 采购扫码返回可记录；未知动作 400', () => {
  const out = run({ kind: 'action', action: 'orders_section_rendered', realm: 'sales', result: 'ok', duration_ms: '21' });
  assert.equal(out.status, 204);
  assert.equal(out.logs[0].event, 'ui.action');
  assert.equal(out.logs[0].action, 'orders_section_rendered');
  assert.equal(run({ kind: 'action', action: 'unknown' }).status, 400);
});

test('客户端接线：扫一扫生命周期与资源错误都有上报点', () => {
  const uiTap = fs.readFileSync(path.join(__dirname, '../public/workbench/shared/ui-tap.js'), 'utf8');
  assert.match(uiTap, /buildDiagnosticUrl/);
  assert.match(uiTap, /client_error/);
  const launch = fs.readFileSync(path.join(__dirname, '../public/workbench/features/scan/launch.js'), 'utf8');
  for (const result of ['opened', 'scanned', 'cancelled', 'timeout', 'unsupported', 'failed']) {
    assert.match(launch, new RegExp(`reportLaunch\\(realm, '${result}'`), `缺 ${result} 上报`);
  }
  const orders = fs.readFileSync(path.join(__dirname, '../public/workbench/features/orders/index.js'), 'utf8');
  assert.match(orders, /orders_section_rendered/);
  const procurement = fs.readFileSync(path.join(__dirname, '../public/workbench/procurement.html'), 'utf8');
  assert.match(procurement, /procurement_scan_returned/);
});
