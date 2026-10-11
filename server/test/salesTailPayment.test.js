// ⭐ 「下次收 X」这类说法要认成尾款（未收的尾款 = owed）；定金 + 尾款 ⇒ 成交额 = 两者之和。
//
// 真机（业务负责人 2026-10-07 22:59，逐字）：
//   「定制一双 37 码的 26632，定金交了 100 元，微信，**下次收**120元」
//   改动前的解析（`sales.ai.parsed` 逐字）：
//     items: [{item_no:"26632", size:37, quantity:1, actual_amount:""}]
//     payments: [{method:"微信", amount:100}]
//     agreed_total: "" · owed: "" · missing_fields: []
//   ⇒ 「下次收 120」**没被认成尾款**，也没推出成交额。
//
// 对照（同一天、能认出来的反例）：「定金微信交了 100 元，**下次欠** 128 元」→ 解析正确
//   （payments[{100,微信}] · agreed_total:228 · owed:128）⇒ 差别只在「欠」vs「收」这个用词。
//
// ⚠️ 为什么「收」也不能当已收款：她说的是「**下次**收」—— 收款**方向**的词在这里等于
//    「这笔钱还没到手、下次收」，**不许**因为方向是"收"就把它算成这次收到的钱。
//
// 本文件钉住：
//   AC-1 ⭐ 她那句原话 → 成交额 220 / owed 120 / payments[微信100] / 缺项为空
//   AC-2    哨兵：「下次欠 128」的既有行为**逐字不变**
//   AC-3    哨兵：只说定金、不说尾款 → 行为不变（**只有定金不能当成交额**这条没动）
//   AC-9    同义说法矩阵：下次收 / 下次付 / 还要收 / 还要付 / 再收 / 再付 /
//           尾款 / 余款 / 剩下 / 剩下的 / 还差 / 补收 —— 都算 owed
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSalesResult } = require('../src/services/doubaoService');

/** 她的原话（逐字，一个标点都没改）。 */
const HER_TEXT = '定制一双 37 码的 26632，定金交了 100 元，微信，下次收120元';

/** 真机日志里模型逐字给出的那份（`actual_amount: ""` / `agreed_total: ""` / `owed: ""`）。 */
const herModelOutput = () => ({
  intent: 'sale',
  trade_type: '预定',
  items: [{ item_no: '26632', size: 37, quantity: 1, actual_amount: '' }],
  payments: [{ method: '微信', amount: 100 }],
  agreed_total: '',
  owed: '',
  missing_fields: [],
});

const normalize = (modelOutput, sourceText) => normalizeSalesResult(modelOutput, sourceText);

// ── AC-1 ⭐ 她的原话 ──────────────────────────────────────────────────────────
test('AC-1 她那句原话：「下次收 120」= 尾款 ⇒ 成交额 220、owed 120、缺项为空', () => {
  const result = normalize(herModelOutput(), HER_TEXT);

  // ① 「下次收 120」是**未收的尾款**，不是本次已收款。
  assert.deepEqual(result.payments, [{ method: '微信', amount: 100 }],
    `已收只有定金那 100：${JSON.stringify(result.payments)}`);
  assert.equal(result.owed, 120, '「下次收 120」必须认成 owed（未收的尾款）');
  // ② 定金 + 尾款 ⇒ 成交额 = 两者之和（100 + 120 = 220）。
  assert.equal(result.agreed_total, 220, '成交额 = 定金 100 + 尾款 120');
  assert.equal(result.items[0].actual_amount, 220, '这一件鞋的实收金额 = 220');
  // ③ 她已经把话说全了 ⇒ 不许再报缺项（更不许问她"实收金额"）。
  assert.deepEqual(result.missing_fields, [],
    `她已经说清了定金和尾款，不该再报缺项：${JSON.stringify(result.missing_fields)}`);
  // ④ 逐字段（她要的就是这份逐字段解析）。
  assert.deepEqual(result.items, [{
    item_no: '26632',
    color: '',
    size: 37,
    quantity: 1,
    actual_amount: 220,
    trade_type: '预定',
    trade_type_code: 'SALE_PREPAID',
    gift: false,
    gift_description: '',
  }]);
  assert.equal(result.total_paid, 100, '已收 = 100（「下次收」的那 120 还没到手）');
});

// ── AC-2 哨兵：能认出来的那条既有行为不变 ────────────────────────────────────
test('AC-2 哨兵：「下次欠 128」的既有行为**逐字不变**（成交额 228 / owed 128 / 缺项为空）', () => {
  const text = '26002-52 37 码，定金微信交了 100 元，下次欠 128 元';
  const result = normalize({
    intent: 'sale', trade_type: '预付',
    items: [{ item_no: '26002-52', size: 37, quantity: 1 }],
    payments: [{ method: '微信', amount: 100 }], agreed_total: 228, owed: 128,
  }, text);

  assert.deepEqual(result.missing_fields, []);
  assert.deepEqual(result.payments, [{ method: '微信', amount: 100 }]);
  assert.equal(result.agreed_total, 228);
  assert.equal(result.owed, 128);
  assert.equal(result.trade_type, '预定');

  // 模型漏给 agreed_total / owed 时后端自己也能推出来（既有行为）。
  const derived = normalize({
    intent: 'sale', trade_type: '预付',
    items: [{ item_no: '26002-52', size: 37, quantity: 1 }],
    payments: [{ method: '微信', amount: 100 }], agreed_total: null, owed: null,
  }, text);
  assert.equal(derived.agreed_total, 228);
  assert.equal(derived.owed, 128);
  assert.deepEqual(derived.missing_fields, []);
});

// ── AC-3 哨兵：只说定金、不说尾款 → 行为不变 ─────────────────────────────────
test('AC-3 哨兵：只说定金、不说尾款 → 成交额仍为空（「只有定金不能当成交额」没动）', () => {
  const result = normalize({
    intent: 'sale',
    items: [{ item_no: '9A207-0', size: 43, quantity: 1 }],
    payments: [{ method: '微信', amount: 50 }],
    trade_type: '预付',
  }, '9A207-0 43码，定金微信 50');

  assert.equal(result.agreed_total, '', '只说了定金，**不许**把定金当成实收金额');
  assert.equal(result.items[0].actual_amount, '', '这一件的实收金额仍然未知');
  assert.equal(result.owed, '', '她没说还欠多少 ⇒ 不许自己减出欠款');
  assert.ok(result.missing_fields.includes('items[0].actual_amount'),
    `仍然要她补实收金额：${JSON.stringify(result.missing_fields)}`);
});

// ── AC-9 同义说法矩阵 ────────────────────────────────────────────────────────
// 她说「定金交了 100 元，微信，<这些说法> 120 元」时，**每一种**都必须：
//   owed = 120 · 成交额 = 220 · payments 只有定金那 100。
const TAIL_PHRASES = [
  '下次收', '下次付', '还要收', '还要付', '再收', '再付',
  '尾款以后付', '余款下次收', '剩下的下次收', '还差', '补收',
];

for (const phrase of TAIL_PHRASES) {
  test(`AC-9 「${phrase} 120 元」也算尾款（owed 120 / 成交额 220）`, () => {
    const text = `26632 37 码，定金微信交了 100 元，${phrase} 120 元`;
    const result = normalize({
      intent: 'sale', trade_type: '预定',
      items: [{ item_no: '26632', size: 37, quantity: 1 }],
      payments: [{ method: '微信', amount: 100 }],
      agreed_total: null, owed: null,
    }, text);

    assert.equal(result.owed, 120, `「${phrase}」必须认成 owe/尾款`);
    assert.equal(result.agreed_total, 220, `「${phrase}」⇒ 成交额 = 100 + 120`);
    assert.equal(result.items[0].actual_amount, 220);
    assert.deepEqual(result.payments, [{ method: '微信', amount: 100 }],
      `「${phrase}」的那 120 不是已收款`);
    assert.deepEqual(result.missing_fields, [],
      `「${phrase}」她已经说全了：${JSON.stringify(result.missing_fields)}`);
  });
}

// ── 边界：原话里**没有**「定金」时（「收了 100，下次收 120」）──────────────────
// ⚠️ 确定性的尾款识别挂在 `depositTerms` 上（要求原话里有「定金」）——
//    这条只是把**当前边界**钉住，不是新口径：
//      · 模型按提示词 9.1 给了 owed ⇒ 走既有「成交额 = 实收 + 欠款」得到 220（正确）；
//      · 模型漏给 owed ⇒ **回头问她**，绝不许静默把 120 算丢（原来会算成"这单就值 100"）。
test('没有「定金」时：模型给了 owed 就推出 220；模型漏给则问她（不许静默算成 100）', () => {
  const text = '26632 37 码，收了 100 元微信，下次收 120 元';

  const withOwed = normalize({
    intent: 'sale',
    items: [{ item_no: '26632', size: 37, quantity: 1 }],
    payments: [{ amount: 100, method: '微信' }], agreed_total: null, owed: 120,
  }, text);
  assert.equal(withOwed.agreed_total, 220, '成交额 = 实收 100 + 欠款 120');
  assert.equal(withOwed.owed, 120);
  assert.deepEqual(withOwed.missing_fields, []);

  const withoutOwed = normalize({
    intent: 'sale',
    items: [{ item_no: '26632', size: 37, quantity: 1 }],
    payments: [{ amount: 100, method: '微信' }], agreed_total: null, owed: null,
  }, text);
  assert.notEqual(withoutOwed.agreed_total, 100,
    '「下次收 120」是钱没结清的说法 ⇒ 不许套用"实收金额 = 实收 100"（那会把 120 算丢）');
  assert.ok(withoutOwed.missing_fields.includes('items[0].actual_amount'),
    `模型漏给欠款时要回头问她：${JSON.stringify(withoutOwed.missing_fields)}`);
});

// ── 模型把尾款也塞进 payments 时，后端仍然不把它当已收款 ──────────────────────
test('模型把「下次收 120」错记成一笔收款 → 后端按她明说的尾款剔掉它', () => {
  const result = normalize({
    intent: 'sale', trade_type: '预定',
    items: [{ item_no: '26632', size: 37, quantity: 1 }],
    payments: [{ method: '微信', amount: 100 }, { method: '微信', amount: 120 }],
    agreed_total: null, owed: null,
  }, HER_TEXT);

  assert.deepEqual(result.payments, [{ method: '微信', amount: 100 }],
    '还没到手的那 120 不许留在已收款里');
  assert.equal(result.owed, 120);
  assert.equal(result.agreed_total, 220);
  assert.deepEqual(result.missing_fields, []);
});
