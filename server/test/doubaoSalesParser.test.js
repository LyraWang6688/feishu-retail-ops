const test = require('node:test');
const assert = require('node:assert/strict');
const salesParser = require('../src/services/doubaoService');
const { normalizeSalesResult } = salesParser;

test('normalizes one cash sale using item number and color and leaves formula fields out', () => {
  const result = normalizeSalesResult({
    intent: 'sale',
    sales_behavior: '现货销售',
    behavior_code: 'SALE_CASH',
    item_no: '8088-26',
    color: '棕',
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
    item_no: '8088-26',
    color: '棕',
    size: 38,
    quantity: 1,
    gift: true,
    gift_description: '袜子一双',
    items: [{ item_no: '8088-26', color: '棕', size: 38, quantity: 1, gift: true, gift_description: '袜子一双' }],
    payments: [{ amount: 230, method: '微信' }],
    agreed_total: '',
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
    item_no: '8088-26',
    color: '棕',
    size: 38,
    quantity: 1,
    total_paid: 0,
    payment_method: '微信',
  });
  assert.ok(result.missing_fields.includes('当前只支持现货销售'));
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
