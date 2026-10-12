/**
 * ⭐⭐ 2026-10-12 真机修复 AC：「二维码印了过期公式值」
 *
 * 【现场】她 17:45 扫出来的编号 = `MK31-1|咖色|`（**缺「类别」那一段**）⇒ 扫码页查不到 ⇒ 提交 400。
 *   日志：`product.tag_qr.number_mismatch` formula_number="MK31-1|咖色|"
 *         assembled_number="MK31-1|咖色|B" existing_file_name_number="MK31-1_咖色_" formula_looks_stale=true
 *   只读核生产真表：`MK31-1` 两款 类别=B ✓ 编号=`MK31-1|咖色|B` ✓ ⇒ **真表是对的** ⇒
 *   病根 = **写出去的值用了过期的公式值**。
 *
 * 【本轮实现】`resolveQrNumber`：
 *   ① `formulaLooksStale` **先算**（原来它在"拼装为空就回落公式"**之后**才算）；
 *   ② 拼装为空 **且公式停在旧值** ⇒ 记 `product.tag_qr.assemble_incomplete` 并标 `incomplete`
 *      （**不许静默把过期值印出去**）；
 *   ③ 用了拼装值 ⇒ 记 `product.tag_qr.used_assembled`（**两个值 + 三段源字段**，下次一发生即自证）；
 *   ④ 缺段 ⇒ 作业日志带 `assemble_incomplete` / `missing_segments`。
 *
 * ⚠️ 本文件只测 `resolveQrNumber` / `assembleParts` 这两个**纯函数**（走项目代码，
 *    通过 `createTagQrCodeService` 拿到的真实实现）—— 出图/写表那条另有既有用例覆盖。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { TAG_QR_CODE } = require('../src/config/tagQrCode');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

// ⚠️ `assembleParts` 读的是**物理列名**（`fieldNames = V1_BITABLE_SCHEMA.tables.product.fields`）
const COL = V1_BITABLE_SCHEMA.tables.product.fields;
const srcFields = ({ itemNo = '', color = '', category = '' }) => ({
  [COL.itemNo]: itemNo, [COL.color]: color, [COL.category]: category,
});
const { createTagQrCodeService } = require('../src/services/tagQrCodeService');

const svc = () => createTagQrCodeService({ gateway: {}, generatePng: async () => Buffer.from('png') });

// 与真机同一串：货号 MK31-1 · 颜色 咖色 · 类别 B
const FULL = 'MK31-1|咖色|B';
const STALE_FORMULA = 'MK31-1|咖色|';          // 公式停在旧值（缺类别）
const OLD_FILE_NAME_NUMBER = 'MK31-1_咖色_';   // 现存附件名里反解出来的（文件名形态）

test('AC-1 公式=旧值（缺段）且源字段齐全 ⇒ **用拼装值**（逐字）', () => {
  const { resolveQrNumber, assembleParts } = svc();
  // 源字段齐全 ⇒ assembleParts 三段都有值
  const fields = srcFields({ itemNo: 'MK31-1', color: '咖色', category: 'B' });
  const parts = assembleParts(fields);
  assert.deepEqual(parts.map((p) => [p.key, p.value]),
    [['itemNo', 'MK31-1'], ['color', '咖色'], ['category', 'B']],
    '三段源字段都要各自读得出值（诊断用）');

  const pick = resolveQrNumber({
    formulaNumber: STALE_FORMULA,
    assembledNumber: FULL,
    existingFileNameNumber: OLD_FILE_NAME_NUMBER,
    recordId: 'rec_mk31_1',
    parts,
  });
  // ⭐ 这就是本轮的病根：公式停在旧值 ⇒ **必须**用拼装值，而不是把旧公式印出去
  assert.equal(pick.number, FULL, '印出去的编号必须是拼装值（货号|颜色|类别 三段齐全）');
  assert.equal(pick.source, 'assembled_formula_stale');
  assert.equal(pick.formulaLooksStale, true);
  assert.equal(pick.mismatch, true);
  assert.deepEqual(pick.missingSegments, [], '源字段齐全 ⇒ 没有缺段');
});

test('AC-2 公式与拼装**一致** ⇒ 逐字回归（不变）', () => {
  const { resolveQrNumber } = svc();
  const pick = resolveQrNumber({
    formulaNumber: FULL, assembledNumber: FULL,
    existingFileNameNumber: 'MK31-1_咖色_B', recordId: 'rec', parts: [],
  });
  assert.equal(pick.number, FULL, '一致时原样用它');
  assert.equal(pick.source, 'both_agree');
  assert.equal(pick.mismatch, false, '一致 ⇒ 不算 mismatch（不产生噪音日志）');
});

test('AC-3 拼装**缺段** ⇒ 不静默：标 incomplete + 报出缺哪一段', () => {
  const { resolveQrNumber, assembleParts } = svc();
  // 颜色读成空（关联字段 type 18 读成数组/对象时就是这种形状）
  const fields = srcFields({ itemNo: 'MK31-1', color: '', category: 'B' });
  const parts = assembleParts(fields);
  assert.equal(parts.find((p) => p.key === 'color').value, '', '颜色那一段确实读空了');

  // 情形 a：公式**不是**旧值（没有现存附件可对照）⇒ 回落公式，但**报出缺段**
  const a = resolveQrNumber({
    formulaNumber: FULL, assembledNumber: '', existingFileNameNumber: null, recordId: 'rec', parts,
  });
  assert.equal(a.number, FULL, '没有可比对的旧值 ⇒ 仍以公式为准（保证与扫码页的键一致）');
  assert.equal(a.source, 'formula_only');
  assert.deepEqual(a.missingSegments, ['color'], '要能说出**缺的是哪一段**');

  // 情形 b：公式**停在旧值** ⇒ ⭐ 不许静默把过期值印出去，标 incomplete
  const b = resolveQrNumber({
    formulaNumber: STALE_FORMULA, assembledNumber: '',
    existingFileNameNumber: OLD_FILE_NAME_NUMBER, recordId: 'rec', parts,
  });
  assert.equal(b.source, 'formula_stale_incomplete');
  assert.equal(b.incomplete, true, '缺段 + 公式停旧值 ⇒ 产物上要有**可见标记**（不静默）');
  assert.equal(b.formulaLooksStale, true);
  assert.deepEqual(b.missingSegments, ['color']);
});

test('AC-4 只有一边有值 ⇒ 逐字回归（`none` / `assembled_fallback` / `formula_only`）', () => {
  const { resolveQrNumber } = svc();
  assert.equal(resolveQrNumber({ formulaNumber: '', assembledNumber: '', recordId: 'r', parts: [] }).source, 'none');
  const onlyAssembled = resolveQrNumber({
    formulaNumber: '', assembledNumber: FULL, recordId: 'r', parts: [],
  });
  assert.equal(onlyAssembled.number, FULL);
  assert.equal(onlyAssembled.source, 'assembled_fallback');
  const onlyFormula = resolveQrNumber({
    formulaNumber: FULL, assembledNumber: '', existingFileNameNumber: null, recordId: 'r', parts: [],
  });
  assert.equal(onlyFormula.number, FULL);
  assert.equal(onlyFormula.source, 'formula_only');
});

test('AC-5 配置先行：拼装顺序/分隔符来自 `config.numberAssembly`（换配置就换拼法）', () => {
  assert.deepEqual(TAG_QR_CODE.numberAssembly.fields, ['itemNo', 'color', 'category'],
    '顺序 = 她公式的顺序');
  assert.equal(TAG_QR_CODE.numberAssembly.separator, '|');
});

// ── 反向哨兵：旧行为（公式停旧值却仍印公式）**不许回来** ─────────────────────
test('哨兵：公式停旧值 + 拼装齐全 ⇒ 绝不许印公式值', () => {
  const { resolveQrNumber } = svc();
  const pick = resolveQrNumber({
    formulaNumber: STALE_FORMULA, assembledNumber: FULL,
    existingFileNameNumber: OLD_FILE_NAME_NUMBER, recordId: 'rec', parts: [],
  });
  assert.notEqual(pick.number, STALE_FORMULA, '这正是她扫不出商品的根因，绝不许回退');
  assert.match(pick.number, /^MK31-1\|咖色\|B$/);
});
