/**
 * ⭐⭐ 「订单列表」移动端紧凑改版 —— 验收标准（业务负责人 2026-10-12，**先写后做**）。
 *
 * 她的原话（逐字）：
 *   「目前它对**移动端不太友好**，**整个数据都撑满了**，**一屏下来只能展示一个半订单**。
 *    我觉得我们需要调整一下，**争取在一屏里给用户呈现更多信息**」
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**可测量的**，不用"感觉"）
 *   AC1 一张订单卡**默认两行**：① 单号 + 状态 + 「打开 ›」 ② 金额摘要 + 展开；
 *       明细与收款明细**默认收起**（`<details>` 上没有 `open` 属性）。
 *   AC2 一张卡的默认高度 **≤120px**（375px 宽：`2×padding + 单号行 44 + gap + 折叠行 44`）。
 *   AC3 375×667（iPhone SE）一屏 **≥3 单**（按卡高 + 卡片间距算）。
 *   AC4 **信息一个都不少**：把卡展开，单号 / 履约状态 / 收款状态 / 应收 / 已收 / 还差 /
 *       待交付 / 每条明细的 货号·颜色·尺码·金额·状态 **全都还在**（逐字）。
 *   AC5 **≥44px 不破**：「打开」按钮与折叠行（summary）都是 ≥44px 命中区。
 *   AC6 **三段分类与写入逻辑一个字不变**（`config/orders.js` 的 `SALES_SECTIONS` 逐字 + 判据没动）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WORKBENCH = path.join(__dirname, '../public/workbench');
const read = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

/** 与既有用例同一套做法：把前端模块复制成 `.mjs`（只改 import 的文件名）。 */
function loadOrdersModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-compact-'));
  const copy = (from, to, replacements = []) => {
    let source = read(from);
    for (const [needle, replacement] of replacements) {
      assert.ok(source.includes(needle), `${from} 里没有找到要改的 import：${needle}`);
      source = source.split(needle).join(replacement);
    }
    fs.writeFileSync(path.join(dir, to), source, 'utf8');
  };
  copy('config/orders.js', 'orders-config.mjs');
  copy('core/formatters.js', 'formatters.mjs');
  copy('core/api-client.js', 'api-client.mjs');
  copy('core/ui.js', 'ui.mjs');
  copy('features/orders/index.js', 'orders-index.mjs', [
    ["from '../../config/orders.js'", "from './orders-config.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../../core/api-client.js'", "from './api-client.mjs'"],
    ["from '../../core/ui.js'", "from './ui.mjs'"],
  ]);
  return Promise.all([
    import(pathToFileURL(path.join(dir, 'orders-index.mjs')).href),
    import(pathToFileURL(path.join(dir, 'orders-config.mjs')).href),
  ]).then(([orders, config]) => ({ orders, config }));
}

/** 一张"信息最全"的单（AC4 用它逐字核"展开后一个都不少"）。 */
const ORDER = {
  record_id: 'order_1',
  order_no: 'XSD-20261012-0001',
  fulfillment_status: '部分交付',
  payment_status: '部分收款',
  receivable_amount: 187,
  paid_amount: 50,
  pending_amount: 137,
  pending_delivery_quantity: 2,
  payments: [{ record_id: 'p1', amount: 50, method: '微信', status: '已收款' }],
  details: [
    { record_id: 'd1', product: 'P1', color: '黑色', size: 38, actual_amount: 89, fulfillment_status: '已交付', requires_size: true },
    { record_id: 'd2', product: 'P2', color: '米白', size: 39, actual_amount: 59, fulfillment_status: '未交付', requires_size: true },
  ],
};

const TEXTS = (() => {
  const source = read('config/orders.js');
  return {
    receivable: /receivable:\s*'([^']+)'/.exec(source)[1],
    paid: /paid:\s*'([^']+)'/.exec(source)[1],
    pending: /pending:\s*'([^']+)'/.exec(source)[1],
    details: /details:\s*'([^']+)'/.exec(source)[1],
    open: /open:\s*'([^']+)'/.exec(source)[1],
  };
})();

// ═══════════════════════════════════════════════════════════════════════════
// AC1 默认两行 + 默认收起
// ═══════════════════════════════════════════════════════════════════════════

test('AC1 一张卡默认两行：单号行（含「打开」） + 折叠摘要行；明细/收款默认收起', async () => {
  const { orders } = await loadOrdersModule();
  const html = orders.ordersListHtml([ORDER]);

  assert.ok(/<article class="order-card"/.test(html), '仍是一单一张卡');
  // ① 第一行：单号 + 状态标签 + 打开按钮（都在 order-card-head 里）
  const head = html.slice(html.indexOf('<div class="order-card-head">'), html.indexOf('<details'));
  assert.ok(head.includes('XSD-20261012-0001'), '第一行有单号');
  assert.ok(head.includes('部分交付'), '第一行有履约状态小标签');
  assert.ok(head.includes('data-action="open-order"'), '「打开」按钮仍在（挪进第一行）');
  // ② 第二行 = 折叠行（summary 上带金额摘要 + 「明细 N 项 ›」）
  assert.ok(/<details class="order-details-toggle">/.test(html), '第二行是折叠行');
  const details = html.match(/<details class="order-details-toggle">[\s\S]*?<\/details>/)[0];
  assert.equal(/<details[^>]*\sopen/.test(details), false, '默认**收起**（没有 open 属性）');
  assert.ok(details.includes(`${TEXTS.receivable} ¥187`), '折叠行上有应收');
  assert.ok(details.includes(`${TEXTS.paid} ¥50`), '折叠行上有已收');
  assert.ok(details.includes(`${TEXTS.pending} ¥137`), '折叠行上有还差');
  assert.ok(details.includes('待交付 2'), '折叠行上有待交付');
  // ③ 不再有"独占一行的动作区"
  assert.equal(html.includes('order-card-actions'), false, '动作区不再独占一行（省 ~56px/单）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2 / AC3 高度 ≤120px、一屏 ≥3 单（用 CSS 里声明的值算）
// ═══════════════════════════════════════════════════════════════════════════

test('AC2/AC3 一张卡默认高度 ≤120px ⇒ 375×667 一屏 ≥3 单', () => {
  const tokens = read('styles/tokens.css');
  const css = read('features/orders/orders.css');
  const px = (name) => Number(new RegExp(`${name}:\\s*(\\d+)px`).exec(tokens)[1]);

  const controlHeight = px('--control-height'); // 44
  const space2 = px('--space-2');               // 8
  const space3 = px('--space-3');               // 12
  const space6 = px('--space-6');               // 24（段落之间）

  // 卡片：`padding: var(--space-3)` 上下 + `gap: var(--space-2)` + 两行各 44px
  assert.match(css, /\.order-card\s*\{[^}]*gap:\s*var\(--space-2\)/s, '卡片内间距 = --space-2');
  assert.match(css, /\.order-card\s*\{[^}]*padding:\s*var\(--space-3\)/s, '卡片内边距 = --space-3（16 → 12）');
  assert.match(css, /\.order-details-toggle summary\s*\{[^}]*min-height:\s*var\(--control-height\)/s,
    '折叠行仍是 44px 命中区');

  const cardHeight = 2 * space3 + controlHeight + space2 + controlHeight; // 12+44+8+44+12 = 120
  assert.ok(cardHeight <= 120, `一张卡默认高度 ${cardHeight}px ≤ 120px`);

  // iPhone SE：667px 高；扣掉外壳 padding（16×2）+ 一级 tab（44）+ 子 tab（44）+ 三段段头（约 3×24）≈ 150
  const usable = 667 - (16 * 2 + controlHeight + controlHeight + 3 * space6);
  const perCard = cardHeight + space3; // 卡片 + 卡片间距
  const ordersPerScreen = Math.floor(usable / perCard);
  assert.ok(ordersPerScreen >= 3, `375×667 一屏至少 3 单（算出来 ${ordersPerScreen} 单：可用 ${usable}px / 每单 ${perCard}px）`);
  assert.ok(space6 > 0, '（占位：段间距参与计算）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4 信息一个都不少（展开后逐字）
// ═══════════════════════════════════════════════════════════════════════════

test('AC4 展开后所有字段都还在：单号 / 两个状态 / 三项金额 / 待交付 / 每条明细的 5 个字段', async () => {
  const { orders } = await loadOrdersModule();
  const html = orders.ordersListHtml([ORDER]);

  for (const needle of [
    'XSD-20261012-0001',
    '部分交付', '部分收款',
    `¥187`, `¥50`, `¥137`, '待交付 2',
    'P1', '黑色', '38 码', '¥89',
    'P2', '米白', '39 码', '¥59',
  ]) {
    assert.ok(html.includes(needle), `卡片里少了：${needle}`);
  }
  // 两条明细的"未交付 / 已交付"状态标签也在
  assert.ok(html.includes('已交付') && html.includes('未交付'), '每条明细的履约状态标签都在');
  // 收款那一段（已记 N 笔 + 方式）在展开区里
  assert.ok(html.includes('已记 1 笔') && html.includes('微信'), '收款明细（笔数与方式）在展开区里');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC5 ≥44px 命中区
// ═══════════════════════════════════════════════════════════════════════════

test('AC5 「打开」按钮与折叠行都仍是 ≥44px 命中区', async () => {
  const { orders } = await loadOrdersModule();
  const html = orders.ordersListHtml([ORDER]);
  const css = read('features/orders/orders.css');
  const tokens = read('styles/tokens.css');
  assert.match(tokens, /--control-height:\s*44px;/);
  assert.ok(html.includes('class="btn btn-ghost order-open"'), '「打开」用 .order-open（视觉小、命中区不小）');
  assert.match(css, /\.order-open\s*\{[^}]*min-height:\s*var\(--control-height\)/, '「打开」≥44px');
  assert.match(css, /\.order-details-toggle summary\s*\{[^}]*min-height:\s*var\(--control-height\)/, '折叠行 ≥44px');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC6 三段分类与写入逻辑一个字不变
// ═══════════════════════════════════════════════════════════════════════════

test('AC6 两段分类逐字不变（待交割单 / 售后列表），本次只动排版', async () => {
  const { orders, config } = await loadOrdersModule();
  // ⭐ 2026-10-17 成对迁移：她逐字「只保留二次交割以及售后」⇒ 「补充信息单」退场
  //   （缺信息的单并入待交割 ⇒ 覆盖仍不重不漏 ✓）
  assert.deepEqual(config.SALES_SECTIONS.map((section) => [section.key, section.label, section.tag]), [
    ['pending', '待交割单', '待交割'],
    ['afterSales', '售后列表', '已两清'],
  ], '两段分类逐字不变');
  assert.deepEqual(config.SALES_GROUPS.map((group) => group.label),
    ['钱货两清', '有二次 · 货未交付', '有二次 · 资金未收', '有二次 · 两者都有']);
  // 判据（页面侧）也没动：三份单子的归属仍由 salesSectionOf 决定
  assert.equal(typeof orders.salesSectionOf, 'function');
  assert.equal(orders.salesSectionOf(ORDER), 'pending', '缺收款信息前这一单仍是「待交割单」');
});
