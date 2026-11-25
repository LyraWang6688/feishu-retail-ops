'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderSalePaymentStepPage } = require('../src/views/scanPageRenderer');
const { SCAN_PAGE } = require('../src/config/scanPage');

test('资金页最后一双：payDelistIds 进表单，确认标签来自配置', () => {
  const html = renderSalePaymentStepPage({
    write: {
      texts: {}, fields: {},
      paymentRows: [{ method: '微信', amount: '' }],
      paymentMethods: ['微信'], defaultPaymentMethod: '微信',
      draft: { lines: [{ product_record_id: 'rec_last', stock_total: 1 }] },
    },
    orderNo: 'XSD-TEST-1', postAction: '/r/TEST', submitKey: 'k', count: 1,
  });
  assert.ok(html.includes('data-delist-product-ids="rec_last"'), '最后一双要带下架候选');
  assert.ok(html.includes('data-delist-confirm-label="' + SCAN_PAGE.delistConfirm + '"'));
  assert.ok(html.includes('data-delist-cancel-label="' + SCAN_PAGE.delistCancel + '"'));
});

test('下架确认不再用 window.confirm，改用站内弹层', () => {
  const script = fs.readFileSync(path.join(__dirname, '../src/views/scanPage/script.js'), 'utf8');
  assert.equal(script.includes('window.confirm'), false, '不允许再依赖飞书 WebView 的原生 confirm');
  assert.ok(script.includes('data-delist-modal'), '要有站内确认弹层');
  assert.ok(script.includes('__scanDelistModal'), '提交脚本要能打开弹层');
});
