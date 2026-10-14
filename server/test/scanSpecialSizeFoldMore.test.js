'use strict';

/**
 * ⭐⭐ 2026-10-14「特殊码折叠」**扩到库存 + 补货**，＋ 补货页新版式（**先写先红**）。
 *
 * 口径真源：`docs/special-size-fold-and-enterable-base-2026-10-14.md`（她的原话逐字）
 *   ① 可录范围（女 34–43 / 男 38–48）= 缺货/预订**基准**
 *   ② **有货 ⇒ 全展示**（含特殊码）
 *   ③ **缺货 = 可录范围 − 有货**：缺货**普通码**照旧正常展示；缺货**特殊码** ⇒ 默认收起的「特殊码」折叠块
 *   ④ **三处都要**：销售（#515 已完成）· **库存** · **补货**
 *   ⑤ 补货版式：每格「**尺码 × 数量**」· **一行 3 个** · 自动换行 · 每格 ≥44px · 列数走配置
 *      🔴 **禁用 `auto-fit` / `auto-fill`**（那会变 2/4 列 ✗ 她要的是"保持一行 3 个"）
 *   ⑥ **缺码默认勾**语义**不变**
 *
 * ⚠️ 本文件现在**故意是红的**（库存/补货还没折叠、补货还是一行一条）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_sfm';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'sfm_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { renderScanPage } = require('../src/views/scanPageRenderer');
const { saleSizeGroups, purchaseSizeLines } = require('../src/views/scanPageRealm');

const RENDERER_SRC = fs.readFileSync(path.join(__dirname, '../src/views/scanPageRenderer.js'), 'utf8');
const REALM_SRC = fs.readFileSync(path.join(__dirname, '../src/views/scanPageRealm.js'), 'utf8');

/** 女鞋（B）一款：36 有货；34/35/42/43 是缺货的特殊码；37..41 是缺货的普通码。 */
const femaleView = () => ({
  found: true,
  number: 'JX505|咖色|B',
  item_no: 'JX505',
  color: '咖色',
  category_name: '休闲鞋',
  price_text: '¥399',
  total: 1,
  columns: [{ key: '门盒', label: '门盒' }, { key: '样品', label: '样品' }, { key: '仓库', label: '仓库' }],
  rows: [
    ...[36].map((size) => ({ size_text: String(size), cells: [{ key: '门盒', count: 1 }], total: 1, missing: false })),
    ...[34, 35, 42, 43, 37, 38, 39, 40, 41].map((size) => ({ size_text: String(size), cells: [{ key: '门盒', count: 0 }], total: 0, missing: true })),
  ],
  missing_count: 9,
  sizes_degraded: false,
  notes: [],
  updated_at_text: 't',
});

const WRITE = {
  enabled: true,
  texts: SCAN_PAGE.texts,
  fields: {},
  actions: {},
  sizes: [],
  replenishEnabled: true,
  replenishSizes: [],
};

const pageOf = (realm, view = femaleView()) => renderScanPage(view, SCAN_PAGE, WRITE, realm);

// ═══════════════════════════════════════════════════════════════════════════
// 一处共用判据（三处都调它 ⇒ 不许三处各写一遍 if ✗）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MF1 ⭐ 判据**只有一处**（缺货 ∩ 特殊码）：三处都调同一个 helper', () => {
  assert.match(REALM_SRC, /const specialSizesOfView = \(view\) => \{/, '共用判据 `specialSizesOfView` 在 realm 里（一处定义 ✓）');
  // 库存 / 补货 两条链都不许自己再写一遍"是不是特殊码"
  const extra = (REALM_SRC.match(/range\?\.special/g) || []).length;
  assert.equal(extra, 1, `"特殊码"的取值只许有一处（实际 ${extra} 处 ✗ 三处各写一遍 = 漂）`);
  assert.match(REALM_SRC, /const foldedSpecialRowsOf = \(view\)/, '库存/补货共用的"缺货 ∩ 特殊码"helper 存在 ✓');
});

test('AC-MF2 ⭐ 库存页：缺货的特殊码出现在**折叠块**里（默认收起），普通码的行列不受影响', () => {
  const html = pageOf('inventory');
  const foldStart = html.indexOf('data-special-fold');
  assert.ok(foldStart > -1, '库存页要有「特殊码」折叠块（缺货的特殊码不许消失 ✗）');
  const fold = html.slice(foldStart, html.indexOf('</details>', foldStart));
  assert.ok(fold.includes('<summary'), '折叠块用原生 `<summary>` ✓');
  assert.equal(/<details[^>]*\sopen/.test(fold.slice(0, 200)), false, '**默认收起**（不带 open ✓）');
  for (const size of ['34', '35', '42', '43']) {
    assert.ok(fold.includes(`>${size} 码<`) || fold.includes(`>${size}<`), `缺货的特殊码 ${size} 要在折叠块里`);
  }
  // ⭐ 折叠块**不许**塞进库存表本体（`stockTableHtml` 那块是 `AC1` 逐字哨兵罩着的）
  const tableEnd = html.indexOf('</table>');
  assert.ok(tableEnd > -1 && foldStart > tableEnd, '折叠块要在库存表**之外**（AC1 哨兵 ✓）');
  // 普通码照旧在表里
  const table = html.slice(html.indexOf('<table'), tableEnd);
  assert.ok(table.includes('>37<') || table.includes('37 码'), '缺货的普通码 37 照旧在库存表里 ✓');
});

test('AC-MF3 ⭐ 补货页：缺货的特殊码进折叠块；缺货的普通码照旧在列表里（语义不变）', () => {
  const html = pageOf('replenish');
  const lines = purchaseSizeLines(femaleView()).map((item) => item.size_text);
  for (const size of ['37', '38', '39', '40', '41']) {
    assert.ok(lines.includes(size), `缺货的普通码 ${size} 照旧在补货清单里 ✓`);
  }
  const foldStart = html.indexOf('data-special-fold');
  assert.ok(foldStart > -1, '补货页也要有「特殊码」折叠块 ✓');
  const fold = html.slice(foldStart, html.indexOf('</details>', foldStart));
  for (const size of ['34', '35', '42', '43']) {
    assert.ok(fold.includes(size), `缺货的特殊码 ${size} 要在补货折叠块里`);
  }
});

test('AC-MF4 ⭐ 折叠块仍按**男女各自一块**（女鞋块里不许出现男鞋的特殊码）', () => {
  const male = { ...femaleView(), number: 'MK31|黑|A', rows: [
    { size_text: '40', cells: [{ key: '门盒', count: 1 }], total: 1, missing: false },
    ...[46, 47, 48].map((size) => ({ size_text: String(size), cells: [{ key: '门盒', count: 0 }], total: 0, missing: true })),
  ] };
  const femaleFold = pageOf('replenish').slice(pageOf('replenish').indexOf('data-special-fold'));
  assert.equal(femaleFold.includes('>46<') || femaleFold.includes('>46 码<'), false, '女鞋页不许出现男鞋特殊码 46 ✗');
  const maleHtml = pageOf('replenish', male);
  const maleFold = maleHtml.slice(maleHtml.indexOf('data-special-fold'));
  assert.ok(maleFold.includes('46') && maleFold.includes('47') && maleFold.includes('48'), '男鞋页折叠块 = 46/47/48');
});

// ═══════════════════════════════════════════════════════════════════════════
// 补货版式：尺码 × 数量 · 一行 3 个 · 自动换行 · ≥44px · 列数走配置
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MF5 ⭐⭐ 补货版式：**一行 3 个**（列数走配置 `purchaseSizes.columnsPerRow`）· 自动换行', () => {
  const cfg = SCAN_PAGE.purchaseSizes || {};
  assert.equal(cfg.columnsPerRow, 3, '`purchaseSizes.columnsPerRow` = 3（**显式数字** ✓ 不许 || 兜底 ✗）');
  // CSS：固定列数 + 每列自适应（minmax(0,1fr) ⇒ 内容再长也不撑爆 ⇒ 不会变 2 个 ✗）
  assert.match(RENDERER_SRC, /\.purchase-size-grid \{[^}]*grid-template-columns: repeat\(var\(--size-cols, 3\), minmax\(0, 1fr\)\)/,
    'CSS 必须 `repeat(var(--size-cols, 3), minmax(0, 1fr))` ✓');
  // ⚠️ 只在**那条 CSS 规则**里判（注释里出现这四个字不算 ✗ —— 我自己就写了"不用 auto-fit"的注释）
  const gridRule = (RENDERER_SRC.match(/\.purchase-size-grid \{[^}]*\}/) || [''])[0];
  assert.ok(gridRule.length > 0, '`.purchase-size-grid` 规则存在 ✓');
  assert.equal(/auto-fit|auto-fill/.test(gridRule), false, '🔴 规则里不许用 auto-fit / auto-fill（那会变 2/4 列 ✗）');
  // 渲染层把配置写进 CSS 变量（以后改配置就行 ⇒ 一行代码不动 ✓）
  const html = pageOf('replenish');
  assert.match(html, /--size-cols:\s*3/, '渲染出的 CSS 变量来自配置（`--size-cols: 3`）✓');
  // ⚠️ 类名与既有的 `.purchase-sizes` 共存（旧选择器/旧断言照旧 ✓）⇒ 不能要求引号紧跟其后
  assert.match(html, /class="purchase-size-grid\b/, '补货列表用新网格类名 ✓');
});

test('AC-MF6 ⭐⭐ 每格 = 「**尺码 × 数量**」· 命中区 ≥44px · 数量 0 照旧显示 0', () => {
  assert.match(RENDERER_SRC, /\.purchase-size-cell \{[^}]*min-height: var\(--control-height\)/,
    '每格 ≥44px（`--control-height` = 44px ✓ 她的老规矩 ✓）');
  const html = pageOf('replenish');
  const grid = html.slice(html.indexOf('purchase-size-grid'), html.indexOf('</ul>', html.indexOf('purchase-size-grid')));
  assert.ok(grid.includes('37'), '缺货的普通码 37 在格子里 ✓');
  assert.ok(/\u00d7|×/.test(grid), '格子里要有「尺码 × 数量」的乘号 ✓（她逐字要求）');
  assert.match(grid, /0 双|>0</, '数量 0 ⇒ 照旧显示 0（不藏 ✗）');
});

test('AC-MF7 ⭐ 回归：**缺码默认勾**语义不变（补货要补的就是缺的那些）', () => {
  const lines = purchaseSizeLines(femaleView());
  const missing = lines.filter((item) => item.missing).map((item) => item.size_text);
  assert.ok(missing.includes('37'), '缺货的普通码仍标缺码 ✓');
  assert.equal(lines.filter((item) => item.checked).map((item) => item.size_text).sort().join(','),
    missing.slice().sort().join(','), '`checked` 仍跟着 `missing` 走（语义不变 ✓）');
  // 渲染上：缺码那一格仍默认勾着（checked 属性在表单里）
  const html = pageOf('replenish');
  assert.match(html, /value="37"[^>]*checked|checked[^>]*value="37"/, '缺码 37 那一格仍默认勾 ✓');
});

test('AC-MF8 ⭐ 哨兵：可录范围本体 + 销售页（#515）**一字不动**', () => {
  const { sizesForCategory, enterableScopeOf } = require('../src/services/scanPageService');
  assert.deepEqual(sizesForCategory('B', SCAN_PAGE).sizes, [34, 35, 36, 37, 38, 39, 40, 41, 42, 43], '验收页口径不动 ✓');
  assert.deepEqual(enterableScopeOf('B', SCAN_PAGE).sizes, [34, 35, 36, 37, 38, 39, 40, 41, 42, 43], '可录范围不动 ✓');
  const groups = saleSizeGroups(femaleView());
  assert.deepEqual(groups.folded.map((item) => Number(item.size_text)), [34, 35, 42, 43], '销售页折叠组（#515）不动 ✓');
  assert.deepEqual(groups.inStock.map((item) => item.size_text), ['36'], '有货的 36 仍在现货 ✓');
});
