const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPurchaseQuantities } = require('../src/services/purchaseQuantityPolicy');

test('empty quantity description defaults every selected size to one without AI', async () => {
  let parserCalled = false;
  const items = await buildPurchaseQuantities({
    selectedSizes: [39, 40, 41],
    quantityDescription: '  ',
    parseOverrides: async () => {
      parserCalled = true;
      return [];
    },
  });

  assert.equal(parserCalled, false);
  assert.deepEqual(items, [
    { size: 39, quantity: 1 },
    { size: 40, quantity: 1 },
    { size: 41, quantity: 1 },
  ]);
});

test('quantity description overrides only mentioned sizes and preserves defaults', async () => {
  let parserInput;
  const items = await buildPurchaseQuantities({
    selectedSizes: [39, 40, 41],
    quantityDescription: '40两双',
    parseOverrides: async (text, context) => {
      parserInput = { text, context };
      return [{ size: 40, quantity: 2 }];
    },
  });

  assert.deepEqual(parserInput, {
    text: '40两双',
    context: { selectedSizes: [39, 40, 41] },
  });
  assert.deepEqual(items, [
    { size: 39, quantity: 1 },
    { size: 40, quantity: 2 },
    { size: 41, quantity: 1 },
  ]);
});

// 用户在说明里写“各一双”是在确认默认数量，不是在说含糊的话。
// 提示词要求这种情况回显全部已选尺码 ×1，规则层必须接受这个结果而不是判为失败。
test('description confirming the default one pair per size is accepted', async () => {
  const items = await buildPurchaseQuantities({
    selectedSizes: [39, 40, 41],
    quantityDescription: '各一双',
    parseOverrides: async () => [
      { size: 39, quantity: 1 },
      { size: 40, quantity: 1 },
      { size: 41, quantity: 1 },
    ],
  });

  assert.deepEqual(items, [
    { size: 39, quantity: 1 },
    { size: 40, quantity: 1 },
    { size: 41, quantity: 1 },
  ]);
});

test('quantity description can override every selected size', async () => {
  const items = await buildPurchaseQuantities({
    selectedSizes: [39, 40, 41],
    quantityDescription: '每个码两双',
    parseOverrides: async () => [
      { size: 39, quantity: 2 },
      { size: 40, quantity: 2 },
      { size: 41, quantity: 2 },
    ],
  });

  assert.deepEqual(items, [
    { size: 39, quantity: 2 },
    { size: 40, quantity: 2 },
    { size: 41, quantity: 2 },
  ]);
});

test('fractional, zero and negative sizes are rejected', async () => {
  for (const size of [42.5, 0, -1]) {
    await assert.rejects(buildPurchaseQuantities({ selectedSizes: [size] }), /已选尺码必须是正整数/);
  }
});

test('unselected size in quantity description is rejected', async () => {
  await assert.rejects(buildPurchaseQuantities({
    selectedSizes: [39, 40, 41],
    quantityDescription: '42两双',
    parseOverrides: async () => [{ size: 42, quantity: 2 }],
  }), /未勾选的 42 码/);
});

test('ambiguous or empty AI result is rejected for non-empty description', async () => {
  await assert.rejects(buildPurchaseQuantities({
    selectedSizes: [39, 40],
    quantityDescription: '这几个多来一点',
    parseOverrides: async () => [],
  }), /没有识别出明确的尺码数量/);
});

test('conflicting duplicate quantities for the same size are rejected', async () => {
  await assert.rejects(buildPurchaseQuantities({
    selectedSizes: [39, 40],
    quantityDescription: '39两双，39三双',
    parseOverrides: async () => [
      { size: 39, quantity: 2 },
      { size: 39, quantity: 3 },
    ],
  }), /39 码给出了不同数量/);
});

test('quantity must be a positive integer', async () => {
  await assert.rejects(buildPurchaseQuantities({
    selectedSizes: [39],
    quantityDescription: '39一双半',
    parseOverrides: async () => [{ size: 39, quantity: 1.5 }],
  }), /采购数量必须是正整数/);
});

test('at least one selected size is required', async () => {
  await assert.rejects(buildPurchaseQuantities({ selectedSizes: [] }), /至少选择一个尺码/);
});

// ── 回归：提示词 2026-10-06 加了「明确说了数量（哪怕就是 1）也必须输出」之后， ──
// 「没提到的尺码默认一双」这条本意不能被改坏。
//
// 风险长什么样：模型可能开始把**没提到的尺码也回显成 1**（那正是被禁止的"输出全部尺码"）。
// 回显 1 与"默认 1"同值，所以规则层必须照样得出正确结果——这条把它钉住。

test('模型把没提到的尺码也回显成 1 时，默认一双的结果不变', async () => {
  const items = await buildPurchaseQuantities({
    selectedSizes: [38, 39, 40],
    quantityDescription: '38 码 3 双',
    // 模型"多嘴"回显了 39/40（各自 1），这正是提示词里不许发生、但必须容忍的形状。
    parseOverrides: async () => [
      { size: 38, quantity: 3 },
      { size: 39, quantity: 1 },
      { size: 40, quantity: 1 },
    ],
  });

  assert.deepEqual(items, [
    { size: 38, quantity: 3 },
    { size: 39, quantity: 1 },
    { size: 40, quantity: 1 },
  ]);
});

// 「说明没有提到」不等于「说了数量是 1」：她明说"一双/1 双"时，
// 模型会（也必须）输出 quantity=1 的那一条，规则层只能接受，不能判为失败。
test('说明明确说“一双”时，解析出的数量 1 必须被接受（不是"没提到"）', async () => {
  const items = await buildPurchaseQuantities({
    selectedSizes: [38],
    quantityDescription: '一双',
    parseOverrides: async () => [{ size: 38, quantity: 1 }],
  });

  assert.deepEqual(items, [{ size: 38, quantity: 1 }]);
});
