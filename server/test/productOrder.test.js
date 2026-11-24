'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PUBLIC = path.join(__dirname, '..', 'public/workbench');

test('货品排序：文本 A→Z，货号→颜色→男女→recordId，空值最后', async () => {
  const { sortProductRows } = await import(pathToFileURL(path.join(PUBLIC, 'features/shared/productOrder.js')).href);
  const rows = [
    { productRecordId: 'r2', itemNo: '2', color: 'Black', category: 'A' },
    { productRecordId: 'r10', itemNo: '10', color: 'Black', category: 'A' },
    { productRecordId: 'rA', itemNo: 'A', color: 'White', category: 'A' },
    { productRecordId: 'rB', itemNo: 'A', color: 'Black', category: 'B' },
    { productRecordId: 'rA2', itemNo: 'A', color: 'Black', category: 'A' },
    { productRecordId: 'rEmpty', itemNo: '', number: 'Z|Black|A', color: 'Black' },
  ];
  assert.deepEqual(sortProductRows(rows).map((row) => row.productRecordId), [
    'r10', 'r2', 'rA2', 'rB', 'rA', 'rEmpty',
  ], '10 在 2 前（文本序）；同货号按颜色、男女；空货号最后');
});

test('货品排序：itemNo 为空不用 number 冒充货号', async () => {
  const { compareProductOrder, sortProductRows } = await import(pathToFileURL(path.join(PUBLIC, 'features/shared/productOrder.js')).href);
  const blankWithNumber = { productRecordId: 'rBlank', itemNo: '', number: '000|Black|A' };
  const normal = { productRecordId: 'rNormal', itemNo: 'Z', number: 'Z|Black|A' };
  assert.ok(compareProductOrder(normal, blankWithNumber) < 0, '有效货号在前');
  assert.deepEqual(sortProductRows([blankWithNumber, normal]).map((row) => row.productRecordId), ['rNormal', 'rBlank']);
});

test('货品排序：颜色相同用男女，男女相同用 recordId 稳定兜底', async () => {
  const { sortProductRows } = await import(pathToFileURL(path.join(PUBLIC, 'features/shared/productOrder.js')).href);
  const rows = [
    { productRecordId: 'r3', itemNo: 'A', color: 'Black', number: 'A|Black|女' },
    { productRecordId: 'r2', itemNo: 'A', color: 'Black', number: 'A|Black|男' },
    { productRecordId: 'r1', itemNo: 'A', color: 'Black', number: 'A|Black|男' },
  ];
  const out = sortProductRows(rows);
  assert.equal(out[2].number, 'A|Black|女', '女性排在男性之后');
  assert.deepEqual(out.slice(0, 2).map((row) => row.productRecordId), ['r1', 'r2'], '同男女按 recordId 稳定');
});
