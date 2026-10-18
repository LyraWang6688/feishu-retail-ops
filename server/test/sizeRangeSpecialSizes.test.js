require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
/**
 * ⭐⭐ 2026-10-13「尺码范围 + 特殊尺码」（业务负责人逐字确认 · docs/size-range-special-sizes-2026-10-13.md）
 *
 * 口径（**2026-10-14 由业务负责人两次改写，以最后一次为准**）：
 *   · **可录范围**：女 34–43 · 男 38–48（都能录 ✓）
 *   · **普通码（normal）= 默认展示 / 缺码判断 / 销售页"预订"范围**：女 **36–41** · 男 **38–44** ✓
 *   · **特殊尺码（special）** = 女 **[34, 35, 42, 43]** · 男 **[45, 46, 47, 48]**：
 *       ⭐ **实时库存里有 ⇒ 就展示** ✓；没有 ⇒ 不显示、**也不算缺码** ✓
 *       （⚠️ 改前是"采购明细里出现过才展示"✗ —— 那条读表已按她拍板**整块删除** ✓）
 *
 * ⚠️ 本文件只断言**纯函数**（无 IO）⇒ 接线（scanPageRealm.js 的 missing）在六 tab 那批里已落地。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { SIZE_SEGMENTS, missingSizes, displaySizes, expandRange } = require('../src/config/scanPage');

const R = SIZE_SEGMENTS.ranges;

// ══════════════════════════════════════════════════════════════════════════════
// AC-1 ⭐ 默认展示**不含**特殊码（女 34/43 · 男 46/47/48）
// ══════════════════════════════════════════════════════════════════════════════
test('AC-1 ⭐ 默认展示不含 34 / 43（女）· 不含 45 / 46 / 47 / 48（男）', () => {
  // 2026-10-14 改指向（她晚定：女普通码 **36–41**，覆盖 36–42 / 35–42）：
  //   能力不变 —— 默认展示 = **普通码**（不含任何特殊码 ✓）。
  //   改前逐字：assert.deepEqual(women.base, [36,37,38,39,40,41,42], '女默认 36–42（她 2026-10-14 明确 ✓）');
  const women = displaySizes('B', []);
  assert.deepEqual(women.base, [36, 37, 38, 39, 40, 41], '女普通码 36–41（她 2026-10-14 晚明确 ✓）');
  assert.deepEqual(women.extra, [], '没有特殊码库存 ⇒ 不展示 ✓');
  const men = displaySizes('A', []);
  assert.deepEqual(men.base, [38, 39, 40, 41, 42, 43, 44], '男默认 38–44');
  assert.deepEqual(men.extra, [], '46/47/48 不展示 ✓');
  // 三条硬口径（逐条钉住）
  assert.equal(R.B.default.includes(34), false, '女默认不含 34');
  assert.equal(R.B.default.includes(43), false, '女默认不含 43');
  for (const size of [45, 46, 47, 48]) assert.equal(R.A.default.includes(size), false, `男默认不含 ${size}`);
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
  // 女：有 36–41 全套 ⇒ 不该报任何缺（34/35/42/43 **不算缺** ✓）
  assert.deepEqual(missingSizes('B', [36, 37, 38, 39, 40, 41]), [], '女不缺');
  // 男：有 38–44 全套 ⇒ 不该报 45/46/47/48 缺 ✓
  assert.deepEqual(missingSizes('A', [38, 39, 40, 41, 42, 43, 44]), [], '男不缺');
  // 真的缺常规码 ⇒ 如实报（且**只报普通码范围内的**）
  assert.deepEqual(missingSizes('B', [35, 36]), [37, 38, 39, 40, 41], '女缺 37–41（不含 34/35/42/43 ✓）');
  assert.deepEqual(missingSizes('A', [38]), [39, 40, 41, 42, 43, 44], '男缺 39–44（不含 45–48 ✓）');
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
  assert.deepEqual(R.A.special, [45, 46, 47, 48], '男特殊 = 45–48（45 从普通码移入）');
  // 2026-10-14 改指向（她当日最后一条）：女特殊 = **34/35/42/43**（⭐ 42 也算特殊 —— 普通码只到 41）
  //   改前逐字：assert.deepEqual(R.B.special, [34, 43], '女特殊 = 34/43（default 34–43 的两端）');
  assert.deepEqual(R.B.special, [34, 35, 42, 43], '女特殊 = 34/35/42/43（普通码 36–41 的两端）');
});

// ══════════════════════════════════════════════════════════════════════════════
// AC-6（**2026-10-14 退役原能力，改成源码哨兵**）
//   ⚠️ 原 AC 钉的是"采购明细读不到 ⇒ 降级成只给 default" ——
//      业务负责人 2026-10-14 拍板：「**不用读尺码管理和采购明细了**，扫一扫只需要读货品信息和实时库存」
//      ⇒ 那次读**整块删除** ⇒ 原来这条 AC **没有对象了** ✓
//   能力去哪：降级仍然存在（`missingSizes`/`displaySizes` 只按**普通码**算 ⇒ 不依赖任何读表 ✓），
//      只是**不再有"采购明细那次读"** ⇒ 用源码哨兵钉住"扫码页不再引用它" ✓（能真红 ✓）
// ══════════════════════════════════════════════════════════════════════════════
test('AC-6（退役→哨兵）扫码页**不再引用**采购明细读取器 / 特殊码字段；缺码仍只按普通码算', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  // ⚠️ 2026-10-14 修正假红：**必须先剥注释**再 match —— 我在注释里解释历史用词（`purchaseSizeReader`）
  //   会被当成引用 ✗（能力判断只看**代码** ✓ 严格性不变 ✗）
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const rel of ['src/routes/scanPage.js', 'src/services/scanPageService.js', 'src/views/scanPageRealm.js']) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    const code = strip(src);
    assert.equal(/purchaseSizeReader/.test(code), false, `${rel} 的**代码**里不许再 require/调用采购明细读取器 ✗`);
    assert.equal(/present_special_sizes/.test(code), false, `${rel} 的**代码**里不许再往视图模型挂那个字段 ✗`);
  }
  // 配置里那两套码仍然清楚（普通码判缺码 / 特殊码只展示 ✓），且**不依赖任何读表**
  assert.deepEqual(expandRange(R.A.normal), [38, 39, 40, 41, 42, 43, 44], '男普通码 38–44 ✓');
  assert.deepEqual(expandRange(R.B.normal), [36, 37, 38, 39, 40, 41], '女普通码 36–41 ✓');
  assert.deepEqual(missingSizes('B', [36]), [37, 38, 39, 40, 41], '缺码仍只按普通码算（0 次读表 ✓）');
});
