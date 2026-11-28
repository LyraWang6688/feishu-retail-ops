'use strict';

/**
 * 确认单页面回归（2026-11-28）：
 *   · 页头不再有「返回订单列表」；
 *   · 尺码候选 = 实时库存 + 原单尺码；
 *   · 原单尺码固定第一项并默认选中，实时库存中同尺码不重复。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../public/workbench');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('确认单页头不再有「返回订单列表」', () => {
  const html = read('sales-confirm.html');
  assert.equal(html.includes('返回订单列表'), false);
  assert.equal(read('config/salesCorrection.js').includes("back: '返回订单列表'"), false);
});

test('确认单尺码 = 实时库存 + 原单尺码，原单默认选中且不重复', () => {
  const js = read('features/sales-confirm/index.js');
  assert.match(js, /T\.original/);
  assert.match(js, /selected>'s*\n\s*\+ escapeHtml\(T\.original\)/);
  assert.match(js, /if \(String\(item\.size\) === String\(currentSize\)\) continue;/);
});

test('确认单：未收款行不显示支付方式，避免默认成第一个方式', () => {
  const js = read('features/sales-confirm/index.js');
  const cfg = read('config/salesCorrection.js');
  assert.match(cfg, /SALES_CORRECTION_PAYMENT_STATUS/);
  assert.match(cfg, /unpaid: '未收款'/);
  assert.match(js, /payment\.status === SALES_CORRECTION_PAYMENT_STATUS\.unpaid/);
  assert.match(js, /sales-confirm-unpaid/);
  assert.match(js, /if \(payment\.status === SALES_CORRECTION_PAYMENT_STATUS\.unpaid\) \{\s*\n\s*paymentHtml/);
});

test('确认单列表按钮文案 = 修改', () => {
  assert.match(read('config/salesCorrection.js'), /edit: '修改'/);
});
