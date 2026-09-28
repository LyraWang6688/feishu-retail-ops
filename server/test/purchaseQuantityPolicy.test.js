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
