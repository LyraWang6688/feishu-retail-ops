'use strict';

/**
 * 工作台流畅性接线的验收：
 *   - main.js 真正 import/调用 tracker + installFluencyObservers；
 *   - tab 切换记 realm、DOM 观察骨架/卡片/表单；
 *   - ui-tap 能把 fluency 的额外事实带进 URL；
 *   - 服务端只白名单记录 fluency 字段，不覆盖请求自己的 path。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('工作台 main.js 接入 tracker / observers，并记录 realm / 骨架 / 卡片 / 表单', () => {
  const src = read('server/public/workbench/main.js');
  assert.match(src, /createFluencyTracker/);
  assert.match(src, /installFluencyObservers/);
  assert.match(src, /realmEntered\(moduleId\)/);
  assert.match(src, /skeletonShown\(\)/);
  assert.match(src, /skeletonReplaced\(/);
  assert.match(src, /cardSwapped\(/);
  assert.match(src, /formRevealed\(/);
  assert.match(src, /window\.dshFluency = tracker/);
});

test('ui-tap 支持 fluency 额外字段（target 仍唯一，额外事实进 query）', () => {
  const src = read('server/public/workbench/shared/ui-tap.js');
  const sandbox = {
    window: { navigator: { sendBeacon: () => true } },
    navigator: { sendBeacon: () => true },
    encodeURIComponent,
    Date,
    Math,
  };
  sandbox.window.window = sandbox.window;
  vm.runInNewContext(src, sandbox);
  const reporter = sandbox.window.dshUiTap;
  assert.ok(reporter, 'ui-tap 应暴露 dshUiTap');
  const url = reporter.buildUrl({
    path: '/api/workbench/ui-tap',
    page: 'workbench',
    target: 'fluency:skeleton',
    tapId: 'tap-x',
    extra: { ms: '2600', level: 'slow', phase: 'skeleton' },
  });
  assert.match(url, /target=fluency%3Askeleton/);
  assert.match(url, /ms=2600/);
  assert.match(url, /level=slow/);
  assert.match(url, /phase=skeleton/);
});

test('服务端 fluency 字段白名单：path 改 client_path，不覆盖请求 path', () => {
  const { fluencyFieldsOf } = require('../src/utils/uiTapReport');
  const fields = fluencyFieldsOf({
    ms: '2600', count: '2', phase: 'skeleton', level: 'slow',
    realm: 'inventory', form: 'return-form', status: '404',
    path: '/api/workbench/orders?q=1',
  });
  assert.deepEqual(fields, {
    ms: '2600', count: '2', phase: 'skeleton', level: 'slow',
    realm: 'inventory', form: 'return-form', status: '404',
    client_path: '/api/workbench/orders?q=1',
  });
  assert.equal(Object.hasOwn(fields, 'path'), false, '不能覆盖服务端请求 path');
  assert.deepEqual(fluencyFieldsOf({ 姓名: '张三', amount: '1' }), {}, '非白名单键一律不进去');
});
