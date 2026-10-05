const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeDocumentRows } = require('../src/services/doubaoService');

// 到货单是表格照片，模型很容易把表头那一排毫米制尺码照抄下来。
// 提示词里已经要求换算，这里再兜一层确定性的规则（欧码 = (数值 - 50) / 5）。
test('document rows convert millimetre sizes to EU sizes', () => {
  const rows = normalizeDocumentRows([
    { item_no: '1366-31', color: '棕色', size: 240, quantity: 1 },
    { item_no: '1366-31', color: '棕色', size: 250, quantity: 2 },
  ]);
  assert.deepEqual(rows, [
    { item_no: '1366-31', color: '棕色', size: 38, quantity: 1 },
    { item_no: '1366-31', color: '棕色', size: 40, quantity: 2 },
  ]);
});

test('document rows keep EU sizes and coerce string numbers', () => {
  const rows = normalizeDocumentRows([{ item_no: ' 628-6 ', color: '米紫', size: '36', quantity: '1' }]);
  assert.deepEqual(rows, [{ item_no: '628-6', color: '米紫', size: 36, quantity: 1 }]);
});

test('document rows drop rows that would write a wrong size or quantity', () => {
  const rows = normalizeDocumentRows([
    { item_no: '1366-31', color: '棕色', size: 37, quantity: 1 },
    { item_no: '', color: '棕色', size: 38, quantity: 1 },
    { item_no: '1366-31', color: '棕色', size: 0, quantity: 1 },
    { item_no: '1366-31', color: '棕色', size: 39, quantity: 0 },
    { item_no: '1366-31', color: '棕色', size: 42.5, quantity: 1 },
  ]);
  assert.deepEqual(rows, [{ item_no: '1366-31', color: '棕色', size: 37, quantity: 1 }]);
});

test('document rows tolerate a non-array model response', () => {
  assert.deepEqual(normalizeDocumentRows(null), []);
  assert.deepEqual(normalizeDocumentRows({ items: [] }), []);
});

// ─── 到货单价格 → unit_cost ───
// 产品负责人的口径：单据上有价格，那就是成本。模型可能把「销售价」列回成
// unit_cost / unitCost / cost / price，字符串里还可能带 ￥ / 元 / 千分位。

test('document rows parse the per-piece price into unit_cost', () => {
  const rows = normalizeDocumentRows([
    { item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: 199 },
    { item_no: '1366-31', color: '棕色', size: 37, quantity: 2, unit_cost: '￥199.00' },
    { item_no: '1366-31', color: '棕色', size: 38, quantity: 1, unitCost: '1,299元/双' },
    { item_no: '1366-31', color: '棕色', size: 39, quantity: 1, price: '209' },
  ]);
  assert.deepEqual(rows.map((row) => row.unit_cost), [199, 199, 1299, 209]);
});

test('document rows keep only a partial set of prices (rows without a price stay on the sheet)', () => {
  const rows = normalizeDocumentRows([
    { item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: 199 },
    { item_no: '8088', color: '灰色', size: 38, quantity: 1 },
  ]);
  assert.equal(rows.length, 2, '没有价格的行仍然要入库，只是不写成本');
  assert.equal(rows[0].unit_cost, 199);
  assert.equal('unit_cost' in rows[1], false, '没价格时不能挂一个 undefined/null 的 unit_cost');
});

test('document rows drop unusable prices instead of writing a wrong cost', () => {
  const rows = normalizeDocumentRows([
    { item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: '面议' },
    { item_no: '1366-31', color: '棕色', size: 37, quantity: 1, unit_cost: 0 },
    { item_no: '1366-31', color: '棕色', size: 38, quantity: 1, unit_cost: '199-299' },
    { item_no: '1366-31', color: '棕色', size: 39, quantity: 1, unit_cost: '199' },
  ]);
  assert.deepEqual(rows.map((row) => row.unit_cost), [undefined, undefined, undefined, 199]);
  // 更严格地说：非法价格连 key 都不该出现（否则下游会把 null 当成"识别到了价格"）。
  assert.equal('unit_cost' in rows[0], false);
  assert.equal('unit_cost' in rows[1], false);
  assert.equal('unit_cost' in rows[2], false);
});

