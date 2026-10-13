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

test('AC-BAR3 🔴 级联上必须真的**覆盖掉** `nowrap`（只写不生效 = 假绿 ✗）', () => {
  const page = pageHtml();
  const style = (page.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];
  const baseAt = style.indexOf('white-space: nowrap');
  const overrideAt = style.indexOf('white-space: normal');
  assert.ok(baseAt > -1, '基础规则（.realm-tab 的 nowrap）应当还在（不动别人的那段 ✓）');
  assert.ok(overrideAt > -1, '必须有一层追加覆盖把 nowrap 改掉 ✓');
  assert.ok(overrideAt > baseAt, '覆盖必须排在**后面**（否则级联不生效 ⇒ 重叠照旧 ✗）');
  assert.equal((style.match(/white-space:\s*normal/g) || []).length >= 1, true);
  assert.ok(/\.realm-tab\s*\{[^}]*white-space:\s*normal/.test(style), '覆盖要**正好打在 `.realm-tab` 上** ✓');
});

test('AC-BAR4 每格可点高度 ≥ 44px（她的老规矩，回归）', () => {
  assert.match(STYLE, /\.realm-tab\s*\{[^}]*min-height:\s*var\(--control-height\)/s,
    '`.realm-tab` 必须保留 min-height: var(--control-height)（= 44px ✓）');
  assert.match(SRC, /\.realm-bar\s*\{\s*grid-auto-rows:\s*minmax\(var\(--control-height\),\s*auto\)/,
    '行高也要至少 44px（换行后不许变矮 ✗）');
});

test('AC-BAR5 源码哨兵：修法**不许**动那段大 STYLE 字面量里的 tab 规则（避免门禁假红）', () => {
  // 基础那一段仍是 main 的样子（nowrap 在位 ✓），修法是**追加**覆盖 ✓
  assert.match(SRC, /const REALM_BAR_STYLE = `\.realm-tab \{ white-space: normal/, '追加覆盖必须在 ✓');
  assert.equal((SRC.match(/const STYLE = `/) || []).length, 1, 'STYLE 只许一处定义 ✓');
});
