const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSalesResult } = require('../src/services/doubaoService');

test('normalizes one cash sale using product number and leaves formula fields out', () => {
  const result = normalizeSalesResult({
    intent: 'sale',
    sales_behavior: '现货销售',
    behavior_code: 'SALE_CASH',
    product_number: '8088-26棕',
    size: 38,
    quantity: 1,
    gift: true,
    gift_description: '袜子一双',
    total_paid: 230,
    payment_method: '微信',
    unit_price: 230,
  });

  assert.deepEqual(result, {
    intent: 'sale',
    sales_behavior: '现货销售',
    behavior_code: 'SALE_CASH',
    product_number: '8088-26棕',
    size: 38,
    quantity: 1,
    gift: true,
    gift_description: '袜子一双',
    total_paid: 230,
    payment_method: '微信',
    missing_fields: [],
  });
  assert.equal('unit_price' in result, false);
});

test('blocks non-cash-sale behavior in V1', () => {
  const result = normalizeSalesResult({
    intent: 'unsupported',
    sales_behavior: '换货',
    product_number: '8088-26棕',
    size: 38,
    quantity: 1,
    total_paid: 0,
    payment_method: '微信',
  });
  assert.ok(result.missing_fields.includes('当前只支持现货销售'));
});
