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
  slowEvents: ['slow.event'],
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

test('收件人优先级：open_id（私发）优先于群，且 receive_id_type 正确', async () => {
  const { createAlertNotifier } = require('../src/services/alertNotifier');
  const calls = [];
  const fake = { im: { message: { create: async (args) => { calls.push(args); return { code: 0 }; } } } };
  const log = console.log;
  console.log = () => {};
  try {
    await createAlertNotifier({ config: { openId: 'ou_owner', chatId: 'oc_group' }, clientFactory: () => fake })(
      { rule: 'r', key: 'k', text: 't' },
    );
    await createAlertNotifier({ config: { openId: '', chatId: 'oc_group' }, clientFactory: () => fake })(
      { rule: 'r', key: 'k', text: 't' },
    );
  } finally { console.log = log; }
  assert.equal(calls[0].params.receive_id_type, 'open_id', '有 open_id ⇒ 私发');
  assert.equal(calls[0].data.receive_id, 'ou_owner');
  assert.equal(calls[1].params.receive_id_type, 'chat_id', '没有 open_id ⇒ 回落到群');
  assert.equal(calls[1].data.receive_id, 'oc_group');
});

test('配置：open_id 默认空（默认仍关 + 无收件人时不乱发）', () => {
  assert.equal(OBSERVABILITY_ALERTS.openId, '');
  assert.equal(OBSERVABILITY_ALERTS.enabled, false);
});


test('慢事件白名单：默认只认 perf.request.completed（http 全局日志不再重复报警）', async () => {
  const sent = [];
  let t = 0;
  const cfg = baseConfig({ slowEvents: ['perf.request.completed'] });
  const monitor = createAlertMonitor({ config: cfg, now: () => t, notify: async (a) => sent.push(a) });
  t += 1; monitor.record({ level: 'info', event: 'http.request.completed', duration_ms: 18259, trace_id: 'trace-1' });
  await flush();
  assert.equal(sent.length, 0, 'http.request.completed 不许再触发慢告警');
  t += 1; monitor.record({ level: 'info', event: 'perf.request.completed', duration_ms: 18259, trace_id: 'trace-1', chain: 'orders.list' });
  await flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /perf\.request\.completed/);
  assert.match(sent[0].text, /orders\.list/, '文案必须带链名（一眼知道哪条链路慢）');
});

test('trace_id 去重：同一请求的 perf + http 两条慢日志只告警一次', async () => {
  const sent = [];
  let t = 0;
  const cfg = baseConfig({ slowEvents: ['perf.request.completed', 'http.request.completed'] });
  const monitor = createAlertMonitor({ config: cfg, now: () => t, notify: async (a) => sent.push(a) });
  t += 1; monitor.record({ level: 'info', event: 'perf.request.completed', duration_ms: 18259, trace_id: 'trace-9', chain: 'orders.list' });
  t += 1; monitor.record({ level: 'info', event: 'http.request.completed', duration_ms: 18259, trace_id: 'trace-9' });
  await flush();
  assert.equal(sent.length, 1, '同一 trace 只许一条慢告警');
});
