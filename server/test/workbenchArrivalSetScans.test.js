/**
 * ⭐⭐ task-13 · **F1/F2（验收真 bug 修复）**
 *
 * 业务负责人 / Lead 批的两条（2026-10-29）：
 *   F1 工作台【确认到货】页面上的「**自定义尺码 / 自定义货号**」填了**必然** 400 ——
 *      根因：路由逐行 `addScan`，而 `addScan` 只认"本批申请行里已有的 (款,尺码)" ✗。
 *   F2 同一会话**二次提交**（改数量 / 改成 0）**不生效** ——
 *      根因：`addScan` 对已有 (款,尺码) 返回 `duplicate`（数字一个都不变）✗；
 *      页面提交的是"整张清单" ⇒ 只有**整单替换**才是它的真实语义。
 *
 * 改法（本文件钉住）：
 *   · `scanArrivalService` 新增 **`setScans({ openId, lines })`** —— 整单替换；
 *   · 路由 `POST /purchase/arrivals/accept` 从"逐行 addScan"改成"一次 setScans"；
 *   · 本批的款 + **自定义尺码**（尺码不在申请行里，但款在）⇒ **收**；
 *   · 款不在本批 / 重复行 / 空清单 / 数量非法 / 自定义尺码没建档 ⇒ **400 + 会话一个字不动**；
 *   · 清单有变化 ⇒ `submit_round + 1`（新的幂等键）；清单没变 ⇒ 轮次不动（连点两次同一份 = 同一把钥匙）。
 *
 * 🔴 **本文件用真实 `createScanArrivalService`**（只有最外层后台那一跑用替身）——
 *    不 stub 掉核心行为（Lead 要求）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_set_scans_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'set_scans_secret';

const { SCAN_WRITE } = require('../src/config/scanWrite');
const arrivalTab = require('../src/config/workbenchArrival');
const { createScanArrivalService } = require('../src/services/scanArrivalService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { createWorkbenchPurchaseRoutes } = require('../src/routes/workbench/purchase');

const OPEN_ID = 'ou_set_scans';
const BATCH = 'BH-SET-SCANS-1';
const BATCH_RECORD_ID = 'batch_rec_set_scans';
const ROWS = Object.freeze([
  { record_id: 'pr_40', product_record_id: 'p1', item_no: 'A1', size: 40, quantity: 2 },
  { record_id: 'pr_41', product_record_id: 'p1', item_no: 'A1', size: 41, quantity: 1 },
]);

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `arrival-set-scans-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } };

const texts = {
  ...SCAN_WRITE.texts,
  acceptDuplicateLinesBody: arrivalTab.texts.duplicateLines,
  acceptSizeUnknownBody: arrivalTab.texts.sizeUnknown,
};

/** 真实 `scanArrivalService` + 真实会话存储（只有读表/尺码/后续入库用替身）。 */
const makeHarness = (options = {}) => {
  const sessionDir = tempDir('session');
  const store = new JsonTaskStore({ dir: sessionDir, idField: 'session_id' });
  const rows = options.rows || ROWS;
  const purchaseQuery = {
    listPurchaseRequests: async () => rows.map((row) => ({
      ...row,
      record_id: row.record_id,
      report_behavior: 'purchase_request',
    })),
  };
  const sizeReferences = options.sizeReferences || {
    resolveByNumber: async (value) => {
      const size = Number(value);
      // 99 = 「尺码管理」里没有的尺码（AC-SS7 用它）；42 = 自定义但已建档 ✓
      return size === 99 ? null : { recordId: `size_${size}`, size };
    },
  };
  const arrival = createScanArrivalService({
    config: SCAN_WRITE.acceptance,
    store,
    purchaseQuery,
    sizeReferences,
    texts,
  });
  return {
    arrival, store, purchaseQuery, sizeReferences,
    cleanup: () => rmDir(sessionDir),
  };
};

const startSession = async (harness) => {
  const started = await harness.arrival.start({
    openId: OPEN_ID, batchNo: BATCH, batchRecordId: BATCH_RECORD_ID,
  });
  assert.equal(started.ok, true, '会话必须先开起来（start 是既有入口 ✓）');
  return started.session;
};

const scansOf = (session) => (session.scans || [])
  .map((line) => `${line.product_record_id}|${Number(line.size)}|${Number(line.quantity)}`)
  .sort();

/** 路由夹具：真路由 + **真** scanArrivalService（后台那一跑用替身）。 */
const appFor = ({ arrival, purchaseQuery, scheduled }) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.workbenchUser = { open_id: OPEN_ID };
    req.requestId = 'req_set_scans_test';
    next();
  });
  app.use(createWorkbenchPurchaseRoutes({
    options: {
      arrival,
      purchaseQuery,
      gateway: { table: () => ({ fields: {} }) },
      acceptBackground: {
        schedulePurchaseRest: (input) => { scheduled.push(input); return true; },
      },
    },
  }));
  return app;
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const postAccept = async (base, body) => {
  const res = await fetch(`${base}${arrivalTab.api.accept}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-SS1 / AC-SS2 —— 自定义尺码（款在本批）能收；整单替换语义
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SS1 ⭐⭐ F1：本批的款 + **自定义尺码**（42，不在申请行里）⇒ setScans 收下（旧 addScan 必 400）', async () => {
  const h = makeHarness();
  try {
    await startSession(h);
    const result = await h.arrival.setScans({
      openId: OPEN_ID,
      lines: [
        { product_record_id: 'p1', size: 40, quantity: 2 },
        { product_record_id: 'p1', size: 42, quantity: 1 }, // 自定义：没报过、但到了
      ],
    });
    assert.equal(result.ok, true, '自定义尺码必须能收（F1 的核心 ✓）');
    assert.equal(result.changed, true);
    assert.deepEqual(scansOf(result.session), ['p1|40|2', 'p1|42|1'], '会话清单 = 她提交的整张清单 ✓');
    assert.equal(Number(result.session.scanned), 3, '已验收合计 = 3 双');
    assert.equal(Number(result.session.submit_round), 1, '第一次提交 ⇒ 轮次 1（新的幂等键 ✓）');
  } finally { h.cleanup(); }
});

test('AC-SS2 ⭐⭐ F2：**整单替换**（改数量 / 删行）与"没变不换轮次"（连点两次 = 同一把钥匙）', async () => {
  const h = makeHarness();
  try {
    await startSession(h);
    const first = await h.arrival.setScans({
      openId: OPEN_ID, lines: [{ product_record_id: 'p1', size: 40, quantity: 2 }],
    });
    assert.equal(first.ok, true);
    assert.equal(Number(first.session.submit_round), 1);
    // ① 改数量为 1 ⇒ 生效（旧 addScan 会 duplicate、数字不变 ✗）
    const changed = await h.arrival.setScans({
      openId: OPEN_ID, lines: [{ product_record_id: 'p1', size: 40, quantity: 1 }],
    });
    assert.equal(changed.ok, true);
    assert.equal(changed.changed, true, '数量改了 ⇒ changed=true');
    assert.deepEqual(scansOf(changed.session), ['p1|40|1'], '改后的数量真的落进会话 ✓');
    assert.equal(Number(changed.session.submit_round), 2, '清单变了 ⇒ 轮次 +1（新的幂等键 ✓）');
    // ② 同一份再提交一次 ⇒ 轮次**不动**（连点两次 / 网络重试 = 同一把钥匙 ✓）
    const same = await h.arrival.setScans({
      openId: OPEN_ID, lines: [{ product_record_id: 'p1', size: 40, quantity: 1 }],
    });
    assert.equal(same.ok, true);
    assert.equal(same.changed, false, '同一份 ⇒ changed=false');
    assert.equal(Number(same.session.submit_round), 2, '没变化 ⇒ 轮次不许变（否则连点两次会写两遍 ✗）');
    // ③ 删行（只提交 41）⇒ 40 从清单消失（旧 addScan 做不到"删" ✗）
    const removed = await h.arrival.setScans({
      openId: OPEN_ID, lines: [{ product_record_id: 'p1', size: 41, quantity: 1 }],
    });
    assert.equal(removed.ok, true);
    assert.deepEqual(scansOf(removed.session), ['p1|41|1'], '整单替换 ⇒ 没提交的行被删掉 ✓');
  } finally { h.cleanup(); }
});

test('AC-SS3 ⭐ 数量 0 / 空 = 这一行**不算到货**（她"没到的改成 0"）⇒ 从清单里去掉，不算错', async () => {
  const h = makeHarness();
  try {
    await startSession(h);
    await h.arrival.setScans({
      openId: OPEN_ID,
      lines: [
        { product_record_id: 'p1', size: 40, quantity: 2 },
        { product_record_id: 'p1', size: 41, quantity: 1 },
      ],
    });
    const result = await h.arrival.setScans({
      openId: OPEN_ID,
      lines: [
        { product_record_id: 'p1', size: 40, quantity: 0 },   // 没到
        { product_record_id: 'p1', size: 41, quantity: ' ' }, // 空 = 没填 = 不算到货
      ],
    });
    assert.equal(result.ok, false, '全部是 0 / 空 ⇒ 等于"一双都没到" ⇒ 走 no_scan_lines（空单不许提交）');
    assert.equal(result.reason, 'no_scan_lines');
    // 但**旧清单不许被清空**（她误改成 0 再提交失败，之前填的还在 ✓）
    const session = await h.arrival.get(OPEN_ID);
    assert.deepEqual(scansOf(session), ['p1|40|2', 'p1|41|1'], '校验失败 ⇒ 会话一个字不动 ✓');
    // 部分 0：只留 41
    const partial = await h.arrival.setScans({
      openId: OPEN_ID,
      lines: [
        { product_record_id: 'p1', size: 40, quantity: 0 },
        { product_record_id: 'p1', size: 41, quantity: 1 },
      ],
    });
    assert.equal(partial.ok, true);
    assert.deepEqual(scansOf(partial.session), ['p1|41|1'], '0 那一行被去掉，其余照她填的 ✓');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SS4..SS7 —— 四条"400 + 会话一个字不动"（Lead 批的硬判据）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SS4 ⭐ 重复行（同款同码两次）⇒ 400 `duplicate_lines`（**不合并**、会话不动）', async () => {
  const h = makeHarness();
  try {
    await startSession(h);
    await h.arrival.setScans({
      openId: OPEN_ID, lines: [{ product_record_id: 'p1', size: 40, quantity: 2 }],
    });
    const before = await h.arrival.get(OPEN_ID);
    const result = await h.arrival.setScans({
      openId: OPEN_ID,
      lines: [
        { product_record_id: 'p1', size: 40, quantity: 1 },
        { product_record_id: 'p1', size: 40, quantity: 2 },
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'duplicate_lines');
    assert.equal(result.message, arrivalTab.texts.duplicateLines, '人话走配置（workbenchArrival ✓）');
    const after = await h.arrival.get(OPEN_ID);
    assert.deepEqual(scansOf(after), scansOf(before), '会话一个字不动 ✓');
    assert.equal(Number(after.submit_round), Number(before.submit_round), '轮次也不动 ✓');
  } finally { h.cleanup(); }
});

test('AC-SS5 ⭐ 款不在本批 ⇒ 400 `not_in_batch`（不猜款、会话不动）', async () => {
  const h = makeHarness();
  try {
    await startSession(h);
    const before = await h.arrival.get(OPEN_ID);
    const result = await h.arrival.setScans({
      openId: OPEN_ID, lines: [{ product_record_id: 'p_unknown', size: 40, quantity: 1 }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_in_batch');
    assert.equal(result.message, SCAN_WRITE.texts.acceptNotInBatchBody);
    const after = await h.arrival.get(OPEN_ID);
    assert.deepEqual(scansOf(after), scansOf(before), '会话一个字不动 ✓');
  } finally { h.cleanup(); }
});

test('AC-SS6 ⭐ 空清单 ⇒ 400 `no_scan_lines`，**不许清空旧会话**（误点一次不丢已填的）', async () => {
  const h = makeHarness();
  try {
    await startSession(h);
    await h.arrival.setScans({
      openId: OPEN_ID, lines: [{ product_record_id: 'p1', size: 40, quantity: 2 }],
    });
    const result = await h.arrival.setScans({ openId: OPEN_ID, lines: [] });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_scan_lines');
    assert.equal(result.message, SCAN_WRITE.texts.acceptNoScansBody);
    const after = await h.arrival.get(OPEN_ID);
    assert.deepEqual(scansOf(after), ['p1|40|2'], '旧会话原样保留 ✓');
  } finally { h.cleanup(); }
});

test('AC-SS7 ⭐ 自定义尺码在「尺码管理」里不存在 ⇒ 400 `size_unknown`（不许留给后台写失败 = 假成功 ✗）', async () => {
  const h = makeHarness();
  try {
    await startSession(h);
    const before = await h.arrival.get(OPEN_ID);
    // 99 在夹具里 `resolveByNumber` 返回 null（= 尺码管理里没有 99）
    const result = await h.arrival.setScans({
      openId: OPEN_ID, lines: [{ product_record_id: 'p1', size: 99, quantity: 1 }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'size_unknown');
    assert.equal(result.message, arrivalTab.texts.sizeUnknown, '人话走配置 ✓');
    const after = await h.arrival.get(OPEN_ID);
    assert.deepEqual(scansOf(after), scansOf(before), '会话一个字不动 ✓');
  } finally { h.cleanup(); }
});

test('AC-SS8 ⭐ 单次明细超上限 ⇒ 400 `too_many_scans`；数量超上限 ⇒ 400 `quantity_invalid`', async () => {
  const h = makeHarness();
  try {
    await startSession(h);
    const tooMany = await h.arrival.setScans({
      openId: OPEN_ID,
      lines: Array.from({ length: SCAN_WRITE.acceptance.maxScans + 1 }, (_, index) => ({
        product_record_id: 'p1', size: 40 + index, quantity: 1,
      })),
    });
    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.reason, 'too_many_scans');
    const tooBig = await h.arrival.setScans({
      openId: OPEN_ID,
      lines: [{ product_record_id: 'p1', size: 40, quantity: SCAN_WRITE.acceptance.maxQuantity + 1 }],
    });
    assert.equal(tooBig.ok, false);
    assert.equal(tooBig.reason, 'quantity_invalid');
    const after = await h.arrival.get(OPEN_ID);
    assert.deepEqual(scansOf(after), [], '两次都失败 ⇒ 会话仍是空清单 ✓');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SS9..SS12 —— 路由层（真路由 + 真服务）：F1/F2 端到端；失败零写入、零后台
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SS9 ⭐⭐ F1 路由：自定义尺码（42）⇒ **200 accepted** + 后台被调度一次 + 会话 = 整张清单', async () => {
  const h = makeHarness();
  const scheduled = [];
  try {
    await startSession(h);
    await withServer(appFor({ arrival: h.arrival, purchaseQuery: h.purchaseQuery, scheduled }), async (base) => {
      const res = await postAccept(base, {
        batchNo: BATCH,
        actualAmount: 599,
        lines: [
          { productRecordId: 'p1', size: 40, quantity: 2 },
          { productRecordId: 'p1', size: 42, quantity: 1 }, // 自定义（旧实现必 400 ✗）
        ],
      });
      assert.equal(res.status, 200, `自定义尺码必须能提交（旧实现 400 ✗）：${JSON.stringify(res.body)}`);
      assert.equal(res.body.success, true);
      assert.equal(res.body.accepted, true);
    });
    assert.equal(scheduled.length, 1, '通过校验 ⇒ **排一次**后台那一跑 ✓');
    const session = await h.arrival.get(OPEN_ID);
    assert.deepEqual(scansOf(session), ['p1|40|2', 'p1|42|1'], '会话 = 她提交的整张清单 ✓');
  } finally { h.cleanup(); }
});

test('AC-SS10 ⭐⭐ F2 路由：**改数量再提交** ⇒ 第二次是新的一次（新幂等键）且会话按第二次落', async () => {
  const h = makeHarness();
  const scheduled = [];
  try {
    await startSession(h);
    await withServer(appFor({ arrival: h.arrival, purchaseQuery: h.purchaseQuery, scheduled }), async (base) => {
      const first = await postAccept(base, {
        batchNo: BATCH, actualAmount: 599,
        lines: [{ productRecordId: 'p1', size: 40, quantity: 2 }],
      });
      assert.equal(first.status, 200);
      const second = await postAccept(base, {
        batchNo: BATCH, actualAmount: 599,
        lines: [{ productRecordId: 'p1', size: 40, quantity: 1 }],
      });
      assert.equal(second.status, 200);
    });
    assert.equal(scheduled.length, 2, '两次提交 = 两次后台（改完再提交是"新的一次" ✓）');
    const keys = scheduled.map((item) => item?.restInput ? item : item);
    assert.notEqual(JSON.stringify(keys[0]), JSON.stringify(keys[1]), '两次的提交键必须不同（否则第二次被幂等吞掉 ✗）');
    const session = await h.arrival.get(OPEN_ID);
    assert.deepEqual(scansOf(session), ['p1|40|1'], '会话按第二次的数量 ✓');
  } finally { h.cleanup(); }
});

test('AC-SS11 ⭐⭐ 路由失败不假成功：重复行 / 未知款 / 空清单 / 金额缺失 ⇒ 400 + **零后台调度** + 会话不动', async () => {
  const h = makeHarness();
  const scheduled = [];
  try {
    await startSession(h);
    await withServer(appFor({ arrival: h.arrival, purchaseQuery: h.purchaseQuery, scheduled }), async (base) => {
      const cases = [
        {
          why: '重复行',
          body: { batchNo: BATCH, actualAmount: 599, lines: [
            { productRecordId: 'p1', size: 40, quantity: 1 },
            { productRecordId: 'p1', size: 40, quantity: 2 },
          ] },
          said: arrivalTab.texts.duplicateLines,
        },
        {
          why: '未知款',
          body: { batchNo: BATCH, actualAmount: 599, lines: [
            { productRecordId: 'p_unknown', size: 40, quantity: 1 },
          ] },
          said: SCAN_WRITE.texts.acceptNotInBatchBody,
        },
        {
          why: '空清单',
          body: { batchNo: BATCH, actualAmount: 599, lines: [] },
          said: SCAN_WRITE.texts.acceptNoScansBody,
        },
      ];
      for (const kase of cases) {
        const res = await postAccept(base, kase.body);
        assert.equal(res.status, 400, `${kase.why} ⇒ 必须 400（不许假成功 ✗）`);
        if (kase.said) assert.ok(String(res.body.error || '').includes(kase.said), `${kase.why} 的人话来自配置 ✓`);
      }
    });
    assert.equal(scheduled.length, 0, '全部被拦 ⇒ **一次后台都不许排** ✓');
    const session = await h.arrival.get(OPEN_ID);
    assert.deepEqual(scansOf(session), [], '失败 ⇒ 会话一个字都不动 ✓');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SS12 —— 自定义行能一路到 `finish`（会话 → scanLines → 既有 buildPlan）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SS11b ⭐ 金额缺失 ⇒ 400 + **零后台调度**（会话清单是本地状态；业务表零写入 —— 与改动前同一顺序）', async () => {
  const h = makeHarness();
  const scheduled = [];
  try {
    await startSession(h);
    await withServer(appFor({ arrival: h.arrival, purchaseQuery: h.purchaseQuery, scheduled }), async (base) => {
      const res = await postAccept(base, {
        batchNo: BATCH,
        // 故意不传 actualAmount
        lines: [{ productRecordId: 'p1', size: 40, quantity: 1 }],
      });
      assert.equal(res.status, 400, '金额缺失 ⇒ 必须 400（不许假成功 ✗）');
    });
    assert.equal(scheduled.length, 0, '金额被拦 ⇒ **一次后台都不许排** ✓');
    // ⚠️ 说明（与改动前同一顺序）：`setScans` 在金额闸门**之前**落会话（`addScan` 当年也是这个顺序），
    //   所以这里会话里有那行 —— 但**没有任何业务表写入**、也没有后台调度 ✓。
    const session = await h.arrival.get(OPEN_ID);
    assert.deepEqual(scansOf(session), ['p1|40|1'], '会话是本地状态（与改动前同顺序 ✓）');
  } finally { h.cleanup(); }
});

test('AC-SS12 ⭐ 自定义尺码从会话一路传到 finish 的 scanLines（既有 buildPlan 的自定义分支能收到）', async () => {
  const sessionDir = tempDir('session');
  const store = new JsonTaskStore({ dir: sessionDir, idField: 'session_id' });
  const captured = [];
  const purchaseQuery = {
    listPurchaseRequests: async () => ROWS.map((row) => ({ ...row, report_behavior: 'purchase_request' })),
  };
  const arrival = createScanArrivalService({
    config: SCAN_WRITE.acceptance,
    store,
    purchaseQuery,
    texts,
    arrivalConversation: {
      confirmBatchArrival: async (input) => {
        captured.push(input);
        return { ok: true, message: 'done', taskId: 'task_custom_1' };
      },
    },
    // 没有 gateway ⇒ pendingBatches 跳过（不构造 ✓）
  });
  try {
    const started = await arrival.start({ openId: OPEN_ID, batchNo: BATCH, batchRecordId: BATCH_RECORD_ID });
    assert.equal(started.ok, true);
    const set = await arrival.setScans({
      openId: OPEN_ID,
      lines: [
        { product_record_id: 'p1', size: 40, quantity: 2 },
        { product_record_id: 'p1', size: 42, quantity: 1 },
      ],
    });
    assert.equal(set.ok, true);
    const finished = await arrival.finish({
      openId: OPEN_ID, actualAmount: 599, submitKey: arrival.submitKeyOf(set.session),
    });
    assert.equal(finished.ok, true, JSON.stringify(finished));
    assert.equal(captured.length, 1, 'finish 要调用既有 confirmBatchArrival 一次 ✓');
    assert.deepEqual(
      captured[0].scanLines.map((line) => `${line.product_record_id}|${line.size}|${line.quantity}`).sort(),
      ['p1|40|2', 'p1|42|1'],
      '自定义尺码必须出现在 scanLines 里（到既有 buildPlan 的自定义分支 ✓）',
    );
  } finally { rmDir(sessionDir); }
});
