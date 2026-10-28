'use strict';

/**
 * ⭐⭐⭐ **四页统一库存口径 —— 开关「开着」那条路的证据用例**（业务负责人 2026-10-16 20:5x 亲口定的口径）。
 *
 *   「既然四个页面用的都是**实时库存**，那就**统一不用看状态**，只要在实时库存里
 *    **这个编号有尺码记录，就都是有货**……也就是说**口径和库存是一样的了**。
 *    另外，实际上对于**退货**来说，它展示的是**实时库存里所有的数据**。……
 *    我们之前有个规定要分**普通码和特殊码**：**普通码有货无货都要展示出来，特殊码无货时则折叠**」
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  AC-ST5 **一致性（核心）**：**同一份实时库存** ⇒ 四页的「有货」集合**完全一致**
 *          （库存页那一行的合计 ＝ 销售页现货段 ＝ 补货页现货 tag ＝ 退货页列出的尺码）。
 *  AC-ST6 **她那把 44 码复刻**：44 码只有「未标状态」= 1 ⇒ **四页都必须认为它有货**
 *          （销售页把它放进「有货（现货）」；补货页不再 `0 双/缺码`；退货页允许退）。
 *  AC-ST8 **展示规则**：**普通码有货无货都展示** · **特殊码无货折叠**（有货的特殊码照旧全展示）。
 *  AC-ST9 **同一份数据的 total 相同**：库存页标题「共 N 双」＝ 补货页逐格「N 双」之和 ＝ 视图模型 `total`。
 *
 * 🔴 **本文件在 require 之前把 `SCAN_STOCK_POLICY_ENABLED` 设成 `true`** ——
 *    `node --test` 每个测试文件跑在**独立进程**里 ⇒ 不会污染别的文件（缺省那条路见
 *    `scanStockPolicyConfig.test.js` / `scanStockPolicyZeroRegression.test.js`）。
 * ⚠️ 本文件只**渲染 + 读 HTML**，不碰任何写入口（`scanWriteService.js` / `routes/**` 一个字没动 ✗）。
 */
// 改前逐字：`process.env.SCAN_STOCK_POLICY_ENABLED = 'true';`（本文件靠设开关来验新口径）
//   改后逐字：**删掉** ✓ —— ⭐ **已经没有开关了** ⇒ 新口径就是**唯一**口径 ✓（依据 = 她 22:5x ✓）

const test = require('node:test');
const assert = require('node:assert/strict');

const fx = require('./fixtures/scanStockPolicyViews');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_STOCK_POLICY, countInStockOf, resolveScanStockPolicy, ENABLED_KEY } = require('../src/config/scanStockPolicy');
const { sellableCountOf } = require('../src/views/scanPageRealm');

const REALMS = fx.REALM_IDS;
const page = (view, realm) => fx.fullPageOf(view, realm);
const block = (view, realm) => fx.blockOfFull(view, realm);

// ── 从 HTML 里读「有货」集合（**不借内部函数** ⇒ 判据是"页面真的这么显示" ✓）──────────

/** 销售页某一段（`in_stock` / `prepaid` / 折叠块）里的尺码。 */
const salesGroupSizes = (html, group) => {
  const b = fx.blockOf(html, 'sales');
  const start = group === 'folded'
    ? b.indexOf('data-special-fold')
    : b.indexOf(`data-stock-group="${group}"`);
  assert.ok(start > -1, `销售页缺 ${group} 那一段`);
  const end = b.indexOf(group === 'folded' ? '</details>' : '</fieldset>', start);
  return [...b.slice(start, end).matchAll(/name="size" value="(\d+)"/g)].map((m) => m[1]);
};

/** 补货页每个格子的「尺码 → 数量」（主列表 + 折叠块都算）。 */
const replenishCells = (html) => {
  const b = fx.blockOf(html, 'replenish');
  const cells = [...b.matchAll(/<li class="purchase-size-cell[^"]*" data-purchase-size="(\d+)">([\s\S]*?)<\/li>/g)];
  return cells.map((m) => {
    const amount = /<span class="purchase-size__times">×<\/span>(\d+) 双/.exec(m[2]);
    const tag = /<span class="tag tag--\w+">([^<]+)<\/span>/.exec(m[2]);
    return { size: m[1], count: Number(amount ? amount[1] : NaN), tag: tag ? tag[1] : '' };
  });
};

/** 补货页折叠块里的尺码（`data-special-fold` 那一段）。 */
const replenishFoldedSizes = (html) => {
  const b = fx.blockOf(html, 'replenish');
  const start = b.indexOf('data-special-fold');
  if (start < 0) return [];
  return [...b.slice(start, b.indexOf('</details>', start)).matchAll(/data-purchase-size="(\d+)"/g)].map((m) => m[1]);
};

/** 库存页表体：尺码 → 那一行数字格之和（`—` 记 0）。 */
const inventoryRows = (html) => {
  const b = fx.blockOf(html, 'inventory');
  const table = b.slice(b.indexOf('<table class="stock">'), b.indexOf('</table>'));
  return [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) => {
      const size = /<th scope="row">(\d+)/.exec(m[1]);
      if (!size) return null;
      const cells = [...m[1].matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((c) => c[1]);
      const total = cells.reduce((sum, text) => sum + (/^\d+$/.test(text) ? Number(text) : 0), 0);
      return { size: size[1], cells, total };
    })
    .filter(Boolean);
};

/** 库存页折叠块（缺货的特殊码）里的尺码。 */
const inventoryFoldedSizes = (html) => {
  const b = fx.blockOf(html, 'inventory');
  const start = b.indexOf('data-special-fold');
  if (start < 0) return [];
  return [...b.slice(start, b.indexOf('</details>', start)).matchAll(/data-folded-size="(\d+)"/g)].map((m) => m[1]);
};

/** 退货页列出的尺码（= 允许退的）。 */
const returnSizes = (html) => [
  ...fx.blockOf(html, 'purchase_return').matchAll(/name="return_sizes" value="(\d+)"/g),
].map((m) => m[1]);

const setOf = (list) => [...new Set(list.map(String))].sort((a, b) => Number(a) - Number(b));

// ── 夹具 ────────────────────────────────────────────────────────────────────

const COLUMNS = [
  { key: '门盒', label: '门盒' }, { key: '样品', label: '样品' },
  { key: '仓库', label: '仓库' }, { key: '', label: SCAN_PAGE.states.emptyLabel },
];

/** 一行的四种状态格（`counts` = [门盒, 样品, 仓库, 未标]）。 */
const rowOf = (size, counts, missing) => ({
  size_text: String(size),
  cells: counts.map((count, index) => ({ key: COLUMNS[index].key, count })),
  total: counts.reduce((sum, count) => sum + count, 0),
  missing,
});

/**
 * ⭐ **男款（A）混一份**：把四种状态 + 普通/特殊都摆上（她 2026-10-16 的口径要的正是这个）：
 *   40 门盒1 · 42 门盒1+样品1 · 43 **仓库2** · 44 **未标状态1** · 46 **特殊码有货(样品1)**
 *   38/39/41/45 普通码无货 · 47/48 特殊码无货
 *   ⇒ 新口径「有货」= {40,42,43,44,46}（**仓库与未标状态都算** ✓ —— "统一不用看状态"）
 */
const MIXED_A_VIEW = {
  found: true, number: '8516|黑色|A', item_no: '8516', color: '黑色',
  category_name: '凉鞋', category_code: 'A', price_text: '¥99',
  total: 7, // 记录条数 = 1 + 2 + 2 + 1 + 1
  columns: COLUMNS,
  rows: [
    rowOf(38, [0, 0, 0, 0], true), rowOf(39, [0, 0, 0, 0], true),
    rowOf(40, [1, 0, 0, 0], false), rowOf(41, [0, 0, 0, 0], true),
    rowOf(42, [1, 1, 0, 0], false), rowOf(43, [0, 0, 2, 0], false),
    rowOf(44, [0, 0, 0, 1], false), rowOf(45, [0, 0, 0, 0], true),
    rowOf(46, [0, 1, 0, 0], false), rowOf(47, [0, 0, 0, 0], true),
    rowOf(48, [0, 0, 0, 0], true),
  ],
  missing_count: 6, sizes_degraded: false, notes: [], updated_at_text: '2026-10-16 21:00',
  product_record_id: 'prod_8516',
};

/** ⭐ **女款（B）**：特殊码 = 34/35/41/42/43（离散）· 普通码 = 36–40。 */
const MIXED_B_VIEW = {
  found: true, number: 'MK31-1|咖色|B', item_no: 'MK31-1', color: '咖色',
  category_name: '休闲鞋', category_code: 'B', price_text: '¥299',
  total: 2, // 36 门盒1 + 42 仓库1
  columns: COLUMNS,
  rows: [
    rowOf(34, [0, 0, 0, 0], true), rowOf(35, [0, 0, 0, 0], true),
    rowOf(36, [1, 0, 0, 0], false), rowOf(37, [0, 0, 0, 0], true),
    rowOf(38, [0, 0, 0, 0], true), rowOf(39, [0, 0, 0, 0], true),
    rowOf(40, [0, 0, 0, 0], true), rowOf(41, [0, 0, 0, 0], true),
    rowOf(42, [0, 0, 1, 0], false), rowOf(43, [0, 0, 0, 0], true),
  ],
  missing_count: 8, sizes_degraded: false, notes: [], updated_at_text: '2026-10-16 21:00',
  product_record_id: 'prod_mk31',
};

/** ⭐ 她真机那一款（44 码 1 双在「未标状态」）—— 与 `stockStateConsistency.test.js` 同一份形状。 */
const HER_44_VIEW = fx.FULL_SIZES_BLANK_VIEW;

// ═══════════════════════════════════════════════════════════════════════════
// 前置自证：本进程真的开着（否则下面全是假绿）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ST5-pre ⭐ **已经没有任何开关**（所以本文件不再需要"本进程开关真的开着"那一步 ✓）', () => {
  // ⭐⭐ 2026-10-16 22:5x **成对迁移**（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：`assert.equal(process.env[ENABLED_KEY], 'true', 'env 设上了');`
  //   改后逐字：⭐ **`ENABLED_KEY` 已退场 ⇒ `process.env[undefined]` 当然是 `undefined`** ✓
  //     ⇒ ⭐ 这条**不改断言强度**：仍钉"本进程没有任何开关可读" ✓（依据 = 她 22:5x「不需要开关」✓）
  assert.equal(ENABLED_KEY, undefined, '⭐ 开关变量名已退场 ✓');
  assert.equal(process.env[ENABLED_KEY], undefined, '⭐ 本进程没有任何开关 env 可读 ✓');
  assert.equal(SCAN_STOCK_POLICY.enabled, undefined, '⭐ 开关已退场 ⇒ 不再有开与关这回事 ✓');
  assert.equal(countInStockOf({ total: 1, cells: [] }), 1, '判据走的是"实时库存里有记录"那条路');
  assert.equal(resolveScanStockPolicy({}).enabled, undefined, '⭐ 纯函数也不再解析任何开关 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ST5 ⭐⭐ 核心：同一份实时库存 ⇒ 四页「有货」集合完全一致
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ST5 ⭐⭐ 同一份实时库存 ⇒ 四页的"有货"集合**完全一致**（含仓库 + 未标状态）', () => {
  const view = MIXED_A_VIEW;
  // ① 判据集合 = 实时库存里有记录的尺码（**不看状态**）
  const criterion = setOf(view.rows.filter((row) => countInStockOf(row, view.columns) > 0).map((row) => row.size_text));
  assert.deepEqual(criterion, ['40', '42', '43', '44', '46'],
    '判据：40/42（门盒样品）+ 43（**仓库**）+ 44（**未标状态**）+ 46（特殊码有货）—— 统一不看状态 ✓');

  // ② 四页各自渲染出来的「有货」集合
  const salesHtml = page(view, 'sales');
  const replenishHtml = page(view, 'replenish');
  const returnHtml = page(view, 'purchase_return');
  const inventoryHtml = page(view, 'inventory');

  const inventoryInStock = setOf(inventoryRows(inventoryHtml).filter((row) => row.total > 0).map((row) => row.size));
  assert.deepEqual(inventoryInStock, criterion, '库存页：那一行四种状态的合计 > 0 ⇒ 有货（**基线**）');
  assert.deepEqual(setOf(salesGroupSizes(salesHtml, 'in_stock')), criterion, '销售页「有货（现货）」段');
  assert.deepEqual(setOf(replenishCells(replenishHtml).filter((cell) => cell.tag === '现货').map((cell) => cell.size)),
    criterion, '补货页带「现货」tag 的格子');
  assert.deepEqual(setOf(returnSizes(returnHtml)), criterion, '退货页列出的尺码（可退）');

  // ③ 🔴 四页**必须**彼此相同（这才是她说的"口径和库存是一样的了"）
  assert.deepEqual(setOf(salesGroupSizes(salesHtml, 'in_stock')), inventoryInStock, '销售 ⇔ 库存');
  assert.deepEqual(setOf(replenishCells(replenishHtml).filter((c) => c.tag === '现货').map((c) => c.size)),
    inventoryInStock, '补货 ⇔ 库存');
  assert.deepEqual(setOf(returnSizes(returnHtml)), inventoryInStock, '退货 ⇔ 库存');

  // ④ 「仓库」那一行（43）与「未标状态」那一行（44）**四页都必须算它有货**
  //    （这正是她 2026-10-16 要的；旧口径下这两行三页都说"没有" ⇒ 打架 ✗）
  for (const [label, set] of [
    ['销售页', setOf(salesGroupSizes(salesHtml, 'in_stock'))],
    ['补货页', setOf(replenishCells(replenishHtml).filter((c) => c.tag === '现货').map((c) => c.size))],
    ['退货页', setOf(returnSizes(returnHtml))],
    ['库存页', inventoryInStock],
  ]) {
    assert.ok(set.includes('43'), `${label} 必须把「仓库 2 双」的 43 算有货（统一不看状态 ✓）`);
    assert.ok(set.includes('44'), `${label} 必须把「未标状态 1 双」的 44 算有货（统一不看状态 ✓）`);
  }

  // ⑤ ⭐⭐ 2026-10-16 22:5x **成对迁移**（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：`const off = resolveScanStockPolicy({ [ENABLED_KEY]: 'false' });`
  //             `const legacySet = setOf(… countInStockOf(row, view.columns, off) > 0 …);`
  //             `assert.deepEqual(legacySet, ['40','42','46'], '旧口径只认门盒+样品 ⇒ 43/44 不在里面');`
  //             `assert.notDeepEqual(legacySet, inventoryInStock, '旧口径 vs 库存页必须对不上 …');`
  //   改后逐字：⭐ **旧口径已经不存在** ✗（开关与 `legacySellableCountOf` / `LEGACY_SELLABLE_STATES` 全退场）
  //     ⇒ ⭐ 那条"两种口径对不上"的**活性检查**换成 ⭐ **同义的活性检查**：
  //       **把状态的差别抹平**（同一份数据里"只有仓库 / 未标状态"的码也必须算有货 ✓）
  //       ＋ ⭐ 断言那几个老符号**已是 `undefined`**（谁把它们加回来 ⇒ 红 ✓）
  //   依据 = 业务负责人 20:5x「**统一不用看状态**，只要在实时库存里这个编号有尺码记录，就都是有货」
  //          ＋ 22:5x「**不需要开关**」✓（`docs/no-switch-rule-2026-10-16.md` ✓）
  assert.equal(typeof ENABLED_KEY, 'undefined', '⭐ 开关变量名已退场 ✓（不许留开关 ✗）');
  for (const label of ['43', '44']) {
    assert.ok(inventoryInStock.includes(label),
      `⭐ 活性检查（改后口径）：${label} 必须算有货 —— 只有「仓库」/「未标状态」也照样算 ✓（= 统一不看状态 ✓）`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ST6 ⭐⭐ 她那把 44 码复刻（只有「未标状态」= 1 ⇒ 四页都必须认为它有货）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ST6 ⭐⭐ 她的 44 码（只有「未标状态」= 1）⇒ 四页都说有货', () => {
  const view = HER_44_VIEW;
  const salesHtml = page(view, 'sales');
  const replenishHtml = page(view, 'replenish');
  const returnHtml = page(view, 'purchase_return');
  const inventoryHtml = page(view, 'inventory');

  // ① 销售页：44 必须在「有货（现货）」那一段（改前它在「现在没有（预订）」✗）
  assert.deepEqual(setOf(salesGroupSizes(salesHtml, 'in_stock')), ['44'],
    '销售页「有货（现货）」段 = 只有 44（她截图那一双）');
  assert.equal(salesGroupSizes(salesHtml, 'prepaid').includes('44'), false, '44 **不再**在预订段');
  assert.equal(salesHtml.includes('这一款现在没有可选的尺码'), false, '**不再**写"这一款现在没有可选的尺码"');

  // ② 补货页：44 显示 `1 双` + 「现货」tag（改前是 `0 双` + 「缺码」✗）
  const cell44 = replenishCells(replenishHtml).find((cell) => cell.size === '44');
  assert.deepEqual(cell44, { size: '44', count: 1, tag: '现货' }, '补货页 44 = `1 双` + 现货 tag');
  // ⚠️ 只查 **44 那一格**（不许拿"44 之后还有没有 `0 双`"当判据 —— 45/46/47/48 本来就有 ✓）
  const cell44Html = /<li class="purchase-size-cell[^"]*" data-purchase-size="44">([\s\S]*?)<\/li>/
    .exec(fx.blockOf(replenishHtml, 'replenish'))[1];
  assert.equal(cell44Html.includes('0 双'), false, '44 那一格不许再出现 `0 双`');
  assert.equal(cell44Html.includes('>缺码<'), false, '44 那一格不许再标「缺码」');

  // ③ 退货页：允许退 44（改前整款写"没有可退的库存" ✗）
  assert.deepEqual(setOf(returnSizes(returnHtml)), ['44'], '退货页列出 44（有数量 ⇒ 可退 ✓）');
  assert.equal(returnHtml.includes(`data-view="return-no-stock"`), false, '不再写"这一款现在没有可退的库存"');
  assert.match(returnHtml, /data-stock="1"[^>]*name="return_sizes" value="44"/,
    '44 那一行的库存上限 = 1（退货数量不许超过它 ✓）');

  // ④ 库存页：44 那一行只有「未标状态」= 1（她截图那一行**没变** —— 它本来就是对的 ✓）
  const row44 = inventoryRows(inventoryHtml).find((row) => row.size === '44');
  assert.deepEqual(row44.cells, ['—', '—', '—', '1'], '库存页 44 行四格逐字（门盒/样品/仓库/未标状态）');
  assert.equal(row44.total, 1, '库存页 44 合计 = 1');

  // ⑤ 判据集合 = {44}
  assert.deepEqual(setOf(view.rows.filter((row) => countInStockOf(row, view.columns) > 0).map((row) => row.size_text)),
    ['44'], '四页共用的判据：只有 44 有货');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ST8 ⭐⭐ 展示规则：普通码有货无货都展示 · 特殊码无货时折叠
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ST8 ⭐⭐ 普通码（A 38–44 / B 36–40）**有货无货都展示** · 特殊码**无货折叠**', () => {
  const { normalSizesOf, specialSizesOf } = require('../src/config/scanStockPolicy');
  const cases = [
    { view: MIXED_A_VIEW, code: 'A', stocked: ['40', '42', '43', '44', '46'] },
    { view: MIXED_B_VIEW, code: 'B', stocked: ['36', '42'] },
  ];
  for (const { view, code, stocked } of cases) {
    const normal = normalSizesOf(code).map(String);
    const special = specialSizesOf(code).map(String);
    const salesHtml = page(view, 'sales');
    const replenishHtml = page(view, 'replenish');
    const inventoryHtml = page(view, 'inventory');

    // ① **普通码：有货无货都展示** —— 一个都不许消失 ✗（销售：现货段 ∪ 预订段）
    const salesVisible = setOf([...salesGroupSizes(salesHtml, 'in_stock'), ...salesGroupSizes(salesHtml, 'prepaid')]);
    const replenishVisible = setOf(replenishCells(replenishHtml).filter((c) => !replenishFoldedSizes(replenishHtml).includes(c.size)).map((c) => c.size));
    const inventoryVisible = setOf([...inventoryRows(inventoryHtml).map((r) => r.size), ...inventoryFoldedSizes(inventoryHtml)]);
    for (const size of normal) {
      assert.ok(salesVisible.includes(size), `${code} 普通码 ${size} 必须在销售页可见（有货无货都展示 ✓）`);
      assert.ok(replenishVisible.includes(size), `${code} 普通码 ${size} 必须在补货页可见`);
      assert.ok(inventoryVisible.includes(size), `${code} 普通码 ${size} 必须在库存页可见`);
    }
    // 无货的普通码**不进折叠块**（它们要"摆出来"）
    for (const size of normal.filter((size) => !stocked.includes(size))) {
      assert.equal(salesGroupSizes(salesHtml, 'folded').includes(size), false, `无货普通码 ${size} 不进销售折叠块`);
      assert.equal(replenishFoldedSizes(replenishHtml).includes(size), false, `无货普通码 ${size} 不进补货折叠块`);
      assert.equal(inventoryFoldedSizes(inventoryHtml).includes(size), false, `无货普通码 ${size} 不进库存折叠块`);
      assert.ok(salesGroupSizes(salesHtml, 'prepaid').includes(size), `无货普通码 ${size} 在"预订"段（展示出来 ✓）`);
    }

    // ② **特殊码：无货时折叠**（三页都有它的折叠块），**有货的照旧全展示**
    const specialOutOfStock = special.filter((size) => !stocked.includes(size));
    const specialInStock = special.filter((size) => stocked.includes(size));
    assert.deepEqual(setOf(salesGroupSizes(salesHtml, 'folded')), setOf(specialOutOfStock), '销售页折叠块 = 无货的特殊码');
    assert.deepEqual(setOf(replenishFoldedSizes(replenishHtml)), setOf(specialOutOfStock), '补货页折叠块 = 无货的特殊码');
    assert.deepEqual(setOf(inventoryFoldedSizes(inventoryHtml)), setOf(specialOutOfStock), '库存页折叠块 = 无货的特殊码');
    for (const size of specialInStock) {
      assert.ok(salesGroupSizes(salesHtml, 'in_stock').includes(size), `有货的特殊码 ${size} 在销售现货段（不许折 ✗）`);
      assert.ok(replenishCells(replenishHtml).find((c) => c.size === size && c.tag === '现货'),
        `有货的特殊码 ${size} 在补货页带现货 tag`);
      assert.ok(inventoryRows(inventoryHtml).some((r) => r.size === size && r.total > 0),
        `有货的特殊码 ${size} 在库存页表体里（不许折 ✗）`);
      assert.equal(inventoryFoldedSizes(inventoryHtml).includes(size), false, `有货的特殊码 ${size} 不许出现在折叠块`);
    }

    // ③ **没有任何一个可录尺码凭空消失**（要么在表体/列表，要么在折叠块）
    const all = setOf([...normal, ...special]);
    const shown = setOf([...inventoryVisible]);
    for (const size of all) {
      assert.ok(shown.includes(size), `${code} 可录码 ${size} 必须在库存页出现（表体或折叠块 ✓）`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ST9 ⭐⭐ 同一份数据：库存页的 total ＝ 另外三页的数之和
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ST9 ⭐⭐ 库存页与另外三页对同一份数据的 total 必须相同', () => {
  for (const view of [MIXED_A_VIEW, MIXED_B_VIEW, HER_44_VIEW]) {
    const columns = view.columns;
    // ① 逐行：判据 = 那一行所有状态格之和（**同一个数** —— 库存页显示的就是它）
    for (const row of view.rows) {
      assert.equal(sellableCountOf(row, columns), row.total,
        `${view.item_no} ${row.size_text} 码：判据数量必须 = 库存页那一行的合计`);
    }
    // ② 一款的合计：判据之和 = 视图模型 total（= 「实时库存」里属于这一款的记录条数）
    const sumByCriterion = view.rows.reduce((sum, row) => sum + sellableCountOf(row, columns), 0);
    assert.equal(sumByCriterion, view.total, `${view.item_no}：判据之和必须 = total（记录条数）`);

    // ③ 页面上的两个数也要对得上：库存页标题「共 N 双」= 补货页逐格「N 双」之和
    const inventoryHtml = page(view, 'inventory');
    const replenishHtml = page(view, 'replenish');
    const heading = new RegExp(`<h2 class="stock__heading">${SCAN_PAGE.texts.stockHeading.replace('{total}', String(view.total))}</h2>`);
    assert.match(inventoryHtml, heading, `库存页标题必须写「共 ${view.total} 双」`);
    const replenishSum = replenishCells(replenishHtml).reduce((sum, cell) => sum + cell.count, 0);
    assert.equal(replenishSum, view.total, `补货页逐格之和（${replenishSum}）必须 = 库存页 total（${view.total}）`);
    // ④ 退货页列出的数量列之和也要 = total（"退货展示实时库存里所有的数据" ✓）
    const returnCounts = [...fx.blockOf(returnHtmlOf(view), 'purchase_return')
      .matchAll(/data-view="return-stock">(\d+)</g)].map((m) => Number(m[1]));
    assert.equal(returnCounts.reduce((sum, n) => sum + n, 0), view.total,
      '退货页每行的"当前库存数量"之和也要 = total');
  }
});

/** 退货页（`AC-ST9` 里用一次；独立出来免得读串）。 */
function returnHtmlOf(view) {
  return page(view, 'purchase_return');
}

// ═══════════════════════════════════════════════════════════════════════════
// AC-ST5b 四页装配自证：四页都真的渲染出来了（防"某页是空串"的假绿）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ST5b ⭐ 四个领域都被渲染出来（防空串假绿 ✓）', () => {
  for (const realm of REALMS) {
    const html = page(MIXED_A_VIEW, realm);
    assert.ok(block(MIXED_A_VIEW, realm).length > 100, `${realm} 那一块要有内容`);
    assert.ok(html.includes(`realm-block--${realm}"`), `${realm} 块必须在页面里`);
  }
});
