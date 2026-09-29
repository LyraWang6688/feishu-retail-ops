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

test('two pairs in one AI line must be restated as two individually priced lines', () => {
  const result = normalizeSalesResult({ intent: 'sale', items: [
    { item_no: 'A100', size: 38, quantity: 2, actual_amount: 178 },
  ], payments: [{ method: '微信', amount: 178 }] });
  assert.ok(result.missing_fields.some((issue) => issue.includes('逐双列出成交金额')));
});

test('deposit alone cannot be mistaken for a shoe transaction price', () => {
  const result = normalizeSalesResult({ intent: 'sale', items: [{ item_no: '9A207-0', size: 43, quantity: 1 }],
    payments: [{ method: '微信', amount: 50 }], delivery_status: '未交付' });
  assert.equal(result.agreed_total, '');
  assert.equal(result.delivery_status, '未交付');
  assert.ok(result.missing_fields.includes('items[0].actual_amount'));
});

test('future balance is not recorded as cash received, and ambiguous tail payment stops confirmation', () => {
  const ai = { intent: 'sale', items: [{ item_no: '695887B-5', color: '黑', size: 43,
    quantity: 1, actual_amount: 240 }],
  payments: [{ method: '微信', amount: 100 }, { method: '微信', amount: 140 }], agreed_total: 240 };
  const future = normalizeSalesResult(ai, '695887B-5黑43，微信付定金100元，下次尾款付140元');
  assert.deepEqual(future.payments, [{ method: '微信', amount: 100 }]);
  assert.equal(future.agreed_total, 240);
  assert.deepEqual(future.missing_fields, []);
  const ambiguous = normalizeSalesResult(ai, '695887B-5黑43，微信付定金100元，尾款付140元');
  assert.ok(ambiguous.missing_fields.some((item) => item.includes('尾款是否已支付')));
  const later = normalizeSalesResult(ai, '695887B-5黑43，总价240元，微信付定金100元，尾款以后付140元');
  assert.deepEqual(later.payments, [{ method: '微信', amount: 100 }]);
  assert.deepEqual(later.missing_fields, []);
  const conflict = normalizeSalesResult(ai, '695887B-5黑43，成交价260元，微信付定金100元，尾款以后付140元');
  assert.ok(conflict.missing_fields.some((item) => item.includes('成交价与定金')));
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
      { amount: 169, method: '微信', status: '已收款' },
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
    { method: '微信', amount: 169, status: '已收款' },
    { method: '抖音团购券', amount: 85.4, status: '待平台结算' },
  ]);
  assert.deepEqual(result.missing_fields, []);
});

test('AI calling a 19-yuan top-up the shoe price does not block a voucher sale', () => {
  const result = normalizeSalesResult({ intent: 'sale', items: [
    { item_no: '31663', color: '黑', size: 40, quantity: 1, actual_amount: 19 }],
    payments: [{ method: '微信', amount: 19 }], agreed_total: 19,
  }, '31663黑40的是19元微信，再加上一个89.9块抵100块钱的代金券');
  assert.equal(result.items[0].actual_amount, 104.4);
  assert.equal(result.agreed_total, 104.4);
  assert.deepEqual(result.missing_fields, []);
});

test('voucher accepts payment method before amount and a voucher-only sale', () => {
  const reversed = normalizeSalesResult({ intent: 'sale', items: [
    { item_no: '2A831-18', color: '黑', size: 44, quantity: 1 }],
    payments: [{ method: '微信', amount: 160 }],
  }, '2A831-18黑44，微信支付160元，加一张89.9元抵100元代金券，赠袜子一双');
  assert.equal(reversed.agreed_total, 245.4);
  assert.deepEqual(reversed.payments, [
    { method: '微信', amount: 160, status: '已收款' },
    { method: '抖音团购券', amount: 85.4, status: '待平台结算' },
  ]);
  assert.deepEqual(reversed.missing_fields, []);
  const voucherOnly = normalizeSalesResult({ intent: 'sale', items: [
    { item_no: 'XHB8095', color: '黑', size: 42, quantity: 1 }], payments: [],
  }, 'XHB8095黑42，是一张89.9元抵100元代金券，送两双袜子');
  assert.equal(voucherOnly.agreed_total, 85.4);
  assert.deepEqual(voucherOnly.payments, [
    { method: '抖音团购券', amount: 85.4, status: '待平台结算' },
  ]);
  assert.deepEqual(voucherOnly.missing_fields, []);
  const omittedCash = normalizeSalesResult({ intent: 'sale', items: [
    { item_no: 'XHB8095', color: '黑', size: 42, quantity: 1 }], payments: [],
  }, 'XHB8095黑42，一张89.9元抵100元代金券');
  assert.ok(omittedCash.missing_fields.some((item) => item.includes('只用团购券')));
});

test('colloquial gifts preserve explicit pair count without inventing a count for other gifts', async () => {
  const oldKey = process.env.ARK_API_KEY;
  const oldModel = process.env.ARK_MODEL_ENDPOINT;
  const oldGetClient = salesParser.getClient;
  process.env.ARK_API_KEY = 'test-key';
  process.env.ARK_MODEL_ENDPOINT = 'test-model';
  try {
    salesParser.getClient = () => ({ chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({
      intent: 'sale', items: [{ item_no: '31663', color: '黑', size: 40, quantity: 1 }],
      payments: [{ method: '微信', amount: 19 }],
    }) } }] }) } } });
    const mixed = await salesParser.parseSalesText('31663黑40，19元微信，一张89.9抵100券，赠了双鞋垫和袜子');
    assert.equal(mixed.items[0].gift_description, '一双鞋垫和袜子');
    const twoPairs = await salesParser.parseSalesText('31663黑40，19元微信，一张89.9抵100券，送了两双袜子');
    assert.equal(twoPairs.items[0].gift_description, '两双袜子');
  } finally {
    salesParser.getClient = oldGetClient;
    if (oldKey === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.ARK_MODEL_ENDPOINT;
    else process.env.ARK_MODEL_ENDPOINT = oldModel;
  }
});

test('explicit contradictory sale price still blocks a voucher sale', () => {
  const result = normalizeSalesResult({ intent: 'sale', items: [
    { item_no: '31663', color: '黑', size: 40, quantity: 1, actual_amount: 19 }],
    payments: [{ method: '微信', amount: 19 }], agreed_total: 19,
  }, '31663黑40成交价120元，19元微信，再加一个89.9抵100代金券');
  assert.ok(result.missing_fields.some((field) => field.includes('成交价')));
});

test('voucher parsing preserves two gifts and logs AI values separately from normalized values', async () => {
  const oldKey = process.env.ARK_API_KEY;
  const oldModel = process.env.ARK_MODEL_ENDPOINT;
  const oldGetClient = salesParser.getClient;
  const oldLog = console.log;
  const logs = [];
  process.env.ARK_API_KEY = 'test-key';
  process.env.ARK_MODEL_ENDPOINT = 'test-model';
  try {
    console.log = (line) => logs.push(JSON.parse(line));
    salesParser.getClient = () => ({ chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({
      intent: 'sale', items: [{ item_no: '31663', color: '黑', size: 40, quantity: 1,
        actual_amount: 19, gift: true, gift_description: '一双鞋垫' }],
      payments: [{ method: '微信', amount: 19 }], agreed_total: 19,
    }) } }] }) } } });
    const result = await salesParser.parseSalesText(
      '31663黑40的是19元微信，再加上一个89.9块抵100块钱的代金券，赠了一双鞋垫，赠了一双袜子',
      { taskId: 'sale_log_test' });
    assert.equal(result.items[0].actual_amount, 104.4);
    assert.equal(result.items[0].gift_description, '一双鞋垫、一双袜子');
    assert.deepEqual(result.missing_fields, []);
    assert.equal(logs[0].event, 'sales.ai.parsed');
    assert.equal(logs[0].task_id, 'sale_log_test');
    assert.equal(logs[0].items[0].actual_amount, 19);
    assert.equal(logs[1].event, 'sales.ai.normalized');
    assert.equal(logs[1].items[0].actual_amount, 104.4);
    assert.equal(logs[1].items[0].gift_description, '一双鞋垫、一双袜子');
    assert.ok(logs.every((entry) => !JSON.stringify(entry).includes('31663黑40的是')));
  } finally {
    console.log = oldLog;
    salesParser.getClient = oldGetClient;
    if (oldKey === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.ARK_MODEL_ENDPOINT;
    else process.env.ARK_MODEL_ENDPOINT = oldModel;
  }
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

// ─── 收银员真实说法的回归基线 ───
//
// 下面这批用例记录「今天实际会发生什么」，用的是收银员真实的说法，
// 而不是为了迁就代码整理过的措辞。
//
// 标注「当前行为·待修复」的是已知缺口：它们断言的是今天的（不合理）结果。
// 修复之后这些用例应当失败，届时按新行为更新断言——它们的作用是让缺口
// 一直可见，而不是假装不存在。

test('voucher plus cash plus gift keeps the store settlement at 85.4 and marks it pending', () => {
  const result = normalizeSalesResult({
    intent: 'sale',
    items: [{ item_no: '2A831-18', color: '黑', size: 44, quantity: 1, gift_description: '袜子一双' }],
    payments: [{ method: '微信', amount: 169 }],
    agreed_total: 269,
  }, '2A831-18 44码黑，169元微信➕89.9代100元代金券 赠袜一双');

  assert.equal(result.agreed_total, 254.4);
  assert.equal(result.items[0].actual_amount, 254.4);
  assert.equal(result.items[0].gift, true);
  assert.deepEqual(result.payments, [
    { amount: 169, method: '微信', status: '已收款' },
    { method: '抖音团购券', amount: 85.4, status: '待平台结算' },
  ]);
  assert.deepEqual(result.missing_fields, []);
});

test('single-line deposit derives the receivable from deposit plus balance', () => {
  const result = normalizeSalesResult({
    intent: 'sale',
    items: [{ item_no: '695887B-5', color: '黑', size: 43, quantity: 1 }],
    payments: [{ method: '微信', amount: 100 }],
    agreed_total: null,
  }, '695887B-5 43码黑，微信付定金100元，尾款以后付140元');

  assert.equal(result.agreed_total, 240);
  assert.equal(result.items[0].actual_amount, 240);
  assert.equal(result.total_paid, 100);
  assert.deepEqual(result.missing_fields, []);
});

test('a deposit order with several lines is refused instead of dropping the unpaid balance', () => {
  const result = normalizeSalesResult({
    intent: 'sale',
    items: [
      { item_no: '695887B-5', color: '黑', size: 43, quantity: 1 },
      { item_no: '39元腰带', quantity: 1, actual_amount: 39 },
    ],
    payments: [{ method: '微信', amount: 100 }],
    agreed_total: null,
  }, '695887B-5 43码黑，39元腰带一条，微信付定金100元，尾款以后付140元');

  // 尾款 140 无法判断属于哪一件，不能猜（以前是整块跳过，应收金额被静默算丢）。
  assert.ok(result.missing_fields.some((field) => field.includes('定金单暂只支持一条明细')),
    `实际待补充：${JSON.stringify(result.missing_fields)}`);
  assert.equal(result.agreed_total, '', '不再静默跳过尾款');
});

test('[当前行为·待修复] a deposit phrased the way the cashier says it is rejected as missing', () => {
  const result = normalizeSalesResult({
    intent: 'sale',
    items: [{ item_no: '695887B-5', color: '黑', size: 43, quantity: 1 }],
    payments: [{ method: '微信', amount: 100 }],
    agreed_total: null,
  }, '695887B-5 43码黑，100元微信定金，还需要再付140元');

  // 用户说清了「100 定金 + 140 尾款」，但规则层的正则只认「定金在前」或
  // 「数字紧贴定金」，中间夹一个支付方式就失效，于是判为没说定金金额。
  // 修复后这里应变成 agreed_total = 240、missing_fields 为空。
  assert.ok(result.missing_fields.includes('请明确已经收到的定金金额'));
  assert.equal(result.agreed_total, '');
});

test('[当前行为·待修复] mixing an accessory into a deposit order loses the receivable and demands a size', () => {
  const result = normalizeSalesResult({
    intent: 'sale',
    items: [
      { item_no: '695887B-5', color: '黑', size: 43, quantity: 1 },
      { item_no: '39元腰带', quantity: 1, actual_amount: 39 },
    ],
    payments: [{ method: '微信', amount: 100 }],
    agreed_total: null,
  }, '695887B-5 43码黑，39元腰带一条，微信付定金100元，尾款以后付140元');

  // 与上一条完全相同的语序，只多了一行配品：应收从 240 变成空，
  // 并且系统要求配品补尺码——配品没有尺码，用户永远补不上，整单走不完。
  assert.equal(result.agreed_total, '');
  assert.ok(result.missing_fields.includes('items[1].size'));
});

test('[当前行为·待修复] two vouchers in one order are rejected', () => {
  const result = normalizeSalesResult({
    intent: 'sale',
    items: [{ item_no: '2A831-18', color: '黑', size: 44, quantity: 1 }],
    payments: [{ method: '微信', amount: 169 }],
    agreed_total: null,
  }, '2A831-18 44码黑，169元微信，两张89.9代100元代金券');

  assert.ok(result.missing_fields.includes('团购券暂只支持一单一张，请明确券种和数量'));
});

test('[当前行为·待修复] a pure-voucher sale must confirm there was no cash', () => {
  const result = normalizeSalesResult({
    intent: 'sale',
    items: [{ item_no: 'XHB8095', color: '黑', size: 43, quantity: 1, gift_description: '袜子两双' }],
    payments: [],
    agreed_total: null,
  }, 'XHB8095 43码黑，一张89.9代100元代金券 赠袜两双');

  assert.ok(result.missing_fields.includes('请确认是否只用团购券、没有补现金额'));
});

// ─── 配品：只有名字和金额，没有货号、颜色、尺码 ───

test('an accessory item keeps its name and needs no item number or size', () => {
  const result = normalizeSalesResult({
    intent: 'sale',
    items: [
      { item_no: 'XHB8095', color: '黑', size: 43, quantity: 1, actual_amount: 200 },
      { kind: 'accessory', accessory_name: '39元腰带', quantity: 1, actual_amount: 39 },
    ],
    payments: [{ method: '微信', amount: 239 }],
    agreed_total: 239,
  });

  const accessory = result.items[1];
  assert.equal(accessory.kind, 'accessory');
  assert.equal(accessory.accessory_name, '39元腰带');
  assert.equal(accessory.actual_amount, 39);
  // 配品不要求 item_no 与 size，所以整单不应因此被判"信息不全"。
  assert.deepEqual(result.missing_fields, []);
});

test('a standalone accessory sale needs only a name and an amount', () => {
  const result = normalizeSalesResult({
    intent: 'sale',
    items: [{ kind: 'accessory', accessory_name: '9.9元袜子', quantity: 1, actual_amount: 9.9 }],
    payments: [{ method: '微信', amount: 9.9 }],
    agreed_total: 9.9,
  });

  assert.equal(result.intent, 'sale');
  assert.equal(result.items[0].accessory_name, '9.9元袜子');
  assert.deepEqual(result.missing_fields, []);
});

test('an accessory without a name is asked for by name, not by item number', () => {
  const result = normalizeSalesResult({
    intent: 'sale',
    items: [{ kind: 'accessory', quantity: 1, actual_amount: 9.9 }],
    payments: [],
  });

  assert.ok(result.missing_fields.includes('items[0].accessory_name'));
  assert.ok(!result.missing_fields.includes('items[0].item_no'));
  assert.ok(!result.missing_fields.includes('items[0].size'));
});
