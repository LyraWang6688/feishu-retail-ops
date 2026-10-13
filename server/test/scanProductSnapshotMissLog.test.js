'use strict';

/**
 * ⭐⭐ 2026-10-14（她今晚第三次说"慢"）：`product_snapshot_hit` **一直 false** ✗
 *   ⇒ 每次切换都真读「货品信息」（她日志 1.2~8.5 秒 ✗）。
 * 代码依据：`scanPageService.js` 里 `timing.product_snapshot_hit = Boolean(product)` **只在
 *   `indexed.ready` 那一支置位** ⇒ false 只说明 `ready === false`，**说明不了原因** ✗
 *   ⇒ 这一版**只加一行诊断**：把 `get()` 的 `reason` / `ageMs` 用**既有**事件名
 *      `scan.snapshot.miss` 打出来（`disabled` / `not_ready` / `stale` / `limit_exceeded` ✓）
 *      —— 拿到 reason 才谈修（不许盲改 TTL / 上限 ✗）。
 *
 * AC-WM1 `product` 快照未就绪 ⇒ **必有一条** miss 日志，且带 `reason` 与 `age_ms`（能真红 ✓）
 * AC-WM2 快照**命中**时**不许**打这条（不刷屏 ✓ 能真红 ✓）
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_wm_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'wm_secret';
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'wm_app_token';

const { createScanPageService } = require('../src/services/scanPageService');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');

/** 拦 stdout（服务里 `logInfo` 是 require 时解构的 ⇒ 只能从出口拦 ✓）。 */
const captureStdout = async (run) => {
  const lines = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    lines.push(text);
    return original(chunk, ...rest);
  };
  try { await run(); } finally { process.stdout.write = original; }
  return lines.join('');
};

const gateway = {
  table: (key) => require('../src/config/v1BitableSchema').V1_BITABLE_SCHEMA.tables[key],
  listAll: async () => [],
  listByFilter: async () => [],
  create: async () => { throw new Error('扫码页不许写'); },
  update: async () => { throw new Error('扫码页不许写'); },
  delete: async () => { throw new Error('扫码页不许写'); },
};

test('AC-WM1 货品快照未就绪 ⇒ 必有一条 `scan.snapshot.miss`（带 reason + age_ms）', async () => {
  const output = await captureStdout(async () => {
    const service = createScanPageService(gateway, {
      // ⚠️ 假的"未就绪"快照：reason='stale'（TTL 过期那一种）
      productSnapshot: { get: () => ({ ready: false, reason: 'stale', ageMs: 1234 }) },
      snapshot: false,
      startSnapshot: false,
    });
    await service.lookup({ number: 'YD6693-2|黑色|A', requestId: 'req_wm1', timing: {} });
  });
  assert.ok(output.includes('scan.snapshot.miss'), `必须打一条 miss 日志：${output.slice(0, 200)}`);
  assert.ok(output.includes('"table_key":"product"'), '必须指明是 product（不然分不清哪个快照 ✗）');
  assert.ok(output.includes('"reason":"stale"'), '必须带 reason（这就是我们要的答案 ✓）');
  assert.ok(output.includes('"age_ms":1234'), '必须带 ageMs（stale 时要看它有多旧 ✓）');
});

test('AC-WM2 快照命中（ready:true）⇒ **不许**打这条 miss（不刷屏 ✓）', async () => {
  const output = await captureStdout(async () => {
    const service = createScanPageService(gateway, {
      productSnapshot: { get: () => ({ ready: true, records: [], ageMs: 5 }) },
      snapshot: false,
      startSnapshot: false,
    });
    await service.lookup({ number: 'YD6693-2|黑色|A', requestId: 'req_wm2', timing: {} });
  });
  assert.equal(output.includes('"table_key":"product"'), false, '命中的那一趟不许打 miss ✗');
});
