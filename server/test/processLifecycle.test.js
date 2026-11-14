'use strict';

/**
 * #50：优雅退出处理器（SIGTERM/SIGINT → 停新连接 → drains → 退出）。
 *   AC-PL-1 顺序：server.close → drain（按注册顺序）→ exit(0)
 *   AC-PL-2 重复信号只执行一次
 *   AC-PL-3 卡住的 drain 到超时也退出（不卡部署）
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createShutdownHandler } = require('../src/services/processLifecycle');

const logger = { logInfo: () => {}, logWarn: () => {} };

test('AC-PL-1 顺序：close → drains → exit', async () => {
  const events = [];
  const server = { close: (cb) => { events.push('server.close'); if (cb) cb(); } };
  const handler = createShutdownHandler({
    server,
    drains: [async () => events.push('drain1'), async () => events.push('drain2')],
    timeoutMs: 100,
    logger,
    exit: (code) => events.push(`exit:${code}`),
  });
  await handler('SIGTERM', 0);
  assert.deepEqual(events, ['server.close', 'drain1', 'drain2', 'exit:0']);
});

test('AC-PL-2 重复信号只执行一次', async () => {
  const events = [];
  const handler = createShutdownHandler({
    server: { close: (cb) => { events.push('close'); if (cb) cb(); } },
    drains: [async () => events.push('drain')],
    timeoutMs: 50,
    logger,
    exit: (code) => events.push(`exit:${code}`),
  });
  await handler('SIGTERM', 0);
  await handler('SIGINT', 0);
  assert.deepEqual(events, ['close', 'drain', 'exit:0']);
});

test('AC-PL-3 卡住的 drain 到超时也退出', async () => {
  const events = [];
  const handler = createShutdownHandler({
    server: { close: (cb) => { if (cb) cb(); } },
    drains: [() => new Promise(() => {})],
    timeoutMs: 5,
    logger,
    exit: (code) => events.push(`exit:${code}`),
  });
  await handler('SIGTERM', 0);
  assert.deepEqual(events, ['exit:0']);
});
