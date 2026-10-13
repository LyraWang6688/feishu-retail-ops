'use strict';

/**
 * ⭐ 2026-10-13（她真机截图）：「**库存**」和「**标签**」**重叠**了 ✗
 *   她的口径逐字：「在一行也行，但是『库存』和『标签』重叠了」·「**绝对不许重叠**」✓
 *
 * 病根：`.realm-tab { white-space: nowrap }` 在**三列等宽**网格里 ⇒ 窄屏时列被压缩、
 *   文字溢出格子 ⇒ 两个标签压在对方身上 ✗
 * 修法：**追加一层覆盖**（`REALM_BAR_STYLE`）把 `.realm-tab` 改回可换行 + 允许断词 ✓
 *   ⚠️ 为什么用"追加覆盖"而不是改那段 STYLE：那段 STYLE 是**大模板串**，
 *     中文门禁把它**整段当一个串**读 ⇒ 动它就算"新增"（前几轮踩过 ✓ 所以这里不动它 ✓）
 *   ⚠️ 三行三列的顺序（销售·补货·库存 ／ 标签·上新·配品）**一个字都没改** ✓
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_realm_bar';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'realm_bar_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { renderScanPage, STYLE } = require('../src/views/scanPageRenderer');

const SRC = fs.readFileSync(path.join(__dirname, '../src/views/scanPageRenderer.js'), 'utf8');
const NAMES = ['销售', '补货', '库存', '标签', '上新', '配品'];

const pageHtml = () => renderScanPage({
  found: false, number: 'X', rows: [], columns: [],
}, SCAN_PAGE, null, 'sales', {});

test('AC-BAR1 ⭐ 六个 tab 名称与顺序逐字 = 销售·补货·库存·标签·上新·配品（回归）', () => {
  const html = pageHtml();
  const labels = [...html.matchAll(/<a[^>]*class="[^"]*realm-tab[^"]*"[^>]*>([^<]*)<\/a>/g)].map((m) => m[1].trim());
  assert.deepEqual(labels.slice(0, 6), NAMES, `六个 tab 的名称/顺序必须逐字（实际 ${JSON.stringify(labels)}）`);
});

test('AC-BAR2 🔴 每个标签各在自己那一格（**不许**出现「库存标签」连在一起 ✗）', () => {
  const html = pageHtml();
  const bar = (html.match(/<nav[^>]*realm-bar[\s\S]*?<\/nav>/) || [html])[0];
  // ① 每个名字都必须被**自己的标签包着**（两两分开 ✓ 不是挤进同一个 <a> ✗）
  for (const name of NAMES) {
    assert.match(bar, new RegExp(`>\\s*${name}\\s*<`), `「${name}」必须在自己那一格里`);
  }
  // ② ⭐ 可见文本里**不许**出现两个名字直接相连（那就是"叠字/挤在一格" ✗）
  const visible = bar.replace(/<[^>]*>/g, '|');
  assert.equal(visible.includes('库存标签'), false,
    '「库存标签」连在一起 = 重叠/挤在一格 ✗（她的原话：不许重叠）');
});

test('AC-BAR3 🔴 覆盖层必须**恢复 `nowrap`**（文字不许被竖拆成两行 ✗）', () => {
  // ⚠️ 2026-10-13 第二次修：上一版用 `white-space: normal` 消重叠 ⇒ 两个字被**竖拆** ✗（她截图：销/售 各一行 ✗）
  //    正解 = **nowrap（一行）+ 缩小字号/内边距** ⇒ 三格放得下（不重叠 ✓）且都完整（不竖拆 ✓）
  // 判据分两层（都在**覆盖层自己**上，不受基础 STYLE 里别的规则的 overflow-wrap 影响 ✓）：
  const override = (SRC.match(/const REALM_BAR_STYLE = `([\s\S]*?)`;/) || ['', ''])[1];
  assert.ok(override.length > 0, '覆盖层必须存在 ✓');
  assert.match(override, /\.realm-tab\s*\{[^}]*white-space:\s*nowrap/, '覆盖层必须把 `.realm-tab` 设回 nowrap ✓');
  assert.equal(/white-space:\s*normal/.test(override), false, '覆盖层里不许有 normal（竖拆元凶 ✗）');
  assert.equal(/overflow-wrap/.test(override), false, '覆盖层里不许允许任意断词（竖拆元凶 ✗）');
  // 且它**真的进了页面**、排在基础之后（级联生效 ✓ 不是写了没用 ✗）
  const style = (pageHtml().match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];
  const hits = [...style.matchAll(/white-space:\s*nowrap/g)].map((m) => m.index);
  assert.ok(hits.length >= 2, `基础 + 覆盖都要在（实际 ${hits.length} 处 nowrap）`);
  assert.equal(/white-space:\s*normal/.test(style), false, '🔴 页面上不许再出现 normal（那会把销/售竖拆 ✗）');
});

test('AC-BAR4 每格可点高度 ≥ 44px（她的老规矩，回归）', () => {
  assert.match(STYLE, /\.realm-tab\s*\{[^}]*min-height:\s*var\(--control-height\)/s,
    '`.realm-tab` 必须保留 min-height: var(--control-height)（= 44px ✓）');
  assert.match(SRC, /\.realm-bar\s*\{\s*grid-auto-rows:\s*minmax\(var\(--control-height\),\s*auto\)/,
    '行高也要至少 44px（换行后不许变矮 ✗）');
});

test('AC-BAR5 源码哨兵：修法**不许**动那段大 STYLE 字面量里的 tab 规则（避免门禁假红）', () => {
  // 基础那一段仍是 main 的样子（nowrap 在位 ✓），修法是**追加**覆盖 ✓
  assert.match(SRC, /const REALM_BAR_STYLE = `\.realm-tab \{ white-space: nowrap/, '追加覆盖必须在（且是 nowrap ⇒ 不竖拆 ✓）');
  assert.equal((SRC.match(/const STYLE = `/) || []).length, 1, 'STYLE 只许一处定义 ✓');
});
