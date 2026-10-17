'use strict';

/**
 * ⭐ 2026-10-18（埋点第 5 刀）：前端漏斗 `ui.page.view` / `ui.step.enter`。
 *   · 扫码页：服务端渲染时记（不依赖客户端 JS，不动页面字节）
 *   · 工作台：客户端 beacon 走同一个 `/ui-tap` 端点（`kind=page_view`）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FUNNEL, funnelStepOf } = require('../src/config/funnel');
const { handleUiTap } = require('../src/utils/uiTapReport');

test('配置：事件名 / step 白名单 / 默认开', () => {
  assert.equal(FUNNEL.enabled, true);
  assert.equal(FUNNEL.events.pageView, 'ui.page.view');
  assert.equal(FUNNEL.events.stepEnter, 'ui.step.enter');
  assert.equal(funnelStepOf('payment'), 'payment');
  assert.equal(funnelStepOf('home'), 'home');
  assert.equal(funnelStepOf('user-input'), '', '白名单外不认（不采集任意值）');
});

test('handleUiTap：kind=page_view 不需要 target，记 page.view + step.enter', () => {
  const logs = [];
  const orig = console.log;
  console.log = (line) => logs.push(JSON.parse(line));
  try {
    let status = null;
    const res = { status(code) { status = code; return { end() {} }; } };
    handleUiTap({
      req: { requestId: 'r1', query: { kind: 'page_view', page: 'workbench', step: 'home' }, originalUrl: '/api/workbench/ui-tap?kind=page_view' },
      res, scope: 'workbench',
    });
    assert.equal(status, 204);
  } finally { console.log = orig; }
  assert.equal(logs.length, 2);
  assert.equal(logs[0].event, 'ui.page.view');
  assert.equal(logs[0].page, 'workbench');
  assert.equal(logs[0].step, 'home');
  assert.equal(logs[1].event, 'ui.step.enter');
});

test('handleUiTap：step 不在白名单 ⇒ 只记 page.view（不猜）', () => {
  const logs = [];
  const orig = console.log;
  console.log = (line) => logs.push(JSON.parse(line));
  try {
    handleUiTap({
      req: { requestId: 'r2', query: { kind: 'page_view', page: 'workbench', step: 'unknown-step' }, originalUrl: '/api/workbench/ui-tap?kind=page_view' },
      res: { status() { return { end() {} }; } }, scope: 'workbench',
    });
  } finally { console.log = orig; }
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'ui.page.view');
  assert.equal('step' in logs[0], false);
});

test('两个来源都接线了（源码哨兵）', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage', 'index.js'), 'utf8');
  assert.match(route, /logFunnelPage\(/, '扫码页必须在渲染时记漏斗');
  assert.match(route, /goods: 'entry'/, '主页面（goods）必须记 entry step');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'workbench', 'shared', 'funnel.js'), 'utf8');
  assert.match(client, /function view\(page, options\)/, '客户端必须有 view()');
  assert.equal(/[^\x00-\x7F]/.test(client), false, 'shared/funnel.js 必须保持 ASCII');
  for (const file of ['index.html', 'inventory-adjustment.html']) {
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'workbench', file), 'utf8'),
      /dshFunnel\.view\("workbench"/, `${file} 必须上报 page.view`);
  }
});
