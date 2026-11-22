'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public/workbench');

test('共享订单卡：售后高亮/操作只落在命中明细，其他明细也展示', async () => {
  const { salesOrderCardHtml } = await import(pathToFileURL(path.join(PUBLIC, 'features/shared/salesOrderCard.js')).href);
  const html = salesOrderCardHtml({
    order_no: 'XSD-1', recorded_at: Date.parse('2026-10-29T10:00:00+08:00'),
    total_amount: 1280,
    payments: [{ method: '现金', amount: 1000, status: '已收款' }],
    details: [
      { record_id: 'd1', number: '8012|黑|男', size: 39, actual_amount: 399, fulfillment_status: '已交付' },
      { record_id: 'd2', number: '8013|白|女', size: 38, actual_amount: 482, fulfillment_status: '已交付' },
    ],
  }, { highlightDetailId: 'd1', actionDetailId: 'd1', actionHtml: '<button data-action="return">退货</button>', matchDetailId: 'd1' });
  assert.match(html, /sq-detail-highlight/);
  assert.match(html, /data-as-match="d1"/);
  assert.match(html, /8013|白|女/);
  assert.match(html, /data-action="return"/);
  const second = salesOrderCardHtml({ order_no: 'XSD-1', details: [{ record_id: 'd2' }] }, { highlightDetailId: 'd2' });
  assert.match(second, /sq-detail-highlight/);
  assert.doesNotMatch(second, /data-action="return"/);
});
