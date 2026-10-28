require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
/**
 * ⭐⭐ 2026-10-28「尺码范围 + 特殊尺码」的**现行口径**（唯一真源 `config/scanPage.js`）。
 *
 * 口径（**2026-10-18 起，之后未变**）：
 *   · **可录范围**：女 34–43 · 男 38–48（都能录 ✓）
 *   · **普通码（normal）**：女 **36–40** · 男 **38–44** ✓
 *   · **特殊尺码（special）**：女 **[34, 35, 41, 42, 43]** · 男 **[45, 46, 47, 48]** ✓
 *   · 缺货基准 = **可录范围 − 有货**（缺货特殊码归「特殊码」折叠块，不改变缺码基准）
 *
 * 🔴 2026-10-28 口径收口：旧的 `missingSizes` / `displaySizes`（缺码只算 default、
 *    “采购明细出现过才展示 special”）已从 `config/scanPage.js` **删除** —— 运行时无调用、
 *    只被旧测试引用，留着会与现行口径混淆 ✗。本文件只断言现行配置与纯函数 `expandRange`。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { SIZE_SEGMENTS, expandRange } = require('../src/config/scanPage');

const R = SIZE_SEGMENTS.ranges;

// ══════════════════════════════════════════════════════════════════════════════
// AC-1 ⭐ 普通码 = 默认展示范围，不含任何特殊码
// ══════════════════════════════════════════════════════════════════════════════
test('AC-1 ⭐ 普通码：女 36–40 · 男 38–44（默认展示不含特殊码）', () => {
  assert.deepEqual(expandRange(R.B.normal), [36, 37, 38, 39, 40], '女普通码 36–40');
  assert.deepEqual(expandRange(R.A.normal), [38, 39, 40, 41, 42, 43, 44], '男普通码 38–44');
  // default 是 normal 的兼容别名（同一份，不是第二份）
  assert.deepEqual(R.B.default, R.B.normal, 'B.default === B.normal（兼容别名 ✓）');
  assert.deepEqual(R.A.default, R.A.normal, 'A.default === A.normal（兼容别名 ✓）');
  // 普通码不含特殊码
  for (const size of R.B.special) assert.equal(R.B.normal.includes(size), false, `女普通码不含特殊码 ${size}`);
  for (const size of R.A.special) assert.equal(R.A.normal.includes(size), false, `男普通码不含特殊码 ${size}`);
  // 2026-10-18 的关键裁决：41 从普通码移入特殊码
  assert.equal(R.B.normal.includes(41), false, '女普通码不含 41（2026-10-18 移入特殊码）✓');
});

// ══════════════════════════════════════════════════════════════════════════════
// AC-2 ⭐⭐ 特殊码 = 离散清单（不是区间），且与普通码互斥
// ══════════════════════════════════════════════════════════════════════════════
test('AC-2 ⭐⭐ 特殊码：女 34/35/41/42/43 · 男 45/46/47/48（离散、与普通码互斥）', () => {
  assert.deepEqual(R.B.special, [34, 35, 41, 42, 43], '女特殊码 = 34/35/41/42/43');
  assert.deepEqual(R.A.special, [45, 46, 47, 48], '男特殊码 = 45–48');
  for (const key of ['A', 'B']) {
    const normal = expandRange(R[key].normal);
    for (const size of R[key].special) {
      assert.equal(normal.includes(size), false, `${key} 特殊码 ${size} 不许同时是普通码`);
    }
    // 特殊码必须是升序、去重（离散清单）
    assert.deepEqual([...R[key].special].sort((a, b) => a - b), R[key].special, `${key}.special 必须升序`);
    assert.equal(new Set(R[key].special).size, R[key].special.length, `${key}.special 不许重复`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AC-3 ⭐ 可录范围 = 普通码 ∪ 特殊码（现行缺货基准）
// ══════════════════════════════════════════════════════════════════════════════
test('AC-3 ⭐ 可录范围：女 34–43 · 男 38–48 = 普通码 ∪ 特殊码', () => {
  assert.deepEqual(expandRange(R.B.enterable), [34, 35, 36, 37, 38, 39, 40, 41, 42, 43], '女可录 34–43');
  assert.deepEqual(expandRange(R.A.enterable), [38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48], '男可录 38–48');
  for (const key of ['A', 'B']) {
    const union = [...expandRange(R[key].normal), ...R[key].special].sort((a, b) => a - b);
    assert.deepEqual(union, expandRange(R[key].enterable),
      `${key}：可录范围必须 = 普通码 ∪ 特殊码（不留无人管的码）`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AC-4 ⭐ 兼容语义：from/to 仍等于 enterable 两端（既有渲染层按 from/to 取值）
// ══════════════════════════════════════════════════════════════════════════════
test('AC-4 ⭐ from/to 与 enterable 两端一致（兼容旧语义，不另写一份数字）', () => {
  for (const key of ['A', 'B']) {
    const range = R[key];
    assert.equal(range.from, range.enterable[0], `${key}：from == enterable 起点`);
    assert.equal(range.to, range.enterable[1], `${key}：to == enterable 终点`);
    assert.deepEqual(expandRange({ from: range.from, to: range.to }), expandRange(range.enterable),
      `${key}：from/to 展开 == enterable 展开`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AC-5 ⭐ 旧 helper 不再导出（防止它们被重新引回、与现行口径并存）
// ══════════════════════════════════════════════════════════════════════════════
test('AC-5 ⭐ 旧 helper `missingSizes` / `displaySizes` 不再从 config 导出', () => {
  // eslint-disable-next-line global-require
  const config = require('../src/config/scanPage');
  assert.equal(config.missingSizes, undefined, '`missingSizes` 已删除（缺码现行基准在 service 层）');
  assert.equal(config.displaySizes, undefined, '`displaySizes` 已删除（特殊码展示在 realm 层）');
});
