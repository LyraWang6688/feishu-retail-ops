/**
 * ⭐⭐ 扫码页「**去说明书**」的验收标准（业务负责人 **2026-10-10**，与工作台同一批口径）。
 *
 * 她的规则（逐字要点）：**只留"能点、能做的事"，删掉"解释我怎么用"的句子**。
 * 工作台那一批已做完；扫码页当时被硬约束挡住（`src/views/**` 与 `config/scanPage.js` /
 * `scanWrite.js` 的文案字段不在改动范围内），**现在解禁**。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-S1 **说明句逐条退场**（配置里没有这些 key，渲染出来的 HTML 里也没有这些句子）：
 *        领域条提示（`barHint`）· noscript 解释句（`noScriptHint`）· 标签页说明（`labelHint`）·
 *        销售两组说明（`saleInStockHint` / `salePrepaidHint`）· 采购尺码说明（`purchaseSizesHint`）·
 *        「一键补货（缺的尺码已勾上，默认各 1 双）」**压成最短**「一键补货」·
 *        销售标题（`saleHeading`）· 补货标题（`replenishHeading`）· 资金说明（`fundsPendingNote`）·
 *        补货提示（`replenishHint`）· 分组备注（`groupNote`「（这一组 = 男 A · 38–48）」）·
 *        缺码说明（`missingSize.hint`）。
 *  AC-S2 **两处源码扫一遍**：`views/**` 与 `config/scanPage.js` / `config/scanWrite.js`
 *        去注释后，上面那些句子一句都不许留（免得将来又长回来）。
 *  AC-S3 **功能性提示一个都不能少**（这不是放宽）：`⚠️ 缺` 高亮 · 状态小标签（现货 / 预订）·
 *        两组标题 · `一键补货` 折叠 · 表单按钮 / 字段 · `realmEmpty*` 人话卡 ·
 *        **`<noscript>` 兜底链接**（没有脚本时四条领域链接照旧可点，只是不再解释）。
 *  AC-S4 **数据不全的如实说明一条都不许删**（降级 / 状态越界 / 尺码读不出 / 截断）——
 *        那是"我们不确定"的如实交代，不是说明书。
 * ─────────────────────────────────────────────────────────────────────────
 */
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { renderScanPage, STYLE } = require('../src/views/scanPageRenderer');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { REALM_TEXTS, REALMS } = require('../src/views/scanPageRealm');

const SRC = path.join(__dirname, '..', 'src');
const readSrc = (relative) => fs.readFileSync(path.join(SRC, relative), 'utf8');
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 她点名（+ 本轮核实）要退场的说明句 —— **逐字**。 */
const REMOVED_SENTENCES = [
  '同一个二维码，四个领域都能扫；点一下切换',
  '本页不需要 JavaScript',
  '打这一款（按货号）的鞋盒标签',
  '选这一组里的尺码 = 现货',
  '选这一组里的尺码 = 预订',
  '只算可卖的：样品 + 门盒',
  '一键补货（缺的尺码已勾上，默认各 1 双）',
  '销售（可以连着扫，最后一起提交）',
  '补货报单（勾选要补的尺码）',
  '打勾的尺码会生成采购申请；不填数量按 1 双算。',
  '这一单先记了货、还没记钱',
  '（这一组 = 男',
  '标注「缺」的尺码',
];

const VIEW = {
  found: true,
  number: 'YD6693-2|黑色|A',
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 3,
  columns: [{ key: '门盒', label: '门盒' }, { key: '样品', label: '样品' }, { key: '仓库', label: '仓库' }],
  rows: [
    { size_text: '40', cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }], total: 1, missing: false },
    { size_text: '41', cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }], total: 0, missing: true },
    { size_text: '42', cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 1 }, { key: '仓库', count: 0 }], total: 2, missing: false },
  ],
  missing_count: 1,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-08 20:30',
  product_record_id: 'prod_1',
};

/** 写上下文：形状照路由给渲染层的那一份（文案直接用**真配置**，才测得到"说明书真的没了"）。 */
const WRITE = {
  enabled: true,
  saleEnabled: true,
  replenishEnabled: true,
  texts: SCAN_WRITE.texts,
  fields: SCAN_WRITE.fields,
  actions: SCAN_WRITE.actions,
  postAction: '/s/YD6693-2%7C%E9%BB%91%E8%89%B2%7CA',
  sizes: [{ size_text: '40', missing: false }, { size_text: '41', missing: true }],
  draft: { lines: [] },
  saleKey: 'scan_sale:scan_session_0123456789abcdef:1',
  replenishKey: 'scan_replenish:scan_session_0123456789abcdef:1',
  paymentMethods: SCAN_WRITE.sale.paymentMethods,
  defaultPaymentMethod: SCAN_WRITE.sale.defaultPaymentMethod,
  notice: '',
};

const pageFor = (realm) => renderScanPage(VIEW, SCAN_PAGE, WRITE, realm);

// ═══════════════════════════════════════════════════════════════════════════
// AC-S1 说明句逐条退场（配置 + 渲染面）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-S1 那些"解释我怎么用"的文案字段整体退场（配置里连 key 都不该有）', () => {
  // ① 领域层：提示句 / 说明句的 key 都不在了
  for (const key of ['barHint', 'noScriptHint', 'labelHint', 'saleInStockHint', 'salePrepaidHint', 'purchaseSizesHint']) {
    assert.equal(REALM_TEXTS[key], undefined, `REALM_TEXTS.${key} 是说明句 ⇒ 必须删掉`);
  }
  // ② 「一键补货」压成最短 —— 功能名保留，"缺的尺码已勾上、默认各 1 双"那句说明删掉
  assert.equal(REALM_TEXTS.oneTapReplenish, '一键补货');

  // ③ 写入口：两个标题与两句说明退场
  for (const key of ['saleHeading', 'replenishHeading', 'fundsPendingNote', 'replenishHint']) {
    assert.equal(SCAN_WRITE.texts[key], undefined, `SCAN_WRITE.texts.${key} 是说明句 ⇒ 必须删掉`);
  }

  // ④ 缺码那句解释退场（`⚠️ 缺` 高亮本身留 —— 见 AC-S3）
  assert.equal(SCAN_PAGE.missingSize.hint, undefined, 'missingSize.hint 那句解释必须删掉');
  assert.equal(SCAN_PAGE.missingSize.badge, '缺', '「缺」这个标记本身留');
  assert.equal(SCAN_PAGE.missingSize.icon, '⚠️');

  // ⑤ 四个领域渲染出来的 HTML 里，一句说明都不许有
  for (const realm of ['sales', 'inventory', 'purchase', 'product']) {
    const html = pageFor(realm);
    for (const gone of REMOVED_SENTENCES) {
      assert.equal(html.includes(gone), false, `realm=${realm} 的页面里还有说明句：「${gone}」`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-S2 源码里也不许留着（免得将来又长回来）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-S2 `views/**` 与两个 config 去注释后一句都不许留', () => {
  const surface = ['views/scanPageRenderer.js', 'views/scanPageRealm.js',
    'config/scanPage.js', 'config/scanWrite.js']
    .map((file) => stripComments(readSrc(file))).join('\n');
  for (const gone of REMOVED_SENTENCES) {
    assert.equal(surface.includes(gone), false, `源码里还留着说明句：「${gone}」`);
  }
  // 渲染层也不许再画那几个 hint 容器（说明句的载体）
  const renderer = stripComments(readSrc('views/scanPageRenderer.js'));
  assert.equal(/realm-hint/.test(renderer), false, '领域条下面那句提示的容器不再画');
  assert.equal(/labelHint|purchaseSizesHint|saleInStockHint|salePrepaidHint|groupNote/.test(renderer), false,
    '渲染层不许再引用那些说明句');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-S3 功能性提示一个都不能少（不是放宽）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-S3 功能性的东西一个都不能少：⚠️ 缺 / 状态小标签 / 一键补货 / 表单 / noscript 兜底', () => {
  // ① 领域切换条照旧是四条真链接
  const inventory = pageFor('inventory');
  for (const realm of REALMS) {
    assert.ok(inventory.includes(`href="?from=${realm.id}"`), `领域条缺 ${realm.id}`);
    assert.ok(inventory.includes(`data-realm-id="${realm.id}"`));
  }
  // ② ⚠️ 缺 高亮 + 状态小标签（她点名要留的"能点、能做的事"）
  assert.ok(inventory.includes('⚠️ 缺'), '缺码高亮照旧');
  assert.ok(inventory.includes('class="badge"'), '缺码徽标照旧');
  assert.ok(inventory.includes('<tr class="missing">'), '缺码整行高亮照旧');
  assert.ok(pageFor('sales').includes('现货') && pageFor('sales').includes('预订'), '现货 / 预订小标签照旧');
  assert.ok(REALM_TEXTS.saleInStockHeading && REALM_TEXTS.salePrepaidHeading, '两组标题照旧');

  // ③ 「一键补货」= 折叠头（最短文案），里面的表单一个字段都不少
  const purchase = pageFor('purchase');
  assert.ok(purchase.includes('data-view="one-tap-replenish"'), '一键补货折叠还在');
  assert.match(purchase, /<summary[^>]*>一键补货<\/summary>/, '折叠头就是最短的「一键补货」');
  for (const needle of ['name="sizes" value="41" checked', 'name="qty_41"', 'name="submit_key"',
    `value="${WRITE.replenishKey}"`]) {
    assert.ok(purchase.includes(needle), `补货表单少了 ${needle}`);
  }
  assert.ok(purchase.includes('data-view="purchase-sizes"'), '各尺码数量清单照旧');

  // ④ 销售表单：尺码两组 + 加入本单 + 提交这一单 + 默认微信
  const sales = pageFor('sales');
  for (const needle of ['data-stock-group="in_stock"', 'data-stock-group="prepaid"',
    '加入本单', '提交这一单', '<option value="微信" selected>微信</option>']) {
    assert.ok(sales.includes(needle), `销售表单少了 ${needle}`);
  }
  // ⑤ 货品标签页照旧（只是不再解释这一页怎么用）
  assert.ok(pageFor('product').includes('货品标签') && pageFor('product').includes('/workbench/label-print.html'));

  // ⑥ `<noscript>` 兜底链接照旧（没有脚本时四条领域链接可点；只是不再有解释句）
  for (const realm of ['sales', 'inventory', 'purchase', 'product']) {
    const page = pageFor(realm);
    const start = page.indexOf('<noscript>');
    assert.ok(start > -1, `realm=${realm} 缺 noscript 兜底`);
    const noScript = page.slice(start, page.indexOf('</noscript>'));
    for (const other of REALMS) {
      assert.ok(noScript.includes(`href="?from=${other.id}"`), `noscript 里缺 ${other.id} 的链接`);
    }
    // 兜底链接是**能点的字**（不是空块）：四条领域名逐字在里面
    for (const other of REALMS) assert.ok(noScript.includes(other.label), `noscript 里缺「${other.label}」这几个字`);
  }

  // ⑦ 拿不到写上下文时仍然是**人话卡片**（绝不白屏），不是说明句被删就跟着没了
  const emptySales = renderScanPage(VIEW, SCAN_PAGE, null, 'sales');
  assert.ok(emptySales.includes(SCAN_PAGE.texts.realmEmptyTitle), '销售领域没人话卡');
  assert.ok(emptySales.includes(SCAN_PAGE.texts.realmEmptySalesBody));
  assert.ok(emptySales.includes(SCAN_PAGE.texts.realmEmptyAction));
  const emptyPurchase = renderScanPage({ ...VIEW, rows: [] }, SCAN_PAGE, { ...WRITE, sizes: [] }, 'purchase');
  assert.ok(emptyPurchase.includes(SCAN_PAGE.texts.realmEmptyTitle), '采购领域没人话卡');
  const emptyPurchaseBody = emptyPurchase.slice(emptyPurchase.indexOf('</head>'));
  assert.equal(emptyPurchaseBody.includes('一键补货'), false, '没有可补的尺码时不该还画补货表单');

  // ⑧ 样式表里也没有"默认藏起来"的写法（那是白屏的形状）
  assert.equal(/display:\s*none/.test(STYLE), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-S4 数据不全的如实说明一条都不许删
// ═══════════════════════════════════════════════════════════════════════════

test('AC-S4 数据不全的如实说明（降级 / 状态越界 / 尺码读不出 / 截断）逐条保留并渲染', () => {
  const keys = ['degradedSizesNote', 'unknownStateNote', 'unknownSizeNote', 'truncatedSizesNote'];
  for (const key of keys) {
    assert.equal(typeof SCAN_PAGE.texts[key], 'string', `SCAN_PAGE.texts.${key} 必须还在`);
    assert.ok(SCAN_PAGE.texts[key].trim().length > 0, `SCAN_PAGE.texts.${key} 不许为空`);
    const html = renderScanPage({ ...VIEW, notes: [SCAN_PAGE.texts[key]] }, SCAN_PAGE, WRITE, 'inventory');
    assert.ok(html.includes(SCAN_PAGE.texts[key]), `渲染出来的页面少了「${SCAN_PAGE.texts[key]}」`);
  }
  // 备注容器照旧在（删的是"怎么用"，不是"数据可能不全"）
  const withNotes = renderScanPage({ ...VIEW, notes: [SCAN_PAGE.texts.degradedSizesNote] }, SCAN_PAGE, WRITE, 'inventory');
  assert.match(withNotes, /<ul class="notes"><li>/, '备注列表容器照旧渲染');
  // ⚠️ 某条备注的文案被删掉之后（`notes` 里可能留下一个空位）**绝不许**渲染出空 `<li>` ——
  //    她看到的会是一条莫名其妙的空行。
  const withEmpty = renderScanPage({ ...VIEW, notes: ['', undefined, SCAN_PAGE.texts.unknownSizeNote] },
    SCAN_PAGE, WRITE, 'inventory');
  assert.equal(/<li><\/li>/.test(withEmpty), false, '空备注不许渲染成空行');
  assert.ok(withEmpty.includes(SCAN_PAGE.texts.unknownSizeNote), '有字的备注照旧渲染');
});
