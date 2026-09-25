const test = require('node:test');
const assert = require('node:assert/strict');
const salesParser = require('../src/services/doubaoService');
const { normalizeSalesResult } = salesParser;

test('normalizes one cash sale using item number and color and leaves formula fields out', () => {
  const result = normalizeSalesResult({
    intent: 'sale',
    item_no: '8088-26',
    color: '棕',
    size: 38,
    quantity: 1,
    gift: true,
    gift_description: '袜子一双',
    total_paid: 230,
    payment_method: '微信',
    agreed_total: 230,
    unit_price: 230,
  });

  assert.equal(result.items[0].actual_amount, 230);
  assert.equal(result.delivery_status, '待确认');
  assert.equal(result.agreed_total, 230);
  assert.deepEqual(result.missing_fields, []);
  assert.equal('unit_price' in result, false);
});

test('blocks non-cash-sale behavior in V1', () => {
  const result = normalizeSalesResult({
    intent: 'unsupported',
    sales_behavior: '换货',
    item_no: '8088-26',
    color: '棕',
    size: 38,
    quantity: 1,
    total_paid: 0,
    payment_method: '微信',
  });
  assert.ok(result.missing_fields.includes('当前只支持商品销售录单'));
});

test('multi-shoe sale requires each actual price and does not allocate an order total', () => {
  const result = normalizeSalesResult({ intent: 'sale', agreed_total: 250,
    items: [{ item_no: '93827', size: 43, quantity: 1 }, { item_no: '2115', size: 37, quantity: 1 }],
    payments: [{ method: '现金', amount: 250 }],
  });
  assert.equal(result.items[0].actual_amount, '');
  assert.equal(result.items[1].actual_amount, '');
  assert.ok(result.missing_fields.includes('items[0].actual_amount'));
  assert.ok(result.missing_fields.includes('items[1].actual_amount'));
});

test('deposit alone cannot be mistaken for a shoe transaction price', () => {
  const result = normalizeSalesResult({ intent: 'sale', items: [{ item_no: '9A207-0', size: 43, quantity: 1 }],
    payments: [{ method: '微信', amount: 50 }], delivery_status: '未交付' });
  assert.equal(result.agreed_total, '');
  assert.equal(result.delivery_status, '未交付');
  assert.ok(result.missing_fields.includes('items[0].actual_amount'));
});

test('gift-only model item is folded into preceding sold shoe', () => {
  const result = normalizeSalesResult({ intent: 'sale', behavior_code: 'SALE_CASH', items: [
    { item_no: '628-6', color: '米紫', size: 36, quantity: 1 },
    { item_no: '', gift: true, gift_description: '袜子一双' },
  ], payments: [{ method: '微信', amount: 220 }], agreed_total: 220 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].gift, true);
  assert.equal(result.items[0].gift_description, '袜子一双');
  assert.deepEqual(result.missing_fields, []);
});

test('explicit gift in one-shoe source survives model omission', async () => {
  const oldKey = process.env.ARK_API_KEY;
  const oldModel = process.env.ARK_MODEL_ENDPOINT;
  const oldGetClient = salesParser.getClient;
  process.env.ARK_API_KEY = 'test-key';
  process.env.ARK_MODEL_ENDPOINT = 'test-model';
  try {
    salesParser.getClient = () => ({ chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({
      intent: 'sale', behavior_code: 'SALE_CASH', items: [{ item_no: '6V637-7', color: '黑', size: 41, quantity: 1 }],
      payments: [{ method: '微信', amount: 150 }, { method: '现金', amount: 100 }], agreed_total: 250,
    }) } }] }) } } });
    const result = await salesParser.parseSalesText('6V637-7黑41码一双，赠鞋垫一双，150元微信，100元现金');
    assert.equal(result.items[0].gift, true);
    assert.equal(result.items[0].gift_description, '鞋垫一双');
  } finally {
    salesParser.getClient = oldGetClient;
    if (oldKey === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.ARK_MODEL_ENDPOINT;
    else process.env.ARK_MODEL_ENDPOINT = oldModel;
  }
});
