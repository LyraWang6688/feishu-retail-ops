'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public/workbench');

test('统一删除线：共享样式只有 line-through，不改颜色', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'styles/base.css'), 'utf8');
  const rule = (css.match(/\.product-delisted\s*\{[^}]*\}/) || [''])[0];
  assert.match(rule, /text-decoration:\s*line-through/);
  assert.doesNotMatch(rule, /color:/);
});

test('订单交割 / 库存流水：用共享删除线类，不显示已下架文字标签', () => {
  const delivery = fs.readFileSync(path.join(PUBLIC, 'features/sales-delivery/render.js'), 'utf8');
  const ledger = fs.readFileSync(path.join(PUBLIC, 'features/inventory/ledger.js'), 'utf8');
  assert.match(delivery, /product-delisted/);
  assert.doesNotMatch(delivery, /sd-delisted-tag|已下架/);
  assert.match(ledger, /product-delisted/);
  assert.doesNotMatch(ledger, /ledger-delisted-tag|PAGE\.texts\.delisted/);
});

test('销售查询订单卡：仅打开 strikeDelisted 时给下架明细加删除线', async () => {
  const { salesOrderCardHtml } = await import(pathToFileURL(path.join(PUBLIC, 'features/shared/salesOrderCard.js')).href);
  const order = {
    order_no: 'XSD-1', recorded_at: Date.parse('2026-11-23T10:00:00+08:00'), total_amount: 100,
    details: [{ record_id: 'd1', number: '8012|黑|男', size: 39, actual_amount: 100, fulfillment_status: '已交付', delisted: true }],
  };
  assert.doesNotMatch(salesOrderCardHtml(order), /product-delisted/);
  assert.match(salesOrderCardHtml(order, { strikeDelisted: true }), /sq-detail-product product-delisted/);
});
