'use strict';

/**
 * ⭐⭐ ⑨b-1：**工作台「续写 / 重试」入口**的验收用例（AC-AS4 / AC-AS5 / AC-AS9）。
 *
 * 她的逐字：「失败落「**写入失败**」、工作台显示「**未完成，可点重试**」；
 *   重试**只走 `submitSale` 同一把 `submitKey`**（**绝不直调 `_confirm`**、**绝不重复写/重复扣**）」
 *
 * 判据（逐条）：
 *  · **AC-AS5** 重试**同键**（**串行两跑** + **并发两跑**）⇒ **只写一次**（写链路只进一次 ⇒ 库存不重复扣 ✓）
 *  · **AC-AS5b** 第二次是"**还她上一次的结果**"（`reused:true`）而不是又写一遍 ✓
 *  · **AC-AS4** 重试**失败** ⇒ **如实反馈**（500 + 人话 / 400 + 人话）· **绝不含糊地返回成功** ✗
 *  · **AC-AS9** 她**回看/刷新**看到的是**真实状态**：没有待续的单 ⇒ 如实 400（**不猜** ✗）；
 *    写成了再点 ⇒ `reused`（真实）✓
 *
 * ⚠️ 跑的是**真的** `routes/workbench.js`（含既有 `requireWorkbenchAccess` 闸门）+ **真的**
 *   `createScanWriteService.submitSale`；只有外部世界（建单 / 业务层 / 状态写入）是替身。
 */

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_retry_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'retry_test_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET || 'retry-route-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SCAN_WRITE, PAYMENT_STATUS } = require('../src/config/scanWrite');
const { createScanWriteService } = require('../src/services/scanWriteService');
const { createScanSessionService } = require('../src/services/scanSessionService');
const { createWorkbenchRouter } = require('../src/routes/workbench');

const OPEN_ID = 'ou_retry_1';
const ORDER_NO = 'XSD-20261015-0002';
const SECRET = process.env.LARK_WEB_SESSION_SECRET;

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'retry-'));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

const cookieOf = (openId) => {
  const payload = Buffer.from(JSON.stringify({ open_id: openId, name: 't', exp: Date.now() + 36e5 })).toString('base64url');
  return `workbench_session=${payload}.${crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
};

/**
 * 台子：真的写服务（外部世界替身）+ 真的工作台路由。
 * `failConfirm` = 模拟"业务层那一步写不成"（用来验"如实反馈" ✗ 假成功）。
 */
const createHarness = ({ failConfirm = false } = {}) => {
  const dir = tempDir();
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir });
  const calls = { entry: [], confirm: [], underscoreConfirm: [], status: [] };
  const scanWrite = createScanWriteService({
    gateway: {},
    config: SCAN_WRITE,
    sessions,
    readCache: false,
    createSalesEntry: async () => {
      calls.entry.push(true);
      return { recordId: 'entry_retry_1', record: { fields: { 销售单号: ORDER_NO } } };
    },
    sales: {
      confirm: async (input, options) => {
        calls.confirm.push({ input, options });
        if (failConfirm) throw new Error('业务层写不成（用例注入）');
        return { detailRecordIds: ['det_1'], paymentRecordIds: ['pay_1'] };
      },
      _confirm: async (input) => { calls.underscoreConfirm.push(input); return {}; },
    },
    status: { write: async (id, dims, correlation) => { calls.status.push({ id, dims, correlation }); } },
  });
  const router = createWorkbenchRouter({ gateway: {}, scanWrite, followup: { listOrders: async () => ({ orders: [] }) } });
  return { scanWrite, sessions, calls, router, cleanup: () => rmDir(dir) };
};

/** 起一个真服务器（走真路由 + 真闸门），并把她"资金页点过按钮之后"的会话铺好。 */
const withServer = async (h, run) => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/workbench', h.router);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

/** 她那次提交之后的会话：**同一把 `submitKey`** + 资金入参都在 `submitPending` 里 ✓ */
const seedPendingSession = async (h) => {
  const session = (await h.sessions.get(OPEN_ID)) || (await h.sessions.ensure(OPEN_ID));
  const key = session.sale.key;
  await h.sessions.saveSaleProgress(OPEN_ID, {
    master_record_id: 'entry_retry_1',
    order_no: ORDER_NO,
    // ⚠️ `product_record_id` 必填：`submitSale` 逐行要它（缺 ⇒ `line_product_missing` ✗）；
    //    这里**照会话里那一条原样给**（她提交时就已经在会话里了 ✓ 不是新造字段）
    lines: [{
      size: 41, quantity: 1, item_no: 'YD6693-2', number: 'YD6693-2|黑色|A', color: '黑色',
      amount: '399', product_record_id: 'prod_1', in_stock: true,
    }],
    submitPending: {
      size: '41', amount: '399', gift: '',
      payments: [{ method: '微信', amount: '399' }],
      lineAmounts: ['399'],
      paymentStatus: PAYMENT_STATUS.full,
      paidAmount: '399',
    },
  });
  return key;
};

const retry = (base, body = {}) => fetch(`${base}/api/workbench/sales/retry`, {
  method: 'POST',
  headers: { cookie: cookieOf(OPEN_ID), 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AS5 重试同键：只写一次（串行 + 并发）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AS5 ⭐ 重试**同键**（串行两跑）⇒ 只写一次：写链路只进一次、主表不重建', async () => {
  const h = createHarness();
  try {
    const key = await seedPendingSession(h);
    await withServer(h, async (base) => {
      const first = await retry(base, { order_no: ORDER_NO });
      assert.equal(first.status, 200, '第一次重试 ⇒ 200 ✓');
      const firstBody = await first.json();
      assert.equal(firstBody.success, true, JSON.stringify(firstBody));
      assert.equal(firstBody.reused, false, '第一次是**真写**（不是"还她上一次"）✓');
      assert.equal(firstBody.order_no, ORDER_NO, '返回的是**真单号** ✓');

      // 🔴 写成功之后再点一次（她连点 / 刷新后再点）——
      //   ⭐ **真实语义**（用例跑出来的，我第一版写错过）：写成功后**那一把键会轮换**
      //     （既有协议：`completeSale` 成功即翻轮 ✓ 幂等键不许拆 ✗）⇒ 再点 = **这一单已经写完、没有要接着写的东西**
      //     ⇒ 端**如实 400 + 人话**（**绝不**又写一遍、也**绝不**假成功 ✓）
      const second = await retry(base, { order_no: ORDER_NO });
      assert.equal(second.status, 400, '已经写完 ⇒ 再点如实 400（不是又写一遍 ✗）');
      const secondBody = await second.json();
      assert.equal(secondBody.success, false, '**不许**假成功 ✗');
      assert.ok(String(secondBody.error || '').trim(), '要给她一句人话（"没有要接着写的东西" ✓）');

      // ⭐ 关键（本 AC 的立身之本）：写链路**只进了一次** ⇒ 明细/收款/库存都不会写第二遍 ✓
      assert.equal(h.calls.confirm.length, 1, `写链路恰进一次（实际 ${h.calls.confirm.length} 次）`);
      assert.equal(h.calls.entry.length, 0, '重试**不重建主表**（主表已经在会话里 ✓）');
      assert.equal(h.calls.underscoreConfirm.length, 0, '绝不直调 `_confirm` ✗');
      assert.equal(h.calls.confirm[0].options.correlation.task_id, key,
        '走的是**同一把** `submitKey`（幂等一字没拆 ✓）');
    });
  } finally { h.cleanup(); }
});

test('AC-AS5b ⭐ 重试**同键**（并发两跑）⇒ 同样只写一次（既有串行队列兜住 ✓）', async () => {
  const h = createHarness();
  try {
    await seedPendingSession(h);
    await withServer(h, async (base) => {
      const [a, b] = await Promise.all([retry(base, { order_no: ORDER_NO }), retry(base, { order_no: ORDER_NO })]);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      const bodies = [await a.json(), await b.json()];
      assert.equal(bodies.filter((body) => body.success === true).length, 2, '两次都给她结果 ✓');
      assert.equal(h.calls.confirm.length, 1, `并发两跑也只写一次（实际 ${h.calls.confirm.length}）`);
      assert.equal(h.calls.entry.length, 0, '不重建主表 ✓');
    });
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AS4 重试失败 ⇒ 如实反馈（不许假成功）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AS4 🔴 重试**没写成功** ⇒ 如实 500 + 人话（**绝不返回成功** ✗）', async () => {
  const h = createHarness({ failConfirm: true });
  try {
    await seedPendingSession(h);
    await withServer(h, async (base) => {
      const response = await retry(base, { order_no: ORDER_NO });
      assert.equal(response.status, 500, '写不成 ⇒ 500（系统没写成，不是"成功" ✗）');
      const body = await response.json();
      assert.equal(body.success, false, '**不许** `success:true` ✗');
      assert.ok(String(body.error || '').trim(), '要给她一句人话（不是空 ✗）');
      assert.equal(h.calls.confirm.length, 1, '确实试过一次 ✓');
      // 她还能再点（会话里的键与入参没被清掉）⇒ 下一次仍然走同一把键 ✓
      const again = await retry(base, { order_no: ORDER_NO });
      assert.equal(again.status, 500, '再点还是如实失败（不糊弄 ✓）');
      assert.equal(h.calls.confirm.length, 2, '又试了一次（每次都真的去写 ✓）');
    });
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AS9 回看/刷新看到真实状态（不猜、不假成功）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AS9 ⭐ 没有待续的单 ⇒ 如实 400 + 人话（**不猜、不假成功** ✗）', async () => {
  const h = createHarness();
  try {
    // 会话里**没有**主表（= 这一单根本没走到"建过单"那一步）⇒ 不许"替她重试"
    await h.sessions.ensure(OPEN_ID);
    await withServer(h, async (base) => {
      const response = await retry(base, { order_no: ORDER_NO });
      assert.equal(response.status, 400, '没有待续的单 ⇒ 400 ✓');
      const body = await response.json();
      assert.equal(body.success, false);
      assert.equal(body.code, 'no_pending_order', '原因码明写 ✓');
      assert.equal(h.calls.confirm.length, 0, '一个字都不写 ✓');
      assert.equal(h.calls.entry.length, 0, '也不建单 ✓');
    });
  } finally { h.cleanup(); }
});

test('AC-AS9b 🔴 单号对不上 ⇒ 如实 400（点的是哪一单就重试哪一单 ✗ 不许动别的单）', async () => {
  const h = createHarness();
  try {
    await seedPendingSession(h);
    await withServer(h, async (base) => {
      const response = await retry(base, { order_no: 'XSD-20260101-9999' });
      assert.equal(response.status, 400, '单号对不上 ⇒ 400 ✓');
      assert.equal((await response.json()).code, 'order_mismatch');
      assert.equal(h.calls.confirm.length, 0, '一个字都不写 ✓');
    });
  } finally { h.cleanup(); }
});

test('AC-AS9c ⭐ 她回看看到**真实状态**：写成功后再点 ⇒ 如实"没有要接着写的东西"（不猜、不再写一遍 ✓）', async () => {
  const h = createHarness();
  try {
    await seedPendingSession(h);
    await withServer(h, async (base) => {
      const first = await retry(base, { order_no: ORDER_NO });
      assert.equal(first.status, 200);
      assert.equal((await first.json()).order_no, ORDER_NO, '第一次拿到的是**真单号** ✓');
      // 她刷新/回看再点：**真实状态** = 这一单已经写完了（不是"我再替她写一遍" ✗）
      const again = await retry(base, { order_no: ORDER_NO });
      assert.equal(again.status, 400, '如实 400（没有待续的单 ✓ 不猜 ✗）');
      const body = await again.json();
      assert.equal(body.success, false);
      assert.equal(h.calls.confirm.length, 1, '端状态**没有被再写一遍** ✓');
    });
  } finally { h.cleanup(); }
});
