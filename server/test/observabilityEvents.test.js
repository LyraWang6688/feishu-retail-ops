'use strict';

/**
 * ⭐ 2026-10-17（埋点第一刀）：
 *   ① 事件目录 `src/config/events.js` = 全仓日志事件名的**唯一真源**（自动生成）；
 *   ② 运行时校验：未登记事件在日志里带 `unregistered: true`（`LOG_EVENT_STRICT=true` 时另打一条 warn）；
 *   ③ `docs/observability-events.md` 自动生成，源码与文档必须同步（过期即红）。
 * ⚠️ "能真红"：新增一条 `logInfo('brand.new.event', …)` 而不重新生成 ⇒ 本用例红。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_ROOT = path.join(__dirname, '..');
const { EVENTS, isRegisteredEvent } = require('../src/config/events');
const { logInfo } = require('../src/utils/logger');

const modulePath = path.join(SERVER_ROOT, 'scripts', 'observability-events.mjs');

test('事件目录/文档与源码同步（新增日志未登记 ⇒ 红）', async () => {
  const { generate } = await import(modulePath);
  const { events, catalog, doc } = generate({ write: false });
  assert.ok(events.size > 100, `事件数异常少：${events.size}`);
  assert.equal(fs.readFileSync(path.join(SERVER_ROOT, 'src/config/events.js'), 'utf8'), catalog,
    'src/config/events.js 已过期 ⇒ 跑 pnpm run observability:events');
  assert.equal(fs.readFileSync(path.join(SERVER_ROOT, '..', 'docs/observability-events.md'), 'utf8'), doc,
    'docs/observability-events.md 已过期 ⇒ 跑 pnpm run observability:events');
  assert.equal(EVENTS.length, events.size, '运行时目录与扫描结果不一致');
  for (const [event] of events) assert.equal(isRegisteredEvent(event), true, `${event} 未登记`);
  assert.equal(isRegisteredEvent('definitely.not.registered'), false);
  assert.deepEqual(EVENTS, [...new Set(EVENTS)], '目录不许重复');
  assert.deepEqual(EVENTS, [...EVENTS].sort((a, b) => a.localeCompare(b)), '目录必须有序（生成器保证稳定 diff）');
});

test('运行时校验：未登记事件带 unregistered 标记；strict 模式只 warn 一次', () => {
  const logged = [];
  const warned = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (line) => logged.push(line);
  console.warn = (line) => warned.push(line);
  try {
    logInfo(EVENTS[0], { ok: 1 });
    logInfo('zzz.unknown.event', { ok: 1 });
    const known = JSON.parse(logged[0]);
    const unknown = JSON.parse(logged[1]);
    assert.equal(known.unregistered, undefined, '已登记事件不许带 unregistered');
    assert.equal(unknown.unregistered, true, '未登记事件必须带 unregistered: true');
    assert.equal(warned.length, 0, '默认（非 strict）不额外 warn，避免刷屏');
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }

  process.env.LOG_EVENT_STRICT = 'true';
  try {
    console.log = () => {};
    console.warn = (line) => warned.push(line);
    logInfo('zzz.unknown.event', { detail: 1 });
    logInfo('zzz.unknown.event', { detail: 2 });
    const unregisteredWarns = warned.map((line) => JSON.parse(line))
      .filter((item) => item.event === 'log.event.unregistered' && item.name === 'zzz.unknown.event');
    assert.equal(unregisteredWarns.length, 1, 'strict 模式同名未登记事件只 warn 一次');
  } finally {
    delete process.env.LOG_EVENT_STRICT;
    console.log = origLog;
    console.warn = origWarn;
  }
});

test('生成器 --check 在过期时报错（CLI 口径）', () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, [modulePath, '--check'], { cwd: SERVER_ROOT, encoding: 'utf8' });
  assert.match(out, /是最新的/, '--check 必须报告"最新"');
});
