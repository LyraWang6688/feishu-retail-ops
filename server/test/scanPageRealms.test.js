/**
 * ⭐⭐ 扫码页「**一个码、三个领域扫出来不一样**」的验收标准（业务负责人 **2026-10-09**）。
 *
 * 她的口径（逐字要点）：
 *   · **同一个二维码**（`/s/{编号}?from=…`）在三个领域里**做三件不同的事**；
 *   · **`from=inventory`（单款查询）就是现在这个页面 —— 一个字不许变**（既有用例是哨兵）；
 *   · **`from=sales`（销售建单）**：尺码**分两组** ——
 *       第一组 = **有货（样品 + 门盒）**的尺码 ⇒ 选中它 = **现货**；
 *       第二组 = 该组（男 A = 38–48 / 女 B = 34–43）**目前没有的** ⇒ 选中它 = **预订**；
 *       提交走**既有**销售建单链路，交易类型用**既有**行为编码（`SALE_CASH` / `SALE_PREPAID`）；
 *   · **`from=purchase`（补货）**：列出该编号下**各尺码及数量（样品 + 门盒）** + 【**一键补货**】——
 *       一键补货 = 列出**缺的尺码**、**默认各 1 双**、**数量可改** ⇒ 走**既有**
 *       `purchaseWebhookService` 那条链路生成采购申请。
 *   · 三个领域**共用业务处理层**、各自**独立的状态 / 出口**（入口隔离不变）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC1 **库存领域一个字不变**：从 `<div class="realm-block realm-block--inventory">` 到它的
 *      `</div>` 与身份区**逐字**等于既有实现（库存表 / 缺码高亮 / 0 用「—」/ 备注）。
 *  AC2 **销售领域尺码分两组**：有货（样品 + 门盒 ＞ 0）= 第一组（现货）、
 *      其余 = 第二组（预订）；两组各自可选中（radio 的 `name="size"`），
 *      「仓库」有货**不算**有货（她 2026-10-09：「可卖 = 样品 + 门盒」）。
 *  AC3 **采购领域**：先列该编号各尺码的（样品 + 门盒）数量；【一键补货】列出缺的尺码、
 *      默认各 1 双、数量可改；「仓库」有货的尺码**不预勾**（既有缺码口径不变）。
 *  AC4 **三个领域共用业务处理层、各自独立出口**（源码哨兵）：渲染层不认识业务写入；
 *      三块各自带 `realm-block--<领域>`，没有 JS 时四块全显示（兜底、绝不白屏）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderScanPage, STYLE } = require('../src/views/scanPageRenderer');
const { SCAN_PAGE } = require('../src/config/scanPage');
const {
  SELLABLE_STATES, SIZE_GROUP_RANGES, REALM_TEXTS, sellableCountOf, saleSizeGroups, purchaseSizeLines,
} = require('../src/views/scanPageRealm');

const SRC = path.join(__dirname, '..', 'src');
const readSrc = (relative) => fs.readFileSync(path.join(SRC, relative), 'utf8');
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/**
 * 视图模型夹具（**照测试 Base 的真实列形状**写）：
 *   40 = 门盒 1                ⇒ 有货（现货）
 *   41 = 三种状态都没有         ⇒ 缺码（预订）
 *   42 = 门盒 1 + 样品 1        ⇒ 有货（现货）
 *   43 = 只有仓库 2            ⇒ **不算有货**（她：可卖 = 样品 + 门盒）⇒ 预订
 *   44 = 三种状态都没有         ⇒ 缺码（预订）
 */
const VIEW = {
  found: true,
  number: 'YD6693-2|黑色|A',
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 5,
  columns: [{ key: '门盒', label: '门盒' }, { key: '样品', label: '样品' }, { key: '仓库', label: '仓库' }],
  rows: [
    { size_text: '40', cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }], total: 1, missing: false },
    { size_text: '41', cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }], total: 0, missing: true },
    { size_text: '42', cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 1 }, { key: '仓库', count: 0 }], total: 2, missing: false },
    { size_text: '43', cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '仓库', count: 2 }], total: 2, missing: false },
    { size_text: '44', cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }], total: 0, missing: true },
  ],
  missing_count: 2,
  sizes_degraded: false,
  notes: ['缺码说明'],
  updated_at_text: '2026-10-08 20:30',
  product_record_id: 'prod_1',
};

/** 最小写上下文（字段名 / 动作 / 文案都照 `config/scanWrite.js` 的形状）。 */
const WRITE = {
  enabled: true,
  texts: {
    saleHeading: '销售（可以连着扫，最后一起提交）',
    draftHeading: '本单现在 {count} 双',
    draftEmpty: '本单还没有鞋',
    draftItem: '{itemNo} {size} 码',
    sizeLabel: '尺码',
    sizePlaceholder: '这一款没有可用尺码',
    amountLabel: '成交金额',
    amountPlaceholder: '不填按单价算',
    giftLabel: '赠品',
    addButton: '加入本单',
    paymentLabel: '收款方式',
    paymentAmountLabel: '收款金额',
    paymentAmountPlaceholder: '不填就是还没收钱',
    submitButton: '提交这一单',
    fundsPendingNote: '资金不是必填，之后可以在订单列表里补',
    clearButton: '清空本单',
    replenishHeading: '补货报单（勾选要补的尺码）',
    replenishHint: '打勾的尺码会生成采购申请；不填数量按 1 双算。',
    replenishQuantityLabel: '数量',
    replenishButton: '生成采购申请',
  },
  fields: {
    action: 'action',
    submitKey: 'submit_key',
    size: 'size',
    amount: 'amount',
    gift: 'gift',
    paymentMethod: 'payment_method',
    paymentAmount: 'payment_amount',
    replenishSizes: 'sizes',
    replenishQuantityPrefix: 'qty_',
  },
  actions: { addLine: 'add_line', submitOrder: 'submit_order', clearDraft: 'clear_draft', replenish: 'replenish' },
  postAction: '/s/YD6693-2%7C%E9%BB%91%E8%89%B2%7CA',
  sizes: [{ size_text: '40', missing: false }, { size_text: '41', missing: true }],
  draft: { lines: [] },
  saleKey: 'scan_sale:scan_session_0123456789abcdef:1',
  replenishKey: 'scan_replenish:scan_session_0123456789abcdef:1',
  paymentMethods: ['微信', '现金'],
  defaultPaymentMethod: '微信',
  notice: '',
};

const html = renderScanPage(VIEW, SCAN_PAGE, WRITE);
const body = html.slice(html.indexOf('</head>'));

/** 取某一个领域那一块的 HTML（到下一个领域块开始为止，并收在它自己的 `</div>`）。 */
const blockOf = (id) => {
  const start = body.indexOf(`realm-block--${id}`);
  assert.ok(start > -1, `缺 ${id} 块`);
  const next = ['sales', 'inventory', 'purchase', 'product']
    .map((other) => body.indexOf(`realm-block--${other}`, start + 1))
    .filter((index) => index > -1).sort((left, right) => left - right)[0] ?? body.length;
  const slice = body.slice(start, next);
  return slice.slice(0, slice.lastIndexOf('</div>') + '</div>\n'.length);
};

// ═══════════════════════════════════════════════════════════════════════════
// AC1 库存领域一个字不变（既有页面就是哨兵）
// ═══════════════════════════════════════════════════════════════════════════

test('AC1 `from=inventory` 就是现在这个页面：库存领域那一块 + 身份区**逐字不变**', () => {
  // 身份区（在领域块之外，四个领域共用）逐字不变
  assert.ok(body.includes(`<header class="card identity">
<div class="identity__main">
<h1 class="identity__item">YD6693-2</h1>
<p class="identity__meta">黑色 · 休闲鞋</p>
</div>
<div class="price">
<span class="price__label">单价</span>
<span class="price__value">¥399</span>
</div>
</header>`), '身份区（货号 / 颜色 · 品类 / 单价）逐字不变');

  // 库存领域那一块 = 库存表（逐字）+ 备注，外面只有 realm-block 那一层 div
  const golden = `realm-block--inventory">
<section class="card">
<h2 class="stock__heading">库存（共 5 双）</h2>
<table class="stock">
<thead><tr><th>尺码</th><th>门盒</th><th>样品</th><th>仓库</th></tr></thead>
<tbody>
<tr><th scope="row">40</th><td>1</td><td class="zero">—</td><td class="zero">—</td></tr>
<tr class="missing"><th scope="row">41<span class="badge" title="缺码：这个尺码没有库存">⚠️ 缺</span></th><td class="zero">—</td><td class="zero">—</td><td class="zero">—</td></tr>
<tr><th scope="row">42</th><td>1</td><td>1</td><td class="zero">—</td></tr>
<tr><th scope="row">43</th><td class="zero">—</td><td class="zero">—</td><td>2</td></tr>
<tr class="missing"><th scope="row">44<span class="badge" title="缺码：这个尺码没有库存">⚠️ 缺</span></th><td class="zero">—</td><td class="zero">—</td><td class="zero">—</td></tr>
</tbody>
</table>
<ul class="notes"><li>缺码说明</li></ul>
</section>
</div>
`;
  assert.equal(blockOf('inventory'), golden, '库存领域那一块一个字都不许变（她是既有用例的哨兵）');

  // 库存块里不许混进销售 / 采购的新东西
  for (const forbidden of ['data-stock-group', 'data-view="one-tap-replenish"', 'purchase-sizes', 'size-chip']) {
    assert.equal(blockOf('inventory').includes(forbidden), false, `库存块里混进了 ${forbidden}`);
  }
  // 领域切换条与兜底规则不变
  assert.ok(html.includes('href="?from=inventory"'));
  assert.ok(/html:not\(\[data-realm\]\) \.realm-block \{ display: block; \}/.test(STYLE));
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2 销售领域：尺码分两组（有货 = 现货 / 其余 = 预订）
// ═══════════════════════════════════════════════════════════════════════════

test('AC2 `from=sales` 尺码分两组：有货（样品+门盒）⇒ 现货；其余 ⇒ 预订', () => {
  // ① 判据在视图层，且**只认「样品 + 门盒」**（仓库不算可卖）
  assert.deepEqual([...SELLABLE_STATES], ['门盒', '样品'], '可卖 = 样品 + 门盒（她 2026-10-09 的口径）');
  assert.equal(sellableCountOf(VIEW.rows[0], VIEW.columns), 1, '40：门盒 1');
  assert.equal(sellableCountOf(VIEW.rows[2], VIEW.columns), 2, '42：门盒 1 + 样品 1');
  assert.equal(sellableCountOf(VIEW.rows[3], VIEW.columns), 0, '43：只有仓库 2 → 不算有货');
  // 「老形状」（cells 上没有 key，既有夹具就是这种）也认 —— 按视图模型的列序取
  const legacyShape = {
    columns: VIEW.columns,
    rows: [
      { size_text: '40', cells: [{ count: 1 }, { count: 0 }, { count: 0 }], total: 1, missing: false },
      { size_text: '43', cells: [{ count: 0 }, { count: 0 }, { count: 2 }], total: 2, missing: false },
    ],
  };
  assert.deepEqual(saleSizeGroups(legacyShape).inStock.map((item) => item.size_text), ['40'],
    '没有 key 时按列序取（仓库那 2 双不算有货）');
  assert.deepEqual(saleSizeGroups(VIEW), {
    inStock: [{ size_text: '40', count: 1 }, { size_text: '42', count: 2 }],
    prepaid: [{ size_text: '41', count: 0 }, { size_text: '43', count: 0 }, { size_text: '44', count: 0 }],
  }, '第一组 = 有货（现货）40 / 42；第二组 = 其余 41 / 43 / 44（预订）');

  // ② 男女两组（A = 男 38–48 / B = 女 34–43）——她去 2026-10-09 给的范围
  assert.deepEqual(SIZE_GROUP_RANGES.A, { label: '男', from: 38, to: 48 });
  assert.deepEqual(SIZE_GROUP_RANGES.B, { label: '女', from: 34, to: 43 });

  // ③ 页面上真的分了两组：两组各自的可选项 / 组标题 / 状态标签
  const sales = blockOf('sales');
  const groupOf = (id) => {
    const start = sales.indexOf(`data-stock-group="${id}"`);
    assert.ok(start > -1, `销售块里缺 ${id} 那一组`);
    const next = sales.indexOf('</fieldset>', start);
    return sales.slice(start, next);
  };
  const inStock = groupOf('in_stock');
  const prepaid = groupOf('prepaid');
  for (const size of ['40', '42']) {
    assert.ok(inStock.includes(`name="size" value="${size}"`), `现货组缺尺码 ${size}`);
    assert.equal(prepaid.includes(`name="size" value="${size}"`), false, `${size} 有货，不该出现在预订组`);
  }
  for (const size of ['41', '43', '44']) {
    assert.ok(prepaid.includes(`name="size" value="${size}"`), `预订组缺尺码 ${size}`);
    assert.equal(inStock.includes(`name="size" value="${size}"`), false, `${size} 没货，不该出现在现货组`);
  }
  assert.ok(sales.includes(REALM_TEXTS.saleInStockHeading), '第一组的标题 = 现货');
  assert.ok(sales.includes(REALM_TEXTS.salePrepaidHeading), '第二组的标题 = 预订');
  assert.ok(/tag[^>]*>\s*现货/.test(sales), '现货 = 彩色小标签');
  assert.ok(/tag[^>]*>\s*预订/.test(sales), '预订 = 彩色小标签');
  // 每个可选项都是一整块可点的（≥44px 命中区）
  assert.ok(inStock.includes('size-chip') && prepaid.includes('size-chip'), '每个尺码 = 一整块可点');
  assert.match(STYLE, /\.size-chip\s*\{[^}]*min-height:\s*var\(--control-height\)/s,
    '尺码卡片的命中区 ≥44px（手机上好点）');
  // 销售建单该有的东西一样不少（提交走既有链路）
  assert.ok(sales.includes('加入本单') && sales.includes('提交这一单'));
  assert.ok(sales.includes('资金不是必填') || sales.includes(WRITE.texts.fundsPendingNote));
  assert.ok(sales.includes('<option value="微信" selected>微信</option>'));

  // ④ 降级（拿不到该类别尺码）时：第二组为空、页面上说明只显示有库存的尺码
  const degraded = saleSizeGroups({ ...VIEW, sizes_degraded: true });
  assert.deepEqual(degraded.prepaid, [], '降级时不许编造"没有的尺码"');
  assert.deepEqual(degraded.inStock.map((item) => item.size_text), ['40', '42']);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3 采购领域：各尺码（样品+门盒）数量 + 一键补货
// ═══════════════════════════════════════════════════════════════════════════

test('AC3 `from=purchase`：列出各尺码（样品+门盒）数量 + 【一键补货】列出缺的尺码、默认各 1 双', () => {
  // ① 取数：每个尺码的（样品 + 门盒）数量 + 是不是"三种状态都没有"（既有缺码口径）
  assert.deepEqual(purchaseSizeLines(VIEW), [
    { size_text: '40', sellable: 1, missing: false, checked: false },
    { size_text: '41', sellable: 0, missing: true, checked: true },
    { size_text: '42', sellable: 2, missing: false, checked: false },
    { size_text: '43', sellable: 0, missing: false, checked: false },
    { size_text: '44', sellable: 0, missing: true, checked: true },
  ], '缺码（三种状态都没有）默认勾上；43 只有仓库 → 不预勾');

  const purchase = blockOf('purchase');
  // ② 先给她看"各尺码现在有多少"
  assert.ok(purchase.includes('data-view="purchase-sizes"'), '要先列出各尺码的（样品 + 门盒）数量');
  for (const size of ['40', '41', '42', '43', '44']) {
    assert.ok(purchase.includes(`data-purchase-size="${size}"`), `尺码清单缺 ${size}`);
  }
  assert.ok(/data-purchase-size="42"[\s\S]*?2 双/.test(purchase), '42 要显示 2 双（门盒 1 + 样品 1）');
  // ③ 【一键补货】：缺的尺码默认勾上、默认各 1 双、数量可改
  assert.ok(purchase.includes('data-view="one-tap-replenish"'), '要有【一键补货】');
  assert.ok(purchase.includes('一键补货'));
  assert.ok(purchase.includes('name="sizes" value="41" checked'));
  assert.ok(purchase.includes('name="sizes" value="44" checked'));
  assert.equal(/name="sizes" value="40" checked/.test(purchase), false, '40 有货 → 不预勾');
  assert.equal(/name="sizes" value="43" checked/.test(purchase), false, '43 有仓库货 → 不预勾');
  for (const size of ['40', '41', '42', '43', '44']) {
    assert.ok(purchase.includes(`name="qty_${size}"`), `数量输入框缺 ${size}（数量可改）`);
  }
  assert.match(purchase, /name="qty_41"[^>]*value="1"/, '默认各 1 双');
  assert.ok(purchase.includes('生成采购申请'), '生成采购申请 = 既有链路（既有写入口）');
  assert.ok(purchase.includes(WRITE.replenishKey), '幂等键照旧在表单里');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4 三个领域共用业务处理层 / 各自独立出口（源码哨兵）
// ═══════════════════════════════════════════════════════════════════════════

test('AC4 三个领域共用业务处理层、各自独立出口（渲染层不认识业务写入）', () => {
  const renderer = stripComments(readSrc('views/scanPageRenderer.js'));
  // 渲染层一个写库调用都没有（写入口在 scanWriteService，路由只做接线）
  for (const pattern of [/gateway\.(create|update|delete)\s*\(/, /appTableRecord\.(create|update|delete)/,
    /(applySale|applyPurchase|applyChange|applyReturn)\s*\(/, /inventoryService|salesOrderService|purchaseWebhookService/]) {
    assert.equal(pattern.test(renderer), false, `scanPageRenderer.js 出现了业务写入：${pattern}`);
  }
  // 三块各自带领域标记（入口隔离：各领域各自一块，没有 JS 时全显示 —— 绝不白屏）
  for (const id of ['sales', 'inventory', 'purchase']) {
    assert.ok(blockOf(id).length > 0, `缺 ${id} 领域块`);
  }
  // 三块共用**同一份视图模型**（渲染层不自己查表：分组 / 补货清单都是纯函数算的）
  const source = readSrc('views/scanPageRenderer.js');
  assert.match(source, /require\('\.\/scanPageRealm'\)/, '分组 / 补货清单来自视图层的同一份配置');
  assert.ok(source.includes('saleSizeGroups(view)') && source.includes('purchaseSizeLines(view)'),
    '销售与采购两块都拿同一份视图模型算（没有各领域自己再查一次表）');
  assert.ok(source.includes('stockTableHtml(view, config)'), '库存那一块也是同一份视图模型');
  // 交易类型 / 缺码判据都在**既有配置**里，视图层不写死编码
  const realm = stripComments(readSrc('views/scanPageRealm.js'));
  assert.equal(/SALE_CASH|SALE_PREPAID/.test(realm), false, '视图层不许写死交易类型编码（用既有判据）');
});
