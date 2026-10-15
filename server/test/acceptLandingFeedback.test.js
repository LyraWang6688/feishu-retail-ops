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
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
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

/**
 * ⭐⭐ 2026-10-14 晚（业务负责人口径）：**「`/s/accept` 这条路要彻底拆掉」**
 *
 * ⚠️ **本文件原样保留夹具，只把"验收落地页必须存在"那一族断言**（改前逐字：GET /s/accept ⇒ 200 +
 *    列未到货批次 + 手输兜底 + 进验收模式 …）**改成"必须不存在"** ✓（**不是整份删覆盖** ✗）：
 *    · 路由里**没有** `/accept` 注册 ✓
 *    · 渲染层里**没有**验收那一块的标记（`data-view="acceptance"` / `accept-pending`）✓
 *    · 旧 `?from=accept` **回落销售**（`resolveRealm` 既有口径 ✓ 不报错 ✓）
 *    · **仍成立、照旧不许动**的：加库存走 `InventoryService.applyPurchase` ✓ ·
 *      工作台 `POST /api/workbench/purchase/arrivals/confirm` ✓ · 工作台「采购 → 验收」那屏 ✓
 */
const SRC_DIR = path.join(__dirname, '../src');
const readSrc = (rel) => fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');

test('AC-OFF1 🔴 路由里**没有** `/accept` 注册（扫码页那条路已彻底拆掉）', () => {
  const routes = readSrc('routes/scanPage.js');
  assert.equal(/router\.(get|post)\('\/accept'/.test(routes), false,
    '改前逐字：router.get(\'/accept\'…) 存在 ✓ ⇒ 改后：**必须没有** ✓（依据：她 2026-10-14 晚「这条路要彻底拆掉」）');
});

test('AC-OFF2 🔴 渲染层里**没有**验收那一块的标记（`data-view="acceptance"` / `accept-pending`）', () => {
  const renderer = readSrc('views/scanPageRenderer.js');
  assert.equal(renderer.includes('data-view="acceptance"'), false, '改前逐字：必须有 data-view="acceptance" ✗ ⇒ 改后：必须没有 ✓');
  assert.equal(renderer.includes('accept-pending'), false, '改前逐字：自助块 data-view="accept-pending" ✗ ⇒ 改后：必须没有 ✓');
  assert.equal(/renderAcceptance(Page|DonePage|SelfServe)/.test(renderer), false, '三个验收渲染函数随验收一起退场 ✓');
});

test('AC-OFF3 🔴 旧 `?from=accept` **回落销售**（不报错、不白屏）', () => {
  const { resolveRealm } = require('../src/views/scanPageRealm');
  // ⭐⭐ 2026-10-14 晚 **cut B 成对翻新**（依据：业务负责人逐字「**`/s/accept` 这条路要彻底拆掉**」
  //    ＋ Lead 的 cut B 清单「REALMS 删 `accept`」）：
  //   改前逐字：`assert.equal(resolveRealm('accept'), 'accept', 'cut A：领域还在（cut B 删它时才变 sales ✓ 不提前谎报 ✗）');`
  //   改后逐字：`assert.equal(resolveRealm('accept'), 'sales', 'cut B：accept 已退出 REALMS ⇒ 按既有口径回落缺省 ✓');`
  //   依据：cut A 拆的是"路"（`/s/accept` 不再有路由），cut B 拆的是**领域本身** ⇒
  //     `accept` 现在与 `?from=purchase` / `?from=accessory` / `?from=new` **同一条口径**：
  //     认不出的值一律回落缺省（销售），**不报错、不白屏** ✓（判据没放宽：另一条断言逐字不变 ✓）
  assert.equal(resolveRealm('accept'), 'sales', 'cut B：accept 已退出 REALMS ⇒ 按既有口径回落缺省 ✓');
  assert.equal(resolveRealm('bogus'), 'sales', '认不出的一律回落缺省（既有口径一字不动 ✓）');
});

test('AC-OFF4 ✅ 仍成立、照旧不许动的（共享能力没跟着删）', () => {
  const routes = readSrc('routes/workbench.js');
  assert.match(routes, /router\.post\('\/purchase\/arrivals\/confirm'/, '工作台"确认到货"接口照旧 ✓');
  const renderer = readSrc('views/scanPageRenderer.js');
  assert.ok(renderer.length > 0);
  const inventory = readSrc('services/inventoryService.js');
  assert.match(inventory, /applyPurchase/, '加库存仍只走 `InventoryService.applyPurchase` ✓');
});
