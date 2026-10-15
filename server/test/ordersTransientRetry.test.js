'use strict';

/**
 * ⭐⭐ 2026-10-15（业务负责人逐字：「**需要加上**」）：
 *   **工作台订单列表的「瞬时错误自动重试」**验收用例（AC-W1…AC-W5）。
 *
 * 起因（她真机）：`GET /api/workbench/sales/orders` 内部读飞书时，飞书回了
 *   **`1254607 Data not ready, please try again later`**（瞬时错误）⇒ 路由 502 ⇒ 页面把内部 400 显示出来 ✗。
 *
 * 口径（照扫码页那条 `liveInventorySnapshot.listAllWithRetry` 的同一套）：
 *   · **只重试瞬时错误**（`1254607` / 429 / 5xx / 网络类）；`401/403/404` **一次都不重试** ✗
 *   · **次数/退避来自配置**（默认 1 次 + 300ms ✓ 不写死 ✗）
 *   · **如实**：命中记一条 `workbench.sales.orders.read_retry`；重试用完仍失败 ⇒ 仍 **502** 并落
 *     `workbench.sales.orders.failed`（**绝不把失败吞成成功** ✗）
 *
 * ⚠️ 跑的是**真的** `SalesFollowupService` + **真的** `routes/workbench.js`；
 *   只有飞书网关是替身（可按表/按次注入瞬时失败）。`sleep` 注入成"不等真时间"⇒ 不 flake ✓
 */

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_orders_retry_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'orders_retry_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET || 'orders-retry-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ⚠️📌 抓日志必须在 **require 业务模块之前** 打桩（`utils/logger` 的函数在 require 时被解构）
const logger = require('../src/utils/logger');
const logs = [];
const originalWarn = logger.logWarn;
const originalInfo = logger.logInfo;
const originalError = logger.logError;
logger.logWarn = (event, fields) => { logs.push({ level: 'warn', event, fields }); };
logger.logInfo = (event, fields) => { logs.push({ level: 'info', event, fields }); };
// ⚠️ 路由那条失败日志走的是 **logError**（不是 warn）—— 不抓它就会误判"没落日志" ✗
logger.logError = (event, fields) => { logs.push({ level: 'error', event, fields }); };
test.after(() => {
  logger.logWarn = originalWarn; logger.logInfo = originalInfo; logger.logError = originalError;
});

const { SalesFollowupService } = require('../src/services/salesFollowupService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { resolveOrderReadRetryConfig } = require('../src/config/orderReadRetry');

const OPEN_ID = 'ou_orders_retry';
const SECRET = process.env.LARK_WEB_SESSION_SECRET;
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orders-retry-'));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 忽略 */ } };

/** 飞书那类瞬时错误（她真机上抓到的形状：400 + code 1254607）。 */
const transientError = () => Object.assign(new Error('Data not ready, please try again later'), {
  code: 1254607,
  response: { status: 400, data: { code: 1254607, msg: 'Data not ready, please try again later' } },
});
const forbiddenError = () => Object.assign(new Error('forbidden'), {
  response: { status: 403, data: { code: 99991672, msg: 'no permission' } },
});

/**
 * 假网关：按 **表名 + 第几次调用** 决定抛什么。
 * `failures = { product: [1254607] }` ⇒ 表 product 第 1 次抛瞬时错，之后成功 ✓
 * 传 `'always'` ⇒ 每次都抛（用来验"重试用完仍失败 ⇒ 502"）✓
 */
const createFakeGateway = (failures = {}) => {
  const calls = [];
  const boom = (kind) => (kind === 'transient' ? transientError() : forbiddenError());
  const gateway = {
    calls,
    table: (key) => V1_BITABLE_SCHEMA.tables[key] || { fields: {}, tableId: `tbl_${key}` },
    listAll: async (key) => {
      const plan = failures[key];
      const nth = calls.filter((entry) => entry.table === key).length + 1;
      calls.push({ table: key, nth });
      if (plan === 'always') throw boom('transient');
      if (Array.isArray(plan) && plan.length >= nth) {
        const code = plan[nth - 1];
        if (code) throw boom(code === 1254607 ? 'transient' : 'forbidden');
      }
      return [];
    },
    get: async () => null,
  };
  return gateway;
};

const createService = ({ failures = {}, retry, sleep } = {}) => {
  const dir = tempDir();
  const gateway = createFakeGateway(failures);
  const service = new SalesFollowupService({
    gateway,
    orderReadRetry: retry || resolveOrderReadRetryConfig({}),
    sleep: sleep || (() => Promise.resolve()), // ⚠️ 不等真时间（本机降速会 flake ✗）
    samplePending: { listPending: async () => [] },
    store: { dir, idField: 'task_id' },
  });
  return { service, gateway, calls: gateway.calls, cleanup: () => rmDir(dir) };
};

const countOf = (calls, table) => calls.filter((entry) => entry.table === table).length;
const retryLogs = () => logs.filter((entry) => entry.event === 'workbench.sales.orders.read_retry');

// ═══════════════════════════════════════════════════════════════════════════
// AC-W1 第一次瞬时错、第二次成功 ⇒ 照旧拿到完整订单（+ 一条"重试命中"日志）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-W1 ⭐ 第一次 `1254607`、第二次成功 ⇒ **她的请求拿到完整订单**（+ 日志里一条重试命中）', async () => {
  logs.length = 0;
  const h = createService({ failures: { product: [1254607] } });
  try {
    const result = await h.service.listOrders();
    assert.ok(result && Array.isArray(result.orders), '照旧返回 `{orders: [...]}`（形状一个字没变 ✓）');
    assert.equal(countOf(h.calls, 'product'), 2, '表 product 读了**两次**（1 次失败 + 1 次成功重试）✓');
    assert.equal(countOf(h.calls, 'salesEntry'), 1, '其它表**不受影响**（各读一次 ✓）');
    const hit = retryLogs();
    assert.equal(hit.length, 1, `命中重试要**如实记一条**（实际 ${hit.length}）`);
    assert.equal(hit[0].fields.table_key, 'product', '日志要写清**哪张表** ✓');
    assert.equal(hit[0].fields.reason, 'read_retry', '理由码与扫码页那条同一口径 ✓');
    assert.equal(hit[0].fields.attempt, 1, '写清第几次尝试 ✓');
    assert.equal(hit[0].fields.of, 2, '写清一共几次（默认 1 重试 ⇒ 2 次尝试）✓');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-W2 不可重试的错误（403）⇒ **不重试**，直接抛（路由仍 502）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-W2 🔴 `403` 这类确定性错误 ⇒ **一次都不重试**（直接抛；不白等、不糊弄）', async () => {
  logs.length = 0;
  const h = createService({ failures: { product: 'always' }, retry: { maxRetries: 3, delayMs: 0 } });
  // 'always' 抛的是瞬时错 ⇒ 这条要先验"不可重试"的判据，所以换成 403：
  const h403 = createService({ failures: { product: [403] }, retry: { maxRetries: 3, delayMs: 0 } });
  try {
    await assert.rejects(() => h403.service.listOrders(), /forbidden/);
    assert.equal(countOf(h403.calls, 'product'), 1, '确定性错误**只读一次**（一次都不重试 ✗）');
    assert.equal(retryLogs().length, 0, '**不许**为它记"重试命中"（它根本没重试 ✓）');
  } finally { h.cleanup(); h403.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-W3 重试用完仍失败 ⇒ 仍然抛（路由照旧 502 + `workbench.sales.orders.failed`）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-W3 🔴 重试用完**仍失败** ⇒ 抛原错（**绝不把失败吞成成功** ✗）', async () => {
  logs.length = 0;
  const h = createService({ failures: { product: 'always' }, retry: { maxRetries: 1, delayMs: 0 } });
  try {
    await assert.rejects(() => h.service.listOrders(), /Data not ready/);
    assert.equal(countOf(h.calls, 'product'), 2, '默认配置 = 1 次重试 ⇒ 共 2 次尝试 ✓');
    assert.equal(retryLogs().length, 1, '命中那一次照实记 ✓（用完仍失败 ⇒ 由调用方落 502）');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-W4 次数/退避**来自配置**（注入不同 config ⇒ 行为跟着变）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-W4 ⭐ 次数/退避**可配**：`maxRetries=0` ⇒ 不重试；`=2` ⇒ 三次尝试（不写死 ✗）', async () => {
  logs.length = 0;
  const off = createService({ failures: { product: 'always' }, retry: { maxRetries: 0, delayMs: 0 } });
  const two = createService({ failures: { product: 'always' }, retry: { maxRetries: 2, delayMs: 0 } });
  try {
    await assert.rejects(() => off.service.listOrders());
    assert.equal(countOf(off.calls, 'product'), 1, 'maxRetries=0 ⇒ **一次都不重试** ✓');
    await assert.rejects(() => two.service.listOrders());
    assert.equal(countOf(two.calls, 'product'), 3, 'maxRetries=2 ⇒ 共 3 次尝试 ✓');
    const hit = retryLogs();
    // ⚠️ 事实（我第一版算错过）：`maxRetries=0` 那条**一次都没重试** ⇒ 0 条日志；
    //    `maxRetries=2` 那条命中 2 次 ⇒ 2 条 ⇒ 合计 2 条 ✓（不是 3）
    assert.equal(hit.length, 2, '每次命中各一条（0 次那条没有 + 2 次那条有 2 条 ⇒ 共 2 条）✓');
    assert.deepEqual(hit.map((entry) => entry.fields.attempt), [1, 2], 'attempt 逐次递增 ✓');
  } finally { off.cleanup(); two.cleanup(); }
});

test('AC-W4b ⭐ 退避**可配**：注入的 sleep 收到的正是配置算出来的线性退避（300 * (attempt+1)）', async () => {
  logs.length = 0;
  const slept = [];
  const h = createService({
    failures: { product: 'always' }, retry: { maxRetries: 2, delayMs: 300 },
    sleep: async (ms) => { slept.push(ms); },
  });
  try {
    await assert.rejects(() => h.service.listOrders());
    assert.deepEqual(slept, [300, 600], '线性退避 = delayMs * (attempt + 1) ⇒ 300 / 600 ✓');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-W5（路由那一层）：200 / 502 的**对外口径**没变
// ═══════════════════════════════════════════════════════════════════════════

const cookieOf = (openId) => {
  const payload = Buffer.from(JSON.stringify({ open_id: openId, name: 't', exp: Date.now() + 36e5 })).toString('base64url');
  return `workbench_session=${payload}.${crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
};

const withRoute = async (service, run) => {
  const express = require('express');
  // eslint-disable-next-line global-require
  const { createWorkbenchRouter } = require('../src/routes/workbench');
  const router = createWorkbenchRouter({
    gateway: service.gateway,
    followup: service,
    ordersCache: { get: () => undefined, set: () => {}, invalidate: () => {} },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/workbench', router);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base);
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
};

const getOrders = (base) => fetch(`${base}/api/workbench/sales/orders`, {
  headers: { cookie: cookieOf(OPEN_ID) },
});

test('AC-W5 ⭐ 路由对外口径不变：瞬时错被重试掉 ⇒ **200 + 完整订单**；重试用完仍失败 ⇒ **502 + 如实落 failed**', async () => {
  logs.length = 0;
  const ok = createService({ failures: { product: [1254607] } });
  try {
    await withRoute(ok.service, async (base) => {
      const response = await getOrders(base);
      assert.equal(response.status, 200, '瞬时错被重试掉 ⇒ 她的请求拿到 **200** ✓（不再是红色 502 ✗）');
      const body = await response.json();
      assert.equal(body.success, true);
      assert.ok(Array.isArray(body.orders), '订单形状照旧（页面一个字不用改 ✓）');
    });
  } finally { ok.cleanup(); }

  logs.length = 0;
  const bad = createService({ failures: { product: 'always' }, retry: { maxRetries: 1, delayMs: 0 } });
  try {
    await withRoute(bad.service, async (base) => {
      const response = await getOrders(base);
      assert.equal(response.status, 502, '重试用完仍失败 ⇒ 仍然 **502**（**不假成功** ✗）');
      const failed = logs.filter((entry) => entry.event === 'workbench.sales.orders.failed');
      assert.equal(failed.length, 1, '照旧落 `workbench.sales.orders.failed` ✓');
      assert.ok(!logs.some((entry) => entry.event === 'workbench.sales.orders.ok'), '不许有任何"成功"日志 ✗');
    });
  } finally { bad.cleanup(); }
});
