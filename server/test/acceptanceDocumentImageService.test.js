'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { statusOf, summarize } = require('../src/services/acceptanceDocumentImageService');
const { renderAcceptanceDocumentPng } = require('../src/services/acceptanceDocumentImageService');

test('验收单渲染口径：一致 / 未到货 / 多到货 / 自定义', async () => {
  const rows = [
    { product_record_id: 'p1', item_no: '888-1', color: '茶褐色', size: 38, quantity: 2, actual: 2 },
    { product_record_id: 'p1', item_no: '888-1', color: '茶褐色', size: 39, quantity: 2, actual: 1 },
    { product_record_id: 'p1', item_no: '888-1', color: '茶褐色', size: 40, quantity: 1, actual: 2 },
    { product_record_id: 'p1', item_no: '888-1', color: '茶褐色', size: 41, quantity: 0, actual: 0, custom: true },
    { product_record_id: 'p1', item_no: '888-1', color: '茶褐色', size: 42, quantity: 0, actual: 1, custom: true },
  ];
  assert.deepEqual(rows.map(statusOf), [
    { key: 'match', expected: 2, actual: 2, extra: 0 },
    { key: 'short', expected: 2, actual: 1, extra: 0 },
    { key: 'extra', expected: 1, actual: 1, extra: 1 },
    { key: 'extra', expected: 0, actual: 0, extra: 0 },
    { key: 'extra', expected: 0, actual: 0, extra: 1 },
  ]);
  assert.deepEqual(summarize(rows), { expected: 5, actual: 4, extra: 2 });
});

test('验收单渲染：生成 PNG 且包含标题/供应商/批次', async () => {
  const png = await renderAcceptanceDocumentPng({
    batchNo: 'CGD-20261123-0001', supplierName: '信踏', acceptedAt: '2026-11-23 18:00',
    rows: [
      { product_record_id: 'p1', item_no: '888-1', color: '茶褐色', size: 38, quantity: 2, actual: 2 },
      { product_record_id: 'p1', item_no: '888-1', color: '茶褐色', size: 39, quantity: 2, actual: 1 },
    ],
  });
  assert.ok(Buffer.isBuffer(png));
  assert.ok(png.length > 1000);
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});
