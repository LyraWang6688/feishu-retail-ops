'use strict';

/**
 * ⭐ 2026-10-18（拆分第 2 刀）：`routes/scanPage/renderContext.js` —— **只搬不改**。
 *   `logRendered` / `logFunnelPage` / `successReturnFields` 的行为与日志形状逐字不变。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createRenderContext } = require('../src/routes/scanPage/renderContext');

const capture = (run) => {
  const logs = [];
  const orig = console.log;
  console.log = (line) => logs.push(JSON.parse(line));
  try { run(); } finally { console.log = orig; }
  return logs;
};

test('logRendered：scan.page.rendered + 漏斗（goods→entry）', () => {
  const logs = capture(() => {
    const { logRendered } = createRenderContext({
      config: { events: { rendered: 'scan.page.rendered' } },
      postActionFor: () => '/s/',
    });
    logRendered({ requestId: 'r1', query: { from: 'sales' } }, { page: 'goods', trigger: 'realm:sales', number: 'N1' });
  });
  const rendered = logs.find((l) => l.event === 'scan.page.rendered');
  assert.ok(rendered);
  assert.equal(rendered.page, 'goods');
  assert.equal(rendered.number, 'N1');
  assert.deepEqual(rendered.query_keys, ['from']);
  const view = logs.find((l) => l.event === 'ui.page.view');
  assert.equal(view.step, 'entry');
  assert.equal(view.realm, 'sales');
  assert.ok(logs.find((l) => l.event === 'ui.step.enter' && l.step === 'entry'));
});

test('successReturnFields：开关关 ⇒ {}；开启 ⇒ 回跳 + 单号 + 兜底 postActionFor', () => {
  const calls = [];
  const { successReturnFields } = createRenderContext({
    config: { successReturn: { enabled: false } },
    postActionFor: () => '/s/',
  });
  assert.deepEqual(successReturnFields({ baseUrl: '/s' }, '#x'), {});

  const cfg = {
    successReturn: { enabled: true, homePath: '/', homeRealm: 'sales', noticeKey: 'done', label: '回首页', delaySeconds: 2 },
  };
  const ctx = createRenderContext({ config: cfg, postActionFor: (target, realm) => { calls.push([target, realm]); return `/s/${target}?from=${realm}`; } });
  const fields = ctx.successReturnFields({ baseUrl: '/s' }, 'rec1', 'XSD-1');
  assert.equal(fields.returnLabel, '回首页');
  assert.equal(fields.returnDelaySeconds, 2);
  assert.match(fields.returnPath, /done=XSD-1/);
  assert.equal(fields.autoReturnUrl, fields.returnPath);
});

test('源码哨兵：实现已搬走（塞回 index ⇒ 红），聚合路径可解析', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage', 'index.js'), 'utf8');
  assert.match(index, /createRenderContext/, 'index 必须用工厂');
  assert.equal(/const logRendered = \(req, \{ page, trigger/.test(index), false, '实现不许留在 index');
  assert.equal(/const successReturnFields = \(req, target, noticeNo = ''\) => \{/.test(index), false);
  const ctx = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage', 'renderContext.js'), 'utf8');
  assert.match(ctx, /module\.exports = \{ createRenderContext \}/);
  const aggregation = fs.readFileSync(path.join(__dirname, '..', 'test', 'support', 'scanPageSource.js'), 'utf8');
  assert.ok(aggregation.includes('./scanPage/renderContext'), '聚合器必须把 require 路径迁到 scanPage/renderContext（旧位置执行）');
});
