'use strict';

/**
 * ⭐⭐ 2026-10-14 真机 bug（她今晚第三次说"慢"）：**货品快照被一次 400 废掉**
 *
 * 线上铁证：
 *   `scan.snapshot.miss {"reason":"Request failed with status code 400","age_ms":-1}` ✗
 *   ＋ `scan.snapshot.refreshed {table_key:"product", records:561}` ✓（预热成功过）
 *   ⇒ 之后某次刷新失败 ⇒ 代码把"上次失败"记住 ⇒ **此后永远判未就绪** ⇒ 每次查款都掉回真读货品表
 *     （1.5~4.3 秒）⇒ 六格切换卡 ⇒ 成片 499 ✗
 *   ⇒ ⚠️ **不是"两个实例"**（那条假说已证伪 ✓）
 *
 * 本文件**先写先红**（现状：`refresh` 失败只 `drop()` + 记 `lastError`，没有重试、也没有把飞书 code 打出来）
 *
 *   AC-SR1 `一次 400 ⇒ 自动重试一次 ⇒ ready=true`（假网关注入 ✓）
 *   AC-SR2 `连续两次 400 ⇒ 第三次仍会尝试`（**不钉死** ✓）
 *   AC-SR3 `写操作的路径一次都不重试`（**源码哨兵** ✓）
 *   AC-SR4 `预热之后连续两次取数 ⇒ 两次都吃快照`（不回落真读 ✓）
 *   AC-SR5 ① 的判据：失败日志里**能看到飞书的 code/msg**（不许只给 axios 那句 ✗）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_sr';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'sr_secret';

const { createLiveInventorySnapshot } = require('../src/services/liveInventorySnapshot');

const SNAPSHOT_SRC = fs.readFileSync(path.join(__dirname, '../src/services/liveInventorySnapshot.js'), 'utf8');

/** 造一个飞书风格的 400：`error.response.data` 里带 code/msg（真机就是这种形状）。 */
const feishu400 = (code = 1254607, msg = 'Data not ready, please try again later') => {
  const error = new Error('Request failed with status code 400');
  error.response = { status: 400, data: { code, msg } };
  return error;
};

/**
 * 假网关：`listAll` 按脚本逐次返回（抛错或数据）；**只记读调用**。
 * ⚠️ 刻意**没有** create/update/delete —— 一写就抛 ⇒ "写路径不重试"的物理哨兵 ✓
 */
const fakeGateway = (script) => {
  const calls = [];
  let index = 0;
  return {
    calls,
    listAll: async (tableKey) => {
      calls.push(tableKey);
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      if (step instanceof Error) throw step;
      return step;
    },
  };
};

const config = { enabled: true, refreshIntervalMs: 30_000, maxAgeMs: 60_000, maxRecords: 5_000 };

const snapshotFor = (gateway, options = {}) => createLiveInventorySnapshot({
  gateway, config, tableKey: 'product', maxRecords: 5_000,
  now: options.now || (() => 1_000),
  setIntervalFn: () => null, clearIntervalFn: () => undefined,
});

test('AC-SR1 ⭐ 一次 400 ⇒ **自动重试一次** ⇒ ready=true（读路径可以重试 ✓）', async () => {
  const gateway = fakeGateway([feishu400(), [{ record_id: 'p1' }]]);
  const snapshot = snapshotFor(gateway);
  const result = await snapshot.refresh({ reason: 'warm' });
  assert.equal(result.ok, true, `重试后应当成功：${JSON.stringify(result)}`);
  assert.equal(gateway.calls.length, 2, `应当尝试两次（1 次失败 + 1 次重试），实际 ${gateway.calls.length}`);
  assert.equal(snapshot.get().ready, true, '重试成功后快照要可用 ✓');
  assert.equal(snapshot.get().records.length, 1);
});

test('AC-SR2 ⭐ 连续两次 400 ⇒ **第三次仍会尝试**（不钉死 ✗）', async () => {
  const gateway = fakeGateway([feishu400(), feishu400(), feishu400(), feishu400(), feishu400(), feishu400()]);
  const snapshot = snapshotFor(gateway);
  await snapshot.refresh({ reason: 'warm' });
  const afterFirst = gateway.calls.length;
  await snapshot.refresh({ reason: 'tick' });
  const afterSecond = gateway.calls.length;
  await snapshot.refresh({ reason: 'tick' });
  const afterThird = gateway.calls.length;
  assert.ok(afterFirst >= 1, '第一次要有尝试');
  assert.ok(afterSecond > afterFirst, `第二次仍要尝试（${afterFirst} → ${afterSecond}）—— 不许因"上次失败"就不试 ✗`);
  assert.ok(afterThird > afterSecond, `第三次仍要尝试（${afterSecond} → ${afterThird}）✗ 不许钉死`);
  assert.equal(snapshot.get().ready, false, '失败了就是没就绪（不回退假数据 ✓）');
  assert.ok(String(snapshot.get().reason).length > 0, '要如实给出失败原因');
});

test('AC-SR3 ⭐ **写操作的路径一次都不重试**（源码哨兵：这个文件里没有写调用 ✓）', () => {
  // ① 这个快照文件**只有读**：一处 create/update/delete 都不许有
  // ⚠️ 只认**网关的写调用**：`Map.delete(...)` / `Set.delete(...)` 不是写库 ✗（第一版就是这么误报的）
  // ⚠️ **只认网关写调用**：`Map.delete(...)` / `Set.delete(...)` 不是写库 ✗（第一版用宽正则 ⇒ 假红）
  const gatewayWrites = SNAPSHOT_SRC.match(/gateway\s*\.\s*(create|update|delete|batchCreate|batchUpdate)\s*\(/g) || [];
  assert.deepEqual(gatewayWrites, [], `快照文件里不许有网关写调用（实际 ${gatewayWrites.join(',')}）`);
  // 这个文件里**唯一**的网关调用是"读整表"，且它读的是 `listAll`
  const gatewayCalls = SNAPSHOT_SRC.match(/gateway\s*\.\s*[a-zA-Z]+\s*\(/g) || [];
  assert.deepEqual([...new Set(gatewayCalls)].map((item) => item.replace(/\s+/g, '')), ['gateway.listAll('],
    `快照只该读：实际 ${gatewayCalls.join(',')}`);
  // ② 重试只准包在**读**上：`listAll` 有重试，且重试助手只在读那一处被用
  assert.ok(/listAll\s*\(/.test(SNAPSHOT_SRC), '它读的是 listAll ✓');
  assert.ok(/RETRY|retry|attempt/i.test(SNAPSHOT_SRC), '读路径要有"重试一次"的实现 ✓');
  // ③ 写路径（invalidate 之类）不许套重试：invalidate 里不许出现重试助手
  const invalidateBody = SNAPSHOT_SRC.slice(SNAPSHOT_SRC.indexOf('const invalidate ='));
  assert.equal(/\b(retry|withRetry|attempt)\b/i.test(invalidateBody.slice(0, 600)), false,
    '写库后那条路（invalidate）不许带重试 ✗');
});

test('AC-SR4 ⭐ 预热之后**连续两次取数**都吃快照（不回落真读 ✗）', async () => {
  const gateway = fakeGateway([[{ record_id: 'p1' }]]);
  const snapshot = snapshotFor(gateway);
  await snapshot.refresh({ reason: 'warm' });
  const readsAfterWarm = gateway.calls.length;
  const first = snapshot.get();
  const second = snapshot.get();
  assert.equal(first.ready, true, '第一次取数应当吃快照 ✓');
  assert.equal(second.ready, true, '第二次取数也应当吃快照 ✓（真机症状是第二次就 miss ✗）');
  assert.equal(gateway.calls.length, readsAfterWarm, '两次取数**不许**再读表 ✓');
});

test('AC-SR5 ① 的判据：失败日志里能看到**飞书的 code / msg**（不许只给 axios 那句 ✗）', async () => {
  const gateway = fakeGateway([feishu400(1254607, 'Data not ready, please try again later')]);
  const snapshot = createLiveInventorySnapshot({
    gateway, config, tableKey: 'product', maxRecords: 5_000,
    now: () => 1_000, setIntervalFn: () => null, clearIntervalFn: () => undefined,
    events: { snapshotFailed: 'test.snapshot.failed', snapshotRefreshed: 'test.snapshot.refreshed' },
  });
  // 抓 warn：`logWarn` 是**解构导入**的 ⇒ 必须在快照模块加载前替换（清缓存 + 重新 require ✓）
  const logger = require('../src/utils/logger');
  const original = logger.logWarn;
  const logs = [];
  logger.logWarn = (event, payload) => { logs.push({ event, payload }); };
  const snapshotPath = require.resolve('../src/services/liveInventorySnapshot');
  try {
    // ⚠️ **只清快照模块**的缓存：清掉 logger 会 require 出一个**新实例** ⇒ 我打的补丁就失效了 ✗
    delete require.cache[snapshotPath];
    const { createLiveInventorySnapshot: Fresh } = require('../src/services/liveInventorySnapshot');
    const fresh = Fresh({
      gateway, config, tableKey: 'product', maxRecords: 5_000,
      now: () => 1_000, setIntervalFn: () => null, clearIntervalFn: () => undefined,
      events: { snapshotFailed: 'test.snapshot.failed', snapshotRefreshed: 'test.snapshot.refreshed' },
    });
    await fresh.refresh({ reason: 'warm' });
    const failed = logs.filter((item) => item.event === 'test.snapshot.failed');
    assert.ok(failed.length >= 1, '要记一条失败 warn ✓');
    const text = JSON.stringify(failed);
    assert.ok(/1254607/.test(text), `日志里要能看到飞书的 code（实际：${text}）`);
    assert.ok(/Data not ready/.test(text), '日志里要能看到飞书的 msg（不许只给 axios 那句 ✗）');
  } finally {
    logger.logWarn = original;
    delete require.cache[snapshotPath];
  }
});
