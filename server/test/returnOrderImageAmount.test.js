'use strict';

/** 2026-11-27：退货单按颜色（record ID）显示金额 + 合计；采购申请单布局不变。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPurchaseRequestSvg } = require('../src/services/purchaseRequestImageService');

const ITEMS = [
  { product_record_id: 'rec_coffee', item_no: '2601', color: '咖啡色', size: 39, quantity: 1, amount_cents: 46800 },
  { product_record_id: 'rec_coffee', item_no: '2601', color: '咖啡色', size: 41, quantity: 1, amount_cents: 46800 },
  { product_record_id: 'rec_cocoa', item_no: '2601', color: '可可色', size: 38, quantity: 1, amount_cents: 23400 },
];

test('退货单：颜色行显示 record ID 金额，同色多尺码只显示一次，合计只算一次', () => {
  const svg = buildPurchaseRequestSvg({
    supplierName: '七匹狼/吉祥鸟', items: ITEMS, showAmounts: true, title: '邯美皮鞋退货单',
  });
  assert.match(svg, />颜色</);
  assert.match(svg, />金额</);
  assert.match(svg, />¥468</);
  assert.match(svg, />¥234</);
  assert.match(svg, /合计金额：¥702/);
  assert.equal((svg.match(/¥468/g) || []).length, 1, '同一 record 多尺码不能画两次金额');
  assert.equal((svg.match(/¥702/g) || []).length, 1, '合计不能按尺码翻倍');
});

test('采购申请单：仍是两列，不出现金额', () => {
  const svg = buildPurchaseRequestSvg({ items: ITEMS, showAmounts: false });
  assert.match(svg, />货号</);
  assert.match(svg, />尺码×数量</);
  assert.equal(svg.includes('>金额<'), false);
  assert.equal(svg.includes('合计金额'), false);
});
