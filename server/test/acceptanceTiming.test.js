/**
 * ⭐⭐ 2026-10-12（业务负责人口述版，落档 `docs/acceptance-scan-design-2026-10-12.md`）：
 *   「用户点验收的时候，**先默认带出我们采购申请里的尺码和数量**。用户可以在**给定的区域里
 *     直接修改**，同时**也可以自定义**；**自定义的时候同样支持扫码**。」
 *
 * 本文件钉的就是这段：**进验收 ⇒ 明细预填成一张可编辑清单**（默认 = 报货数量）+ 可改 + 可自定义
 * + 扫码加一款 + 完成时写「实际数量（各行之和）」/「实际金额」+ **逐尺码加库存**（既有口径）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**测试名 = AC**）
 *
 *  AC-AP1 进验收（`GET /s/accept?batch=…`）⇒ **明细逐字预填**（35×1 · 36×1 · 37×1 ⇒ 每个尺码一个
 *         数量输入框，`value` = **报货数量**）+ 实际金额输入框 + 确认完成验收（表单字段名来自配置）。
 *  AC-AP2 **改数量**（37 改成 2）⇒ 完成后写进去的 `scanLines` / 「实际数量」= **改后各行之和**。
 *  AC-AP3 **改成 0** ⇒ 那一行**不算到货**（不进 `scanLines`、不加库存）。
 *  AC-AP4 ⚠️ **自定义加一行**：**能加进清单（会话里看得见）**；但在"完成"这一步会被**既有**链路
 *         按「这一双不在本批」**如实拦住** —— 因为 `purchaseArrivalConversationService.buildPlan`
 *         只认"有采购明细的那几行"（该文件**不在本轮文件面**）。
 *         ⇒ 本条钉的是**不 500、不静默丢、有一句人话**；真正"自定义行也能入库"要等她拍业务口径
 *         （加到哪个款 / 未报货尺码怎么办）+ 授权改那个文件。（报告里单列 ✓）
 *  AC-AP5 ⭐ **扫码加一款**：走既有 `accept_add` 扫进来 ⇒ 该款**出现在清单里**（可继续改数量）。
 *  AC-AP6 **完成** ⇒ 既有口径一字不变：`actualAmount` 原样交给 `confirmBatchArrival` +
 *         **逐尺码** `scanLines`（每一行 货品/尺码/数量）。
 *  AC-AP7 没有采购明细的批次（开关打开）⇒ 页面仍 **200** + 仍能手输自定义 / 扫码加（**不崩**）。
 *  AC-AP8 回归：既有「加入本次验收」表单与自助块**逐字还在**（`name=accept_size` / `accept_quantity`）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_accept_timing';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'accept_timing_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { createScanArrivalService } = require('../src/services/scanArrivalService');
const { createPurchaseQueryService } = require('../src/services/purchaseQueryService');
const { PurchaseArrivalConversationService } = require('../src/services/purchaseArrivalConversationService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const SESSION_SECRET = 'accept-timing-secret';
const NUMBER = 'YD6693-2|黑色|A';
const BATCH = 'CGD-20261012-0001';
const BATCH_ID = 'batch_a';
const SIZES = [35, 36, 37, 38, 39];
const T = SCAN_WRITE.texts;
const F = SCAN_WRITE.fields;
const A = SCAN_WRITE.actions;

const VIEW = {
  found: true, number: NUMBER, item_no: 'YD6693-2', color: '黑色', category_name: '休闲鞋',
  category_code: 'A', price_text: '¥399', total: 2, columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '37', cells: [{ key: '门盒', count: 2 }], total: 2, missing: false }],
  missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: '2026-10-12 16:00',
  product_record_id: 'prod_1',
};
const SIZE_STUB = {
  resolveLinkedCell: async (cell) => {
    const id = Array.isArray(cell) ? cell[0] : cell;
    return { recordId: id, size: Number(String(id).replace('size_', '')) };
  },
  resolveByNumber: async (value) => ({ recordId: `size_${value}`, size: Number(value) }),
};
const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `accept-timing-${label}-`));

/** ⭐ 抓 `confirmBatchArrival` 的入参（= 写库那一刻的"实际数量 / 逐尺码清单 / 实际金额"）。 */
const createHarness = ({ rows = SIZES.map((size) => ({ size, quantity: 1 })), allowEmptyRows = false, twoProducts = false } = {}) => {
  const records = {
    purchaseOrderBatch: [{ record_id: BATCH_ID, fields: { 报货批次号: BATCH, 到货状态: '未到货', 供应商: [{ text: '大发鞋厂' }] } }],
    purchaseRequest: [
      ...rows.map((row, index) => ({
        record_id: `pr_${index + 1}`,
        fields: { 报货批次号: [BATCH_ID], 编号: ['prod_1'], 尺码: [`size_${row.size}`], 数量: row.quantity },
      })),
      // 第二款（只在她要验"多款"那条 AC 时加）
      ...(twoProducts ? [{
        record_id: 'pr_other',
        fields: { 报货批次号: [BATCH_ID], 编号: ['prod_2'], 尺码: ['size_40'], 数量: 1 },
      }] : []),
    ],
    product: [
      { record_id: 'prod_1', fields: { 编号: NUMBER, 货号: 'YD6693-2', 颜色: { text: '黑色' } } },
      ...(twoProducts ? [{ record_id: 'prod_2', fields: { 编号: 'XHB8095|棕色|A', 货号: 'XHB8095', 颜色: { text: '棕色' } } }] : []),
    ],
    sizeManagement: SIZES.map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } })),
    behavior: [],
  };
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => records[key] || [],
    get: async (key, id) => (records[key] || []).find((record) => record.record_id === id) || null,
    listByFilter: async () => { throw new Error('fake gateway 不支持 filter'); },
  };
  const confirmCalls = [];
  const conversation = new PurchaseArrivalConversationService({
    gateway,
    store: new JsonTaskStore({ dir: tempDir('conv'), idField: 'task_id' }),
    sizeReferences: () => SIZE_STUB,
    confirmArrival: async () => ({ toast: { type: 'success', content: 'ok' } }),
    markBatchArrived: async () => ({ updated: true }),
  });
  const originalConfirm = conversation.confirmBatchArrival.bind(conversation);
  conversation.confirmBatchArrival = async (input) => {
    confirmCalls.push(input);
    return originalConfirm(input);
  };
  const config = allowEmptyRows
    ? { ...SCAN_WRITE.acceptance, allowEmptyRows: true }
    : SCAN_WRITE.acceptance;
  const arrival = createScanArrivalService({
    gateway,
    config,
    texts: T,
    events: SCAN_WRITE.events,
    purchaseQuery: createPurchaseQueryService(gateway, { sizeReferences: SIZE_STUB }),
    arrivalConversation: conversation,
    store: new JsonTaskStore({ dir: tempDir('session'), idField: 'session_id' }),
  });
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => VIEW },
    gateway: { table: () => ({ fields: {} }), listAll: async () => [], get: async () => null },
    // ⚠️ 逐码页的 POST 走的是"写入口"那道闸门 ⇒ 没它一律 503（与线上同一道闸门）。
    //    这里给一个最小的替身（本文件只验验收那一段，不碰销售写入）。
    writeService: {
      sessions: { get: async () => null, submitKeyFor: () => 'scan_sale:test:1' },
      addSaleLine: async () => ({ ok: false }),
      submitSale: async () => ({ ok: false }),
      clearDraft: async () => ({ ok: true }),
    },
    arrivalService: arrival,
    writeConfig: { ...SCAN_WRITE, acceptance: config },
  }));
  return { app, arrival, confirmCalls };
};

const sessionCookie = (openId = 'ou_accept_timing') => {
  const payload = Buffer.from(JSON.stringify({ open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};
const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};
const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};
const get = async (base, target, openId = 'ou_accept_timing') => {
  const response = await fetch(`${base}${target}`, { headers: { cookie: sessionCookie(openId) } });
  return { response, html: await response.text() };
};
const post = (base, target, body, openId = 'ou_accept_timing') => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, String(item)));
    else params.append(key, String(value));
  }
  return fetch(`${base}${target}`, {
    method: 'POST',
    headers: { cookie: sessionCookie(openId), 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
};


// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-12（她实测：每批 2~3 分钟 ⇒ 60~200 秒都被她当"没反应"）
//   **先量再改**：验收"完成"要打一条 `scan.accept.timing`（与 `scan.sale.timing` 同一形状），
//   把"每个尺码那 25~35 秒"拆到具体哪一段。
//
//  AC-AT1 一次验收 ⇒ **一条 `scan.accept.timing`**，含 6 段数字 + total_ms + ok
//  AC-AT2 分段之和 **≤** total_ms（分段是墙钟的子集；不是各段独立计时相加 ✗）
//  AC-AT3 提速改动**不许破 P0**：5 码各 +1、到货状态写一次（回归）
// ═══════════════════════════════════════════════════════════════════════════

const TIMING_KEYS = ['queue_wait_ms', 'rows_ms', 'plan_ms', 'seed_ms', 'inventory_ms', 'status_ms'];
const captureInfo = async (run) => {
  const lines = [];
  const original = console.log;
  console.log = (line) => { lines.push(String(line)); };
  try {
    const value = await run();
    return { value, entries: lines.map((line) => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean) };
  } finally { console.log = original; }
};

test('AC-AT1 ⭐ 验收"完成"打一条 `scan.accept.timing`：6 段数字 + total_ms + ok', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    const page = await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    const { value: response, entries } = await captureInfo(() => post(base, '/s/accept', {
      [F.action]: A.acceptFinishRows, batch: BATCH,
      [F.acceptRowQty]: ['1', '1', '1', '1', '1'], [F.acceptAmount]: '10',
    }));
    assert.equal(response.status, 200, `完成验收要成（${response.status}）`);
    const timing = entries.filter((entry) => entry.event === SCAN_WRITE.events.acceptTiming).pop();
    assert.ok(timing, '必须打出一条 scan.accept.timing（按它 grep 就知道慢在哪一段）');
    for (const key of [...TIMING_KEYS, 'total_ms']) {
      assert.equal(typeof timing[key], 'number', `timing 里要有数字 ${key}（实际 ${JSON.stringify(timing)}）`);
    }
    assert.equal(timing.ok, true);
    assert.equal(timing.batch_no, BATCH);
    assert.equal(timing.scanned, 5, '实际数量 5 也要带上（与销售那条同形状）');
  });
});

test('AC-AT2 分段之和 ≤ 总耗时（分段是墙钟子集）', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    const { entries } = await captureInfo(() => post(base, '/s/accept', {
      [F.action]: A.acceptFinishRows, batch: BATCH,
      [F.acceptRowQty]: ['1', '1', '1', '1', '1'], [F.acceptAmount]: '10',
    }));
    const timing = entries.filter((entry) => entry.event === SCAN_WRITE.events.acceptTiming).pop();
    const parts = TIMING_KEYS.reduce((sum, key) => sum + Number(timing[key] || 0), 0);
    assert.ok(parts <= Number(timing.total_ms) + 5,
      `分段之和(${parts}) 不许超过墙钟(${timing.total_ms})——否则说明计时口径错 ✗`);
    assert.ok(Number(timing.total_ms) > 0, '总耗时要有数');
  });
});

test('AC-AT3 回归：提速改动**不破 P0** —— 5 码各 +1、状态写一次、清单恰好一份', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    const done = await post(base, '/s/accept', {
      [F.action]: A.acceptFinishRows, batch: BATCH,
      [F.acceptRowQty]: ['1', '1', '1', '1', '1'], [F.acceptAmount]: '10',
    });
    assert.equal(done.status, 200);
    assert.equal(h.confirmCalls.length, 1, '入库恰好一次');
    const lines = h.confirmCalls[0].scanLines;
    assert.equal(lines.length, SIZES.length);
    for (const line of lines) assert.equal(line.quantity, 1, `${line.size} 码只 +1`);
  });
});
