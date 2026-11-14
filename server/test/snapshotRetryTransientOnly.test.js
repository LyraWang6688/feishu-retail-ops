'use strict';

/**
 * #61：库存快照的读重试**只重试瞬时错误**（2026-11-14）。
 *   AC-SRT-1 401/404（确定性错误）⇒ 一次都不重试
 *   AC-SRT-2 1254607（临时）⇒ 重试后成功
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createLiveInventorySnapshot } = require('../src/services/liveInventorySnapshot');

const feishuError = (status, code, msg) => {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, data: { code, msg } };
  return error;
};

const snapshotOf = (script, config = {}) => {
  const calls = { n: 0 };
  let index = 0;
  let now = 0;
  const gateway = {
    listAll: async () => {
      calls.n += 1;
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      if (step instanceof Error) throw step;
      return step;
    },
  };
  const snapshot = createLiveInventorySnapshot({
    gateway, tableKey: 'liveInventory',
    config: { enabled: true, refreshIntervalMs: 60_000, maxAgeMs: 60_000, ...config },
    now: () => { now += 1000; return now; },
  });
  return { snapshot, calls };
};

test('AC-SRT-1 确定性错误（404/401）不重试', async () => {
  const { snapshot, calls } = snapshotOf([feishuError(404, 1254045, 'field not found')], { readRetryTimes: 2 });
  const out = await snapshot.refresh();
  assert.equal(out.ok, false);
  assert.match(String(out.error), /404/);
  assert.equal(calls.n, 1, '确定性错误只打一次，不空转重试');
});

test('AC-SRT-2 临时错误（1254607）重试后成功', async () => {
  const { snapshot, calls } = snapshotOf([
    feishuError(400, 1254607, 'Data not ready, please try again later'),
    [{ record_id: 'r1', fields: {} }],
  ], { readRetryTimes: 1, readRetryDelayMs: 0 });
  const out = await snapshot.refresh();
  assert.equal(calls.n, 2);
  assert.equal(out.records, 1);
});
