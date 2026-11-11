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
const { CONFIG_TABLES, CONFIG_TABLE_KEYS } = require('../src/config/configTables');
const { addLogListener } = require('../src/utils/logger');

const TTL = CONFIG_TABLES.paymentMethod.ttlMs;

const gatewayOf = (values, calls = { n: 0 }) => ({
  listAll: async () => { calls.n += 1; return values.map((v, i) => ({ record_id: `r${i}`, fields: { name: v } })); },
});

test('配置表 TTL 由统一注册表给定（调用方不再传）', () => {
  assert.ok(CONFIG_TABLE_KEYS.includes('paymentMethod'));
  assert.ok(CONFIG_TABLE_KEYS.includes('sizeManagement'));
  assert.equal(CONFIG_TABLE_KEYS.length, 10, '注册表覆盖既有 10 张配置表（含实时库存短快照）');
  assert.equal(CONFIG_TABLES.category.ttlMs, 24 * 60 * 60 * 1000);
  assert.equal(CONFIG_TABLES.paymentMethod.ttlMs, 24 * 60 * 60 * 1000);
  assert.equal(CONFIG_TABLES.sizeManagement.ttlMs, 24 * 60 * 60 * 1000);
  assert.equal(CONFIG_TABLES.product.ttlMs, 24 * 60 * 60 * 1000);
  assert.equal(CONFIG_TABLES.liveInventory.ttlMs, 5 * 60 * 1000);
});

test('TTL 内复用，过期重读', async () => {
  resetConfigTableCache();
  const calls = { n: 0 };
  let clock = 1000;
  const gateway = gatewayOf(['微信扫码'], calls);
  await getConfigRows({ gateway, tableKey: 'paymentMethod', now: () => clock });
  await getConfigRows({ gateway, tableKey: 'paymentMethod', now: () => clock });
  assert.equal(calls.n, 1);
  clock += TTL + 1;
  await getConfigRows({ gateway, tableKey: 'paymentMethod', now: () => clock });
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
  await getConfigRows({ gateway, tableKey: 'paymentMethod', now: () => clock });
  fail = true;
  clock += TTL + 1;
  const rows = await getConfigRows({ gateway, tableKey: 'paymentMethod', now: () => clock });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fields.name, '微信扫码', '必须继续用 lastGood');
});

test('record_changed → invalidate 后下一次重读', async () => {
  resetConfigTableCache();
  const calls = { n: 0 };
  let clock = 1000;
  const gateway = gatewayOf(['微信扫码'], calls);
  await getConfigRows({ gateway, tableKey: 'paymentMethod', now: () => clock });
  invalidateConfigTable('paymentMethod');
  clock += 1;
  await getConfigRows({ gateway, tableKey: 'paymentMethod', now: () => clock });
  assert.equal(calls.n, 2, '事件后必须重读');
});

test('过期重读失败 ⇒ lastGood 使用有告警（同表 5 分钟内只打一次）', async () => {
  resetConfigTableCache();
  let clock = 10_000;
  let fail = false;
  const gateway = {
    listAll: async () => {
      if (fail) throw new Error('1254607 Data not ready');
      return [{ record_id: 'a', fields: { name: '微信扫码' } }];
    },
  };
  await getConfigRows({ gateway, tableKey: 'paymentMethod', now: () => clock });
  fail = true;
  clock += CONFIG_TABLES.paymentMethod.ttlMs + 1;
  const logs = [];
  const off = addLogListener((payload) => logs.push(payload));
  try {
    await getConfigRows({ gateway, tableKey: 'paymentMethod', now: () => clock });
    await getConfigRows({ gateway, tableKey: 'paymentMethod', now: () => clock });
  } finally {
    off();
  }
  const warnings = logs.filter((entry) => entry.event === 'config_table_cache.last_good_used');
  assert.equal(warnings.length, 1, '5 分钟内只打一次告警');
  assert.equal(warnings[0].level, 'warn');
  assert.equal(warnings[0].table_key, 'paymentMethod');
  assert.ok(warnings[0].age_ms >= CONFIG_TABLES.paymentMethod.ttlMs);
});


test('freshness=fresh：写库前强制重读，失败不回落 lastGood', async () => {
  resetConfigTableCache();
  let calls = 0;
  let clock = 1_000;
  let fail = false;
  const gateway = {
    listAll: async () => {
      calls += 1;
      if (fail) throw new Error('behavior 读失败');
      return [{ record_id: 'b1', fields: { code: 'STOCK_SALE_DECREASE' } }];
    },
  };
  const opts = { gateway, tableKey: 'behavior', now: () => clock };
  await getConfigRows(opts);
  assert.equal(calls, 1);
  // TTL 内普通读命缓存，不重读
  await getConfigRows(opts);
  assert.equal(calls, 1);
  // fresh 即使 TTL 内也强制重读
  await getConfigRows({ ...opts, freshness: 'fresh' });
  assert.equal(calls, 2);
  // fresh 失败必须抛错，不能拿 lastGood 去写库
  fail = true;
  await assert.rejects(() => getConfigRows({ ...opts, freshness: 'fresh' }), /读失败/);
  // 普通读仍可回退 lastGood
  const rows = await getConfigRows(opts);
  assert.equal(rows[0].record_id, 'b1');
});


test('不同字段集分开缓存：精简快照不污染完整快照（#990 回归）', async () => {
  resetConfigTableCache();
  let calls = 0;
  const gateway = { listAll: async () => { calls += 1; return [{ record_id: 'p1', fields: { name: '完整' } }]; } };
  const opts = { gateway, tableKey: 'product', now: () => 1_000 };
  await getConfigRows({ ...opts, fields: ['名称'], loader: async () => [{ record_id: 'p1', fields: { 名称: '精简' } }] });
  const full = await getConfigRows(opts);
  assert.equal(full[0].fields.name, '完整');
  assert.equal(calls, 1);
  const slim = await getConfigRows({ ...opts, fields: ['名称'], loader: async () => { calls += 1; return []; } });
  assert.equal(slim[0].fields['名称'], '精简', '字段集命中自己的快照，不读完整快照');
  assert.equal(calls, 1);
});
