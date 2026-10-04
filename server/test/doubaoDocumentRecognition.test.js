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
