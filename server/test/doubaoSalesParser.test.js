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

test('one 89.9-for-100 voucher is converted to pending 85.4, not received 89.9 or 100', async () => {
  const oldKey = process.env.ARK_API_KEY;
  const oldModel = process.env.ARK_MODEL_ENDPOINT;
  const oldGetClient = salesParser.getClient;
  process.env.ARK_API_KEY = 'test-key';
  process.env.ARK_MODEL_ENDPOINT = 'test-model';
  try {
    // Even when the AI wrongly calls the voucher a 100-yuan payment and omits
    // the gift, the deterministic policy must correct the cash/settlement split.
    salesParser.getClient = () => ({ chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({
      intent: 'sale', items: [{ item_no: '2A831-18', color: '黑', size: 44, quantity: 1, actual_amount: 269 }],
      payments: [{ method: '微信', amount: 169 }, { method: '抖音团购券', amount: 100 }], agreed_total: 269,
    }) } }] }) } } });
    const result = await salesParser.parseSalesText('2A831-18黑色44的，是169元微信，然后一张89块9抵100的代金券，然后赠了一双袜子');
    assert.equal(result.items[0].actual_amount, 254.4);
    assert.equal(result.items[0].gift_description, '一双袜子');
    assert.equal(result.agreed_total, 254.4);
    assert.equal(result.total_paid, 169);
    assert.equal(result.total_covered, 254.4);
    assert.deepEqual(result.payments, [
      { amount: 169, method: '微信', status: '已收清' },
      { method: '抖音团购券', amount: 85.4, status: '待平台结算' },
    ]);
    assert.deepEqual(result.missing_fields, []);
  } finally {
    salesParser.getClient = oldGetClient;
    if (oldKey === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.ARK_MODEL_ENDPOINT;
    else process.env.ARK_MODEL_ENDPOINT = oldModel;
  }
});

test('49.9-for-100 voucher uses configured 47.4 settlement', () => {
  const result = normalizeSalesResult({ intent: 'sale', items: [
    { item_no: 'A100', size: 38, quantity: 1 }], payments: [{ method: '微信', amount: 169 }],
  }, 'A100黑38，169元微信，一张49.9抵100代金券');
  assert.equal(result.agreed_total, 216.4);
  assert.equal(result.payments[1].amount, 47.4);
  assert.equal(result.payments[1].status, '待平台结算');
  assert.deepEqual(result.missing_fields, []);
});

test('spoken cash facts override an AI payment array that mistakes voucher face value for cash', () => {
  const result = normalizeSalesResult({ intent: 'sale', items: [
    { item_no: '2A831-18', color: '黑', size: 44, quantity: 1 }],
    payments: [{ method: '现金', amount: 100 }],
  }, '2A831-18黑44，169元微信，一张89.9抵100代金券');
  assert.deepEqual(result.payments, [
    { method: '微信', amount: 169, status: '已收清' },
    { method: '抖音团购券', amount: 85.4, status: '待平台结算' },
  ]);
  assert.deepEqual(result.missing_fields, []);
});

test('unknown voucher or multiple shoes cannot silently create a settled receipt', () => {
  const unknown = normalizeSalesResult({ intent: 'sale', items: [
    { item_no: 'A100', size: 38, quantity: 1, actual_amount: 269 }],
    payments: [{ method: '微信', amount: 169 }, { method: '团购券', amount: 100 }],
    agreed_total: 269,
  }, 'A100黑38，169元微信，一张79.9抵100团购券');
  assert.ok(unknown.missing_fields.some((field) => field.includes('未配置')));
  const multiple = normalizeSalesResult({ intent: 'sale', items: [
    { item_no: 'A100', size: 38, quantity: 1, actual_amount: 100 },
    { item_no: 'B200', size: 39, quantity: 1, actual_amount: 169 }],
    payments: [{ method: '微信', amount: 169 }, { method: '团购券', amount: 100 }],
    agreed_total: 269,
  }, 'A100黑38和B200黑39，169元微信，一张89.9抵100团购券');
  assert.ok(multiple.missing_fields.some((field) => field.includes('一单一双')));
});
