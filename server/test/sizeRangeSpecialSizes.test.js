/**
 * ⭐⭐ 2026-10-13「尺码范围 + 特殊尺码」（业务负责人逐字确认 · docs/size-range-special-sizes-2026-10-13.md）
 *
 * 口径：
 *   · **可录范围**：女 34–43 · 男 38–48（都能录 ✓）
 *   · **默认展示 / 缺码判断**：女 35–42 · 男 38–45 ✓
 *   · **特殊尺码** = 女 [34,43] · 男 [46,47,48]（共 5 个）：
 *       采购明细里**出现过才展示**（不看实时库存 ✗）· 没出现 ⇒ 不显示、**也不算缺码** ✓
 *
 * ⚠️ 本文件只断言**纯函数**（无 IO）⇒ 接线（scanPageRealm.js 的 missing）由 Lead 在六 tab 合完后安排。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { SIZE_SEGMENTS, missingSizes, displaySizes, expandRange } = require('../src/config/scanPage');

const R = SIZE_SEGMENTS.ranges;

// ══════════════════════════════════════════════════════════════════════════════
// AC-1 ⭐ 默认展示**不含**特殊码（女 34/43 · 男 46/47/48）
// ══════════════════════════════════════════════════════════════════════════════
test('AC-1 ⭐ 默认展示不含 34 / 43（女）· 不含 46 / 47 / 48（男）', () => {
  // 采购明细里**一个特殊码都没出现** ⇒ 展示清单 = 纯 default
  const women = displaySizes('B', []);
  assert.deepEqual(women.base, [35, 36, 37, 38, 39, 40, 41, 42], '女默认 35–42');
  assert.deepEqual(women.extra, [], '没出现过特殊码 ⇒ 不展示 ✓');
  const men = displaySizes('A', []);
  assert.deepEqual(men.base, [38, 39, 40, 41, 42, 43, 44, 45], '男默认 38–45');
  assert.deepEqual(men.extra, [], '46/47/48 不展示 ✓');
  // 三条硬口径（逐条钉住）
  assert.equal(R.B.default.includes(34), false, '女默认不含 34');
  assert.equal(R.B.default.includes(43), false, '女默认不含 43');
  for (const size of [46, 47, 48]) assert.equal(R.A.default.includes(size), false, `男默认不含 ${size}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// AC-2 ⭐⭐ 采购明细里**出现过**的特殊码 ⇒ 才展示（不看实时库存）
// ══════════════════════════════════════════════════════════════════════════════
test('AC-2 ⭐⭐ 采购明细里出现过 34 / 43 ⇒ 女鞋清单出现；没出现 ⇒ 不展示（男同理）', () => {
  assert.deepEqual(displaySizes('B', [34, 43]).extra, [34, 43], '出现过 ⇒ 展示 ✓');
  assert.deepEqual(displaySizes('B', [34]).extra, [34], '只出现过 34 ⇒ 只展示 34（43 不展示 ✓）');
  assert.deepEqual(displaySizes('B', [40]).extra, [], '出现过的是常规码 ⇒ 特殊码一个都不展示 ✓');
  assert.deepEqual(displaySizes('A', [46, 48]).extra, [46, 48], '男：出现过 46/48 ⇒ 展示 ✓');
  assert.deepEqual(displaySizes('A', [47]).extra, [47], '只出现过 47 ⇒ 只展示 47');
  assert.deepEqual(displaySizes('A', [38]).extra, [], '常规码出现不影响特殊码展示 ✓');
});

// ══════════════════════════════════════════════════════════════════════════════
// AC-3 ⭐⭐ 缺码判断**只算默认范围**（这 5 个特殊码不出现 ⇒ **不算缺码**）
// ══════════════════════════════════════════════════════════════════════════════
test('AC-3 ⭐⭐ 缺码判断只算默认范围 —— 34/43/46/47/48 不出现也不报缺', () => {
  // 女：有 35–42 全套 ⇒ 不该报任何缺（34 / 43 **不算缺** ✓）
  assert.deepEqual(missingSizes('B', [35, 36, 37, 38, 39, 40, 41, 42]), [], '女不缺');
  // 男：有 38–45 全套 ⇒ 不该报 46/47/48 缺 ✓
  assert.deepEqual(missingSizes('A', [38, 39, 40, 41, 42, 43, 44, 45]), [], '男不缺');
  // 真的缺常规码 ⇒ 如实报（且**只报默认范围内的**）
  assert.deepEqual(missingSizes('B', [35, 36]), [37, 38, 39, 40, 41, 42], '女缺 37–42（不含 34/43 ✓）');
  assert.deepEqual(missingSizes('A', [38]), [39, 40, 41, 42, 43, 44, 45], '男缺 39–45（不含 46/47/48 ✓）');
  // 反向哨兵：就算她表里有特殊码的库存，它**也不进缺码判据** ✓
  assert.equal(missingSizes('A', [46]).includes(46), false);
  assert.equal(missingSizes('B', [34, 43]).includes(34), false);
});

// ══════════════════════════════════════════════════════════════════════════════
// AC-4 ⭐ 特殊码出现时**能正常选中并录入**（与常规码同一条链路 = 都在可录范围里）
// ══════════════════════════════════════════════════════════════════════════════
test('AC-4 ⭐ 特殊码与常规码同一条链路：5 个特殊码都在 enterable 范围里（可录 ✓）', () => {
  const menEnterable = expandRange(R.A.enterable);
  const womenEnterable = expandRange(R.B.enterable);
  assert.deepEqual(menEnterable, [38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48], '男可录 38–48 ✓');
  assert.deepEqual(womenEnterable, [34, 35, 36, 37, 38, 39, 40, 41, 42, 43], '女可录 34–43 ✓');
  for (const size of R.A.special) assert.equal(menEnterable.includes(size), true, `男 ${size} 可录 ✓`);
  for (const size of R.B.special) assert.equal(womenEnterable.includes(size), true, `女 ${size} 可录 ✓`);
  // ⚠️ 但"可录"≠"默认展示" ⇒ 两者必须分开（这是本次改动的核心 ✓）
  assert.notDeepEqual(R.A.enterable, R.A.default);
  assert.notDeepEqual(R.B.enterable, R.B.default);
});

// ══════════════════════════════════════════════════════════════════════════════
// AC-5 ⭐ 配置单一来源：三个纯函数都读同一份 SIZE_SEGMENTS.ranges（没有第二份数字）
// ══════════════════════════════════════════════════════════════════════════════
test('AC-5 ⭐ 配置单一来源：改配置即改行为（纯函数不含硬编码数字）', () => {
  // 三段齐全 + 都是 [起,止] 形状
  for (const key of ['A', 'B']) {
    const range = R[key];
    for (const seg of ['enterable', 'default', 'special']) {
      assert.ok(Array.isArray(range[seg]), `${key}.${seg} 必须是数组`);
    }
    assert.equal(range.enterable[0], range.from, `${key}：from == enterable 起点（兼容语义不变 ✓）`);
    assert.equal(range.enterable[1], range.to, `${key}：to == enterable 终点 ✓`);
  }
  // 默认范围必须**真包含于**可录范围（否则"可录"是假的）
  for (const key of ['A', 'B']) {
    const enterable = expandRange(R[key].enterable);
    for (const size of expandRange(R[key].default)) {
      assert.equal(enterable.includes(size), true, `${key} 默认 ${size} 必须在可录范围内`);
    }
  }
  // 特殊码必须落在可录范围的**两端之外**（否则它就不是"特殊"了）
  assert.deepEqual(R.A.special, [46, 47, 48], '男特殊 = 46/47/48（default 上界 45 之上）');
  assert.deepEqual(R.B.special, [34, 43], '女特殊 = 34/43（default 34–43 的两端）');
});

// ══════════════════════════════════════════════════════════════════════════════
// AC-6 采购明细读取失败 ⇒ **明确降级**（只给 default）+ warn（**不静默少码**）
//   ⚠️ 它要 `services/purchaseSizeReader.js`（(甲) 已批准新增，下一轮交）
//      ⇒ 本轮**先钉住调用方的降级口径**：读不到 ⇒ `displaySizes(category, [])` = 只给 default ✓
// ══════════════════════════════════════════════════════════════════════════════
test('AC-6 采购明细读不到 ⇒ 明确降级成"只给 default"（等价于一个特殊码都没出现过）', () => {
  for (const [key, base] of [['A', [38, 39, 40, 41, 42, 43, 44, 45]], ['B', [35, 36, 37, 38, 39, 40, 41, 42]]]) {
    const degraded = displaySizes(key, []); // 降级 = 空清单（**不是**"装作读过"）
    assert.deepEqual(degraded.base, base, `${key}：降级后仍给完整 default（不漏常规码 ✓）`);
    assert.deepEqual(degraded.extra, [], `${key}：降级后不给任何特殊码（宁可少、不猜 ✓）`);
  }
});
