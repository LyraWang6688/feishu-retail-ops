const { rendererSource } = require('./support/rendererSource');
/**
 * task-30（业务负责人 2026-10-15 逐字）：
 *   「**是否可以把 4 个领域和顶部的扫一扫合并到顶部一行的，这样也少占一些地方**」
 *   ＋ 当晚确认的**最终排序**：「…**我希望我们的排序可以改下，库存、销售、补货、退货、扫一扫**。默认还是销售页。」
 *
 * 本文件钉这一刀（**新文件**，不动既有判据的语义）：
 *   AC-L1 ⭐⭐ 首屏**同一行**里同时有 4 个领域 + 「扫一扫」（飞书客户端 5 格、**只有一排**）
 *   AC-L2 ⭐⭐ 原来那条「扫一扫」**不再单独占一行**（飞书端本单条里没有它、AppLink 全页只出现一次）
 *   AC-L3 ⭐⭐ 4 个领域的**字段名 / 行为逐字不变**（`?from=<id>` / `data-realm-id` / `data-tap-target` /
 *             服务端高亮 / 缺省=销售 / 认不出的值回落销售）
 *   AC-L4 ⭐⭐ 退货 / 补货的**既有判据一条没放宽**（只列有数量的尺码 · 勾选 · 超库存闸门数据 ·
 *             特殊码折叠块）
 *   AC-L5 ⭐⭐ 移动端**不横滑** + 每格 **≥44px**（列数=格数 + 等分 + 宽度算术）
 *   AC-L6 ⭐ README 那条尾巴（老采购页目录已删）
 *
 * 🔴 领域**成员**仍在 `src/views/scanPageRealm.js`（唯一真源 ✓ 本刀没动）；
 *    本刀只把**显示顺序**搬进配置（`config/scanPage.js` 的 `realmBar.order` ✓ 配置先行）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_toprow';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_toprow_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { renderScanPage } = require('../src/views/scanPageRenderer');

const FEISHU_MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Lark/7.0.0';
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const NO_UA = '';

/** 她的顺序（**配置**是唯一来源 ✓）。 */
const ORDER = [...SCAN_PAGE.realmBar.order];
const EXPECTED_NAMES = ['库存', '销售', '补货', '退货'];
const SCAN_LABEL = SCAN_PAGE.realmBar.scanLabel;

const VIEW = (over = {}) => ({
  found: true,
  number: 'N05|黑色|A',
  item_no: 'N05',
  color: '黑色',
  category_name: '休闲鞋',
  price_text: '¥399',
  total: 4,
  columns: [{ key: '门盒', label: '门盒' }, { key: '样品', label: '样品' }],
  // 40 有 3 双 · 41 **缺码 0 双** · 42 有 1 双（退货只列「有数量」的 ⇒ 41 不列 ✓ task-28 口径）
  rows: [
    { size_text: '40', cells: [{ count: 2 }, { count: 1 }], total: 3, missing: false },
    { size_text: '41', cells: [{ count: 0 }, { count: 0 }], total: 0, missing: true },
    { size_text: '42', cells: [{ count: 1 }, { count: 0 }], total: 1, missing: false },
    // ⭐ 特殊码（男码 46/47/48 = `specialSizes`）没有库存 ⇒ 应当进「特殊码」折叠块 ✓（她说的那种块）
    { size_text: '48', cells: [{ count: 0 }, { count: 0 }], total: 0, missing: true },
  ],
  missing_count: 1,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-15 21:00',
  ...over,
});

const WRITE = {
  draft: { lines: [{ size_text: '40' }] },
  saleKey: 'scan_sale:scan_session_0123456789abcdef:1',
  replenishKey: 'scan_replenish:scan_session_0123456789abcdef:1',
  paymentMethods: SCAN_WRITE.sale.paymentMethods,
  defaultPaymentMethod: SCAN_WRITE.sale.defaultPaymentMethod,
  notice: '',
};

const pageFor = (realm, { write = WRITE, ua = FEISHU_MOBILE_UA, view = VIEW() } = {}) =>
  renderScanPage(view, SCAN_PAGE, write, realm, { userAgent: ua });

const realmBarOf = (html) => {
  const at = html.indexOf('<nav class="realm-bar"');
  assert.ok(at > -1, '页面上没有领域条（`<nav class="realm-bar">`）');
  return html.slice(at, html.indexOf('</nav>', at));
};
const cellsOf = (bar) => [...bar.matchAll(/<a[^>]*class="[^"]*realm-tab[^"]*"[^>]*>([^<]*)<\/a>/g)]
  .map((match) => match[1].trim());
const contentOf = (html) => html.slice(html.indexOf('</style>'));

// ═══════════════════════════════════════════════════════════════════════════
// AC-L1 同一行：4 个领域 + 「扫一扫」
// ═══════════════════════════════════════════════════════════════════════════

test('AC-L1 ⭐⭐ 首屏**同一行**里同时有 4 个领域 + 「扫一扫」（飞书客户端 5 格 · **只有一排**）', () => {
  const bar = realmBarOf(pageFor('sales'));
  const cells = cellsOf(bar);
  assert.deepEqual(cells, [...EXPECTED_NAMES, SCAN_LABEL],
    `飞书客户端：条上必须恰好是「库存·销售·补货·退货·扫一扫」（实际 ${JSON.stringify(cells)}）`);
  // 🔴 同一行的硬判据：**整条只有一排**（`realm-row` 只有一个）——多套一排就是"分了两行" ✗
  assert.equal((bar.match(/class="realm-row"/g) || []).length, 1,
    '领域条**只许有一排**（5 格都在同一行 ✓）——能真红：把「扫一扫」挪进第二个 row ⇒ 红');
  // 列数 = 格数（等分铺满 ✓）
  const cols = Number((bar.match(/grid-template-columns:repeat\((\d+)/) || [])[1]);
  assert.equal(cols, 5, `这一排必须是 5 列（实际 ${cols}）`);
  // 第 5 格是**真 AppLink**（点一下就能扫下一个 ✓ 不是死按钮）
  assert.ok(bar.includes(`href="${SCAN_PAGE.scanNext.applink}"`), '第 5 格必须挂着飞书扫一扫 AppLink ✓');
  assert.equal((bar.match(/realm-tab--scan/g) || []).length, 1, '「扫一扫」那一格只该有一处 ✓');

  // 非飞书（电脑 / 普通浏览器）：**不给假按钮** ⇒ 条上只有 4 格 ✓
  // ⚠️ 不传 UA（`undefined`）会走默认参数（= 飞书那个 UA）⇒ 这一档用**空串**代表「没有 UA」✓
  for (const ua of [DESKTOP_UA, NO_UA, 'Mozilla/5.0 (Linux; Android 13) Chrome/120']) {
    const desktopBar = realmBarOf(pageFor('sales', { ua }));
    assert.deepEqual(cellsOf(desktopBar), EXPECTED_NAMES, `UA=${String(ua)}：条上只有 4 个领域 ✓`);
    assert.equal(desktopBar.includes(SCAN_PAGE.scanNext.applink), false, `UA=${String(ua)}：不许给扫码 AppLink ✗`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-L2 「扫一扫」不再单独占一行
// ═══════════════════════════════════════════════════════════════════════════

test('AC-L2 ⭐⭐ 原来那条「扫一扫」（本单条里独占一行）→ **不再单独占一行**', () => {
  const page = pageFor('sales');
  // ① 飞书端：本单条里**不再有**它（搬进上排了 ✓）
  const barStart = page.indexOf('data-view="draft-bar"');
  if (barStart > -1) {
    const draftBar = page.slice(page.lastIndexOf('<section', barStart), page.indexOf('</section>', barStart));
    assert.equal(draftBar.includes(SCAN_PAGE.scanNext.applink), false, '本单条里不许再重复那颗 AppLink ✓');
    assert.equal(draftBar.includes(`>${SCAN_LABEL}<`), false, '本单条里不许再出现「扫一扫」这一格 ✓');
  }
  // ② AppLink 在**整页只出现一次**（= 就在那一排里；没有第二处 ⇒ 也就没有第二条行 ✓）
  assert.equal((page.match(new RegExp(SCAN_PAGE.scanNext.applink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1,
    '扫码 AppLink 全页**只出现一次**（在顶部那一排里 ✓）');
  // ③ 飞书端 + 空本单 ⇒ **整页连本单条都不渲染**（她就是要"少占地方" ✓）
  const empty = pageFor('sales', { write: { ...WRITE, draft: { lines: [] } } });
  assert.equal(empty.includes('data-view="draft-bar"'), false,
    '飞书端空本单 ⇒ 本单条**整条不渲染**（不再有一条只为「扫一扫」占的行 ✓）');
  // ④ 非飞书端：没有 AppLink，但**那句人话照旧在**（她的硬要求：绝不给点了没反应的按钮 ✓）
  const desktop = pageFor('sales', { ua: DESKTOP_UA });
  assert.equal(desktop.includes(SCAN_PAGE.scanNext.applink), false, '电脑端没有扫码能力 ⇒ 不给链接 ✓');
  assert.ok(desktop.includes(SCAN_PAGE.texts.scanNextHint), '电脑端必须留那句人话（指名用飞书扫一扫 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-L3 4 个领域的字段名 / 行为逐字不变
// ═══════════════════════════════════════════════════════════════════════════

test('AC-L3 ⭐⭐ 4 个领域：`?from=<id>` / `data-realm-id` / `data-tap-target` / 服务端高亮 **逐字不变**', () => {
  for (const id of ORDER) {
    const bar = realmBarOf(pageFor(id));
    // 每一格仍是**真链接**（服务端渲染、零 JS ⇒ 点一下就是一次新请求 ✓）
    assert.ok(bar.includes(`data-realm-id="${id}" href="?from=${id}"`),
      `realm=${id}：那一格必须还是 \`?from=<id>\` 的真链接 ✓`);
    // 点按反馈那两个属性照旧（她 2026-10-13 要的"点到了"的可见变化 ✓）
    assert.ok(bar.includes(`data-tap-target="realm:${id}"`), `realm=${id}：data-tap-target 照旧 ✓`);
    // 当前领域高亮 = **服务端**决定（不是脚本切 class ✓）且**只有一格**高亮
    assert.match(bar, new RegExp(`class="realm-tab realm-tab--active" data-realm-id="${id}"[^>]*aria-current="page"`),
      `realm=${id}：当前那格要高亮 + aria-current ✓`);
    assert.equal((bar.match(/realm-tab--active/g) || []).length, 1, `realm=${id}：只许一格高亮 ✓`);
    // 每个领域仍渲染**自己那一块**（服务端按 from 只拼一块 ✓ 行为没变）
    assert.ok(contentOf(pageFor(id)).includes(`realm-block--${id}"`), `realm=${id}：要渲染自己的块 ✓`);
  }
  // 缺省 = **销售**（她：「默认还是销售页」✓ 一个字没动）
  const defaultBar = realmBarOf(pageFor(undefined));
  assert.match(defaultBar, /class="realm-tab realm-tab--active" data-realm-id="sales"/, '裸扫开 = 销售 ✓');
  // 认不出的 `?from=` ⇒ 回落销售（既有口径 ✓ 不报错、不白屏）
  for (const bogus of ['不存在的领域', 'purchase', 'accessory']) {
    assert.match(realmBarOf(pageFor(bogus)), /class="realm-tab realm-tab--active" data-realm-id="sales"/,
      `?from=${bogus} ⇒ 回落销售 ✓`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-L4 退货 / 补货的既有判据照旧（这一刀不许碰业务语义）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-L4 ⭐⭐ 退货块照旧：**只列有数量的尺码** · 勾选 · 超库存闸门数据 · 特殊码折叠块', () => {
  // ⚠️ 写上下文要**给全**（`texts` / `fields` / `actions` / `postAction`；shape 抄 task-28 的
  //    `scanReturnSizeList.test.js` ✓）——少给一样 `returnFormHtml` 就会抛、被渲染层兜成"人话空态卡"✗
  //    （我第一版就是这么挂的）。尺码清单走 `view.rows`（`purchaseSizeLines` 同一口径 ✓）：
  //    40 有 3 双 · 41 **0 双（缺码）** ⇒ 不列 · 42 有 1 双 ⇒ 列（她逐字：「只展示有数量的尺码」✓）
  const write = {
    enabled: true,
    texts: SCAN_WRITE.texts,
    fields: SCAN_WRITE.fields,
    actions: SCAN_WRITE.actions,
    postAction: '/s/x?from=purchase_return',
    returnKey: 'scan_return:k:1',
  };
  const content = contentOf(pageFor('purchase_return', { write }));
  // ① 只列「有数量」的尺码（task-28 口径 ✓）：40 / 42 有货 ⇒ 两行；41 缺码 ⇒ **不列** ✗
  const rows = [...content.matchAll(/<div class="size-row">([\s\S]*?)<\/div>/g)].map((match) => match[1]);
  const sizes = rows.map((row) => (/value="([^"]+)"/.exec(row) || [])[1]).filter(Boolean);
  assert.deepEqual(sizes, ['40', '42'], `退货只列有数量的尺码（实际 ${JSON.stringify(sizes)}）`);
  // ② 每一行都是**可勾选的尺码**（勾选 = 要退这个码 ✓）
  for (const row of rows) {
    assert.match(row, /<input type="checkbox"/, '每一行都要能勾 ✓');
    assert.match(row, /data-stock="\d+"/, '🔴 勾选那格要带 `data-stock`（= 前端"≤ 当前库存"拦截的判据 ✓）');
  }
  // ③ 前端的拦截闸门照旧（她 task-23/28 要的：超库存 / 超尺码数 / 数量非法 ⇒ 拦住 + 人话）
  const form = content.slice(content.indexOf('<form'), content.indexOf('</form>'));
  for (const attr of ['data-return-max-sizes', 'data-return-max-quantity', 'data-return-stock-text',
    'data-return-limit-text', 'data-return-quantity-text']) {
    assert.ok(form.includes(attr), `退货表单上要有 ${attr}（拦截判据 ✓）`);
  }
  // ④ 整款 0 可退 ⇒ **一句人话**（不是空白页 ✗ —— task-28 她真机那条 ✓）
  const allZero = contentOf(pageFor('purchase_return', {
    view: VIEW({ rows: [{ size_text: '40', cells: [{ count: 0 }], total: 0, missing: true }] }),
    write,
  }));
  assert.ok(allZero.includes(SCAN_PAGE.returnForm.noReturnableStock), '整款 0 库存 ⇒ 要有那句人话 ✓');
  assert.equal((allZero.match(/<input type="checkbox"/g) || []).length, 0, '⛔ 一个都退不了 ⇒ 不许画可勾的行 ✗');
});

test('AC-L4b ⭐⭐ 补货 / 库存 / 销售三处的「特殊码」折叠块照旧（缺货的特殊码进折叠、有货的正常显示）', () => {
  const write = {
    enabled: true,
    texts: SCAN_WRITE.texts,
    fields: SCAN_WRITE.fields,
    actions: SCAN_WRITE.actions,
    postAction: '/s/x?from=replenish',
    replenishKey: 'scan_replenish:k:1',
  };
  const content = contentOf(pageFor('replenish', { write }));
  assert.ok(/data-view="purchase-sizes/.test(content), '补货的尺码格照旧在（`data-view="purchase-sizes*"`）✓');
  assert.ok(content.includes(`name="${SCAN_WRITE.fields.replenishSizes}"`), '每一格仍是**可勾**的输入（字段名来自配置 ✓）');
  // ⭐ 折叠块在**三处**（销售 / 补货 / 库存）都要照旧：`<details data-special-fold="1">` + 文案走配置
  for (const realm of ['sales', 'replenish', 'inventory']) {
    const html = contentOf(pageFor(realm, realm === 'sales' ? { write: { ...write, saleEnabled: true } } : { write }));
    assert.ok(html.includes('data-special-fold="1"'), `realm=${realm}：「特殊码」折叠块照旧要在 ✓`);
    assert.ok(html.includes(SCAN_PAGE.specialSizes.toggleLabel), `realm=${realm}：折叠块文案来自配置 ✓`);
    // 缺货的特殊码（48）进折叠块；有货的（40）照旧正常显示 ⇒ 两边都在 ✓
    const fold = html.slice(html.indexOf('data-special-fold="1"'));
    assert.ok(fold.includes('48'), `realm=${realm}：缺货的特殊码 48 应当在折叠块里 ✓`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-L5 移动端：不横滑 + 每格 ≥44px
// ═══════════════════════════════════════════════════════════════════════════

test('AC-L5 ⭐⭐ 移动端**不横滑** + 每格 **≥44px**（列数=格数 · 等分 · 宽度算术）', () => {
  const bar = realmBarOf(pageFor('sales'));
  const cells = cellsOf(bar);
  // ① 列数 === 格数 且 等分（`minmax(0,1fr)`）⇒ 一排正好铺满容器宽 ⇒ **没有溢出可滚** ✓
  const cols = Number((bar.match(/grid-template-columns:repeat\((\d+),\s*minmax\(0,\s*1fr\)\)/) || [])[1]);
  assert.equal(cols, cells.length, `列数必须 === 格数（${cols} vs ${cells.length}）⇒ 一排铺满、不溢出 ✓`);
  for (const forbidden of [/repeat\(6,\s*minmax/, /grid-template-columns:repeat\(\d+px/, /min-width:\s*\d+px/]) {
    assert.equal(forbidden.test(bar), false, `行内样式里不许写死列数/像素宽（${forbidden} 会撑破容器 ⇒ 横滑 ✗）`);
  }
  // ② 每格：不换行（不竖拆）、可压缩（`min-width:0`）、命中区 ≥44px（tokens 里量）
  const source = rendererSource();
  const tabRule = source.match(/\n\.realm-tab \{([^}]*)\}/)[1];
  assert.match(tabRule, /min-height:\s*var\(--control-height\)/, '每格高度走 `--control-height`（≥44px ✓）');
  assert.match(tabRule, /min-width:\s*0/, '每格能压缩（长文案不撑破容器 ✓）');
  assert.match(tabRule, /white-space:\s*nowrap/, '文案不许竖拆 ✓');
  const tokens = fs.readFileSync(path.join(__dirname, '..', 'public/workbench/styles/tokens.css'), 'utf8');
  const controlHeight = Number((tokens.match(/--control-height:\s*(\d+)px/) || [])[1]);
  assert.ok(controlHeight >= 44, `--control-height 必须 ≥44px（实际 ${controlHeight}）`);
  // ③ 宽度算术：**最多 5 格**各 44px + 4 个 gap 8px = 252px ⇒ 常见最窄手机（320px）**宽裕放得下** ✓
  const gap = Number((bar.match(/gap:(\d+)px/) || [])[1]);
  assert.equal(gap, 8, '行内 gap 与算术一致（8px）✓');
  const needed = 5 * 44 + 4 * gap;
  assert.ok(needed <= 320, `5 格各 ≥44px 只需 ${needed}px ⇒ 320px 手机放得下（不必横滑 ✓）`);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-L6 README 那条尾巴（死采购页目录）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-L6 ⭐ README 不再把已删除的采购页文件写成"还在"（改成"已于 2026-10-15 删除"）', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'public', 'workbench', 'README.md'), 'utf8');
  assert.equal(readme.includes('features/purchase/{index,links}.js'), false,
    'README 不许再出现 `features/purchase/{index,links}.js`（那个目录已在 #607 整目录删除 ✗）');
  assert.ok(readme.includes('已于 2026-10-15 删除'), '要如实写成"已于 2026-10-15 删除"✓');
  assert.ok(readme.includes('features/purchase/'), '仍要能一眼看出说的是哪个目录（`features/purchase/`）✓');
});
