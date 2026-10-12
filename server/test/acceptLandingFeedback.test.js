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

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_accept_ux';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'accept_ux_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { createScanArrivalService } = require('../src/services/scanArrivalService');
const { createPurchaseQueryService } = require('../src/services/purchaseQueryService');
const { PurchaseArrivalConversationService } = require('../src/services/purchaseArrivalConversationService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const SESSION_SECRET = 'accept-ux-secret';
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
const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `accept-ux-${label}-`));

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

const sessionCookie = (openId = 'ou_accept_ux') => {
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
const get = async (base, target, openId = 'ou_accept_ux') => {
  const response = await fetch(`${base}${target}`, { headers: { cookie: sessionCookie(openId) } });
  return { response, html: await response.text() };
};
const post = (base, target, body, openId = 'ou_accept_ux') => {
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
// ⭐⭐ 2026-10-12 21:11（她真机卡住）：`GET /accept` 三次 **200** 但**没有 `scan.accept.started`**
//   ⇒ 她没点中批次行，而是点了下面那颗【进入验收】（输入框空）⇒ 表单 GET 不带 batch
//   ⇒ **原地重画同一页** ⇒ 她的感受是"点了之后里面啥也没有" ✗（我们页面的锅）。
//
//  AC-UX1 空输入点【进入验收】⇒ **一句人话**（"请先点上面那一条批次，或在下面输入批次号"）+ 仍 200。
//  AC-UX2 点中批次行（真链接）⇒ **真的开始验收**：`acceptance-rows` 清单页 + `data-batch` = 那一批。
//  AC-UX3 `?batch=` 有值但明细为空（开关开）⇒ **明确说清**"这一批没有明细"+ 手输/扫码入口仍在。
//  AC-UX4 批次行**看得出来能点**：`data-batch` 在、`<a href="…?batch=…">` 在、命中区 ≥44px + 可点外观。
//  AC-UX5 回归：无 batch 自助块 / 有 batch 清单页 / 三条路（改数量 · 自定义 · 扫码加）逐字不回归。
// ═══════════════════════════════════════════════════════════════════════════

test('AC-UX1 空输入点【进入验收】⇒ 一句人话 + 仍 200（不再原地重画同一页）', async () => {
  login();
  const h = createHarness({ noPending: true });
  await withServer(h.app, async (base) => {
    const bare = await get(base, '/s/accept');
    assert.equal(bare.response.status, 200);
    assert.equal(bare.html.includes('请先点上面那一条批次'), false, '没提交过就不该先喊这句话');
    // ⭐ 她真机上做的事：输入框空着直接点【进入验收】⇒ 表单 GET `?batch=`（值为空）
    const submitted = await get(base, '/s/accept?batch=');
    assert.equal(submitted.response.status, 200, '仍是 200（不是 400 / 不炸）');
    assert.ok(submitted.html.includes(SCAN_PAGE.texts.acceptPendingEmptySubmitHint),
      `空提交要给她一句人话：${SCAN_PAGE.texts.acceptPendingEmptySubmitHint}`);
    assert.ok(submitted.html.includes('data-view="accept-manual"'), '手输框照旧在（她还能改）');
    // 反例：**不许**变成"什么也没发生"（页面必须和裸进来那一次不同）
    assert.notEqual(submitted.html, bare.html, '空提交必须有即时反馈（页面内容要变）');
  });
});

test('AC-UX2 点中批次行 ⇒ 真的开始验收（清单页 + 那一批的批次号）', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    const list = await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    assert.equal(list.response.status, 200);
    assert.ok(list.html.includes('data-view="acceptance-rows"'), '点中批次行后是那张清单页');
    assert.ok(list.html.includes(`data-batch="${BATCH}"`), '页面上带着那一批的批次号');
    // 真链接点下去走的就是这一条（同一个 URL）——她点得到、不是死链
    const self = await get(base, '/s/accept');
    assert.equal(self.response.status, 200);
    const link = self.html.match(new RegExp(`<a class="btn batch-row"[^>]*data-batch="${BATCH}"[^>]*href="([^"]+)"`))
      || self.html.match(new RegExp(`<a class="btn batch-row"[^>]*href="([^"]+)"[^>]*data-batch="${BATCH}"`));
    assert.ok(link, '批次行必须是真链接（a[href]）');
    const clicked = await get(base, link[1].replace(/&amp;/g, '&'));
    assert.equal(clicked.response.status, 200, '点下去要 200');
    assert.ok(clicked.html.includes('data-view="acceptance-rows"'), '点下去就进验收清单');
  });
});

test('AC-UX3 ?batch= 有值但明细为空 ⇒ 明确说清 + 手输/扫码入口仍在', async () => {
  login();
  const h = createHarness({ rows: [], allowEmptyRows: true });
  await withServer(h.app, async (base) => {
    const { response, html } = await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    assert.equal(response.status, 200);
    assert.ok(html.includes(SCAN_WRITE.texts.acceptEmptyDetailBody),
      `这一批没明细时要明确说清（不许是空白页）：${SCAN_WRITE.texts.acceptEmptyDetailBody}`);
    assert.ok(html.includes(`name="${SCAN_WRITE.fields.acceptCustomSize}"`), '手输加行仍在');
    assert.ok(html.includes(SCAN_PAGE.texts.scanNextHint) || html.includes(SCAN_PAGE.texts.scanNextLabel),
      '扫码加一款的入口仍在');
  });
});

test('AC-UX4 批次行看得出来能点：真链接 + ≥44px 命中区 + 一个明确的可点外观', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    const { html } = await get(base, '/s/accept');
    const row = html.match(/<a class="btn batch-row"[^>]*>[\s\S]*?<\/a>/);
    assert.ok(row, '批次行必须在');
    assert.ok(row[0].includes(`data-batch="${BATCH}"`), 'data-batch 在');
    assert.ok(row[0].includes(`href="/s/accept?batch=${BATCH}"`), 'href 指向这一批');
    assert.ok(row[0].includes('batch-row__cta'), '右边要有一个明确的"能点"外观（› / 进入）');
    // 命中区 ≥44px：沿用既有 `.btn` 的 min-height（token），这里钉住那条规则还在
    const style = html.match(/\.btn \{[^}]*\}/);
    assert.ok(style && /min-height: var\(--control-height\)/.test(style[0]),
      '命中区沿用 .btn 的 min-height（≥44px）');
  });
});

test('AC-UX5 回归：三条既有路（改数量 / 自定义 / 扫码加）与两张页逐字不回归', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    // ① 无 batch 的自助块
    const self = await get(base, '/s/accept');
    assert.ok(self.html.includes('data-view="accept-pending"') && self.html.includes('data-view="accept-manual"'));
    // ② 有 batch 的清单页：预填 + 可改 + 自定义 + 候选
    const list = await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    assert.ok(list.html.includes('data-view="acceptance-rows"'));
    for (const size of SIZES) {
      assert.ok(new RegExp(`data-row-size="${size}"`).test(list.html), `预填少了 ${size} 码`);
    }
    assert.ok(list.html.includes(`name="${F.acceptRowQty}" value="1"`), '默认值 = 报货数量');
    assert.ok(list.html.includes(`name="${F.acceptCustomSize}"`), '自定义加行仍在');
    assert.ok(list.html.includes('data-view="accept-unreported"'), '未报货候选区仍在');
    // ③ 改数量照旧能完成（既有口径）
    const done = await post(base, '/s/accept', {
      [F.action]: A.acceptFinishRows, batch: BATCH,
      [F.acceptRowQty]: ['1', '1', '2', '1', '1'], [F.acceptAmount]: '500',
    });
    assert.equal(done.status, 200, `改数量仍能完成验收（${done.status}）`);
    assert.ok(h.confirmCalls[0].scanLines.some((line) => line.size === 37 && line.quantity === 2),
      '改后的数量要照旧传下去');
  });
});
