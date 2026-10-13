'use strict';

/**
 * ⭐⭐ 2026-10-14（业务负责人：「需要做配置～」）：把**三个领域的尺码行为**收进一份显式表。
 *
 * 只收**代码里真实存在的轴**（`sizeRowsOf` 的 special 规则**已经是一份真源** ⇒ 不动 ✗；
 * 库存 0 占位的真源在 `views/scanPageRenderer.js` ⇒ **不入表** ✗；`product` 真源未定位 ⇒ 不入表 ✓）：
 *   · `saleSizeGroups` 的**分组** ← `group`（+ `groupWhenDegraded`）
 *   · `purchaseSizeLines` 的 **missing / checked** ← `missing` / `checkMissingByDefault`
 *
 * ⚠️ 视图形状**照抄真实 fixture**（`test/scanPageWrite.test.js` 的 `view()`）—— 用合成视图会让
 *    `sizeRowsOf` 的 special 过滤结果跟预期对不上，断言会一直追着自己跑 ✗（前一位就栽在这）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SCAN_PAGE } = require('../src/config/scanPage');
const realm = require('../src/views/scanPageRealm');

/** 照抄既有真实 fixture 的最小形状（`cells[0].count` 就是"可卖数"的来源）。 */
const view = (rows, overrides = {}) => ({
  found: true,
  number: 'YD6693-2|黑色|A',
  item_no: 'YD6693-2',
  columns: [{ key: '门盒', label: '门盒' }],
  rows: rows.map((row) => ({
    size_text: String(row.size_text),
    cells: [{ count: row.count ?? 0 }],
    total: row.count ?? 0,
    missing: Boolean(row.missing),
  })),
  missing_count: rows.filter((row) => row.missing).length,
  sizes_degraded: false,
  ...overrides,
});
const twoSizes = () => view([{ size_text: '40', count: 1 }, { size_text: '41', count: 0, missing: true }]);

test('AC-RB-1 ⭐⭐ 改配置即改行为（代码零改动）：`sales.group=null` ⇒ 不再分组；`replenish.checkMissingByDefault=false` ⇒ 不再默认勾', () => {
  const def = realm.saleSizeGroups(twoSizes());
  assert.deepEqual(def.inStock.map((i) => i.size_text), ['40'], '默认：有货的进现货');
  assert.deepEqual(def.prepaid.map((i) => i.size_text), ['41'], '默认：没货的进预订');
  const flat = realm.saleSizeGroups(twoSizes(), { ...SCAN_PAGE.REALM_SIZE_BEHAVIOR.sales, group: null });
  assert.deepEqual(flat.inStock.map((i) => i.size_text), ['40', '41'], 'group=null ⇒ 全进平表');
  assert.deepEqual(flat.prepaid, [], 'group=null ⇒ 不再有预订组');

  const on = realm.purchaseSizeLines(twoSizes());
  assert.deepEqual(on.map((line) => [line.size_text, line.missing, line.checked]),
    [['40', false, false], ['41', true, true]], '默认：缺码标出来 + 默认勾选');
  const off = realm.purchaseSizeLines(twoSizes(),
    { ...SCAN_PAGE.REALM_SIZE_BEHAVIOR.replenish, checkMissingByDefault: false });
  assert.deepEqual(off.map((line) => [line.size_text, line.missing, line.checked]),
    [['40', false, false], ['41', true, false]], '关掉默认勾 ⇒ missing 仍如实、checked 变 false');
});

test('AC-RB-2 ⭐⭐ 三个领域现有行为逐条不变（回归）', () => {
  const sales = realm.saleSizeGroups(twoSizes());
  const salesTexts = [...sales.inStock, ...sales.prepaid].map((i) => i.size_text);
  const replenish = realm.purchaseSizeLines(twoSizes()).map((line) => line.size_text);
  // 库存/补货行集都来自同一份 `sizeRowsOf` ✓ ⇒ 与"销售（现货 ∪ 预订）"同行集
  assert.deepEqual(replenish, salesTexts, '补货行集 == 销售（现货 ∪ 预订）—— 同一份 `sizeRowsOf` ✓');
  const withMissing = realm.purchaseSizeLines(view([{ size_text: '40', count: 0, missing: true }]));
  assert.equal(typeof withMissing[0].sellable, 'number', '可卖数仍是从行上算出来的数字 ✓');
  assert.equal(withMissing[0].missing, true, '缺码要标出来 ✓');
  assert.equal(withMissing[0].checked, true, '缺码 + 默认勾（她口径）✓');
});

test('AC-RB-3 ⭐⭐ 源码哨兵：领域差别只能来自 `REALM_SIZE_BEHAVIOR`（判源码前先剥注释）', () => {
  const raw = fs.readFileSync(path.join(__dirname, '../src/views/scanPageRealm.js'), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const sale = code.slice(code.indexOf('const saleSizeGroups'), code.indexOf('const purchaseSizeLines'));
  const buy = code.slice(code.indexOf('const purchaseSizeLines'), code.indexOf('const purchaseSizeLines') + 600);
  const rowsFn = code.slice(code.indexOf('const sizeRowsOf'), code.indexOf('const saleSizeGroups'));
  assert.ok(sale.includes('REALM_SIZE_BEHAVIOR'), 'saleSizeGroups 从配置取分组口径');
  assert.ok(buy.includes('REALM_SIZE_BEHAVIOR'), 'purchaseSizeLines 从配置取 missing/checked 口径');
  assert.ok(!/'instock\+reserve'/.test(sale), '分组枚举值只许在 config 里');
  assert.ok(!rowsFn.includes('REALM_SIZE_BEHAVIOR'), '`sizeRowsOf`（special 真源）一个字没动');
  // ⚠️ 2026-10-14 实况：`sizeRowsOf` 在今天的 main 上已经是**一行**（`view.rows` 原样返回）——
  //    special 规则已搬去别处 ⇒ 这条只钉"它没被本刀碰过"，**不再**声称 special 在本函数里 ✓
  assert.ok(!rowsFn.includes('behavior'), '`sizeRowsOf` 不参与本刀的配置化 ✓');
});

test('AC-RB-4 ⭐ 表结构：显式枚举/布尔 · 只收真实轴 · 不留"假真源"', () => {
  const table = SCAN_PAGE.REALM_SIZE_BEHAVIOR;
  assert.ok(Object.isFrozen(table), 'Object.freeze');
  assert.deepEqual(Object.keys(table).sort(), ['inventory', 'replenish', 'sales']);
  const allowed = ['checkMissingByDefault', 'group', 'groupWhenDegraded', 'missing'];
  for (const [key, entry] of Object.entries(table)) {
    for (const axis of Object.keys(entry)) assert.ok(allowed.includes(axis), `${key}.${axis} 不是真实轴`);
    for (const axis of ['group', 'missing', 'checkMissingByDefault']) assert.ok(axis in entry, `${key} 缺 ${axis}`);
    assert.ok(entry.group === null || entry.group === SCAN_PAGE.SIZE_ROW_GROUPS.GROUPED, `${key}.group 显式枚举`);
    assert.equal(typeof entry.missing, 'boolean');
    assert.equal(typeof entry.checkMissingByDefault, 'boolean');
  }
  assert.equal(table.sales.group, SCAN_PAGE.SIZE_ROW_GROUPS.GROUPED);
  assert.equal(table.inventory.group, null);
  assert.equal(table.replenish.missing, true);
  assert.equal(table.replenish.checkMissingByDefault, true);
  assert.equal(table.sales.groupWhenDegraded, false);
  assert.ok(!('zeroPlaceholder' in table), 'zeroPlaceholder 真源在渲染层 ⇒ 不许造第二份');
  assert.ok(!('product' in table), 'product 真源未定位 ⇒ 不入表');
});
