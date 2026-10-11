const test = require('node:test');
const assert = require('node:assert/strict');
const salesParser = require('../src/services/doubaoService');
const { normalizeSalesResult } = salesParser;

// 券目录不再写在代码里，来自「团购券管理」表（只取在售）。
// 测试里给一份等价的两档券；券种/结算金额的匹配逻辑由 groupBuyVouchers 单测覆盖。
const VOUCHER_CATALOG = [
  { purchasePrice: 89.9, faceValue: 100, settlementAmount: 85.4, name: '100元代金券（89.9元·9折）', status: '在售' },
  { purchasePrice: 49.9, faceValue: 100, settlementAmount: 47.4, name: '100元代金券（49.9元·5折）', status: '在售' },
];
const normalizeWithVouchers = (result, sourceText = '') =>
  normalizeSalesResult(result, sourceText, { vouchers: VOUCHER_CATALOG });

test('normalizes one cash sale using item number and color and leaves formula fields out', () => {
  const result = normalizeWithVouchers({
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
  // 解析层只判断交易性质；交付状态由 SALES_MOVEMENTS 从交易类型推出来。
  assert.equal(result.trade_type, '现货');
  assert.equal('delivery_status' in result, false);
  assert.equal(result.agreed_total, 230);
  assert.deepEqual(result.missing_fields, []);
  assert.equal('unit_price' in result, false);
});

test('blocks non-cash-sale behavior in V1', () => {
  const result = normalizeWithVouchers({
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

// 退换货第二期：售后诉求的字段契约与销售字段**分开**——退/换/赔不再回
// "只支持销售录单"，而是把"退哪一双 / 钱怎么走 / 退回的鞋放哪"解析出来。
test('return：解析动作 / 哪一双 / 差价 / 钱怎么走 / 回库状态，且不混进销售字段', () => {
  const result = normalizeWithVouchers({
    intent: 'return',
    action: 'return',
    ordinal: 2,
    item_no: '6035',
    color: '黑',
    size: 39,
    settlement: 'prepaid',
    diff_amount: -230,
    restock_state: '门盒',
  }, '第 2 笔，退货，钱先存着');

  assert.equal(result.intent, 'return');
  assert.equal(result.action, 'return');
  assert.equal(result.ordinal, 2);
  assert.equal(result.item_no, '6035');
  assert.equal(result.color, '黑');
  assert.equal(result.size, 39);
  assert.equal(result.settlement, 'prepaid');
  assert.equal(result.diff_amount, -230);
  assert.equal(result.restock_state, '门盒');
  // 销售字段一个都不该出现（否则"sale 的 items"会被当成"要退的鞋"）
  assert.equal('items' in result, false);
  assert.equal('payments' in result, false);
  assert.equal('agreed_total' in result, false);
  assert.deepEqual(result.missing_fields, []);
});

test('exchange：动作 / 中文别名收敛、换成的那一双、模型漏字段时的文本兜底', () => {
  const result = normalizeWithVouchers({
    intent: '换货',
    item_no: '1366-33',
    color: '黑',
    new_item_no: '6035',
    new_color: '黑',
    new_size: 39,
    new_amount: 300,
    settlement: '微信',
  }, '把 1366-33 黑的换一双 6035 黑 39');

  assert.equal(result.intent, 'exchange');
  // 模型没给 action：按原话里的「换」兜底
  assert.equal(result.action, 'exchange');
  assert.equal(result.settlement, 'cash');
  assert.equal(result.new_item_no, '6035');
  assert.equal(result.new_size, 39);
  assert.equal(result.new_amount, 300);
  // 没说差价就留空（接线层再给建议值），解析层不许自己算
  assert.equal(result.diff_amount, '');
  // 没说回库状态就留空（默认值由接线层的卡片给）
  assert.equal(result.restock_state, '');
});

test('compensation：赔货是独立动作（意图注册表里归在换货，但不能被当成换货执行）', () => {
  const result = normalizeWithVouchers({
    intent: 'exchange',
    item_no: 'A100',
    color: '黑',
    new_item_no: 'B200',
    new_color: '棕',
    new_size: 42,
    new_amount: 300,
  }, '那双 A100 开胶了，赔一双 B200 棕 42 码');

  assert.equal(result.action, 'compensation');
  assert.equal(result.new_item_no, 'B200');
  assert.equal(result.new_size, 42);
});

test('「第 2 笔」的序号：模型漏 ordinal 时按原话文本兜底', () => {
  const result = normalizeWithVouchers({ intent: 'return', item_no: '6035', color: '黑' }, '第 2 笔，退货');
  assert.equal(result.ordinal, 2);
  const none = normalizeWithVouchers({ intent: 'return', item_no: '6035', color: '黑' }, '退那双 6035 黑');
  assert.equal(none.ordinal, '');
});

test('multi-shoe sale requires each actual price and does not allocate an order total', () => {
  const result = normalizeWithVouchers({ intent: 'sale', agreed_total: 250,
    items: [{ item_no: '93827', size: 43, quantity: 1 }, { item_no: '2115', size: 37, quantity: 1 }],
    payments: [{ method: '现金', amount: 250 }],
  });
  assert.equal(result.items[0].actual_amount, '');
  assert.equal(result.items[1].actual_amount, '');
  assert.ok(result.missing_fields.includes('items[0].actual_amount'));
  assert.ok(result.missing_fields.includes('items[1].actual_amount'));
});

test('two pairs in one AI line must be restated as two individually priced lines', () => {
  const result = normalizeWithVouchers({ intent: 'sale', items: [
    { item_no: 'A100', size: 38, quantity: 2, actual_amount: 178 },
  ], payments: [{ method: '微信', amount: 178 }] });
  assert.ok(result.missing_fields.some((issue) => issue.includes('逐双列出实收金额')));
});

test('deposit alone cannot be mistaken for a shoe transaction price', () => {
  // ⚠️ 2026-10-07 资金与类型解耦：这条护栏现在**只看"钱"的词**（定金 / 尾款 / 欠…），
  //    不再看交易类型。所以这条用例把她的原话也带进来（生产上 `sourceText` 一定有）。
  const result = normalizeWithVouchers({ intent: 'sale', items: [{ item_no: '9A207-0', size: 43, quantity: 1 }],
    payments: [{ method: '微信', amount: 50 }], trade_type: '预付' }, '9A207-0 43码，定金微信 50');
  assert.equal(result.agreed_total, '', '只说了定金，不能把定金当成实收金额');
  // 标签统一成规范说法（「预付」→「预定」）。
  assert.equal(result.trade_type, '预定');
  assert.equal(result.items[0].trade_type, '预定');
  assert.ok(result.missing_fields.includes('items[0].actual_amount'));
});

test('future balance is not recorded as cash received, and ambiguous tail payment stops confirmation', () => {
  const ai = { intent: 'sale', items: [{ item_no: '695887B-5', color: '黑', size: 43,
    quantity: 1, actual_amount: 240 }],
  payments: [{ method: '微信', amount: 100 }, { method: '微信', amount: 140 }], agreed_total: 240 };
  const future = normalizeWithVouchers(ai, '695887B-5黑43，微信付定金100元，下次尾款付140元');
  assert.deepEqual(future.payments, [{ method: '微信', amount: 100 }]);
  assert.equal(future.agreed_total, 240);
  assert.deepEqual(future.missing_fields, []);
  const ambiguous = normalizeWithVouchers(ai, '695887B-5黑43，微信付定金100元，尾款付140元');
  assert.ok(ambiguous.missing_fields.some((item) => item.includes('尾款是否已支付')));
  const later = normalizeWithVouchers(ai, '695887B-5黑43，总价240元，微信付定金100元，尾款以后付140元');
  assert.deepEqual(later.payments, [{ method: '微信', amount: 100 }]);
  assert.deepEqual(later.missing_fields, []);
  const conflict = normalizeWithVouchers(ai, '695887B-5黑43，成交价260元，微信付定金100元，尾款以后付140元');
  assert.ok(conflict.missing_fields.some((item) => item.includes('成交价与定金')));
});

test('gift-only model item is folded into preceding sold shoe', () => {
  const result = normalizeWithVouchers({ intent: 'sale', behavior_code: 'SALE_CASH', items: [
    { item_no: '628-6', color: '米紫', size: 36, quantity: 1 },
    { item_no: '', gift: true, gift_description: '袜子一双' },
  ], payments: [{ method: '微信', amount: 220 }], agreed_total: 220 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].gift, true);
  assert.equal(result.items[0].gift_description, '袜子一双');
  assert.deepEqual(result.missing_fields, []);
});

test('explicit gift in one-shoe source survives model omission', async () => {
  const oldKey = process.env.TEXT_LLM_API_KEY;
  const oldBase = process.env.TEXT_LLM_BASE_URL;
  const oldModel = process.env.TEXT_LLM_MODEL;
  const oldGetClient = salesParser.getClient;
  process.env.TEXT_LLM_API_KEY = 'test-key';
  process.env.TEXT_LLM_BASE_URL = 'https://api.deepseek.com';
  process.env.TEXT_LLM_MODEL = 'test-model';
  try {
    salesParser.getClient = () => ({ chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({
      intent: 'sale', behavior_code: 'SALE_CASH', items: [{ item_no: '6V637-7', color: '黑', size: 41, quantity: 1 }],
      payments: [{ method: '微信', amount: 150 }, { method: '现金', amount: 100 }], agreed_total: 250,
    }) } }] }) } } });
    const result = await salesParser.parseSalesText('6V637-7黑41码一双，赠鞋垫一双，150元微信，100元现金',
      { vouchers: VOUCHER_CATALOG });
    assert.equal(result.items[0].gift, true);
    assert.equal(result.items[0].gift_description, '鞋垫一双');
  } finally {
    salesParser.getClient = oldGetClient;
    if (oldKey === undefined) delete process.env.TEXT_LLM_API_KEY;
    else process.env.TEXT_LLM_API_KEY = oldKey;
    if (oldBase === undefined) delete process.env.TEXT_LLM_BASE_URL;
    else process.env.TEXT_LLM_BASE_URL = oldBase;
    if (oldModel === undefined) delete process.env.TEXT_LLM_MODEL;
    else process.env.TEXT_LLM_MODEL = oldModel;
  }
});

test('one 89.9-for-100 voucher is converted to pending 85.4, not received 89.9 or 100', async () => {
  const oldKey = process.env.TEXT_LLM_API_KEY;
  const oldBase = process.env.TEXT_LLM_BASE_URL;
  const oldModel = process.env.TEXT_LLM_MODEL;
  const oldGetClient = salesParser.getClient;
  process.env.TEXT_LLM_API_KEY = 'test-key';
  process.env.TEXT_LLM_BASE_URL = 'https://api.deepseek.com';
  process.env.TEXT_LLM_MODEL = 'test-model';
  try {
    // Even when the AI wrongly calls the voucher a 100-yuan payment and omits
    // the gift, the deterministic policy must correct the cash/settlement split.
    salesParser.getClient = () => ({ chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({
      intent: 'sale', items: [{ item_no: '2A831-18', color: '黑', size: 44, quantity: 1, actual_amount: 269 }],
      payments: [{ method: '微信', amount: 169 }, { method: '抖音团购券', amount: 100 }], agreed_total: 269,
    }) } }] }) } } });
    const result = await salesParser.parseSalesText('2A831-18黑色44的，是169元微信，然后一张89块9抵100的代金券，然后赠了一双袜子',
      { vouchers: VOUCHER_CATALOG });
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
    if (oldKey === undefined) delete process.env.TEXT_LLM_API_KEY;
    else process.env.TEXT_LLM_API_KEY = oldKey;
    if (oldBase === undefined) delete process.env.TEXT_LLM_BASE_URL;
    else process.env.TEXT_LLM_BASE_URL = oldBase;
    if (oldModel === undefined) delete process.env.TEXT_LLM_MODEL;
    else process.env.TEXT_LLM_MODEL = oldModel;
  }
});

test('49.9-for-100 voucher uses configured 47.4 settlement', () => {
  const result = normalizeWithVouchers({ intent: 'sale', items: [
    { item_no: 'A100', size: 38, quantity: 1 }], payments: [{ method: '微信', amount: 169 }],
  }, 'A100黑38，169元微信，一张49.9抵100代金券');
  assert.equal(result.agreed_total, 216.4);
  assert.equal(result.payments[1].amount, 47.4);
  assert.equal(result.payments[1].status, '待平台结算');
  assert.deepEqual(result.missing_fields, []);
});

test('spoken cash facts override an AI payment array that mistakes voucher face value for cash', () => {
  const result = normalizeWithVouchers({ intent: 'sale', items: [
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
  const result = normalizeWithVouchers({ intent: 'sale', items: [
    { item_no: '31663', color: '黑', size: 40, quantity: 1, actual_amount: 19 }],
    payments: [{ method: '微信', amount: 19 }], agreed_total: 19,
  }, '31663黑40的是19元微信，再加上一个89.9块抵100块钱的代金券');
  assert.equal(result.items[0].actual_amount, 104.4);
  assert.equal(result.agreed_total, 104.4);
  assert.deepEqual(result.missing_fields, []);
});

test('voucher accepts payment method before amount and a voucher-only sale', () => {
  const reversed = normalizeWithVouchers({ intent: 'sale', items: [
    { item_no: '2A831-18', color: '黑', size: 44, quantity: 1 }],
    payments: [{ method: '微信', amount: 160 }],
  }, '2A831-18黑44，微信支付160元，加一张89.9元抵100元代金券，赠袜子一双');
  assert.equal(reversed.agreed_total, 245.4);
  assert.deepEqual(reversed.payments, [
    { method: '微信', amount: 160, status: '已收款' },
    { method: '抖音团购券', amount: 85.4, status: '待平台结算' },
  ]);
  assert.deepEqual(reversed.missing_fields, []);
  const voucherOnly = normalizeWithVouchers({ intent: 'sale', items: [
    { item_no: 'XHB8095', color: '黑', size: 42, quantity: 1 }], payments: [],
  }, 'XHB8095黑42，是一张89.9元抵100元代金券，送两双袜子');
  assert.equal(voucherOnly.agreed_total, 85.4);
  assert.deepEqual(voucherOnly.payments, [
    { method: '抖音团购券', amount: 85.4, status: '待平台结算' },
  ]);
  assert.deepEqual(voucherOnly.missing_fields, []);
  const omittedCash = normalizeWithVouchers({ intent: 'sale', items: [
    { item_no: 'XHB8095', color: '黑', size: 42, quantity: 1 }], payments: [],
  }, 'XHB8095黑42，一张89.9元抵100元代金券');
  assert.ok(omittedCash.missing_fields.some((item) => item.includes('只用团购券')));
});

test('colloquial gifts preserve explicit pair count without inventing a count for other gifts', async () => {
  const oldKey = process.env.TEXT_LLM_API_KEY;
  const oldBase = process.env.TEXT_LLM_BASE_URL;
  const oldModel = process.env.TEXT_LLM_MODEL;
  const oldGetClient = salesParser.getClient;
  process.env.TEXT_LLM_API_KEY = 'test-key';
  process.env.TEXT_LLM_BASE_URL = 'https://api.deepseek.com';
  process.env.TEXT_LLM_MODEL = 'test-model';
  try {
    salesParser.getClient = () => ({ chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({
      intent: 'sale', items: [{ item_no: '31663', color: '黑', size: 40, quantity: 1 }],
      payments: [{ method: '微信', amount: 19 }],
    }) } }] }) } } });
    const mixed = await salesParser.parseSalesText('31663黑40，19元微信，一张89.9抵100券，赠了双鞋垫和袜子',
      { vouchers: VOUCHER_CATALOG });
    assert.equal(mixed.items[0].gift_description, '一双鞋垫和袜子');
    const twoPairs = await salesParser.parseSalesText('31663黑40，19元微信，一张89.9抵100券，送了两双袜子',
      { vouchers: VOUCHER_CATALOG });
    assert.equal(twoPairs.items[0].gift_description, '两双袜子');
  } finally {
    salesParser.getClient = oldGetClient;
    if (oldKey === undefined) delete process.env.TEXT_LLM_API_KEY;
    else process.env.TEXT_LLM_API_KEY = oldKey;
    if (oldBase === undefined) delete process.env.TEXT_LLM_BASE_URL;
    else process.env.TEXT_LLM_BASE_URL = oldBase;
    if (oldModel === undefined) delete process.env.TEXT_LLM_MODEL;
    else process.env.TEXT_LLM_MODEL = oldModel;
  }
});

test('explicit contradictory sale price still blocks a voucher sale', () => {
  const result = normalizeWithVouchers({ intent: 'sale', items: [
    { item_no: '31663', color: '黑', size: 40, quantity: 1, actual_amount: 19 }],
    payments: [{ method: '微信', amount: 19 }], agreed_total: 19,
  }, '31663黑40成交价120元，19元微信，再加一个89.9抵100代金券');
  assert.ok(result.missing_fields.some((field) => field.includes('成交价')));
});

test('voucher parsing preserves two gifts and logs AI values separately from normalized values', async () => {
  const oldKey = process.env.TEXT_LLM_API_KEY;
  const oldBase = process.env.TEXT_LLM_BASE_URL;
  const oldModel = process.env.TEXT_LLM_MODEL;
  const oldGetClient = salesParser.getClient;
  const oldLog = console.log;
  const logs = [];
  process.env.TEXT_LLM_API_KEY = 'test-key';
  process.env.TEXT_LLM_BASE_URL = 'https://api.deepseek.com';
  process.env.TEXT_LLM_MODEL = 'test-model';
  try {
    console.log = (line) => logs.push(JSON.parse(line));
    salesParser.getClient = () => ({ chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({
      intent: 'sale', items: [{ item_no: '31663', color: '黑', size: 40, quantity: 1,
        actual_amount: 19, gift: true, gift_description: '一双鞋垫' }],
      payments: [{ method: '微信', amount: 19 }], agreed_total: 19,
    }) } }] }) } } });
    const result = await salesParser.parseSalesText(
      '31663黑40的是19元微信，再加上一个89.9块抵100块钱的代金券，赠了一双鞋垫，赠了一双袜子',
      { taskId: 'sale_log_test', vouchers: VOUCHER_CATALOG });
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
    if (oldKey === undefined) delete process.env.TEXT_LLM_API_KEY;
    else process.env.TEXT_LLM_API_KEY = oldKey;
    if (oldBase === undefined) delete process.env.TEXT_LLM_BASE_URL;
    else process.env.TEXT_LLM_BASE_URL = oldBase;
    if (oldModel === undefined) delete process.env.TEXT_LLM_MODEL;
    else process.env.TEXT_LLM_MODEL = oldModel;
  }
});

test('unknown voucher or multiple shoes cannot silently create a settled receipt', () => {
  const unknown = normalizeWithVouchers({ intent: 'sale', items: [
    { item_no: 'A100', size: 38, quantity: 1, actual_amount: 269 }],
    payments: [{ method: '微信', amount: 169 }, { method: '团购券', amount: 100 }],
    agreed_total: 269,
  }, 'A100黑38，169元微信，一张79.9抵100团购券');
  assert.ok(unknown.missing_fields.some((field) => field.includes('未配置')));
  const multiple = normalizeWithVouchers({ intent: 'sale', items: [
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
  const result = normalizeWithVouchers({
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
  const result = normalizeWithVouchers({
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

test('一张单里的定金 + 尾款落到那一件上：不再拒绝多明细，应收也不再算丢', () => {
  // ⚠️ 口径变更（2026-10-07 业务负责人）：「定金单暂只支持一条明细」这条**整单护栏被放开** ——
  //    一张单可以同时有现货明细与预付明细（「这就是一个人买的呀」，不拆单）。
  //    这不是"放宽断言"：改动前这一单**算不出应收**（agreed_total=''）且被整单拒绝；
  //    改动后应收 = 定金 100 + 尾款 140 = 240 落到**那一件鞋**上，整单 = 各分项之和 240+39=279。
  const result = normalizeWithVouchers({
    intent: 'sale',
    items: [
      { item_no: '695887B-5', color: '黑', size: 43, quantity: 1 },
      { item_no: '39元腰带', quantity: 1, actual_amount: 39 },
    ],
    payments: [{ method: '微信', amount: 100 }],
    agreed_total: null,
  }, '695887B-5 43码黑，39元腰带一条，微信付定金100元，尾款以后付140元');

  assert.ok(!result.missing_fields.some((field) => field.includes('定金单暂只支持一条明细')),
    `原来的整单护栏必须已经被放开，实际待补充：${JSON.stringify(result.missing_fields)}`);
  assert.equal(result.items[0].actual_amount, 240, '定金 100 + 尾款 140 落到那一件鞋上');
  assert.equal(result.agreed_total, 279, '整单 = 各分项之和（240 + 39）——应收不再被静默算丢');
  assert.equal(result.owed, 140, '她明说的尾款仍然是欠款（后端据此补未收款）');
});

// 2026-10-07：这条原来标着「[当前行为·待修复]」，特征化的是**不合理**的结果
// （「100元微信定金」这种语序被判成"没说定金金额"）。真机 BUG#1 就是它，
// 现在按修好后的行为钉住 —— 按那次提交自己的约定「修复后它们会失败，届时按新行为更新」。
test('收款方式夹在「定金」与金额之间（100元微信定金）也认得出定金金额与余额', () => {
  const result = normalizeWithVouchers({
    intent: 'sale',
    items: [{ item_no: '695887B-5', color: '黑', size: 43, quantity: 1 }],
    payments: [{ method: '微信', amount: 100 }],
    agreed_total: null,
  }, '695887B-5 43码黑，100元微信定金，还需要再付140元');

  // 她说清了「100 定金 + 140 余额」⇒ 应收 = 定金 + 余额 = 240，缺项为空。
  assert.deepEqual(result.missing_fields, []);
  assert.equal(result.agreed_total, 240);
  assert.equal(result.items[0].actual_amount, 240);
  // 余额是**她明说的欠款**，不是已收：已收只有定金那 100。
  assert.deepEqual(result.payments, [{ method: '微信', amount: 100 }]);
  assert.equal(result.owed, 140);
});

// ─── 真机 BUG#1（业务负责人 2026-10-07 逐字）──────────────────────────────────
// 「26002-52 37 码，定金微信交了 100 元，下次欠 128 元」
// 「定金」与金额之间夹着**收款方式 + 动词**，这是她最日常的语序。
test('真机语序「定金微信交了 100 元，下次欠 128 元」→ 定金金额与欠款都认得出，不再报缺项', () => {
  const result = normalizeWithVouchers({
    intent: 'sale', trade_type: '预付',
    items: [{ item_no: '26002-52', size: 37, quantity: 1 }],
    payments: [{ method: '微信', amount: 100 }], agreed_total: 228, owed: 128,
  }, '26002-52 37 码，定金微信交了 100 元，下次欠 128 元');

  // 她已经说清了 ⇒ 不许再报「请明确已经收到的定金金额」。
  assert.deepEqual(result.missing_fields, []);
  assert.deepEqual(result.payments, [{ method: '微信', amount: 100 }]);
  assert.equal(result.agreed_total, 228);
  assert.equal(result.owed, 128);
  assert.equal(result.trade_type, '预定');
});

test('后端也能自己从「定金 100 + 下次欠 128」推出成交额 228（模型漏给 agreed_total / owed 也不丢账）', () => {
  const result = normalizeWithVouchers({
    intent: 'sale', trade_type: '预付',
    items: [{ item_no: '26002-52', size: 37, quantity: 1 }],
    payments: [{ method: '微信', amount: 100 }], agreed_total: null, owed: null,
  }, '26002-52 37 码，定金微信交了 100 元，下次欠 128 元');

  // 口径依据（既有）：她**明说还欠** ⇒ 成交额 = 实收 + 欠款 = 100 + 128 = 228。
  // 这正是提示词规则 9 / 9.1 与 normalizeSalesResult 里那条"实收 + 欠款"的算法。
  assert.equal(result.agreed_total, 228);
  assert.equal(result.items[0].actual_amount, 228);
  assert.equal(result.owed, 128);
  assert.deepEqual(result.missing_fields, []);
});

test('她没说定金收了多少 → 仍然报「请明确已经收到的定金金额」（这一条不放宽）', () => {
  const result = normalizeWithVouchers({
    intent: 'sale', trade_type: '预付',
    items: [{ item_no: '26002-52', size: 37, quantity: 1 }],
    payments: [], agreed_total: 228, owed: 128,
  }, '26002-52 37 码，定金微信交的，下次欠 128 元');

  assert.ok(result.missing_fields.includes('请明确已经收到的定金金额'),
    `实际待补充：${JSON.stringify(result.missing_fields)}`);
});

test('定金金额**不许**从货号或鞋码里猜（「26002-52 37码 定金微信交的」→ 仍然要求补充）', () => {
  const result = normalizeWithVouchers({
    intent: 'sale', trade_type: '预付',
    items: [{ item_no: '26002-52', size: 37, quantity: 1 }],
    payments: [], agreed_total: null, owed: null,
  }, '26002-52 37码 定金微信交的');

  assert.ok(result.missing_fields.includes('请明确已经收到的定金金额'),
    `货号 26002-52 与 37码 都不是金额：${JSON.stringify(result.missing_fields)}`);
});

test('[当前行为·待修复] 腰带被当成普通明细时仍然要它补尺码（应收已不再丢）', () => {
  const result = normalizeWithVouchers({
    intent: 'sale',
    items: [
      { item_no: '695887B-5', color: '黑', size: 43, quantity: 1 },
      { item_no: '39元腰带', quantity: 1, actual_amount: 39 },
    ],
    payments: [{ method: '微信', amount: 100 }],
    agreed_total: null,
  }, '695887B-5 43码黑，39元腰带一条，微信付定金100元，尾款以后付140元');

  // ⚠️ 这一条只钉**仍然存在**的那个问题：模型没把「39元腰带」标成配品（`kind:"accessory"`），
  //    于是后端把它当普通明细、要它补尺码 —— 那是**配品识别**的事，不是本次口径变更的范围。
  //    ⚠️ 但「应收被算丢」这一半**已经修好**：改动前 agreed_total 是空（240 丢了），
  //       现在是 279 = 各分项之和（240 + 39）。所以这一条**不是放宽**，是收严了钱的账。
  assert.equal(result.agreed_total, 279);
  assert.equal(result.items[0].actual_amount, 240);
  assert.ok(result.missing_fields.includes('items[1].size'));
});

test('[当前行为·待修复] two vouchers in one order are rejected', () => {
  const result = normalizeWithVouchers({
    intent: 'sale',
    items: [{ item_no: '2A831-18', color: '黑', size: 44, quantity: 1 }],
    payments: [{ method: '微信', amount: 169 }],
    agreed_total: null,
  }, '2A831-18 44码黑，169元微信，两张89.9代100元代金券');

  assert.ok(result.missing_fields.includes('团购券暂只支持一单一张，请明确券种和数量'));
});

test('[当前行为·待修复] a pure-voucher sale must confirm there was no cash', () => {
  const result = normalizeWithVouchers({
    intent: 'sale',
    items: [{ item_no: 'XHB8095', color: '黑', size: 43, quantity: 1, gift_description: '袜子两双' }],
    payments: [],
    agreed_total: null,
  }, 'XHB8095 43码黑，一张89.9代100元代金券 赠袜两双');

  assert.ok(result.missing_fields.includes('请确认是否只用团购券、没有补现金额'));
});

// ─── 配品：只有名字和金额，没有货号、颜色、尺码 ───

test('an accessory item keeps its name and needs no item number or size', () => {
  const result = normalizeWithVouchers({
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
  const result = normalizeWithVouchers({
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
  const result = normalizeWithVouchers({
    intent: 'sale',
    items: [{ kind: 'accessory', quantity: 1, actual_amount: 9.9 }],
    payments: [],
  });

  assert.ok(result.missing_fields.includes('items[0].accessory_name'));
  assert.ok(!result.missing_fields.includes('items[0].item_no'));
  assert.ok(!result.missing_fields.includes('items[0].size'));
});

// ─── 实收金额 vs 欠款：她说了"收了多少"、还是明说"欠"（业务负责人口径） ───
// 提示词规则 9 / 9.1 写死了这条口径；下面钉住解析层的确定性结果。

test('她说了"收了 100"、没说欠 → 实收金额=100，owed 留空（119 只是对档位的价位）', () => {
  const result = normalizeWithVouchers({
    intent: 'sale',
    items: [{ kind: 'accessory', accessory_name: '腰带', quantity: 1, actual_amount: 119 }],
    payments: [{ method: '微信', amount: 100 }],
    agreed_total: 119,
  }, '119 的腰带，是收到了 100 元微信');

  assert.equal(result.items[0].actual_amount, 100, '她说了收到 100，成交就是 100');
  assert.equal(result.agreed_total, 100);
  assert.equal(result.owed, '', '她没说欠，owed 必须为空——后端只认它');
  // 119 保留为"用来匹配档位的价位"：只对记录用，不落库、也不当实收金额。
  assert.equal(result.items[0].tier_price, 119);
  assert.deepEqual(result.missing_fields, []);
});

test('模型按新口径把档位价放进 tier_price 时，实收金额仍然是她说的收款额', () => {
  const result = normalizeWithVouchers({
    intent: 'sale',
    items: [{ kind: 'accessory', accessory_name: '腰带', quantity: 1,
      actual_amount: 100, tier_price: 119 }],
    payments: [{ method: '微信', amount: 100 }],
    agreed_total: 100,
  }, '119 的腰带，是收到了 100 元微信');

  assert.equal(result.items[0].actual_amount, 100);
  assert.equal(result.items[0].tier_price, 119);
  assert.equal(result.owed, '');
});

test('她明说"还欠 19" → 实收金额=119、owed=19（后端据此补未收款）', () => {
  const result = normalizeWithVouchers({
    intent: 'sale',
    items: [{ kind: 'accessory', accessory_name: '腰带', quantity: 1, actual_amount: 119 }],
    payments: [{ method: '微信', amount: 100 }],
    agreed_total: 119,
    owed: 19,
  }, '卖了 119 的腰带，先给 100，还欠 19');

  assert.equal(result.items[0].actual_amount, 119);
  assert.equal(result.owed, 19);
  assert.deepEqual(result.missing_fields, []);
});

test('模型只说收到 100、又明说欠 19 时，实收金额由两个她说的数相加得到', () => {
  const result = normalizeWithVouchers({
    intent: 'sale',
    items: [{ kind: 'accessory', accessory_name: '腰带', quantity: 1, actual_amount: 100 }],
    payments: [{ method: '微信', amount: 100 }],
    agreed_total: 100,
    owed: 19,
  }, '卖了 119 的腰带，先给 100，还欠 19');

  assert.equal(result.items[0].actual_amount, 119);
  assert.equal(result.agreed_total, 119);
  assert.equal(result.owed, 19);
});

test('她只说了价格、没说收多少 → 实收金额=她说的价格（原逻辑不变），也没有欠款', () => {
  const result = normalizeWithVouchers({
    intent: 'sale',
    items: [{ kind: 'accessory', accessory_name: '腰带', quantity: 1, actual_amount: 119 }],
    payments: [],
  }, '119 的腰带');

  assert.equal(result.items[0].actual_amount, 119);
  assert.equal(result.owed, '');
});

test('鞋也按同一口径：说了收到 200 就是 200；只给价格就是那个价格（回归）', () => {
  const paidLessThanQuoted = normalizeWithVouchers({
    intent: 'sale',
    items: [{ item_no: 'A100', color: '黑', size: 38, quantity: 1, actual_amount: 230 }],
    payments: [{ method: '微信', amount: 200 }],
    agreed_total: 230,
  }, 'A100黑38，230的鞋，收到了200微信');

  assert.equal(paidLessThanQuoted.items[0].actual_amount, 200);
  assert.equal(paidLessThanQuoted.agreed_total, 200);
  assert.equal(paidLessThanQuoted.owed, '');

  const quoted = normalizeWithVouchers({
    intent: 'sale',
    items: [{ item_no: 'A100', color: '黑', size: 38, quantity: 1, actual_amount: 230 }],
    payments: [],
    agreed_total: 230,
  }, 'A100黑38，230的鞋');
  assert.equal(quoted.items[0].actual_amount, 230);
});

test('原话说的是定金/欠款那类钱没给清的话时，绝不把已收的那笔当实收金额', () => {
  // 2026-10-07：定金语序已经认得出（见上面那条改好的用例），所以这一单不再是"信息不全"。
  // 这条用例要守的东西**没变**：绝不退化成"成交 = 已收的 100"。
  // 她说清了 100 定金 + 140 余额 ⇒ 应收 240、已收只有 100、她明说的欠款 140。
  const result = normalizeWithVouchers({
    intent: 'sale',
    items: [{ item_no: '695887B-5', color: '黑', size: 43, quantity: 1 }],
    payments: [{ method: '微信', amount: 100 }],
    agreed_total: null,
  }, '695887B-5 43码黑，100元微信定金，还需要再付140元');

  assert.notEqual(result.agreed_total, 100, '已有断言不放宽：已收的那笔不是实收金额');
  assert.equal(result.agreed_total, 240);
  assert.equal(result.total_paid, 100);
  assert.equal(result.owed, 140);
});

test('未付单：整单没给钱时说"未付" → owed 填整单金额，payments 为空', () => {
  const result = normalizeWithVouchers({
    intent: 'sale', trade_type: '未付',
    items: [{ item_no: '815195B-6', color: '黑', size: 39, quantity: 1 }],
    payments: [], agreed_total: 260, owed: 260,
  }, '815195B-6黑39码260元未付');

  assert.equal(result.items[0].actual_amount, 260);
  assert.equal(result.owed, 260);
  assert.deepEqual(result.payments, []);
  assert.deepEqual(result.missing_fields, []);
});

test('提示词里写死了"欠"的识别口径（owed / tier_price），删掉就会红', async () => {
  const oldKey = process.env.TEXT_LLM_API_KEY;
  const oldBase = process.env.TEXT_LLM_BASE_URL;
  const oldModel = process.env.TEXT_LLM_MODEL;
  const oldGetClient = salesParser.getClient;
  const prompts = [];
  process.env.TEXT_LLM_API_KEY = 'test-key';
  process.env.TEXT_LLM_BASE_URL = 'https://api.deepseek.com';
  process.env.TEXT_LLM_MODEL = 'test-model';
  try {
    salesParser.getClient = () => ({ chat: { completions: { create: async ({ messages }) => {
      prompts.push(messages[0].content);
      return { choices: [{ message: { content: JSON.stringify({ intent: 'sale', items: [] }) } }] };
    } } } });
    await salesParser.parseSalesText('119 的腰带，是收到了 100 元微信',
      { accessoryNames: ['腰带'], vouchers: VOUCHER_CATALOG });
    const [prompt] = prompts;
    // 「她明说欠才算欠」这条口径必须写在提示词里：模型不认它，owed 就永远是空的。
    assert.match(prompt, /9\.1 owed/);
    assert.match(prompt, /绝不要.*差额.*owed/);
    assert.match(prompt, /tier_price/);
    assert.match(prompt, /"owed": ""/);
  } finally {
    salesParser.getClient = oldGetClient;
    if (oldKey === undefined) delete process.env.TEXT_LLM_API_KEY;
    else process.env.TEXT_LLM_API_KEY = oldKey;
    if (oldBase === undefined) delete process.env.TEXT_LLM_BASE_URL;
    else process.env.TEXT_LLM_BASE_URL = oldBase;
    if (oldModel === undefined) delete process.env.TEXT_LLM_MODEL;
    else process.env.TEXT_LLM_MODEL = oldModel;
  }
});

// ─── ⭐ BUG 修复回归：售后（退货/换货）走消息入口不再 TypeError ──────────────────
//
// 现象：退货/换货的规范化结果里**没有 items**（售后字段契约刻意不装销售字段），
//       parseSalesText 里"赠品归并"那段却直接读 normalized.items.length
//       → TypeError: Cannot read properties of undefined (reading 'length')
//       → 被包成「销售文字解析失败」→ 任务永远 failed、出不了确认卡片。
// 口径：她说「退一双 1682 香槟 38码，钱退现金」→ 出售后确认卡片，绝不能说"解析失败"。
// ─── ⭐ 真机案例（2026-10-07）：一句话里「总额 + 各分项金额」同时出现 ─────────────
//
// 她的原话（逐字）：
//   「400 元微信卖了一双 6A637-7，43码（赠了一双袜子，260 元），然后 140 元微信卖了一条 158 元的腰带」
// 她本人的澄清（逐字）：
//   「其实是这笔一共成交 400 元，鞋是 260 元，腰带是 140 元，为什么理解不了呢？」
//
// ⇒ 一笔共收 400 = 鞋 260 + 腰带 140；赠品「袜子一双」不参与金额。
// 改前的错法：鞋被写成 400（整单实收覆盖了单件金额），又把 140 数成第二笔付款 ⇒ 总额 540。
const REAL_MACHINE_TEXT =
  '400 元微信卖了一双 6A637-7，43码（赠了一双袜子，260 元），然后 140 元微信卖了一条 158 元的腰带';

test('真机原话：总额 + 各分项同时出现 ⇒ 每个件用它自己的分项金额，成交总额 = 各分项之和', () => {
  // 模型按新口径的结构：鞋 260、腰带 140（档位价 158 只用于对档）、一笔微信 400、总额 400。
  const result = normalizeWithVouchers({
    intent: 'sale',
    trade_type: '现货',
    items: [
      { item_no: '6A637-7', size: 43, quantity: 1, actual_amount: 260, gift: true, gift_description: '袜子一双' },
      { kind: 'accessory', accessory_name: '腰带', quantity: 1, tier_price: 158, actual_amount: 140 },
    ],
    payments: [{ amount: 400, method: '微信' }],
    agreed_total: 400,
    owed: '',
  }, REAL_MACHINE_TEXT);

  assert.equal(result.items[0].actual_amount, 260, '鞋必须是它自己的分项金额 260，不许被整单实收 400 覆盖');
  assert.equal(result.items[1].actual_amount, 140, '腰带是 140');
  assert.equal(result.items[1].tier_price, 158, '158 只是对档位的价位，不是实收金额');
  assert.deepEqual(result.payments, [{ method: '微信', amount: 400 }], '她说了「400 元微信」一笔，不许拆成两笔');
  assert.equal(result.agreed_total, 400, '成交总额 = 260 + 140 = 400');
  assert.equal(result.total_paid, 400);
  assert.equal(result.owed, '', '她没说欠，owed 必须为空');
  // 赠品不参与金额：袜子只以 gift_description 出现，不是一件明细。
  assert.equal(result.items[0].gift_description, '袜子一双');
  assert.equal(result.items.length, 2, '袜子不许被当成第三件商品');
  assert.deepEqual(result.missing_fields, [], `金额是自洽的，不该再报缺项：${JSON.stringify(result.missing_fields)}`);
});

test('真机错法（鞋 400 + 腰带 140、两笔微信）⇒ 合计 540 ≠ 总额 400：报缺项、绝不静默算成 540', () => {
  // 改前的错法就是这个形状：整单实收 400 被当成鞋的实收金额，140 又被数成第二笔付款。
  // 后端**不做分摊**（她明令禁止）：谁的数原样留着，只把"对不上"报成缺项，由她重说一遍。
  const result = normalizeWithVouchers({
    intent: 'sale',
    trade_type: '现货',
    items: [
      { item_no: '6A637-7', size: 43, quantity: 1, actual_amount: 400, gift: true, gift_description: '袜子一双' },
      { kind: 'accessory', accessory_name: '腰带', quantity: 1, tier_price: 158, actual_amount: 140 },
    ],
    payments: [{ amount: 400, method: '微信' }, { amount: 140, method: '微信' }],
    agreed_total: 400,
    owed: '',
  }, REAL_MACHINE_TEXT);

  assert.ok(
    result.missing_fields.some((issue) => issue.includes('与各件金额之和') && issue.includes('对不上')),
    `对不上时必须走缺项追问，实际：${JSON.stringify(result.missing_fields)}`,
  );
  // 🔴 后端**不许**把整单实收（540 那笔两笔付款之和）摊到某一件上：一件都不改。
  //    （改前的错位就是被摊出来的：鞋 400 来自整单实收，腰带 140 又被数成第二笔付款。）
  assert.equal(result.items[0].actual_amount, 400, '她说的数原样留着，不许后端自己摊');
  assert.equal(result.items[1].actual_amount, 140);
  // ⚠️ 也不许把它当成"已收 540"静默入账：`total_paid` 只是付款记录的读数，
  //    真正拦单的是上面那条缺项（接线层据此不进确认卡片）。
  assert.ok(result.missing_fields.length > 0);
});

test('多双鞋、只给了整单实收：绝不许把整单实收覆盖成第一双的实收金额（它会顺手把账做平）', () => {
  // 这就是真机错位的**算术成因**：模型没给各件金额、只给了整单实收时，
  // 旧逻辑把"实收"当成第一件的实收金额（250），于是"各件之和 = 总额"永远成立、
  // 那条"对不上"的校验永远拦不住 —— 错账被静默做平。
  // ⇒ 多双鞋时不套用"实收金额 = 实收"那条（它只对整单确实只有一件时成立）。
  const result = normalizeWithVouchers({
    intent: 'sale', agreed_total: 250,
    items: [{ item_no: '93827', size: 43, quantity: 1 }, { item_no: '2115', size: 37, quantity: 1 }],
    payments: [{ method: '现金', amount: 250 }],
  }, '两双鞋，一共 250 现金');
  assert.deepEqual(result.items.map((item) => item.actual_amount), ['', ''],
    '一件都不许被整单实收覆盖 —— 要她逐件说，而不是替她摊');
  assert.ok(result.missing_fields.includes('items[0].actual_amount'));
  assert.ok(result.missing_fields.includes('items[1].actual_amount'));
});

test('「分项之和 ≠ 她说的总额」⇒ 缺项追问里带上两个数，绝不按标价分摊', () => {
  // 她说一共 400，但报的两件是 300 + 140 = 440 —— 对不上，必须问她。
  const result = normalizeWithVouchers({
    intent: 'sale',
    items: [
      { item_no: '6A637-7', size: 43, quantity: 1, actual_amount: 300 },
      { kind: 'accessory', accessory_name: '腰带', quantity: 1, actual_amount: 140 },
    ],
    payments: [{ amount: 400, method: '微信' }],
    agreed_total: 400,
  }, '一共 400 元微信，鞋 300，腰带 140');

  const issue = result.missing_fields.find((entry) => entry.includes('与各件金额之和'));
  assert.ok(issue, `必须有"对不上"的追问，实际：${JSON.stringify(result.missing_fields)}`);
  assert.match(issue, /400/, '追问里要有她说的总额');
  assert.match(issue, /440/, '追问里要有各件金额之和，让她一眼看出差在哪');
  // 不许按标价分摊：任何一个件的金额都不许被改成"为了凑总额"的数。
  assert.equal(result.items[0].actual_amount, 300);
  assert.equal(result.items[1].actual_amount, 140);
});

// ⭐ 提示词侧：这条口径必须写在销售提示词里，并且与她既有规则 6 / 9 自洽。
test('销售提示词写死了「总额 + 分项同时出现」的口径（删掉就会红）', async () => {
  const oldKey = process.env.TEXT_LLM_API_KEY;
  const oldBase = process.env.TEXT_LLM_BASE_URL;
  const oldModel = process.env.TEXT_LLM_MODEL;
  const oldGetClient = salesParser.getClient;
  const prompts = [];
  process.env.TEXT_LLM_API_KEY = 'test-key';
  process.env.TEXT_LLM_BASE_URL = 'https://api.deepseek.com';
  process.env.TEXT_LLM_MODEL = 'test-model';
  try {
    salesParser.getClient = () => ({ chat: { completions: { create: async ({ messages }) => {
      prompts.push(messages[0].content);
      return { choices: [{ message: { content: JSON.stringify({ intent: 'sale', items: [] }) } }] };
    } } } });
    await salesParser.parseSalesText(REAL_MACHINE_TEXT,
      { accessoryNames: ['腰带'], vouchers: VOUCHER_CATALOG });
    const [prompt] = prompts;
    // ① 同时给了总额和每件金额 ⇒ 每件用它自己的分项金额、agreed_total 是各分项之和。
    assert.match(prompt, /同时/);
    assert.match(prompt, /各分项之和|各件金额之和|逐件金额之和/);
    // ② 与规则 6 自洽：只给整单金额仍然留空、要求补充（这条不许被改掉）。
    assert.match(prompt, /只给整单金额/);
    // ③ 与规则 9 自洽：多件时整单实收不再覆盖单件金额。
    assert.match(prompt, /多件/);
    assert.match(prompt, /整单实收/);
  } finally {
    salesParser.getClient = oldGetClient;
    if (oldKey === undefined) delete process.env.TEXT_LLM_API_KEY;
    else process.env.TEXT_LLM_API_KEY = oldKey;
    if (oldBase === undefined) delete process.env.TEXT_LLM_BASE_URL;
    else process.env.TEXT_LLM_BASE_URL = oldBase;
    if (oldModel === undefined) delete process.env.TEXT_LLM_MODEL;
    else process.env.TEXT_LLM_MODEL = oldModel;
  }
});

test('售后意图走 parseSalesText 不再抛 TypeError（赠品归并只对 sale 生效）', async () => {
  const oldKey = process.env.TEXT_LLM_API_KEY;
  const oldBase = process.env.TEXT_LLM_BASE_URL;
  const oldModel = process.env.TEXT_LLM_MODEL;
  const oldGetClient = salesParser.getClient;
  const oldLog = console.log;
  process.env.TEXT_LLM_API_KEY = 'test-key';
  process.env.TEXT_LLM_BASE_URL = 'https://api.deepseek.com';
  process.env.TEXT_LLM_MODEL = 'test-model';
  try {
    // 静音日志，保持测试输出干净（parseSalesText 会打 sales.ai.parsed / normalized）
    console.log = () => {};
    salesParser.getClient = () => ({ chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({
      intent: 'return', action: 'return', item_no: '1682', color: '香槟', size: 38,
      settlement: '现金', diff_amount: -230, restock_state: '门盒',
    }) } }] }) } } });
    // ① 不抛（改动前这里会：Cannot read properties of undefined (reading 'length')）
    const result = await salesParser.parseSalesText('退一双 1682 香槟 38码，钱退现金', { taskId: 'p' });
    // ② 售后契约照旧：没有销售字段 items，售后字段都在
    assert.equal(result.intent, 'return');
    assert.equal('items' in result, false);
    assert.equal(result.item_no, '1682');
    assert.equal(result.color, '香槟');
    assert.equal(result.size, 38);
    assert.equal(result.settlement, 'cash');
    assert.equal(result.diff_amount, -230);
  } finally {
    console.log = oldLog;
    salesParser.getClient = oldGetClient;
    if (oldKey === undefined) delete process.env.TEXT_LLM_API_KEY;
    else process.env.TEXT_LLM_API_KEY = oldKey;
    if (oldBase === undefined) delete process.env.TEXT_LLM_BASE_URL;
    else process.env.TEXT_LLM_BASE_URL = oldBase;
    if (oldModel === undefined) delete process.env.TEXT_LLM_MODEL;
    else process.env.TEXT_LLM_MODEL = oldModel;
  }
});
