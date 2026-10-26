'use strict';

/**
 * 统一配置快照（2026-10-26）：
 *  1) TTL 内复用；
 *  2) 过期重读失败 ⇒ 继续用**最后一次成功**（不退回配置假选项）；
 *  3) 飞书 record_changed ⇒ invalidate；下一次读取重读。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { getConfigRows, invalidateConfigTable, resetConfigTableCache } = require('../src/services/configTableCache');

const gatewayOf = (values, calls = { n: 0 }) => ({
  listAll: async () => { calls.n += 1; return values.map((v, i) => ({ record_id: `r${i}`, fields: { name: v } })); },
});

test('TTL 内复用，过期重读', async () => {
  resetConfigTableCache();
  const calls = { n: 0 };
  let clock = 1000;
  const gateway = gatewayOf(['微信扫码'], calls);
  await getConfigRows({ gateway, tableKey: 'paymentMethod', ttlMs: 5000, now: () => clock });
  await getConfigRows({ gateway, tableKey: 'paymentMethod', ttlMs: 5000, now: () => clock });
  assert.equal(calls.n, 1);
  clock += 5001;
  await getConfigRows({ gateway, tableKey: 'paymentMethod', ttlMs: 5000, now: () => clock });
  assert.equal(calls.n, 2);
});

test('过期重读失败 ⇒ 用最后一次成功（不是配置假选项）', async () => {
  resetConfigTableCache();
  let fail = false;
  let clock = 1000;
  const gateway = {
    listAll: async () => {
      if (fail) throw new Error('1254607 Data not ready');
      return [{ record_id: 'a', fields: { name: '微信扫码' } }];
    },
  };
  await getConfigRows({ gateway, tableKey: 'paymentMethod', ttlMs: 5000, now: () => clock });
  fail = true;
  clock += 5001;
  const rows = await getConfigRows({ gateway, tableKey: 'paymentMethod', ttlMs: 5000, now: () => clock });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fields.name, '微信扫码', '必须继续用 lastGood');
});

test('record_changed → invalidate 后下一次重读', async () => {
  resetConfigTableCache();
  const calls = { n: 0 };
  let clock = 1000;
  const gateway = gatewayOf(['微信扫码'], calls);
  await getConfigRows({ gateway, tableKey: 'paymentMethod', ttlMs: 60_000, now: () => clock });
  invalidateConfigTable('paymentMethod');
  clock += 1;
  await getConfigRows({ gateway, tableKey: 'paymentMethod', ttlMs: 60_000, now: () => clock });
  assert.equal(calls.n, 2, '事件后必须重读');
});
