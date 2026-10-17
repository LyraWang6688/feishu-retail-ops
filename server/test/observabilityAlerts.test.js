'use strict';

/**
 * ⭐ 2026-10-17（埋点第 3 刀）：3 条告警的判定 + 去重 + 防刷屏 + 默认关。
 *   · error_rate（占比 + 最小样本）
 *   · critical（关键链路事件）
 *   · slow（duration_ms 阈值）
 * 能用真红：把任一条规则阈值改成永不触发 ⇒ 对应用例红。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { OBSERVABILITY_ALERTS } = require('../src/config/alerts');
const { createAlertMonitor } = require('../src/services/alertMonitor');

const flush = () => new Promise((resolve) => setImmediate(resolve));

const baseConfig = (over = {}) => ({
  enabled: true,
  windowMinutes: 15,
  silentMinutes: 60,
  maxPerWindow: 3,
  slowMs: 10000,
  errorRate: { thresholdPct: 5, minErrors: 3, minTotal: 10 },
  criticalEvents: ['critical.event', 'critical.event2', 'critical.event3', 'critical.event4'],
  chatId: '',
  prefix: '【告警】',
  ...over,
});

test('默认关：不建窗口、不发送（线上未开开关 ⇒ 零噪音）', async () => {
  const sent = [];
  const monitor = createAlertMonitor({ config: OBSERVABILITY_ALERTS, notify: async (a) => sent.push(a) });
  assert.equal(OBSERVABILITY_ALERTS.enabled, false, '默认必须是关（显式布尔）');
  for (let i = 0; i < 100; i += 1) monitor.record({ level: 'error', event: 'critical.event' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.length, 0);
  assert.equal(monitor._events.length, 0, '关着时连窗口都不建');
});

test('规则① error_rate：占比 + 最小样本，命中一条；silent 内不重复', async () => {
  const sent = [];
  let t = 0;
  const monitor = createAlertMonitor({
    config: baseConfig(), now: () => t, notify: async (a) => sent.push(a),
  });
  for (let i = 0; i < 7; i += 1) { t += 1000; monitor.record({ level: 'info', event: 'ok.event' }); }
  for (let i = 0; i < 3; i += 1) { t += 1000; monitor.record({ level: 'error', event: 'some.error' }); }
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].rule, 'error_rate');
  assert.match(sent[0].text, /30\.0%/);
  t += 1000; monitor.record({ level: 'error', event: 'some.error' });
  assert.equal(sent.length, 1, 'silent 窗口内同 key 不重复');
  t += 61 * 60 * 1000;
  for (let i = 0; i < 7; i += 1) { t += 1000; monitor.record({ level: 'info', event: 'ok.event' }); }
  for (let i = 0; i < 3; i += 1) { t += 1000; monitor.record({ level: 'error', event: 'some.error' }); }
  await flush();
  assert.equal(sent.length, 2, '超过 silent 窗口后、且窗口样本重新达标时可以再发');
});

test('规则② critical：只认"关键链路事件 + error 级别"', async () => {
  const sent = [];
  let t = 0;
  const monitor = createAlertMonitor({ config: baseConfig(), now: () => t, notify: async (a) => sent.push(a) });
  t += 1; monitor.record({ level: 'warn', event: 'critical.event' });
  await flush();
  assert.equal(sent.length, 0, 'warn 级别不触发关键链路告警');
  t += 1; monitor.record({ level: 'error', event: 'not.critical' });
  await flush();
  assert.equal(sent.length, 0, '非关键事件不触发');
  t += 1; monitor.record({ level: 'error', event: 'critical.event' });
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].rule, 'critical');
  assert.match(sent[0].text, /critical\.event/);
});

test('规则③ slow：duration_ms 达阈值才报', async () => {
  const sent = [];
  let t = 0;
  const monitor = createAlertMonitor({ config: baseConfig(), now: () => t, notify: async (a) => sent.push(a) });
  t += 1; monitor.record({ level: 'info', event: 'slow.event', duration_ms: 9999 });
  assert.equal(sent.length, 0);
  t += 1; monitor.record({ level: 'info', event: 'slow.event', duration_ms: 10000 });
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].rule, 'slow');
  assert.match(sent[0].text, /10000ms/);
});

test('防刷屏：每窗口最多 maxPerWindow 条（不同 key 也不超）', async () => {
  const sent = [];
  let t = 0;
  const monitor = createAlertMonitor({ config: baseConfig(), now: () => t, notify: async (a) => sent.push(a) });
  for (const event of ['critical.event', 'critical.event2', 'critical.event3', 'critical.event4']) {
    t += 1; monitor.record({ level: 'error', event });
  }
  await flush();
  assert.equal(sent.length, 3, '超过上限的不发');
});

test('app 接线：只有开关打开才挂监听器（源码哨兵）', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.match(app, /OBSERVABILITY_ALERTS\.enabled/);
  assert.match(app, /addLogListener/);
  assert.match(app, /createAlertMonitor\(\{ notify: createAlertNotifier\(\) \}\)/);
  const logger = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'logger.js'), 'utf8');
  assert.match(logger, /addLogListener/, 'logger 必须暴露监听口');
  assert.match(logger, /监听器失败不许影响业务日志/, '监听器异常必须被隔离');
});
