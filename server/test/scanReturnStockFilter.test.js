'use strict';

/**
 * ⭐⭐ task-28（2026-10-15 · 业务负责人就 #604 的退货交互补的一条口径，逐字）：
 *   「库存 0 的码（缺码）现在也退不了 —— 这是"不能超库存"的字面结果，
 *     **退货严格按照实时库存里的数据来，只展示有数量的尺码**，以及**数量不能超过实时库存里的数量**」
 *
 * ⇒ 两件事**必须分开**（混了就会把能退的码藏掉 ✗）：
 *   · **库存 = 0** ⇒ **不进清单**（不是"列出来显示「—」但退不了"✗）；
 *   · **库存 = 取不到 / 未确认** ⇒ **仍然列出来** + 标注"取不到" ✓。
 *   · 整款都是 0 ⇒ **如实人话**（不许空白 ✗）。
 *
 * ⚠️ 本文件是**新建**的（不去改别人在动的用例文件 ✓）。
 * ⚠️ 路由夹具与 `scanReturnSizeList.test.js`（#604 那一版）同一套：真路由 + 假 lookup + 假写服务 ✓。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；每条能真红）
 *  AC-RT8 某码库存 0 ⇒ **它不出现在清单里**（能真红：改回显示 ⇒ 红）
 *  AC-RT9 有库存的码照旧：勾选框 / 数量输入 / **数量列 = 库存数** / 上限仍是库存（#604 的 RT7 不放宽 ✓）
 *  AC-RT10 整款 0 库存 ⇒ **人话**（不是空白，也不给一颗点了没用的按钮 ✓）
 *  AC-RT11 🔴 **「取不到」与「0」必须区分**：取不到 ⇒ **仍然列出** + 标注"取不到"（当 0 藏掉 ⇒ 红）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_return_stock_filter';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'return_stock_filter_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET || 'return_stock_filter_session';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

// ⚠️ 2026-10-16 深夜（成对迁移）：本文件原来那一行草稿前置（那一族的显式开关）**已随 `config/scanDraft.js` 整件退场而作废** ⇒ 删除。
//   依据 = 业务负责人 2026-10-16 22:0x「**存草稿的功能都删除吧……整个链路都删除**」· 断言一条没删、没放宽 ✓

const { createScanPageRouter } = require('../src/routes/scanPage');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');

const COOKIE = (() => {
  const payload = Buffer.from(JSON.stringify({ open_id: 'ou_return_stock', name: '自检', exp: Date.now() + 36e5 }))
    .toString('base64url');
  return `workbench_session=${payload}.${crypto.createHmac('sha256', process.env.LARK_WEB_SESSION_SECRET)
    .update(payload).digest('base64url')}`;
})();

const NUMBER = 'N05|黑色|A';
const ENCODED = encodeURIComponent(NUMBER);

/** 扫码时**已经取到**的尺码/库存结构 —— 40 有 3 双 · 41 **缺码 0 双** · 42 有 1 双。 */
const view = (overrides = {}) => ({
  found: true,
  number: NUMBER,
  item_no: 'N05',
  color: '黑色',
  category_name: '休闲鞋',
  price_text: '¥399',
  total: 4,
  columns: [{ key: '门盒', label: '门盒' }, { key: '样品', label: '样品' }],
  rows: [
    { size_text: '40', cells: [{ count: 2 }, { count: 1 }], total: 3, missing: false },
    { size_text: '41', cells: [{ count: 0 }, { count: 0 }], total: 0, missing: true },
    { size_text: '42', cells: [{ count: 1 }, { count: 0 }], total: 1, missing: false },
  ],
  missing_count: 1,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-15 21:50',
  ...overrides,
});

const fakeWriteService = () => ({
  sessions: {
    get: async () => null,
    submitKeyFor: () => 'scan_return:probe:1',
    saveSaleProgress: async () => ({ ok: true }),
  },
  listAccessories: async () => [],
});

const appFor = (lookup = async () => view()) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => { req.requestId = 'req_return_stock'; next(); });
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup }, gateway: {}, writeService: fakeWriteService(), startSnapshot: false,
  }));
  return app;
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const getReturnBlock = async (lookup) => {
  let block;
  await withServer(appFor(lookup), async (base) => {
    const response = await fetch(`${base}/s/${ENCODED}?from=purchase_return`, { headers: { cookie: COOKIE } });
    assert.equal(response.status, 200, '退货那一页要能打开 ✓');
    const html = await response.text();
    const start = html.indexOf('realm-block--purchase_return');
    assert.notEqual(start, -1, '退货那一块要在页面上 ✓');
    block = html.slice(start, html.indexOf('</section>', start) + 10);
  });
  return block;
};

const sizeRowsOf = (block) => [...block.matchAll(/<div class="size-row">([\s\S]*?)<\/div>/g)].map((m) => m[1]);

// ═══════════════════════════════════════════════════════════════════════════
// AC-RT8 库存 0 ⇒ 不进清单
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RT8 ⭐ 某码库存 0（41 缺码）⇒ **它不出现在清单里**', async () => {
  const block = await getReturnBlock(async () => view());
  assert.equal(block.includes('value="41"'), false, '⭐ 库存 0 的 41 码不进清单（能真红：改回显示 ⇒ 红）');
  assert.equal(block.includes(`${SCAN_WRITE.fields.returnQuantityPrefix}41`), false,
    '它也不该有自己的数量输入 ✓');
  assert.equal(block.includes(`>41 码<`), false, '连"41 码"这个勾选项都不该出现 ✓');
  // 有数量的两个码照常在（别误伤 ✗）
  assert.ok(block.includes('value="40"') && block.includes('value="42"'), '有数量的 40 / 42 照旧在 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RT9 有库存的码照旧（#604 的三条判据都不放宽）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RT9 ⭐ 有库存的码照旧：勾选框 / 数量输入 / **数量列 = 库存数** / 上限仍是库存', async () => {
  const block = await getReturnBlock(async () => view());
  const rows = sizeRowsOf(block);
  assert.equal(rows.length, 2, '只剩有数量的两行 ✓');
  const rowFor = (size) => rows.find((row) => row.includes(`value="${size}"`));
  assert.ok(rowFor('40').includes('type="checkbox"'), '还是勾选框 ✓');
  assert.ok(rowFor('40').includes('size-qty'), '还是数量输入 ✓（#604 的形状不动 ✓）');
  // 数量列仍是"当前库存数量"（40 ⇒ 3）
  assert.ok(rowFor('40').includes('data-view="return-stock"'), '数量列那个稳定锚还在 ✓');
  assert.match(rowFor('40'), />3</, '40 码显示 3（门盒 2 + 样品 1）✓');
  // 上限 = **这一行的库存**（#604 的 RT7 判据不放宽：`data-stock` 还在、且等于库存 ✓）
  assert.match(block, /data-stock="3"[^>]*value="40"|value="40"[^>]*data-stock="3"/,
    '⭐ 40 码的库存上限仍是 3（`data-stock` ✓ 既有关键判据没放宽 ✓）');
  assert.match(block, /data-stock="1"[^>]*value="42"|value="42"[^>]*data-stock="1"/, '42 码上限 1 ✓');
  // 三句人话 / 默认值走配置（#604 的另两条判据，一条没动 ✓）
  assert.ok(block.includes('data-return-required-text=') && block.includes('data-return-quantity-text=')
    && block.includes('data-return-stock-text='), '三条拦截人话仍在（走配置 ✓）');
  assert.ok(block.includes('data-return-max-quantity=') && block.includes('data-return-max-sizes='),
    '上限配置仍在 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RT10 整款 0 库存 ⇒ 人话（不是空白）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RT10 ⭐ 整款都没有库存 ⇒ **如实人话**（不是空白，也不给一颗点了没用的按钮）', async () => {
  const zeroView = () => view({
    total: 0,
    missing_count: 3,
    rows: [
      { size_text: '40', cells: [{ count: 0 }, { count: 0 }], total: 0, missing: true },
      { size_text: '41', cells: [{ count: 0 }, { count: 0 }], total: 0, missing: true },
    ],
  });
  const block = await getReturnBlock(async () => zeroView());
  assert.ok(block.includes('data-view="return-no-stock"'), '⭐ 要有那句人话的锚（能真红）✓');
  assert.ok(block.includes(SCAN_PAGE.returnForm.noReturnableStock), '人话来自配置 ✓');
  assert.equal(sizeRowsOf(block).length, 0, '一个码都不列（库存全是 0 ✓）');
  assert.equal(block.includes(`name="${SCAN_WRITE.fields.returnSizes}"`), false, '没有可勾的码 ⇒ 不渲染勾选框 ✓');
  // ⚠️ 别拿"隐藏 action 字段"当按钮（它在表单里照旧 ✓）—— 判据是**那颗按钮**在不在
  assert.equal(/<button[^>]*type="submit"/.test(block), false,
    '⭐ 也没有"提交"那一颗（点了也没东西可退 ⇒ 别给她死路 ✓）');
  assert.ok(block.includes(SCAN_WRITE.actions.purchaseReturn),
    '（隐藏的 action 字段照旧在表单里 ✓ 那是提交契约的一部分 ✓）');
  // 但那一块**仍在**（不是整块消失 ✗）
  assert.ok(block.includes('data-view="purchase-return"'), '退货那一块仍在 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RT11 「取不到」≠「0」——取不到必须仍列出 + 标注
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RT11 🔴 库存**取不到** ⇒ **仍然列出** + 标注"取不到"（**不许当 0 藏掉** ✗）', async () => {
  // ⚠️ "库存取不到"在这种页面上长这样：**尺码有**（`write.sizes`）但**没有 sellable**（未确认）——
  //    走真路由时 `view.rows` 空 ⇒ 连 `write.sizes` 也空（尺码那一读根本没回来 ⇒ 见 ② 那条人话 ✓）
  //    ⇒ "尺码有、库存取不到"这一支**直接渲染**（与 #604 的 AC-RT5 ② 同一手法 ✓）。
  const { renderScanPage } = require('../src/views/scanPageRenderer');
  const fallbackWrite = {
    enabled: true, texts: SCAN_WRITE.texts, fields: SCAN_WRITE.fields, actions: SCAN_WRITE.actions,
    postAction: '/s/x?from=purchase_return', returnKey: 'scan_return:k:1',
    sizes: [{ size_text: '40', missing: false }, { size_text: '42', missing: false }],
  };
  const html = renderScanPage(view({ rows: [] }), SCAN_PAGE, fallbackWrite, 'purchase_return', {});
  const start = html.indexOf('realm-block--purchase_return');
  const block = html.slice(start, html.indexOf('</section>', start) + 10);
  const rows = sizeRowsOf(block);
  assert.ok(rows.length > 0, '🔴 **取不到**也要把尺码列出来（能真红：当 0 藏掉 ⇒ 红）✓');
  assert.equal(rows.length, 2, '两个尺码都列出来 ✓');
  assert.ok(block.includes('data-view="return-stock-unknown"'), '每一行都标注"取不到"那个锚 ✓');
  assert.ok(block.includes(SCAN_PAGE.returnForm.stockUnknown), '那句"取不到"的人话来自配置 ✓');
  assert.equal(block.includes('data-view="return-no-stock"'), false,
    '⛔ 取不到**不是**"整款没库存" ⇒ 不许走那句人话（两者必须分开 ✗）');
  // ⛔ 取不到时**不许**给一个假数字（那一格只能是"取不到"那句话 ✓）
  assert.equal(/data-view="return-stock"[^>]*>\s*\d/.test(block), false, '不给假数字 ✓');

  // ② 尺码这一读**根本没回来**（连尺码都没有）⇒ 也要有**人话**（不是空白 ✗）
  let emptyBlock;
  await withServer(appFor(async () => view({ rows: [], total: 0, missing_count: 0 })), async (base) => {
    const response = await fetch(`${base}/s/${ENCODED}?from=purchase_return`, { headers: { cookie: COOKIE } });
    const text = await response.text();
    const at = text.indexOf('realm-block--purchase_return');
    emptyBlock = text.slice(at, text.indexOf('</section>', at) + 10);
  });
  assert.ok(emptyBlock.includes('data-view="return-sizes-unknown"'), '尺码取不到 ⇒ 人话锚 ✓');
  assert.ok(emptyBlock.includes(SCAN_PAGE.returnForm.sizesUnknown), '那句人话来自配置 ✓（不是空白 ✗）');
});
