'use strict';

/**
 * ⭐⭐ **AC-ASY1（硬判据 · 补货 / 退货）**：**提交 ⇒ 响应在"写库"结束【之前】就回来**（异步的唯一硬判据）。
 *
 * 业务负责人 2026-10-16 逐字：
 *   「对于我们**补货、退货还有验收，它都是异步的**……**用户提交之后都是一个成功页**……
 *     **都是一个异步的提醒**，告诉系统已经接收到用户提交的这单了」；
 *   「**异步只针对"写库"**；**校验必须当场同步拦**」。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 🔴 **为什么这条必须新写（既有 `AC-ASY1` 不覆盖这件事）** —— 如实说清，免得后人以为重复造判据 ✗：
 *   `test/purchaseAsyncAcceptance.test.js` 的 AC-ASY1 断言的是「200 ＋ **等后台跑完**后写入口进过一次」——
 *   它在**同步实现**下也**全绿**（登记簿为空 ⇒ `await` 立即返回 ⇒ 写入口已进过 ✓）
 *   ⇒ 那条是"分阶段"判据，**不能**证明"先回她" ✗（作者自己在注释里也这么写 ✓）。
 *   于是"接线被改回同步"这件事**今天没有任何判据会红** ✗ —— 本文件把它钉住 ✓：
 *   **假写服务在写库那一步【卡住不返回】** ⇒ 若响应要等它 ⇒ 必然超时 ⇒ **红** ✓。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 本文件钉的 AC：
 *   **AC-ASY-T1** ⭐⭐ 补货：写库**卡住**时，HTTP 回执**已经回来**（200 ＋ 统一那句成功页）；
 *                 放行后：写入口**恰好进过一次**（数据最终真的落库 ✓）
 *   **AC-ASY-T2** ⭐⭐ 退货：同上
 *   **AC-ASY-T3** ⭐ **探针**：闸门**真的**卡得住（放行前，写入口那一次**不可能**已经结束）
 *                 ⇒ 证明 T1/T2 不是"因为它本来就快"而侥幸绿 ✓
 *   **AC-ASY-T4** 🔴 **校验仍同步**：**写库卡住时**，坏输入（金额空）依然**当场 400** ⇒
 *                 "校验在排队之前"是**实测**，不是读源码 ✓（顺序反了 ⇒ 这条超时 ⇒ 红 ✓）
 *
 * ⚠️ 本文件**只动 test/**（`routes/**` / `views/**` / `config/**` / `services/**` 一个字不改 ✗）。
 * ⚠️ 与「成功页统一极简」那张卡（`test/successPageMinimal.test.js`）**各测各的** ✓ 不重复 ✗。
 */

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_async_timing_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'async_timing_test_secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { waitForPendingPurchaseBackgrounds } = require('../src/services/purchaseWriteBackgroundService');

const SESSION_SECRET = 'scan-async-timing-test-secret';
const NUMBER = 'YD6693-2|黑色|A';
const UNIFIED = SCAN_PAGE.saleSuccess.message;
/** 响应必须在这么久之内回来（写库那一跑卡住时 ⇒ 改回同步 ⇒ 必然超时 ⇒ 红 ✓）。 */
const RESPONSE_BUDGET_MS = 1500;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};
const sessionCookie = (openId = 'ou_async_timing') => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};
const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const i = app.listen(0, '127.0.0.1', () => resolve(i)); });
  server.keepAliveTimeout = 1;
  try { return await run(`http://127.0.0.1:${server.address().port}`); } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};
const view = () => ({
  found: true,
  number: NUMBER,
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 0,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '41', cells: [{ count: 2 }], total: 2, missing: false }],
  missing_count: 0,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-16 10:00',
  product_record_id: 'prod_1',
});

/** ⭐ **卡得住的假写服务**：写库那一步等 `release()`；返回的 `finished` 记"它是否真的跑完了"。 */
const createGatedWriteService = () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const gated = (flow) => async (args) => {
    calls.push({ flow, args, done: false });
    await gate;
    calls[calls.length - 1].done = true;
    return { ok: true, reused: false, batch_no: 'CGD-20261016-0001', request_count: 2 };
  };
  return {
    calls,
    release,
    doneCount: () => calls.filter((c) => c.done).length,
    sessions: { get: async () => null, submitKeyFor: () => 'scan_test:key:timing', setLastRealm: async () => {} },
    submitReplenish: gated('replenish'),
    submitPurchaseReturn: gated('purchase_return'),
  };
};

const appWith = (write) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => view() },
    gateway: {},
    writeService: write,
  }));
  return app;
};
const postForm = async (url, cookie, body) => fetch(url, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
  redirect: 'manual',
});
const pageUrl = (base, realm) => `${base}/s/${encodeURIComponent(NUMBER)}?from=${realm}`;

/** 她**填好了**的两条合法请求（尺码/数量/金额齐 —— 否则会（正确地）被当场拦 ✓）。 */
const legalCases = () => ([
  {
    chain: 'replenish',
    realm: 'replenish',
    action: SCAN_WRITE.actions.replenish,
    extra: {
      [`${SCAN_WRITE.fields.purchaseAmount}`]: '1200',
      [`${SCAN_WRITE.fields.replenishSizes}`]: '41',
      qty_41: '2',
    },
  },
  {
    chain: 'purchase_return',
    realm: 'purchase_return',
    action: SCAN_WRITE.actions.purchaseReturn,
    extra: {
      [`${SCAN_WRITE.fields.purchaseAmount}`]: '800',
      [`${SCAN_WRITE.fields.returnSizes}`]: '41',
      [`${SCAN_WRITE.fields.returnQuantityPrefix}41`]: '1',
    },
  },
]);

// ═══════════════════════════════════════════════════════════════════════════
// AC-ASY-T1 / T2：写库卡住 ⇒ 回执先回来
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ASY-T1/T2 ⭐⭐ 补货 / 退货：**写库卡住时**回执已经回来（先回成功页）⇒ 放行后真的落库', async () => {
  login();
  for (const c of legalCases()) {
    const write = createGatedWriteService();
    await withServer(appWith(write), async (base) => {
      const pending = postForm(pageUrl(base, c.realm), sessionCookie(), {
        action: c.action, submit_key: 'scan_test:key:timing', ...c.extra,
      });
      let raced;
      try {
        // ⭐ 写库那一跑**还卡在闸门后面** ⇒ 回执必须已经回来（改回同步 ⇒ 这里必然 'TIMEOUT' ⇒ **红** ✓）
        raced = await Promise.race([pending.then((r) => r), sleep(RESPONSE_BUDGET_MS).then(() => 'TIMEOUT')]);
      } finally {
        // 🔴 **红的时候也必须放行**（否则这一跑挂死 ⇒ CI 见不到"红"、只见到"卡"✗）
        write.release();
        await pending.catch(() => undefined);
      }
      assert.notEqual(raced, 'TIMEOUT',
        `${c.chain}：🔴 写库还没跑完，成功页就必须已经回来了（改回同步 ⇒ 本判据红 ✗）`);
      assert.equal(raced.status, 200, `${c.chain}：合法提交 ⇒ 200（先回她 ✓）`);
      const html = await raced.text();
      assert.ok(html.includes(UNIFIED), `${c.chain}：回她的那一页 = 统一那句成功页 ✓`);
      // ⭐ 探针（AC-ASY-T3）：这一刻写入口**已经进了**、但**绝不可能**已经结束（闸门还锁着 ✓）
      assert.equal(write.calls.length, 1, `${c.chain}：后台那一跑**已经排下去**了 ✓（不是"根本没调"✗）`);
      // 放行 ⇒ 数据最终真的落库（等登记簿里那一跑 ✓）
      await waitForPendingPurchaseBackgrounds();
      assert.equal(write.calls.length, 1, `${c.chain}：放行后写入口**恰好一次**（不多不少 ✓）`);
      assert.equal(write.doneCount(), 1, `${c.chain}：那一跑**真的跑完**了（数据落库 ✓）`);
      assert.equal(write.calls[0].flow, c.chain, `${c.chain}：进的是**这条链路**的写入口 ✓`);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ASY-T4：校验仍**同步**（写库卡着也当场拦）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ASY-T4 🔴 **校验在排队之前**（实测）：写库卡住时，坏输入仍**当场 400 ＋ 零写入**', async () => {
  login();
  const c = legalCases().find((x) => x.chain === 'purchase_return');
  const write = createGatedWriteService();
  await withServer(appWith(write), async (base) => {
    // 金额**空** ⇒ 她填错了 ⇒ 必须当场拦（不是"先回成功页、后台才失败" ✗）
    const bad = { ...c.extra, [`${SCAN_WRITE.fields.purchaseAmount}`]: '' };
    const pending = postForm(pageUrl(base, c.realm), sessionCookie(), {
      action: c.action, submit_key: 'scan_test:key:timing', ...bad,
    });
    let raced;
    try {
      raced = await Promise.race([pending.then((r) => r), sleep(RESPONSE_BUDGET_MS).then(() => 'TIMEOUT')]);
    } finally {
      write.release();
      await pending.catch(() => undefined);
    }
    assert.notEqual(raced, 'TIMEOUT',
      '🔴 校验必须**在排队之前**（写库卡着也要当场回）—— 顺序反了 ⇒ 这里超时 ⇒ 红 ✓');
    assert.equal(raced.status, 400, '她填错了 ⇒ 当场 400（不是成功页 ✗）');
    const html = await raced.text();
    assert.ok(html.trim().length > 0, '拦住时必须给她人话（不许干巴巴 400 ✗）');
    assert.equal(html.includes(UNIFIED), false, '拦住的那一页**不许**是成功页（否则就是"假成功" ✗）');
    // **零写入**：一次后台都没排（更没写库）
    assert.equal(write.calls.length, 0, '坏输入 ⇒ 写入口**一次都没进**（一个字都没写 ✓）');
    await waitForPendingPurchaseBackgrounds();
    assert.equal(write.calls.length, 0, '放行之后仍然零写入 ✓');
  });
});
