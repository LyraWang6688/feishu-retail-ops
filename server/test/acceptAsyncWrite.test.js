'use strict';

require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）

/**
 * ⭐⭐ task-56：**验收（工作台入口）也接异步** —— 先回成功页 ＋ 后台那一跑写库。
 *
 * 业务负责人口径（逐字）：
 *   · 弹窗选定：**「B：工作台那半也接异步」**（她问的是"验收也接异步吗"）；
 *   · 2026-10-16 当天：「**补货、退货还有验收，它都是异步的**……**用户提交之后都是一个成功页**，
 *     说'已提交成功，数据会更新'类似这类的话就行了。**都是一个异步的提醒**」；
 *   · 「**异步只针对"写库"**；**校验必须当场同步拦**」。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 本文件钉的 AC（**测试名 = AC** · 每条都"能真红"）：
 *
 *  **AC-AA1** ⭐⭐ 先回成功页 ＋ 统一那一句
 *      · 后台那一跑**还卡着**（gate 未放）时，HTTP 回执就必须已经回来（⇒ 改回同步 ⇒ 红 ✓）；
 *      · 成功页正文 = **统一那一句**（`SCAN_PAGE.saleSuccess.message` —— 四条链路**一处定义** ✓）；
 *      · ⛔ **不许**回「已确认到货」那种"还没写就说到货"的话（那一刻后台还没写 ✗）；
 *      · 放行后：后台那一跑**确实进了既有写入口**（`scanArrivalService.finish`）✓。
 *
 *  **AC-AA2** 🔴 校验**留同步路径**：拦住 ＋ 人话 ＋ **零业务写入** ＋ **一次后台都不排**
 *      九种坏输入（没批次号 / 明细读不出 / 空单 / 货号认不出 / 尺码数量非法 / 不在本批 /
 *      金额没填 / 金额不是数字 / 读不到明细的批次）逐条：400（或 503）＋ 写层那句人话 ＋
 *      等完后台 ⇒ `finish` **一次都没进**（= 没排后台、更没写库 ✓）。
 *      ＋ **真链**一条：金额没填 ⇒ 假网关**一个字节都没写**。
 *
 *  **AC-AA3** 🔴 后台失败 ⇒ **绝不假装成功**
 *      · 她那一屏照旧是先回的成功页（异步的代价，如实写在注释里 ✓）；
 *      · 但失败**不被吞**：共用件记一条 warn（事件名走既有配置 ✓）＋ `markFailed` 把原因
 *        落回会话 `last_error`（**可查、可重试** ✓）。
 *
 *  **AC-AA4** 🔴 源码反向哨兵（"先回成功页"被改回同步 ⇒ 红）
 *      · 校验（start / addScan / 金额 / 空单）**都在** `schedulePurchaseRest(...)` **之前**；
 *      · 成功响应**在**排后台**之后**；
 *      · handler 里**不许**再出现 `await arrivalService.finish(`（写库只能活在 `runRest` 里 ✗）；
 *      · 复用**既有共用件** `createPurchaseWriteBackgroundService`（不另造第二个后台件 ✗）；
 *      · `submitKey` **原样透传**（不拼、不加后缀 ✗ —— 幂等的第一层就在它上面 ✓）。
 *
 *  **AC-AA5** ⭐⭐ 幂等**三层都在** ＋ **重复 / 并发点两次 ⇒ 库存只加一次**（当年那条 P0）
 *      真链（工作台路由 → `scanArrivalService` → `PurchaseArrivalConversationService`
 *      → **真 `PurchaseWebhookService`** → **真 `InventoryService`** → 假网关）：
 *        · L1 **会话级键**：会话已记过这把键 ⇒ `finish` 直接 `reused`，`confirmBatchArrival` **零调用**；
 *        · L2 **批次任务闸门**：同一批第二次 ⇒ `already_posted`，**再一个字节都不写**；
 *        · L3 **库存真实三元组**：`liveInventory` / `inventoryLedger` **每码恰好一行**（不是两行 ✓）。
 *      （L1/L2/L3 的实现位置在 `scanArrivalService.finish` / `purchaseArrivalConversationService`
 *        的 `queue.run` ＋ 锁内再查 / `inventoryService` 的 `purchaseIncreaseSourceId` —— **本刀一行未改** ✓）
 *
 * ⚠️ 口径与实现都**只取既有那一份**：成功页文案（`config/scanPage.js`）、
 *    后台件（`services/purchaseWriteBackgroundService.js`）、金额规则（`parseActualAmount`）、
 *    人话（`config/scanWrite.js` / `config/purchaseArrivalTexts.js`）—— 本文件**不抄第二份** ✗。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// ⚠️ 先挂日志替身，**再** require 业务模块 —— 那些模块在 require 期就把 `logWarn` 解构走了
//    （见 `services/purchaseWriteBackgroundService.js`）⇒ 顺序反了就捕获不到那条 warn ✓。
const logger = require('../src/utils/logger');
const logs = [];
const ORIGINAL_LOGGER = { logInfo: logger.logInfo, logWarn: logger.logWarn, logError: logger.logError };
logger.logInfo = (event, fields) => { logs.push({ level: 'info', event, fields }); };
logger.logWarn = (event, fields) => { logs.push({ level: 'warn', event, fields }); };
logger.logError = (event, fields) => { logs.push({ level: 'error', event, fields }); };
test.after(() => { Object.assign(logger, ORIGINAL_LOGGER); });

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_accept_async_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'accept_async_test_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { pageMessages } = require('../src/config/purchaseArrivalTexts');
const arrivalTab = require('../src/config/workbenchArrival');
const { createWorkbenchRouter } = require('../src/routes/workbench');
const { createScanArrivalService } = require('../src/services/scanArrivalService');
const { PurchaseArrivalConversationService } = require('../src/services/purchaseArrivalConversationService');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const { InventoryService } = require('../src/services/inventoryService');
const { createPurchaseQueryService } = require('../src/services/purchaseQueryService');
const { SizeReferenceService } = require('../src/services/sizeReferenceService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { waitForPendingPurchaseBackgrounds } = require('../src/services/purchaseWriteBackgroundService');

const SERVER_DIR = path.join(__dirname, '..');
/** 统一那一句（**唯一真源** = `config/scanPage.js` 的 `SCAN_PAGE.saleSuccess` ✓ 不抄字面量 ✗）。 */
const UNIFIED = SCAN_PAGE.saleSuccess.message;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ── 工作台身份闸门（与 `workbenchAcceptanceFull.test.js` 同一套做法）──────────────────
const SESSION_SECRET = 'workbench_accept_async_test_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};
const OPEN_ID = 'ou_accept_async';
const COOKIE = (() => {
  const payload = Buffer.from(JSON.stringify({
    open_id: OPEN_ID, name: 'T', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  return `workbench_session=${payload}.${crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')}`;
})();

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const i = app.listen(0, '127.0.0.1', () => resolve(i)); });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const appFor = ({ arrival, gateway = {}, purchaseQuery = { listPurchaseRequests: async () => [] } }) => {
  const app = express();
  app.use(express.json());
  app.use('/api/workbench', createWorkbenchRouter({ gateway, purchaseQuery, arrival }));
  app.use((error, req, res, next) => res.status(500).json({ success: false, error: error.message }));
  return app;
};

const postJson = async (base, p, body) => {
  const res = await fetch(`${base}/api/workbench${p}`, {
    method: 'POST', headers: { cookie: COOKIE, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

// ═══════════════════════════════════════════════════════════════════════════
// 替身（工作台路由那一层：只钉"编排"—— 真链在 AC-AA5）
// ═══════════════════════════════════════════════════════════════════════════

const sessionOf = (over = {}) => ({
  session_id: 'sess-aa', batch_no: 'BH-1', status: 'open', submit_round: 2,
  rows: [{ product_record_id: 'p1', size: 40, quantity: 1 }],
  scans: [{ product_record_id: 'p1', size: 40, quantity: 1 }],
  posted_keys: [], last_error: '',
  ...over,
});

/** 替身验收服务：**像真会话一样**带 `scans`（真会话由 `start` 建，从来都有 ✓）。 */
const fakeArrival = ({ start, addScan, finish, session = sessionOf() } = {}) => {
  const calls = [];
  const lastErrors = [];
  return {
    calls, lastErrors,
    start: async (input) => {
      calls.push({ m: 'start', input });
      return start ? start(input) : { ok: true, session };
    },
    addScan: async (input) => {
      calls.push({ m: 'addScan', input });
      return addScan ? addScan(input) : { ok: true };
    },
    get: async () => session,
    submitKeyOf: (s) => `accept:${s?.session_id}:${Number(s?.submit_round || 0)}`,
    store: { update: async (id, patch) => { lastErrors.push({ id, patch }); return {}; } },
    finish: async (input) => {
      calls.push({ m: 'finish', input });
      return finish ? finish(input) : { ok: true, reused: false };
    },
  };
};
const finishCount = (arrival) => arrival.calls.filter((c) => c.m === 'finish').length;

const VALID_BODY = {
  batchNo: 'BH-1', actualAmount: '300',
  lines: [{ productRecordId: 'p1', size: 40, quantity: 1 }],
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-AA1：先回成功页 ＋ 统一那一句
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AA1 ⭐⭐ 先回成功页（统一那一句）—— 后台那一跑还卡着时，回执就已经回来了', async () => {
  login();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const arrival = fakeArrival({ finish: async () => { await gate; return { ok: true, reused: false }; } });
  await withServer(appFor({ arrival }), async (base) => {
    const pending = postJson(base, arrivalTab.api.accept, VALID_BODY);
    // ⚠️ 1.5 秒上限：改回同步 ⇒ 这一跑被 gate 卡住 ⇒ 这里必然 'TIMEOUT' ⇒ **红** ✓
    //    （用 race 而不是"直接 await"，是为了让变异真红时**不把用例挂死** ✓）
    let raced;
    try {
      raced = await Promise.race([pending, sleep(1500).then(() => 'TIMEOUT')]);
      assert.notEqual(raced, 'TIMEOUT',
        '🔴 后台那一跑还卡着，成功页就必须已经回来了（改回同步 ⇒ 这里红 ✗）');
      assert.equal(raced.status, 200, '合法提交 ⇒ 200（先回她 ✓）');
      assert.equal(raced.body.success, true);
      assert.equal(raced.body.message, UNIFIED, '成功页正文 = 统一那一句（唯一真源 ✓）');
      assert.equal(raced.body.accepted, true, '收下了（不是"已入库"✗）');
      assert.equal('notice' in raced.body, false,
        '⛔ 不许再回「已确认到货」那种话（那一刻后台还没写 ⇒ 假成功 ✗）');
      // 后台那一跑**确实已经排下去**（不是"根本没调"✗）
      assert.equal(finishCount(arrival), 1, '后台那一跑已经进了既有写入口 ✓');
    } finally {
      release();
      await pending.catch(() => undefined);
      await waitForPendingPurchaseBackgrounds();
    }
    assert.equal(finishCount(arrival), 1, '跑完仍然只一次 ✓');
    // 统一那一句的**唯一真源**：配置里指向 `SCAN_PAGE.saleSuccess`，路由里不新造字面量 ✗
    assert.equal(arrivalTab.texts.submitted, UNIFIED, '配置里的成功页 = 同一个真源 ✓');
    const route = fs.readFileSync(path.join(SERVER_DIR, 'src', 'routes', 'workbench.js'), 'utf8');
    // ⚠️ 先剥注释再判（注释里当然会引用她原话，那是给人看的 ✓ 不算"抄一份文案" ✗）
    const routeCode = route
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((line) => !/^\s*(\*|\/\/)/.test(line)).join('\n')
      .replace(/\/\/[^\n]*/g, '');
    assert.equal(routeCode.includes(UNIFIED), false,
      '🔴 路由**代码**里不许出现那句话的字面量（文案的家在 config ✓ 抄一份必漂 ✗）');
    assert.ok(routeCode.includes('arrivalTab.texts.submitted'), '成功页文案走配置 ✓');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AA2：校验【同步拦】＋ 零写入 ＋ 不排后台
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AA2 🔴 九种坏输入 ⇒ 当场拦（400/503 ＋ 人话 ＋ 零写入 ＋ **一次后台都不排**）', async () => {
  login();
  const notInBatch = '扫到的这一双不在本批，不能验收：请核对标签再扫。';
  const cases = [
    { why: '没批次号', body: { ...VALID_BODY, batchNo: '' }, error: arrivalTab.texts.batchMissing },
    {
      why: '这一批的采购明细读不到（start 拒）',
      body: VALID_BODY,
      arrival: fakeArrival({ start: () => ({ ok: false, reason: 'no_request_rows', message: '这一批没有采购明细' }) }),
      error: '这一批没有采购明细',
    },
    {
      why: '写入口没接上（not_wired ⇒ 503）',
      body: VALID_BODY,
      status: 503,
      arrival: fakeArrival({ start: () => ({ ok: false, reason: 'not_wired', message: '这一批的采购明细没读到，请稍后再试' }) }),
      error: '这一批的采购明细没读到，请稍后再试',
    },
    {
      why: '货号认不出',
      body: { ...VALID_BODY, lines: [{ itemNo: 'NOT-IN-REQUEST', size: 40, quantity: 1 }] },
      error: arrivalTab.texts.itemNoUnresolved,
    },
    {
      why: '尺码不是数字 / 数量不是正数',
      body: { ...VALID_BODY, lines: [{ productRecordId: 'p1', size: 'abc', quantity: 0 }] },
      error: arrivalTab.texts.sizeInvalid,
    },
    {
      why: '这一双不在本批（addScan 拒）',
      body: VALID_BODY,
      arrival: fakeArrival({ addScan: () => ({ ok: false, message: notInBatch }) }),
      error: notInBatch,
    },
    {
      why: '空单（一行都没有）',
      body: { ...VALID_BODY, lines: [] },
      // ⚠️ 空单的判据在**会话**上（写层 `finish` 也是这么判的 ✓）⇒ 替身会话必须真的"一双都没扫"
      arrival: fakeArrival({ session: sessionOf({ scans: [] }) }),
      error: SCAN_WRITE.texts.acceptNoScansBody,
    },
    {
      why: '金额没填',
      body: { ...VALID_BODY, actualAmount: '' },
      error: pageMessages.m2,
    },
    {
      why: '金额不是数字',
      body: { ...VALID_BODY, actualAmount: 'abc' },
      error: pageMessages.m3,
    },
  ];
  for (const c of cases) {
    const arrival = c.arrival || fakeArrival();
    await withServer(appFor({ arrival }), async (base) => {
      const res = await postJson(base, arrivalTab.api.accept, c.body);
      assert.equal(res.status, c.status || 400, `${c.why} ⇒ **当场** ${c.status || 400}（不是成功页 ✗）`);
      assert.equal(res.body.success, false, `${c.why} ⇒ 如实说不成功 ✗`);
      assert.equal(res.body.error, c.error, `${c.why} ⇒ 那句人话来自既有配置 ✓`);
      // 🔴 关键：**一次后台都没排**（排了的话 finish 在排下那一下就进了 ✓ 确定性可判）
      assert.equal(finishCount(arrival), 0, `${c.why} ⇒ **一次后台都不排**（更没写库 ✓）`);
      await waitForPendingPurchaseBackgrounds();
      assert.equal(finishCount(arrival), 0, `${c.why} ⇒ 等完后台仍旧零写入 ✓`);
    });
  }
});

test('AC-AA2b ⭐ 真链上再证一次：金额没填 ⇒ 假网关**一个字节都没写**', async () => {
  login();
  const chain = makeFullChain();
  await withServer(appFor({ arrival: chain.arrival, gateway: chain.gateway, purchaseQuery: chain.purchaseQuery }), async (base) => {
    const res = await postJson(base, arrivalTab.api.accept, {
      batchNo: chain.batchNo, lines: [{ productRecordId: chain.productId, size: chain.sizes[0], quantity: 1 }],
    });
    assert.equal(res.status, 400, '金额没填 ⇒ 当场 400 ✓');
    assert.equal(res.body.error, pageMessages.m2, '人话 = 既有配置那一句 ✓');
    await waitForPendingPurchaseBackgrounds();
    assert.deepEqual(chain.writes, [], '🔴 零业务写入（不是"看起来没写"✓—— 假网关记下了每一次写）');
    assert.equal(chain.data.liveInventory.length, 0, '库存一行都没动 ✓');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AA3：后台失败 ⇒ 绝不假装成功
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AA3 🔴 后台失败（返回 ok:false / 抛异常）⇒ warn 留痕 ＋ `last_error` 落盘（绝不吞成成功 ✗）', async () => {
  login();
  const shapes = [
    { why: '返回 ok:false', finish: async () => ({ ok: false, message: '飞书 500' }), error: '飞书 500' },
    { why: '抛异常', finish: async () => { throw new Error('boom'); }, error: 'boom' },
  ];
  for (const s of shapes) {
    logs.length = 0;
    const arrival = fakeArrival({ finish: s.finish });
    await withServer(appFor({ arrival }), async (base) => {
      const res = await postJson(base, arrivalTab.api.accept, VALID_BODY);
      // ① 她已经拿到成功页（异步的代价，如实：那一页只承诺"系统已收到"✓）
      assert.equal(res.status, 200, `${s.why}：她那一屏照旧是先回的成功页 ✓`);
      assert.equal(res.body.message, UNIFIED, `${s.why}：仍然是统一那一句 ✓`);
      await waitForPendingPurchaseBackgrounds();
      // ② 🔴 失败**没被吞**：`markFailed` 把原因落回会话（可查、可重试 ✓）
      assert.equal(arrival.lastErrors.length, 1, `${s.why} ⇒ markFailed 被调用一次 ✓`);
      assert.equal(arrival.lastErrors[0].patch.last_error, s.error, `${s.why} ⇒ 原因落进 last_error ✓`);
      // ③ 共用件那条 warn（事件名走既有配置 ⇒ 她按它 grep 得到 ✓）
      const warned = logs.find((l) => l.level === 'warn' && l.event === SCAN_WRITE.events.purchaseBackgroundFailed);
      assert.ok(warned, `${s.why} ⇒ 记了 ${SCAN_WRITE.events.purchaseBackgroundFailed} 这条 warn ✓`);
      assert.equal(warned.fields.chain, 'accept', 'warn 里认得出是**验收**那条链路 ✓');
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AA4：源码反向哨兵
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AA4 🔴 源码哨兵：校验在排后台之前 · 成功响应在排后台之后 · handler 里不许出现 await finish', () => {
  const raw = fs.readFileSync(path.join(SERVER_DIR, 'src', 'routes', 'workbench.js'), 'utf8');
  // ① handler 那一段（从 `router.post(arrivalTab.api.accept` 到挂载下一个 router 为止）
  const start = raw.indexOf('router.post(arrivalTab.api.accept');
  const end = raw.indexOf("router.use('/purchase', createPurchaseQueryRouter", start);
  assert.ok(start > 0 && end > start, '拿得到验收 handler 那一段 ✓');
  const handler = raw.slice(start, end);
  const code = handler
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((line) => !/^\s*(\*|\/\/)/.test(line)).join('\n')
    .replace(/\/\/[^\n]*/g, '');
  // ② 写库那一步**必须在后台件里**（handler 里不许直接 await finish ✗）
  assert.equal(code.includes('await arrivalService.finish('), false,
    '🔴 handler 里不许再 `await arrivalService.finish(...)`（那正是"改回同步"⇒ 红 ✓）');
  assert.ok(code.includes('schedulePurchaseRest('), 'handler 必须把写库排给后台那一跑 ✓');
  // ③ 顺序：校验 ⇒ 排后台 ⇒ 成功响应（顺序反了就是"先排后台再校验"= 把填错变成看起来成功 ✗）
  const atStart = code.indexOf('arrivalService.start(');
  const atSchedule = code.indexOf('schedulePurchaseRest(');
  const atSuccess = code.indexOf('return res.json(');
  assert.ok(atStart > 0 && atSchedule > atStart, '校验（start/addScan/金额）都在排后台**之前** ✓');
  assert.ok(atSuccess > atSchedule, '成功响应在排后台**之后** ✓');
  // ④ 复用**既有**共用件（不另造第二个后台件 ✗）
  assert.ok(raw.includes("require('../services/purchaseWriteBackgroundService')"),
    '🔴 必须 require 既有共用件 `createPurchaseWriteBackgroundService`（#664 ✓）');
  assert.ok(raw.includes('createPurchaseWriteBackgroundService('), '并且真的用它建后台那一跑 ✓');
  const bgFiles = fs.readdirSync(path.join(SERVER_DIR, 'src', 'services'))
    .filter((name) => /BackgroundService\.js$/.test(name));
  assert.deepEqual(bgFiles.sort(), ['purchaseWriteBackgroundService.js', 'saleWriteBackgroundService.js'],
    '🔴 不许为验收另造第三个"后台件"（全仓只该有这两件 ✓）');
  // ⑤ `submitKey` 原样透传：不许拼、不许加后缀（幂等第一层就在这把键上 ✓）
  const slice = raw.slice(raw.indexOf('const acceptBackground'), end);
  assert.equal(/submitKey\s*[:=]\s*[`'"][^`'"]*\$\{/.test(slice), false,
    '🔴 不许对 submitKey 做字符串拼接（一旦拼了 = 幂等第一层失效 ✗）');
  assert.ok(slice.includes('arrivalService.submitKeyOf(session)'),
    '键仍由**服务自己**算（不取表单里的键 ✗）✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AA5：真链 · 幂等三层都在 ＋ 重复/并发点两次 ⇒ 库存只加一次（P0）
// ═══════════════════════════════════════════════════════════════════════════

const F = (tableKey) => V1_BITABLE_SCHEMA.tables[tableKey].fields;
const SIZES = [40, 41];
const PRODUCT = 'prod_1';

/**
 * 真链装配：工作台路由 ⇒ 真 `scanArrivalService` ⇒ 真 `PurchaseArrivalConversationService`
 *   ⇒ 真 `PurchaseWebhookService` ⇒ **真 `InventoryService`** ⇒ 假网关（每一次写都被记下 ✓）。
 * ⚠️ 与生产同一条路：`routes/workbench.js` 里 `scanArrivalService` 没注入会话服务时，
 *    它自己构造的就是 `PurchaseArrivalConversationService` + `PurchaseWebhookService` ✓。
 */
const makeFullChain = () => {
  const writes = [];
  const data = {
    purchaseOrderBatch: [], purchaseRequest: [], product: [], sizeManagement: [], behavior: [],
    liveInventory: [], inventoryLedger: [],
  };
  // ⭐ 并发那一跑的**确定性**闸门：第一跑的"写流水"卡在这里 ⇒ 保证第二跑已经排进 `queue.run`
  //   ⇒ 放行后第二跑必须由 **L2 的锁内再查**拦住（`already_posted`、零重复写 ✓ 不靠计时器赌 ✓）。
  let gateEnteredResolve;
  const gateEntered = new Promise((resolve) => { gateEnteredResolve = resolve; });
  let releaseGate;
  const gatePromise = new Promise((resolve) => { releaseGate = resolve; });
  const gate = { enabled: false, enteredOnce: false, entered: gateEntered, release: releaseGate };
  const physical = (tableKey, values) => {
    const map = F(tableKey);
    const out = {};
    for (const [key, value] of Object.entries(values || {})) out[map[key] || key] = value;
    return out;
  };
  const push = (tableKey, values) => {
    const recordId = `rec_${tableKey}_${(data[tableKey] || []).length + 1}`;
    (data[tableKey] ||= []).push({ record_id: recordId, fields: physical(tableKey, values) });
    return recordId;
  };
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => data[key] || [],
    listByFilter: async (key) => data[key] || [],
    get: async (key, id) => (data[key] || []).find((record) => record.record_id === id) || null,
    create: async (key, values) => { writes.push({ op: 'create', key, values }); return { recordId: push(key, values) }; },
    createBatch: async (key, rows) => {
      if (gate.enabled && key === 'inventoryLedger' && !gate.enteredOnce) {
        gate.enteredOnce = true;
        gateEnteredResolve();
        await gatePromise;
      }
      writes.push({ op: 'createBatch', key, values: rows });
      return (rows || []).map((values) => ({ recordId: push(key, values), fields: values }));
    },
    update: async (key, recordId, values) => {
      writes.push({ op: 'update', key, recordId, values });
      const patch = physical(key, values);
      const row = (data[key] || []).find((record) => record.record_id === recordId);
      if (row) row.fields = { ...row.fields, ...patch };
      return { recordId };
    },
    updateBatch: async (key, patches) => {
      writes.push({ op: 'updateBatch', key, values: patches });
      return (patches || []).map((patch) => ({ recordId: patch.recordId, fields: patch.fields || {} }));
    },
    delete: async () => { throw new Error('本用例不该删记录'); },
  };
  const batchOf = (batchNo) => {
    const recordId = `batch_${batchNo}`;
    data.purchaseOrderBatch.push({
      record_id: recordId,
      fields: { [F('purchaseOrderBatch').batchNo]: batchNo, [F('purchaseOrderBatch').arrivalStatus]: '未到货' },
    });
    for (const size of SIZES) {
      data.purchaseRequest.push({
        record_id: `pr_${batchNo}_${size}`,
        fields: {
          [F('purchaseRequest').batchNo]: [recordId],
          [F('purchaseRequest').product]: [PRODUCT],
          [F('purchaseRequest').size]: [`size_${size}`],
          [F('purchaseRequest').quantity]: 1,
        },
      });
    }
    return recordId;
  };
  const batchA = 'CGD-AA-0001';
  const batchB = 'CGD-AA-0002';
  batchOf(batchA);
  batchOf(batchB);
  data.product.push({
    record_id: PRODUCT,
    fields: { [F('product').itemNo]: 'YD6693-2', [F('product').color]: '黑色' },
  });
  SIZES.forEach((size) => {
    data.sizeManagement.push({
      record_id: `size_${size}`, fields: { [F('sizeManagement').size]: size },
    });
  });
  data.behavior.push({
    record_id: 'beh_in',
    fields: {
      [F('behavior').code]: 'STOCK_PURCHASE_INCREASE',
      [F('behavior').name]: '采购入库',
      [F('behavior').stockDirection]: '增加',
      [F('behavior').enabled]: true,
    },
  });

  const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `accept-async-${label}-`));
  const sessionStore = new JsonTaskStore({ dir: tmp('session'), idField: 'session_id' });
  const taskStore = new JsonTaskStore({ dir: tmp('task'), idField: 'task_id' });
  const inventory = new InventoryService({
    gateway, store: new JsonTaskStore({ dir: tmp('inventory'), idField: 'operation_id' }),
  });
  const webhooks = new PurchaseWebhookService({
    gateway,
    store: taskStore,
    inventory,
    references: {
      resolveProduct: async () => ({ recordId: PRODUCT, record: data.product[0] }),
      resolveSupplier: async () => ({ recordId: 'sup_1', record: null }),
    },
    client: {
      im: {
        image: { create: async () => ({ image_key: 'img' }) },
        message: { create: async () => ({ code: 0 }), reply: async () => ({ code: 0 }) },
      },
    },
    images: { render: async () => Buffer.from('fake') },
  });
  const conversation = new PurchaseArrivalConversationService({
    gateway,
    store: taskStore,
    sizeReferences: () => new SizeReferenceService({ gateway }),
    confirmArrival: (taskId, task, operatorOpenId, options) => webhooks.confirmArrival(taskId, task, operatorOpenId, options),
    markBatchArrived: (batchNo, arrivalOptions) => webhooks.orderBatches.markArrived(batchNo, arrivalOptions),
  });
  const conversationCalls = [];
  const realConfirmBatchArrival = conversation.confirmBatchArrival.bind(conversation);
  conversation.confirmBatchArrival = async (input) => {
    const result = await realConfirmBatchArrival(input);
    conversationCalls.push({ input, result });
    return result;
  };
  const purchaseQuery = createPurchaseQueryService(gateway, { tableCacheTtlMs: 0 });
  const arrival = createScanArrivalService({
    gateway,
    config: SCAN_WRITE.acceptance,
    texts: SCAN_WRITE.texts,
    events: SCAN_WRITE.events,
    store: sessionStore,
    purchaseQuery,
    arrivalConversation: conversation,
    pendingBatches: { invalidate() {} },
  });
  const finishResults = [];
  const realFinish = arrival.finish;
  arrival.finish = async (input) => {
    const result = await realFinish(input);
    finishResults.push(result);
    return result;
  };
  const bodyFor = (batchNo) => ({
    batchNo, actualAmount: '12800',
    lines: SIZES.map((size) => ({ productRecordId: PRODUCT, size, quantity: 1 })),
  });
  return {
    gateway, writes, data, arrival, conversation, conversationCalls, finishResults, taskStore,
    inventory, batchNo: batchA, batchB, productId: PRODUCT, sizes: SIZES,
    purchaseQuery, bodyFor, gate,
  };
};

test('AC-AA5-L1 ⭐ 幂等第一层（会话级键）：这把键用过了 ⇒ `finish` 直接 reused，会话服务**零调用**', async () => {
  login();
  const chain = makeFullChain();
  await withServer(appFor({ arrival: chain.arrival, gateway: chain.gateway, purchaseQuery: chain.purchaseQuery }), async (base) => {
    // 先把会话开出来，并把"这把键已经用掉"直接落到会话上（= 真机里"上一跑刚写完、标记也落了"那一态 ✓）
    await chain.arrival.start({ openId: OPEN_ID, batchNo: chain.batchNo, operatorOpenId: OPEN_ID });
    const session = await chain.arrival.get(OPEN_ID);
    const key = chain.arrival.submitKeyOf(session);
    await chain.arrival.store.update(session.session_id, { posted_keys: [key] });
    const writesBefore = chain.writes.length;
    const res = await postJson(base, arrivalTab.api.accept, chain.bodyFor(chain.batchNo));
    assert.equal(res.status, 200, '已经提交过 ⇒ 仍然是成功页（她看到的一致 ✓）');
    assert.equal(res.body.message, UNIFIED);
    await waitForPendingPurchaseBackgrounds();
    assert.equal(chain.finishResults.at(-1)?.reused, true, '🔴 第一层拦住：finish 直接 reused ✓');
    assert.equal(chain.conversationCalls.length, 0, '🔴 会话服务**一次都没进**（零写入 ✓）');
    assert.equal(chain.writes.length, writesBefore, '🔴 一个字节都没写 ✓');
  });
});

test('AC-AA5-L2L3 ⭐⭐ 真链：串行 + 并发各点两次 ⇒ 库存只加一次（当年那条 P0）', async () => {
  login();
  const chain = makeFullChain();
  const liveRows = () => chain.data.liveInventory.length;
  const ledgerRows = () => chain.data.inventoryLedger.length;
  await withServer(appFor({ arrival: chain.arrival, gateway: chain.gateway, purchaseQuery: chain.purchaseQuery }), async (base) => {
    // ── ① 串行点两次（同一批 A）────────────────────────────────────────────
    const first = await postJson(base, arrivalTab.api.accept, chain.bodyFor(chain.batchNo));
    const second = await postJson(base, arrivalTab.api.accept, chain.bodyFor(chain.batchNo));
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.body.message, UNIFIED, '成功页 = 统一那一句 ✓');
    assert.equal(second.body.message, UNIFIED, '第二跑也是那一句（她看到的一致 ✓）');
    await waitForPendingPurchaseBackgrounds();
    assert.equal(liveRows(), SIZES.length,
      `🔴 库存只加一次：两个尺码各一行（实际 ${liveRows()}，应为 ${SIZES.length}）`);
    assert.equal(ledgerRows(), SIZES.length, `🔴 流水也只有那几条（实际 ${ledgerRows()}）`);
    assert.equal(chain.conversationCalls.length, 2, '两跑都真的排了后台那一跑 ✓（幂等由写层保证 ✓）');
    // 每条（货品+尺码）只有一行（不是"两行各一次"✗）
    const pairKey = (record) => `${String(record.fields[F('liveInventory').product])}|${String(record.fields[F('liveInventory').size])}`;
    assert.equal(new Set(chain.data.liveInventory.map(pairKey)).size, liveRows(),
      '🔴 同一（货品+尺码）不许出现两行 ✓');
    // ── ② 已经入过库之后她再点两次 ⇒ 零写入（L2 的外层闸门）──────────────────
    const writesAfterFirst = chain.writes.length;
    await postJson(base, arrivalTab.api.accept, chain.bodyFor(chain.batchNo));
    await postJson(base, arrivalTab.api.accept, chain.bodyFor(chain.batchNo));
    await waitForPendingPurchaseBackgrounds();
    assert.equal(chain.writes.length, writesAfterFirst, '🔴 已入过库 ⇒ 再点也不写（一个字节都不写 ✓）');
    assert.equal(liveRows(), SIZES.length, '库存仍然是那两行 ✓');
    // ── ③ 并发点两次（**新的一批 B** ⇒ 外面的顺序检查会**双双通过**）──────────
    //    🔴 用闸门把第一跑卡在"写流水"那一步 ⇒ 第二跑**必然**已经排进 `queue.run`
    //      ⇒ 放行后只能由 **L2 的锁内再查**拦住（不靠计时器赌 ✓ 能真红 ✓）
    chain.gate.enabled = true;
    const [a, b] = await Promise.all([
      postJson(base, arrivalTab.api.accept, chain.bodyFor(chain.batchB)),
      postJson(base, arrivalTab.api.accept, chain.bodyFor(chain.batchB)),
    ]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    await chain.gate.entered;
    await sleep(80);              // 给第二跑足够时间排进 `queue.run`（第一跑正卡着 ✓）
    chain.gate.release();
    await waitForPendingPurchaseBackgrounds();
    assert.equal(liveRows(), SIZES.length * 2,
      `🔴 并发点两次也只加一次（实际 ${liveRows()}，应为 ${SIZES.length * 2}）`);
    assert.equal(ledgerRows(), SIZES.length * 2, `🔴 流水同理（实际 ${ledgerRows()}）`);
    // L2 证据（**锁内再查**真的拦住了第二跑）：第二跑拿到 `already_posted`，且它一个字节都没写
    const batchBResults = chain.conversationCalls
      .filter((call) => call.input?.batch?.batch_no === chain.batchB)
      .map((call) => call.result);
    assert.equal(batchBResults.length, 2, '并发两跑都进了会话服务（外层顺序检查双双通过 ✓ 这正是要防的那一态）');
    assert.equal(batchBResults[0].ok, true);
    assert.equal(batchBResults[1].ok, true);
    assert.equal(batchBResults[1].reason, 'already_posted',
      '🔴 L2 锁内再查拦住第二跑（`already_posted`）✓');
    // L3 证据：库存自己的幂等来源是**真实三元组**（批次身份 | 货品 | 尺码）—— 源码还在 ✓
    // ⚠️ 2026-10-18（task-5 · inventoryService.js 大文件拆分）**成对迁移**：
    //    `purchaseIncreaseSourceId` 原样搬到 `src/services/inventory/keys.js`（函数体逐字节未改）
    //    ⇒ 这里改读新模块，下面的正则**逐字不变**（判据没放宽）。
    const inventorySource = fs.readFileSync(path.join(SERVER_DIR, 'src', 'services', 'inventory', 'keys.js'), 'utf8');
    assert.match(inventorySource, /purchase_increase:\$\{identity\}\|\$\{input\.productRecordId\}\|\$\{normalizeSize\(input\.size\)\}/,
      '🔴 L3：加库存的来源标识仍是"真实三元组"（本刀一行未改 ✓）');
    // 每一双的「库存操作键」唯一（同一把键被写两次 = 那条 P0 的形状 ✓）
    const itemKeys = chain.data.liveInventory.map((record) => String(record.fields[F('liveInventory').operationItemKey]));
    assert.equal(new Set(itemKeys).size, itemKeys.length, '🔴 没有一条"同一双写了两行"（库存操作键唯一 ✓）');
    // L2 证据（源码）：批次任务闸门（`queue.run` ＋ 锁内再查）仍在既有会话服务里 ✓
    const conversationSource = fs.readFileSync(
      path.join(SERVER_DIR, 'src', 'services', 'purchaseArrivalConversationService.js'), 'utf8',
    );
    assert.match(conversationSource, /return this\.queue\.run\(taskId, async \(\) => \{/,
      '🔴 L2：批次任务仍走 `queue.run`（同一批串行 ✓）');
    assert.match(conversationSource, /const locked = await this\.store\.get\(taskId\)/,
      '🔴 L2：锁内**再查一次**状态（并发两跑只放一个进去 ✓）');
    // L1 证据：会话级键（`posted_keys`）仍在既有验收服务里 ✓
    const arrivalSource = fs.readFileSync(path.join(SERVER_DIR, 'src', 'services', 'scanArrivalService.js'), 'utf8');
    assert.match(arrivalSource, /posted_keys/, '🔴 L1：会话级幂等键仍在 ✓');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 冻结文件 `scanWriteService.js`（余量 0）：本刀**一个字都没碰** ✓
//    —— 判据不在这里重复造：既有 `test/scanWriteServiceFrozen.test.js` 已经用
//    **写死的 sha256 ＋ 行数基线**把"谁改一个字就红"钉住了（#700 ✓ · AC-FRZ1/2/3）。
//    ⚠️ 本文件**刻意不**用 `git diff` 那种写法：CI 的 checkout 里没有 `origin/main`
//    ⇒ 会变成一条**假红**（判据必须能在 CI 里真跑 ✓）。
// ═══════════════════════════════════════════════════════════════════════════
