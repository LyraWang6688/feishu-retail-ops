/**
 * ⭐⭐ 2026-10-13「特殊尺码接线」（docs/size-range-special-sizes-2026-10-13.md）
 *
 * 口径：**特殊码（女 34/43 · 男 46/47/48）只在「采购明细」里出现过才展示** ——
 *   没出现过 ⇒ 不显示、也不算缺码 ✓（不天天提示她"缺 43 / 缺 48"）。
 *
 * 落点：`views/scanPageRealm.js` 的 `sizeRowsOf(view)` —— 尺码清单的**唯一**收口点
 *   （`saleSizeGroups` / `purchaseSizeLines` 都从它出）⇒ 一处生效、覆盖扫码页 + 采购清单 ✓
 *
 * ⚠️ `view.present_special_sizes` 的**填充**由 `routes/scanPage.js` 落
 *   （`purchaseSizeReader.listSizes()` ⇒ 失败 ⇒ warn + `[]` = 只给 default ✓）；
 *   本文件只钉住"它缺失/为空时**安全降级**"这一半 ✓。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { purchaseSizeLines } = require('../src/views/scanPageRealm');

/**
 * 造一个最小视图模型：`sizes` = "这一款有哪些码"（尺码管理给的清单）。
 * ⚠️ 必须给 `number`（编号第 3 段 = 类别）—— 特殊码**按类别**判：
 *   `43` 对女（B）是特殊码、对男（A）是常规码 ⇒ 并集判会误伤 mens 的 43。
 */
const viewOf = (sizes, presentSpecialSizes, category = 'A') => ({
  number: `X|黑|${category}`,
  rows: sizes.map((size) => ({ size_text: String(size), cells: [] })),
  columns: [],
  ...(presentSpecialSizes === undefined ? {} : { present_special_sizes: presentSpecialSizes }),
});

/** 女款（类别 B）的视图模型。 */
const womenViewOf = (sizes, present) => viewOf(sizes, present, 'B');

const sizesOf = (view) => purchaseSizeLines(view).map((line) => line.size_text);

// ══════════════════════════════════════════════════════════════════════════════
test('AC-1 ⭐ 默认展示不含 34 / 43（女）· 不含 46 / 47 / 48（男）', () => {
  const women = womenViewOf([34, 35, 36, 37, 38, 39, 40, 41, 42, 43]);
  const men = viewOf([38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48]);
  assert.deepEqual(sizesOf(women), ['35', '36', '37', '38', '39', '40', '41', '42'], '女：34/43 不展示 ✓');
  assert.deepEqual(sizesOf(men), ['38', '39', '40', '41', '42', '43', '44', '45'], '男：46/47/48 不展示 ✓');
});

// ══════════════════════════════════════════════════════════════════════════════
test("AC-2 ⭐⭐ present_special_sizes = ['34'] ⇒ **只**多出 34（43 不出现）", () => {
  const sizes = [34, 35, 36, 37, 38, 39, 40, 41, 42, 43];
  assert.deepEqual(sizesOf(womenViewOf(sizes, ['34'])), ['34', '35', '36', '37', '38', '39', '40', '41', '42'],
    '出现过 34 ⇒ 只多出 34 ✓（43 没出现 ⇒ 仍不展示 ✓）');
  assert.deepEqual(sizesOf(womenViewOf(sizes, [43])), ['35', '36', '37', '38', '39', '40', '41', '42', '43'],
    '出现过 43 ⇒ 只多出 43 ✓');
  assert.deepEqual(sizesOf(womenViewOf(sizes, ['34', '43'])), ['34', '35', '36', '37', '38', '39', '40', '41', '42', '43'],
    '两个都出现过 ⇒ 两个都展示 ✓');
  // 男同理
  const men = [38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48];
  assert.deepEqual(sizesOf(viewOf(men, ['47'])), ['38', '39', '40', '41', '42', '43', '44', '45', '47'],
    '男：出现过 47 ⇒ 只多出 47 ✓');
});

// ══════════════════════════════════════════════════════════════════════════════
test('AC-3 ⭐ present_special_sizes 缺失 / 为空 ⇒ 特殊码全不显示（= 明确降级"只给 default"）', () => {
  const sizes = [34, 35, 36, 37, 38, 39, 40, 41, 42, 43];
  const base = ['35', '36', '37', '38', '39', '40', '41', '42'];
  assert.deepEqual(sizesOf(womenViewOf(sizes)), base, '字段**缺失** ⇒ 降级成只给 default ✓（不静默多显示 ✗）');
  assert.deepEqual(sizesOf(womenViewOf(sizes, [])), base, '字段**为空** ⇒ 同上 ✓');
  assert.deepEqual(sizesOf(womenViewOf(sizes, null)), base, 'null ⇒ 同上（不崩）✓');
});

// ══════════════════════════════════════════════════════════════════════════════
test('AC-4 ⭐⭐ 被过滤掉的特殊码**不产生 missing**（缺码判断只算 default）', () => {
  const women = womenViewOf([34, 35, 36, 37, 38, 39, 40, 41, 42, 43]); // 一个都没出现过
  const lines = purchaseSizeLines(women);
  assert.deepEqual(lines.filter((line) => line.missing).map((line) => line.size_text), [],
    '女：34/43 **不算缺码** ✓（它们压根不在清单里）');
  // 出现过 ⇒ 才能进清单；此时它才可能有 missing（与常规码同一条链路 ✓）
  const withSpecial = purchaseSizeLines(womenViewOf([34, 35, 36, 37, 38, 39, 40, 41, 42, 43], ['34']));
  assert.equal(withSpecial.some((line) => line.size_text === '34'), true, '出现过 ⇒ 进清单 ✓');
  const men = purchaseSizeLines(viewOf([38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48]));
  assert.deepEqual(men.filter((line) => line.missing).map((line) => line.size_text), [],
    '男：46/47/48 **不算缺码** ✓');
});

// ══════════════════════════════════════════════════════════════════════════════
test('AC-5 ⭐ 回归哨兵：常规码**一个都不许误伤**（女 35–42 / 男 38–45 全在）', () => {
  const women = womenViewOf([35, 36, 37, 38, 39, 40, 41, 42]);
  const men = viewOf([38, 39, 40, 41, 42, 43, 44, 45]);
  assert.deepEqual(sizesOf(women), ['35', '36', '37', '38', '39', '40', '41', '42'], '女常规码全在 ✓');
  assert.deepEqual(sizesOf(men), ['38', '39', '40', '41', '42', '43', '44', '45'], '男常规码全在 ✓');
  // ⚠️ 反向哨兵：连"有 special 字段但里面全是别的码"也不许误伤常规码
  assert.deepEqual(sizesOf(womenViewOf([35, 36, 37, 38, 39, 40, 41, 42], ['99', '100'])), ['35', '36', '37', '38', '39', '40', '41', '42'],
    '不认识的码不影响常规码 ✓');
  // 读不出尺码的那一行照旧不算
  assert.deepEqual(purchaseSizeLines({ rows: [{ size_text: '' }, { unknown_size: true, size_text: '40' }], columns: [] })
    .map((line) => line.size_text), [], '读不出尺码的行照旧不算 ✓');
});
