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

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_accept_id';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'accept_id_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { createScanArrivalService } = require('../src/services/scanArrivalService');
const { createPurchaseQueryService } = require('../src/services/purchaseQueryService');
const { PurchaseArrivalConversationService } = require('../src/services/purchaseArrivalConversationService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const SESSION_SECRET = 'accept-id-secret';
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
const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `accept-id-${label}-`));

/** ⭐ 抓 `confirmBatchArrival` 的入参（= 写库那一刻的"实际数量 / 逐尺码清单 / 实际金额"）。 */
const createHarness = ({ rows = SIZES.map((size) => ({ size, quantity: 1 })), allowEmptyRows = false, twoProducts = false, delayMs = 0 } = {}) => {
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
  const updates = [];
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => records[key] || [],
    get: async (key, id) => (records[key] || []).find((record) => record.record_id === id) || null,
    listByFilter: async () => { throw new Error('fake gateway 不支持 filter'); },
    // ⭐ 真网关有 update（`markArrived` → `setArrivalStatus` 靠它）——这里记下来并**真的改数据**，
    //    这样"到货状态有没有被写"与"未到货列表里还在不在"都能断言。
    update: async (key, recordId, values) => {
      updates.push({ table: key, recordId, values });
      // ⚠️ 真网关收的是**语义键**（`arrivalStatus`），落表时要翻成**物理列名**（「到货状态」）——
      //    假网关也必须这么做，否则"到货状态到底写没写"就断不出来。
      const mapping = V1_BITABLE_SCHEMA.tables[key].fields;
      const row = (records[key] || []).find((record) => record.record_id === recordId);
      if (row) {
        for (const [semantic, value] of Object.entries(values || {})) {
          if (!mapping[semantic]) throw new Error(`未配置语义字段: ${semantic}`);
          row.fields[mapping[semantic]] = value;
        }
      }
      return { recordId };
    },
  };
  const confirmCalls = [];
  // ⭐ P0：`confirmCalls` 数的是"**进到入口**"（校验失败也会进），所以另数一个
  //    "**真的跑了一遍入库**"——并发那条 AC 要的正是这个数 ✓
  const arrivalRuns = { count: 0 };
  // eslint-disable-next-line global-require
  const { PurchaseOrderBatchService } = require('../src/services/purchaseOrderBatchService');
  const orderBatches = new PurchaseOrderBatchService({ gateway, texts: SCAN_WRITE.texts, events: SCAN_WRITE.events });
  const conversation = new PurchaseArrivalConversationService({
    gateway,
    store: new JsonTaskStore({ dir: tempDir('conv'), idField: 'task_id' }),
    sizeReferences: () => SIZE_STUB,
    confirmArrival: async () => {
      // ⭐ 让"入库"慢一点 ⇒ 两个请求**同时**进来时才测得到"锁内二次检查"（P0 的那条 ✗）
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      arrivalRuns.count += 1;
      return { toast: { type: 'success', content: 'ok' } };
    },
    // ⭐ 与工作台 / 对话到货**同一条路**：既有 `PurchaseOrderBatchService.markArrived`
    //    （它就是"把批次行到货状态写成已到货"的唯一实现）。
    markBatchArrived: (batchNo, arrivalOptions) => orderBatches.markArrived(batchNo, arrivalOptions),
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
  return { app, arrival, confirmCalls, arrivalRuns, updates, orderBatches };
};

const sessionCookie = (openId = 'ou_accept_id') => {
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
const get = async (base, target, openId = 'ou_accept_id') => {
  const response = await fetch(`${base}${target}`, { headers: { cookie: sessionCookie(openId) } });
  return { response, html: await response.text() };
};
const post = (base, target, body, openId = 'ou_accept_id') => {
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
// 🔴 P0 2026-10-12（她真机：**5 双变 10 双**）
//   日志：两次 `scan.accept.finishing` 的 `submit_key` 都是 **空串** ⇒ 重复提交没有钥匙可认 ✗；
//         同一个 task 起了两份 ⇒ **并发没有排队** ⇒ 每个尺码各 +2 ✗✗
//
//  AC-ID1 同一把幂等键提交两次 ⇒ **只执行一次**（第二次零写入，给她"已完成"）✓
//  AC-ID2 两个请求**并发** ⇒ 只跑一次（锁内二次检查拦住第二份）✓
//  AC-ID3 已入库的批次再提交 ⇒ **幂等返回**（不重复执行）✓
//  AC-ID4 回归：一次验收 ⇒ 5 行**各 +1**（不多不少 —— 本次事故的形状）✓
// ═══════════════════════════════════════════════════════════════════════════

const keyOf = (html) => {
  const m = html.match(/name="submit_key" value="([^"]*)"/);
  return m ? m[1] : '';
};

test('AC-ID1 ⭐ 表单带着幂等键；同一把钥匙提交两次 ⇒ 只执行一次（第二次零写入）', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    const page = await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    const key = keyOf(page.html);
    assert.ok(key, `完成验收的表单必须带幂等键（改前是空串 ✗）：${key}`);
    const body = {
      [F.action]: A.acceptFinishRows, batch: BATCH, [F.submitKey]: key,
      [F.acceptRowQty]: ['1', '1', '1', '1', '1'], [F.acceptAmount]: '10',
    };
    const first = await post(base, '/s/accept', body);
    assert.equal(first.status, 200, `第一次要成（${first.status}）`);
    assert.equal(h.confirmCalls.length, 1, '第一次真的入库一次');
    const writesAfterFirst = h.updates.length;
    const second = await post(base, '/s/accept', body);
    assert.equal(second.status, 200, '第二次也要给她 200（不是报错）');
    assert.equal(h.confirmCalls.length, 1, `同一把钥匙不许执行第二次（实际 ${h.confirmCalls.length} 次）`);
    assert.equal(h.updates.length, writesAfterFirst, '第二次零写入');
  });
});

test('AC-ID2 ⭐⭐ 两个请求**并发** ⇒ 只跑一次（锁内二次检查拦住第二份）', async () => {
  login();
  const h = createHarness({ delayMs: 60 }); // 让第一份"卡"在入库里 ⇒ 两份会真的重叠 ✓
  await withServer(h.app, async (base) => {
    const page = await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    const key = keyOf(page.html);
    const body = {
      [F.action]: A.acceptFinishRows, batch: BATCH, [F.submitKey]: key,
      [F.acceptRowQty]: ['1', '1', '1', '1', '1'], [F.acceptAmount]: '10',
    };
    const [a, b] = await Promise.all([post(base, '/s/accept', body), post(base, '/s/accept', body)]);
    assert.ok(a.status < 500 && b.status < 500, `两个并发都不许 5xx（${a.status}/${b.status}）`);
    // ⭐ 关键：**真的跑了一遍入库**只能有一次（这才是"每个尺码各 +2"的反面）
    assert.equal(h.arrivalRuns.count, 1,
      `并发两次只许**入库一次**（实际 ${h.arrivalRuns.count} 次）——这就是"每个尺码各 +2"的根因`);
    // 到货状态也只写一次（第二份在**锁内**就看到了"已入库"⇒ 直接返回）
    assert.equal(h.updates.filter((item) => item.values && item.values.arrivalStatus === '已到货').length, 1,
      '到货状态只许写一次');
    assert.equal(h.confirmCalls[0].scanLines.length, 5, '逐码清单只有一份');
  });
});

test('AC-ID3 已入库的批次再提交 ⇒ 幂等返回（不重复执行、人话仍在）', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    const page = await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    const body = {
      [F.action]: A.acceptFinishRows, batch: BATCH, [F.submitKey]: keyOf(page.html),
      [F.acceptRowQty]: ['1', '1', '1', '1', '1'], [F.acceptAmount]: '10',
    };
    await post(base, '/s/accept', body);
    const calls = h.confirmCalls.length;
    // 换一把新钥匙再提交（模拟"她又点了一次"）⇒ 会话已 posted ⇒ 幂等返回 ✓
    const again = await post(base, '/s/accept', { ...body, [F.submitKey]: 'accept:whatever:9' });
    assert.equal(again.status, 200, '不许报错');
    assert.equal(h.confirmCalls.length, calls, '已入库 ⇒ 不许再执行');
    const text = await again.text();
    assert.ok(/已验收入库|验收已完成/.test(text), `要给她"已完成"的明确页面：${(text.match(/<h1>([^<]*)<\/h1>/) || [])[1]}`);
  });
});

test('AC-ID4 回归：一次验收 ⇒ 5 行**各 +1**、状态一次（不多不少 = 事故的形状钉死）', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    const page = await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    await post(base, '/s/accept', {
      [F.action]: A.acceptFinishRows, batch: BATCH, [F.submitKey]: keyOf(page.html),
      [F.acceptRowQty]: ['1', '1', '1', '1', '1'], [F.acceptAmount]: '10',
    });
    assert.equal(h.confirmCalls.length, 1, '入库**恰好一次**');
    const lines = h.confirmCalls[0].scanLines;
    assert.equal(lines.length, SIZES.length, `逐码清单 = ${SIZES.length} 行`);
    for (const line of lines) assert.equal(line.quantity, 1, `${line.size} 码只 +1（不是 +2 ✗）`);
    const statusWrites = h.updates.filter((item) => item.values && item.values.arrivalStatus === '已到货');
    assert.equal(statusWrites.length, 1, '到货状态**恰好写一次**');
  });
});
