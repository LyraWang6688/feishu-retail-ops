'use strict';

require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）

/**
 * ⭐⭐ 2026-10-14（2026-10-28 口径收口后修订）：**展示尺码接线**的回归哨兵。
 *
 * 现行口径（唯一真源 `config/scanPage.js`）：
 *   · 展示/缺货基准 = **可录范围 enterable**（女 34–43 / 男 38–48）；
 *   · 有货的尺码（含特殊码）照旧出现在现货区；缺货特殊码归「特殊码」折叠块；
 *   · `renderSizes = buckets.keys() ∪ scope.sizes`；缺码 = 在可录范围内 && 三状态都没货。
 *
 * 🔴 2026-10-28：旧的 `normalScopeOf` / `loadSizeScope` 已删除（前者是旧缺码基准，
 *    后者是无调用的包装）；不要按本文件旧版本的注释去源码里找它们 ✗。
 * ⚠️ 本文件第一条 AC 仍钉住：`sizesForCategory` 必须继续返回**可录范围**
 *    （它是验收/一致性核对共用的能力，不许收窄成 normal ✗）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SCAN_PAGE } = require('../src/config/scanPage');
const { sizesForCategory } = require('../src/services/scanPageService');

test('AC-SW-1 ⭐⭐ 越界哨兵：`sizesForCategory` 必须**继续**是"可录范围"（验收页口径：A 38–48 / B 34–43）', () => {
  assert.deepEqual(sizesForCategory('A', SCAN_PAGE).sizes, [38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48],
    'A 可录范围 38–48（验收页"应有尺码"要用它 ⇒ 不许收窄成 normal ✗）');
  assert.deepEqual(sizesForCategory('B', SCAN_PAGE).sizes, [34, 35, 36, 37, 38, 39, 40, 41, 42, 43],
    'B 可录范围 34–43');
});

test('AC-SW-2 ⭐⭐ 展示侧的**缺货基准**读的是配置的 `enterable`（可录范围 A 38–48 · B 34–43）', () => {
  const ranges = SCAN_PAGE.sizeSegments.ranges;
  assert.deepEqual(ranges.A.normal, [38, 44], '男普通码 38–44');
  assert.deepEqual(ranges.B.normal, [36, 40], '女普通码 36–40');
  assert.deepEqual(ranges.A.special, [45, 46, 47, 48], '男特殊码 45–48（**只在有货时才显示** ✓）');
  assert.deepEqual(ranges.B.special, [34, 35, 41, 42, 43], '女特殊码 34/35/41/42/43（同上 ✓）');
  // ⭐⭐ 2026-10-14 **改指向**（她最终口径：缺货基准 = **可录范围** —— 依据
  //   docs/special-size-fold-and-enterable-base-2026-10-14.md 她的原话：「都是按照它的**可录范围**来，
  //   只不过把缺码或者预订里包含**特殊码的归集到一个折叠的区域**」）
  //   改前逐字：`assert.match(code, /scope = normalScopeOf\(parsed\.categoryCode\)/ …)`
  const code = fs.readFileSync(path.join(__dirname, '../src/services/scanPageService.js'), 'utf8');
  assert.match(code, /scope = enterableScopeOf\(parsed\.categoryCode\)/,
    '销售/库存那条链必须用 `enterableScopeOf`（可录范围 ⇒ 零飞书读 ✓）');
  assert.match(code, /const enterableScopeOf = \(categoryCode, config = SCAN_PAGE\) => \{[\s\S]{0,400}?range\?\.enterable/,
    '`enterableScopeOf` 必须读 `enterable`；且定义在**模块作用域**（能导出 ⇒ 用例直接调 ✓）');
});

test('AC-SW-3 ⭐⭐ 有货的特殊码**照旧出现**（靠 `buckets` 带进来）；没货的特殊码**不进展示集合**', () => {
  const code = fs.readFileSync(path.join(__dirname, '../src/services/scanPageService.js'), 'utf8');
  // 展示集合 = 有货的 ∪ 配置范围 ⇒ 有货的特殊码天然在里面 ✓
  assert.match(code, /const renderSizes = sortSizes\(\[\.\.\.new Set\(\[\.\.\.buckets\.keys\(\), \.\.\.scope\.sizes\]\)\]\)/,
    '展示集合 = 有货 ∪ 配置范围（有货的特殊码 ⇒ 现货里照旧出现 ✓）');
  // ⭐⭐ 2026-10-14 改指向：缺码仍在"配置范围之内"判，但那个范围 = **可录范围**（含特殊码 ✓）
  //   ⇒ 缺货的特殊码**有行、算缺**，展示层再把它收进「特殊码」折叠块 ✓
  //   （改前逐字：同一条断言，但注释写的是"没货的特殊码既不显示也不算缺码 ✗"）
  assert.match(code, /missing: Boolean\(config\.missingSize\.enabled && !scope\.degraded && scopeSet\.has\(size\) && rowTotal === 0\)/,
    '缺码 = 在配置范围里 && 三状态都没货');
  assert.match(code, /const scopeSet = new Set\(scope\.sizes\)/, '`scopeSet` 来自 `scope.sizes`（= **可录范围** ✓）');
  // ⭐ 折叠落点：缺货的特殊码归到 `folded`（一处逻辑，展示层共用 ✓）
  const realm = fs.readFileSync(path.join(__dirname, '../src/views/scanPageRealm.js'), 'utf8');
  assert.match(realm, /if \(specialSet\.has\(item\.size_text\)\) folded\.push\(item\)/,
    '缺货 ∩ 特殊码 ⇒ 归到 `folded`（折叠块 ✓）');
});

test('AC-SW-4 ⭐ 旧 helper 已删；`sizesForCategory`（可录范围本体）仍在', () => {
  const code = fs.readFileSync(path.join(__dirname, '../src/services/scanPageService.js'), 'utf8');
  // 2026-10-28 口径收口：这两个旧 helper 不再存在（防止被重新引回、与现行口径并存）
  assert.equal(/const normalScopeOf =/.test(code), false, '`normalScopeOf` 已删除 ✗');
  assert.equal(/const loadSizeScope =/.test(code), false, '`loadSizeScope` 已删除 ✗');
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/scanPage.js'), 'utf8');
  assert.equal(/sizesForCategory\(categoryCode, config\)/.test(route), false,
    '扫码页路由里不再有验收页那个调用点（它随验收退场 ✓）');
  assert.match(code, /const sizesForCategory = \(categoryCode, config = SCAN_PAGE\) => \{/,
    '「可录范围」本体仍在（验收退场 ≠ 能力删 ✗）');
});
