'use strict';

/**
 * ⭐⭐ task-31（2026-10-15 21:47 · 业务负责人真机）：扫 **有库存**的款（`HL55173-1|黑色|A`）点「退货」⇒
 *   **只有一颗按钮** ✗（连"取不到尺码"那句人话都没有）。
 *
 * ## 只读复现（本文件把结论钉成判据 ✓）
 * 用**项目代码**查她那一款（测试 Base，只读）：`found=true · rows=11 · withStock=5 · missing=6`
 * —— 与 Lead 手上的生产日志（`total:5 · sizes:11 · missing:6`）**完全一致** ✓
 * ⇒ 真路由 `GET /s/<编号>?from=purchase_return` 渲染出来**退货块 11 行** ✓
 * ⇒ **不是"有数据不画"** ✗。
 *
 * ## 根因（能画出"一句人话 + 一颗按钮"的只有一条路）
 * `scanPageRenderer.js` 的退货分支：
 * ```js
 * const form = write && write.enabled !== false ? returnFormHtml(view, write) : '';
 * return wrap(form || realmEmptyHtml(PURCHASE_RETURN_REALM, config));   // ← 兜底卡：一句话 + 一颗按钮
 * ```
 * 🔴 兜底卡那句话是「**这一款现在没有可退的尺码。**」＋ 一颗「看看这一款的库存 →」
 *   ⇒ **这一款明明有库存**时它就是**假话** ✗ —— 而且她那一屏"只有一颗按钮"正是这张卡的形状 ✓。
 * 触发条件 = 退货表单**没画出来**（`write` 为空 / `enabled === false`，即**会话没认出来 / 写入口没接上**）✗。
 *
 * ## 改法（Lead 批的两条 ✓）
 * 1. 表单没画出来 ⇒ **如实说**（`returnForm.formMissing`：'退货这一块暂时没接上，请刷新这一页重试'），
 *    **不许**再冒充"这一款没有可退的尺码" ✗；
 *    「整款 0 库存」是**另一件事** ⇒ 用 task-28 的 `noReturnableStock` ✓（两者分开 ✗）。
 * 2. **有库存就必须列出来** 单独钉死（本文件 AC-RB1）—— 表述用"**所有 `sellable > 0` 的码都在清单里**"
 *    ⇒ **task-28 前后都成立** ✓（task-28 只滤 0，不动有货的码 ✓）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；每条能真红）
 *  AC-RB1 有库存的款 ⇒ 退货块**必须列出每个 `sellable > 0` 的尺码 + 各自库存数量**（能真红）
 *  AC-RB2 一个可退尺码都没有（整款 0 / 尺码取不到）⇒ **人话**（不是空白、不给假数字 ✓）
 *  AC-RB3 库存**取不到** ⇒ 仍列出该行 + 标注"取不到"（与「0」**区分** ✗ —— 同 task-28 的 AC-RT11 ✓）
 *  AC-RB4 **表单没画出来不许撒谎**：不许出现「这一款现在没有可退的尺码」那张兜底卡，而是如实 `formMissing` ✓
 *  AC-RB5 **骨架卡不许无声停留**：失败 ⇒ 人话 + 可重试（她 2026-10-14 报过一次"一直停在骨架" ✓）
 *  AC-RB6 既有判据一条没放宽（后端字段名/`data-return-*` 契约逐字还在 ✓）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_return_guard';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'return_guard_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET || 'return_guard_session';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const { createScanPageRouter } = require('../src/routes/scanPage');
const { renderScanPage } = require('../src/views/scanPageRenderer');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');

const COOKIE = (() => {
  const payload = Buffer.from(JSON.stringify({ open_id: 'ou_return_guard', name: '自检', exp: Date.now() + 36e5 }))
    .toString('base64url');
  return `workbench_session=${payload}.${crypto.createHmac('sha256', process.env.LARK_WEB_SESSION_SECRET)
    .update(payload).digest('base64url')}`;
})();

const NUMBER = 'HL55173-1|黑色|A';
const ENCODED = encodeURIComponent(NUMBER);

/** 照她那一款的**真实形状**造一个视图：11 个码、**5 个有库存**、6 个缺码（只读复现里的 numbers ✓）。 */
const stocks = { 38: 0, 39: 1, 40: 1, 41: 0, 42: 2, 43: 0, 44: 1, 45: 0, 46: 1, 47: 0, 48: 0 };
const view = (overrides = {}) => ({
  found: true,
  number: NUMBER,
  item_no: 'HL55173-1',
  color: '黑色',
  category_name: '单鞋',
  price_text: '¥320',
  total: 5,
  columns: [{ key: '门盒', label: '门盒' }, { key: '样品', label: '样品' }],
  rows: Object.keys(stocks).map((size) => ({
    size_text: size,
    cells: [{ count: stocks[size] }, { count: 0 }],
    total: stocks[size],
    missing: stocks[size] === 0,
  })),
  missing_count: 6,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-15 21:47',
  ...overrides,
});

const appFor = (lookup = async () => view()) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => { req.requestId = 'req_return_guard'; next(); });
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup }, gateway: {}, startSnapshot: false,
    writeService: {
      sessions: { get: async () => null, submitKeyFor: () => 'scan_return:k:1', saveSaleProgress: async () => ({}) },
      listAccessories: async () => [],
    },
  }));
  return app;
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, () => resolve(instance)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const getReturnBlock = async (lookup) => {
  let block;
  await withServer(appFor(lookup), async (base) => {
    const response = await fetch(`${base}/s/${ENCODED}?from=purchase_return`, { headers: { cookie: COOKIE } });
    assert.equal(response.status, 200);
    const html = await response.text();
    const at = html.indexOf('realm-block--purchase_return');
    assert.notEqual(at, -1, '退货那一块要在页面上 ✓');
    block = html.slice(at, html.indexOf('</section>', at) + 10);
  });
  return block;
};

const sizeRowsOf = (block) => [...block.matchAll(/<div class="size-row">([\s\S]*?)<\/div>/g)].map((m) => m[1]);

/** 一个"看起来正常"的写上下文（直接渲染渲染器时用 ✓ 与 route 里 buildWriteContext 的形状一致）。 */
const writeContext = (sizes) => ({
  enabled: true, texts: SCAN_WRITE.texts, fields: SCAN_WRITE.fields, actions: SCAN_WRITE.actions,
  postAction: '/s/x?from=purchase_return', returnKey: 'scan_return:k:1', sizes,
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RB1 有库存 ⇒ 必须列出来（task-28 前后都成立 ✓ —— 你点名要单独钉死的正是这条）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RB1 ⭐⭐ 有库存的款 ⇒ **每个 `sellable > 0` 的尺码都在清单里**（含各自库存数量）', async () => {
  const block = await getReturnBlock(async () => view());
  const rows = sizeRowsOf(block);
  const stocked = Object.keys(stocks).filter((size) => stocks[size] > 0);
  assert.equal(stocked.length, 5, '（复现数据：11 个码里 5 个有库存 —— 与生产日志一致 ✓）');
  for (const size of stocked) {
    const row = rows.find((item) => item.includes(`value="${size}"`));
    assert.ok(row, `⭐ 有库存的 ${size} 码**必须**在清单里（能真红：少一个 ⇒ 红）`);
    assert.ok(row.includes('type="checkbox"'), `${size} 码要能勾 ✓`);
    assert.ok(row.includes('size-qty'), `${size} 码要能填数量 ✓`);
    assert.ok(row.includes(`data-view="return-stock"`), `${size} 码要显示库存数量 ✓`);
    assert.ok(row.includes(`>${stocks[size]}<`), `${size} 码的库存数量要是 ${stocks[size]} ✓`);
  }
  // 复现口径：**11 个码里 5 个能退** ⇒ 清单里至少这 5 个（task-28 之后正好 5 个；之前是 11 个 ✓ 两者都过）
  assert.ok(rows.length >= stocked.length, '清单不许比"有库存的码"还少 ✗');
});

test('AC-RB1b ⭐ 哨兵：**有数据时退货块不许退化成兜底卡**（她今晚那屏 = 兜底卡的形状 ✗）', async () => {
  const block = await getReturnBlock(async () => view());
  assert.equal(block.includes('state-msg'), false, '⛔ 有 11 个码的数据时不许出现"兜底卡" ✗');
  assert.equal(block.includes(SCAN_PAGE.texts.realmEmptyReturnBody), false,
    '⛔ 更不许说「这一款现在没有可退的尺码」✗（有库存还说这句 = 假话 ✓）');
  assert.ok(block.includes('data-view="purchase-return"'), '退货表单本身要在 ✓');
  assert.ok(block.includes('data-return-sizes-field='), '表单契约在（`return_sizes` ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RB2 一个可退尺码都没有 ⇒ 人话（不是空白）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RB2 ⭐ 一个可退尺码都没有 ⇒ **人话**（整款 0 库存 / 尺码取不到，两种都各有各的话 ✓）', async () => {
  // ① 整款 0 库存（11 个码全是 0）⇒ task-28 那句「这一款现在没有可退的库存」
  const allZero = view({
    total: 0, missing_count: 11,
    rows: Object.keys(stocks).map((size) => ({
      size_text: size, cells: [{ count: 0 }, { count: 0 }], total: 0, missing: true,
    })),
  });
  const block = await getReturnBlock(async () => allZero);
  assert.ok(block.includes('data-view="return-no-stock"'), '⭐ 整款 0 ⇒ 那句人话的锚 ✓（不是空白 ✗）');
  assert.ok(block.includes(SCAN_PAGE.returnForm.noReturnableStock), '人话来自配置 ✓');
  assert.equal(sizeRowsOf(block).length, 0, '一个码都不列 ✓（没有假数字 ✗）');
  // ② 尺码这一读根本没回来 ⇒ 如实说"取不到"，也不许空白
  const unknown = await getReturnBlock(async () => view({ rows: [], total: 0, missing_count: 0 }));
  assert.ok(unknown.includes('data-view="return-sizes-unknown"'), '尺码取不到 ⇒ 人话锚 ✓');
  assert.ok(unknown.includes(SCAN_PAGE.returnForm.sizesUnknown), '那句人话来自配置 ✓');
  assert.equal(unknown.includes('state-msg'), false, '⛔ 也不许退回兜底卡 ✗');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RB3 取不到 ≠ 0（同 task-28 的 AC-RT11 口径 ✓）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RB3 🔴 库存**取不到** ⇒ 仍列出该行 + 标注"取不到"（**不许当 0 藏掉** ✗）', () => {
  // 尺码有（`write.sizes`）但**没有库存**（未确认）—— 直接渲染渲染器（这一支走 route 到不了 ✓）
  const html = renderScanPage(view({ rows: [] }), SCAN_PAGE, writeContext([
    { size_text: '38', missing: false }, { size_text: '39', missing: false },
  ]), 'purchase_return', {});
  const at = html.indexOf('realm-block--purchase_return');
  const block = html.slice(at, html.indexOf('</section>', at) + 10);
  assert.equal(sizeRowsOf(block).length, 2, '⭐ 取不到也要把码列出来 ✓（当 0 藏掉 ⇒ 红）');
  assert.ok(block.includes('data-view="return-stock-unknown"'), '每行标注"取不到" ✓');
  assert.ok(block.includes(SCAN_PAGE.returnForm.stockUnknown), '那句话来自配置 ✓');
  assert.equal(block.includes('data-view="return-no-stock"'), false,
    '⛔ 取不到**不是**"整款没库存" ⇒ 不许走那句（两者分开 ✗）');
  assert.equal(/data-view="return-stock"[^>]*>\s*\d/.test(block), false, '不许给假数字 ✗');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RB4 表单没画出来 ⇒ **不许撒谎**（她今晚那屏 = 兜底卡 = 那句假话 ✗）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RB4 ⭐⭐ 退货表单**没画出来**（写入口没接上 ⇒ `write` 空）⇒ **如实说"没接上"**，不许说"没有可退的尺码" ✗', () => {
  const html = renderScanPage(view(), SCAN_PAGE, null, 'purchase_return', {});
  const at = html.indexOf('realm-block--purchase_return');
  assert.notEqual(at, -1, '退货那一块仍在（不整块消失 ✓）');
  const block = html.slice(at, html.indexOf('</section>', at) + 10);
  assert.ok(block.includes('data-view="return-form-missing"'), '⭐ 要有一个"没接上"的锚（能真红）✓');
  assert.ok(block.includes(SCAN_PAGE.returnForm.formMissing), '如实那句话来自配置 ✓');
  // 🔴 这一条是本次的**核心**：不许再借用"这一款现在没有可退的尺码"那句假话 ✗
  assert.equal(block.includes(SCAN_PAGE.texts.realmEmptyReturnBody), false,
    '⛔ 不许说「这一款现在没有可退的尺码」（有库存还说这句 = 误导 ✓）');
  assert.equal(block.includes('看看这一款的库存'), false, '⛔ 也不许只留兜底卡那颗"去看看库存"的按钮 ✗');
  // 数据还在的时候（同一屏的库存表）不受影响 ✓
  assert.ok(html.includes(NUMBER), '这一款本身照旧在页面上 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RB5 骨架卡不许无声停留（她 2026-10-14 报过一次；这次一并钉死 ✓）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RB5 ⭐ 骨架的 `?data=1` 失败 ⇒ **人话 + 可重试**（不许无声停在"一张卡 + 一颗按钮" ✗）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/views/scanPageRenderer.js'), 'utf8');
  // ① 失败必须走 `showProblem()`（人话 + 重试），不许 catch 里静默 return
  assert.match(src, /function showProblem\(\)/, '要有"出问题"那条路 ✓');
  // ⚠️ 源码里它们是 `setAttribute('data-view', 'scan-skeleton-error')` 这个形状（不是 HTML 属性 ✓）
  assert.match(src, /'scan-skeleton-error'/, '要给她一句人话 ✓');
  assert.match(src, /'scan-skeleton-retry'/, '要给她一颗**可重试**的按钮 ✓');
  assert.match(src, /retry\.addEventListener\('click'/, '那颗按钮要真能重试 ✓（不是摆设 ✗）');
  assert.match(src, /data-problem/, '要防止反复刷那句话（同一屏只刷一次 ✓）');
  // ② 失败出口必须真的汇到它（能真红：把 `retryOrProblem()` 的调用删掉 ⇒ 这条红）
  //    ⚠️ 真实形状：**第一次**失败 ⇒ 自动重试一次（`showSlow(); load()`）；**第二次** ⇒ `showProblem()`
  assert.match(src, /function retryOrProblem\(\)/, '要有一个失败漏斗 ✓');
  assert.match(src, /if \(attempt === 1\) \{ showSlow\(\); load\(\); return; \}/,
    '第一次失败 ⇒ 只自动重试一次（不无限循环 ✓）');
  const funnelCalls = (src.match(/retryOrProblem\(\);/g) || []).length;
  assert.ok(funnelCalls >= 2, `失败那几条出口（空 body / 仍是骨架 / 请求错）都要汇到漏斗（实际 ${funnelCalls} 处 ✓）`);
  assert.match(src, /showProblem\(\);/, '漏斗第二跳要给她人话 + 手动重试 ✓');
  // ③ 两句文案走配置（页面上不写死中文 ✓）
  assert.ok(typeof SCAN_PAGE.texts.skeletonErrorText === 'string' && SCAN_PAGE.texts.skeletonErrorText.length > 0,
    '骨架失败那句话走配置 ✓');
  assert.ok(typeof SCAN_PAGE.texts.skeletonRetryLabel === 'string' && SCAN_PAGE.texts.skeletonRetryLabel.length > 0,
    '重试按钮的文案走配置 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RB6 既有契约一条不放宽（后端字段名 / 表单属性逐字还在）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RB6 既有契约一条没放宽：`return_sizes` / `return_qty_<尺码>` / 上限与三句人话都在 ✓', async () => {
  const block = await getReturnBlock(async () => view());
  for (const needle of [
    `name="${SCAN_WRITE.fields.returnSizes}"`,
    `${SCAN_WRITE.fields.returnQuantityPrefix}39`,
    'data-return-required-text=', 'data-return-quantity-text=', 'data-return-stock-text=',
    'data-return-max-quantity=', 'data-return-max-sizes=',
    `value="${SCAN_WRITE.actions.purchaseReturn}"`,
  ]) {
    assert.ok(block.includes(needle), `退货表单少了 ${needle} ✗`);
  }
  // ⭐ 「退货数量 ≤ 该行库存」的上限仍在（#604 那条判据不放宽 ✓）
  assert.match(block, /data-stock="1"[^>]*value="39"|value="39"[^>]*data-stock="1"/, '39 码上限 = 库存 1 ✓');
});
