'use strict';

require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）

/**
 * ⭐⭐ 2026-10-14：**"展示尺码读 normal、特殊码只在有货时出现"这条接线**的**回归哨兵**。
 *
 * 结论（先核后写）：**这条修已经在 main 上（`38d80eb`）** ——
 *   · `services/scanPageService.js:1163-1166`：销售/库存那条链的 `scope = normalScopeOf(parsed.categoryCode)`
 *     （`normalScopeOf:771-780` = 配置的 `normal`：A 38–44 · B 36–40 ⇒ **零飞书读** ✓ special 不参与缺码 ✓）
 *   · `loadSizeScope`（= `sizesForCategory`，`from/to` = **enterable** 女 34–43 / 男 38–48）**留给验收页** ✓
 *   · `renderSizes = buckets.keys() ∪ scope.sizes` ⇒ **有货的特殊码照旧出现在现货** ✓（它在 `buckets` 里）
 *   · 缺码 = `scopeSet(=normal).has(size) && rowTotal === 0` ⇒ **没货的特殊码根本不进 renderSizes** ✓
 *     ⇒ 不显示、不算缺码、不进预订 ✓（她："特殊码不要天天提示缺 43/48" ✓）
 *
 * ⚠️ 我第一版把这条修**落到了共用的 `sizesForCategory`** ⇒ 全量两遍各 1 红（`AC-AP10`：验收页候选少了 46/47/48 ✗）
 * ⇒ 因此本文件的第一条 AC 就是**"不许越界"的哨兵**：`sizesForCategory` 必须**继续**返回可录范围（验收页口径）✓
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

test('AC-SW-4 ⭐ 验收页口径未被牵连（`loadSizeScope` 仍在，且只给验收用）', () => {
  const code = fs.readFileSync(path.join(__dirname, '../src/services/scanPageService.js'), 'utf8');
  assert.match(code, /const loadSizeScope = async \(\{ categoryCode \}\) => sizesForCategory\(categoryCode, config\)/,
    '`loadSizeScope`（可录范围）保留 ✓');
  // ⭐⭐ 2026-10-14 晚 **改指向**（依据：她「`/r/accept` 这条路要彻底拆掉」）：
  //   改前逐字：`assert.match(acceptance, /sizesForCategory\(categoryCode, config\)/, '验收页仍在用 …')`
  //   改后：验收那一屏退场 ⇒ 扫码页路由里**不再有**这个调用点 ✓；
  //        而**「可录范围」本体与它的一致性核对照旧**（`sizesForCategory` / `loadSizeScope` 都在 ✓ 没删 ✗）
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/scanPage.js'), 'utf8');
  assert.equal(/sizesForCategory\(categoryCode, config\)/.test(route), false,
    '扫码页路由里不再有验收页那个调用点（它随验收退场 ✓）');
  assert.match(code, /const sizesForCategory = \(categoryCode, config = SCAN_PAGE\) => \{/,
    '「可录范围」本体仍在（验收退场 ≠ 能力删 ✗）');
});
