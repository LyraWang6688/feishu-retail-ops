'use strict';
const { rendererSource } = require('./support/rendererSource');

/**
 * ⭐⭐「特殊码折叠」的验收标准。
 *
 * 口径真源：`config/scanPage.js` 的 `SIZE_SEGMENTS`（2026-10-28 现行）
 *   · 可录范围：女 34–43 / 男 38–48
 *   · 普通码：女 36–40 / 男 38–44
 *   · 特殊码：女 34/35/41/42/43 / 男 45/46/47/48
 *   ① 有货（含特殊码）⇒ **全部正常展开**（现货区）
 *   ② 缺货 = ⭐ **可录范围 − 有货**
 *      · 缺货的**普通码** ⇒ 预订区正常显示
 *      · ⭐ 缺货的**特殊码** ⇒ 收进「特殊码」折叠块（默认收起）
 *
 * ⚠️ 2026-10-28：旧的 `normalScopeOf` / `loadSizeScope` 已删除；本文件旧版本里
 *    “故意是红的 / scope=normalScopeOf” 是历史记录，**不代表现状** ✗。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SCAN_PAGE } = require('../src/config/scanPage');
const realm = require('../src/views/scanPageRealm');

const SERVICE_SRC = fs.readFileSync(path.join(__dirname, '../src/services/scanPageService.js'), 'utf8');
const RENDERER_SRC = rendererSource();

/** 造一个"这一款"的视图模型：只有 `rows`（每行缺码标记由服务层给）+ 编号（第 3 段 = 类别）。 */
const viewOf = ({ number, stocked = [], missing = [] }) => ({
  number,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [
    ...stocked.map((size) => ({ size_text: String(size), cells: [{ key: '门盒', count: 1 }], total: 1, missing: false })),
    ...missing.map((size) => ({ size_text: String(size), cells: [{ key: '门盒', count: 0 }], total: 0, missing: true })),
  ],
  sizes_degraded: false,
});

// ═══════════════════════════════════════════════════════════════════════════
// 判定基准：可录范围（女 34–43 / 男 38–48）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SF1 ⭐ 缺货基准 = **可录范围**（女 34–43 / 男 38–48），不是普通码段', () => {
  // ① `enterableScopeOf` 必须在**模块作用域**（能直接 require 出来 ⇒ 不是工厂内的私货）
  assert.equal(typeof realm.enterableScopeOfOf, 'undefined'); // 防手滑写错模块
  const { enterableScopeOf } = require('../src/services/scanPageService');
  assert.equal(typeof enterableScopeOf, 'function', '`enterableScopeOf` 要能从服务模块直接拿到（模块级 ✓）');
  assert.deepEqual(enterableScopeOf('B', SCAN_PAGE).sizes, [34, 35, 36, 37, 38, 39, 40, 41, 42, 43],
    '女 可录范围 34–43');
  assert.deepEqual(enterableScopeOf('A', SCAN_PAGE).sizes, [38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48],
    '男 可录范围 38–48');
  // ② 展示链路那一行必须改成它（源码哨兵：改前是 `normalScopeOf` ✗）
  assert.match(SERVICE_SRC, /scope = enterableScopeOf\(parsed\.categoryCode\)/,
    '展示链路的缺货基准必须走 `enterableScopeOf`（可录范围）');
  assert.equal(/scope = normalScopeOf\(parsed\.categoryCode\)/.test(SERVICE_SRC), false,
    '旧基准（normalScopeOf）不许再出现在展示链路 ✗');
});

test('AC-SF2 ⭐ 有货（含特殊码）⇒ **现货区正常展开**，不算缺货', () => {
  const view = viewOf({ number: 'JX505|咖色|B', stocked: [36, 43], missing: [] });
  const groups = realm.saleSizeGroups(view);
  const inStock = groups.inStock.map((item) => item.size_text);
  assert.ok(inStock.includes('43'), '43（特殊码）有货 ⇒ 现货区正常展开 ✓（不许被折叠 ✗）');
  assert.equal(inStock.includes('36'), true, '36（普通码）有货 ⇒ 现货区 ✓');
  assert.deepEqual((groups.folded || []).map((item) => item.size_text), [],
    '有货的尺码一个都不许进折叠块 ✗');
});

test('AC-SF3 ⭐ 缺货的**普通码** ⇒ 预订区正常显示（不折叠 ✗）', () => {
  const view = viewOf({ number: 'JX505|咖色|B', stocked: [36], missing: [37, 38, 39, 40] });
  const groups = realm.saleSizeGroups(view);
  const prepaid = groups.prepaid.map((item) => item.size_text);
  for (const size of ['37', '38', '39', '40']) {
    assert.ok(prepaid.includes(size), `缺货的普通码 ${size} 要留在预订区（不折叠 ✓）`);
  }
  // ⭐ 特殊码 = 女 34/35/41/42/43 ⇒ 这五条必须**不在**预订区（它们在折叠块里 ✓）
  for (const size of ['34', '35', '41', '42', '43']) {
    assert.equal(prepaid.includes(size), false, `缺货的特殊码 ${size} 不许留在预订区 ✗（要进折叠块）`);
  }
});

test('AC-SF4 ⭐ 缺货的**特殊码** ⇒ 收进折叠块（`folded`），且**按男女各自一块**', () => {
  const female = viewOf({ number: 'JX505|咖色|B', stocked: [36], missing: [34, 35, 41, 42, 43] });
  const male = viewOf({ number: 'MK31|黑|A', stocked: [40], missing: [45, 46, 47, 48] });
  assert.deepEqual((realm.saleSizeGroups(female).folded || []).map((item) => Number(item.size_text)), [34, 35, 41, 42, 43],
    '女鞋折叠块 = 女鞋的特殊码（缺货的，含 41）');
  assert.deepEqual((realm.saleSizeGroups(male).folded || []).map((item) => Number(item.size_text)), [45, 46, 47, 48],
    '男鞋折叠块 = 男鞋的特殊码（缺货的，含 45）');
  // ⭐ 同页不混：女鞋那一块里不许出现男鞋的码 ✓
  const femaleFolded = (realm.saleSizeGroups(female).folded || []).map((item) => item.size_text);
  assert.equal(femaleFolded.some((size) => ['46', '47', '48'].includes(size)), false, '女鞋块里不许混男鞋的特殊码 ✗');
});

// ═══════════════════════════════════════════════════════════════════════════
// 折叠块本体：原生 details / 默认收起 / ≥44px / 零 JS
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SF5 ⭐ 折叠块用**原生 `<details><summary>`**、默认收起、summary ≥44px、零 JS', () => {
  // ① 配置三键（显式布尔 + 文案走配置，不写死中文 ✗）
  const cfg = SCAN_PAGE.specialSizes || {};
  assert.equal(cfg.foldable, true, '`specialSizes.foldable` = true（显式布尔 ✓）');
  assert.equal(cfg.collapsedByDefault, true, '`specialSizes.collapsedByDefault` = true');
  assert.equal(cfg.toggleLabel, '特殊码', '折叠头文案走配置（渲染层不写死中文 ✗）');
  // ② 渲染层用的是原生 details + summary + 默认收起（**不带 `open`**）
  assert.match(RENDERER_SRC, /<details class="size-group size-fold"/, '要用原生 `<details>`（零 JS ✓）');
  assert.ok(/size-fold__summary/.test(RENDERER_SRC), '`<summary>` 要带自己的类名');
  assert.match(RENDERER_SRC, /\.size-fold__summary \{[^}]*min-height: var\(--control-height\)/,
    '`<summary>` 命中区 ≥44px（`--control-height` = 44px ✓）');
  assert.equal(/specialSizes\.collapsedByDefault !== false[\s\S]{0,40}open/.test(RENDERER_SRC), false,
    '默认收起 ⇒ **不许**默认带 `open` ✗');
  // ③ 这一块里不许引入 JS（页面上零脚本 ✓）
  const foldBlock = RENDERER_SRC.slice(RENDERER_SRC.indexOf('size-fold'), RENDERER_SRC.indexOf('size-fold') + 1200);
  assert.equal(/<script/.test(foldBlock), false, '折叠块里不许有脚本 ✗');
});

test('AC-SF6 ⭐ 回归：可录范围本体（验收页在用）**一字不动**', () => {
  const { sizesForCategory } = require('../src/services/scanPageService');
  assert.deepEqual(sizesForCategory('A', SCAN_PAGE).sizes, [38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48],
    '验收页候选仍按可录范围（含 46/47/48 ✓ AC-AP10）');
  assert.deepEqual(sizesForCategory('B', SCAN_PAGE).sizes, [34, 35, 36, 37, 38, 39, 40, 41, 42, 43]);
  // 2026-10-28 口径收口：无调用的旧包装 `loadSizeScope` 已删除；可录范围本体是 `sizesForCategory` ✓
  assert.equal(/const loadSizeScope =/.test(SERVICE_SRC), false, '`loadSizeScope` 已删除 ✗');
  // 落点哨兵：折叠块**不许**进库存块（`stockTableHtml` 逐字不变 ⇒ AC1）
  assert.equal(/stockTableHtml[\s\S]{0,800}size-fold/.test(RENDERER_SRC), false,
    '折叠块不许放进库存块（`AC1` 哨兵）✗');
});
