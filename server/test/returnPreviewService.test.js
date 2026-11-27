'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReturnPreview } = require('../src/services/returnPreviewService');

test('预览按供应商分组，同 record 多尺码金额只算一次', () => {
  const model = buildReturnPreview({
    items: [
      { product_record_id: 'rec_a', item_no: 'A', color: '黑色', supplier_record_id: 'sup_a', supplier_name: '甲', amount_cents: 10000, entries: [{ size: '40', quantity: 1 }, { size: '41', quantity: 2 }] },
      { product_record_id: 'rec_b', item_no: 'B', color: '白色', supplier_record_id: 'sup_a', supplier_name: '甲', amount_cents: 20000, entries: [{ size: '40', quantity: 1 }] },
      { product_record_id: 'rec_c', item_no: 'C', color: '灰色', supplier_record_id: 'sup_b', supplier_name: '乙', amount_cents: 30000, entries: [{ size: '42', quantity: 1 }] },
    ],
  });
  assert.equal(model.suppliers.length, 2);
  const first = model.suppliers[0];
  assert.equal(first.supplierName, '甲');
  assert.equal(first.products.length, 2);
  assert.equal(first.subtotalQty, 4);
  assert.equal(first.subtotalAmountCents, 30000, 'record 金额不按尺码翻倍');
  assert.equal(model.totals.qty, 5);
  assert.equal(model.totals.amountCents, 60000);
});

test('未标注供应商单独一组', () => {
  const model = buildReturnPreview({
    items: [
      { product_record_id: 'rec_x', supplier_record_id: '', supplier_name: '', amount_cents: 100, entries: [{ size: '40', quantity: 1 }] },
      { product_record_id: 'rec_y', supplier_record_id: 'sup_a', supplier_name: '甲', amount_cents: 200, entries: [{ size: '41', quantity: 1 }] },
    ],
  });
  assert.deepEqual(model.suppliers.map((supplier) => supplier.supplierRecordId), ['', 'sup_a']);
  assert.equal(model.suppliers[0].supplierName, '');
});
