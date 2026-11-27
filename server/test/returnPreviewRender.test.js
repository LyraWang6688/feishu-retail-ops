'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { returnFormHtml } = require('../src/views/scanPage/returnBlock');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { SCAN_PAGE } = require('../src/config/scanPage');

const view = {
  found: true, number: '2601|咖啡色|男', item_no: '2601', color: '咖啡色',
  supplier_record_id: 'sup_a', supplier_name: '甲供应商', stock_total: 3,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '39', cells: [{ key: '门盒', count: 2 }], total: 2, missing: false }],
  multi_items: [{ product_record_id: 'rec_a', number: '2601|黑色|男', item_no: '2601', color: '黑色', supplier_record_id: 'sup_a', supplier_name: '甲供应商', amount_cents: 10000, entries: [{ size: '40', quantity: 1 }] }],
};
const write = { texts: SCAN_WRITE.texts, fields: SCAN_WRITE.fields, actions: SCAN_WRITE.actions, postAction: '#', returnKey: 'k', multiItem: null, delistConfirm: null };

test('退货页渲染退货 / 预览双区，预览按供应商并标明生成独立批次', () => {
  const block = returnFormHtml(view, write, {}, SCAN_PAGE);
  assert.match(block, /data-return-tab="return"/);
  assert.match(block, /data-return-tab="preview"/);
  assert.match(block, /data-return-panel="preview"/);
  assert.match(block, /将生成 1 个退货批次/);
  assert.match(block, /甲供应商/);
  assert.match(block, /¥100/);
  assert.match(block, /data-view="return-preview-data"/);
  assert.equal(block.includes('data-view="purchase-return"'), true, '既有退货表单锚点仍在');
});
