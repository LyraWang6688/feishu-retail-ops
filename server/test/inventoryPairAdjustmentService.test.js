'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { InventoryPairAdjustmentService } = require('../src/services/inventoryPairAdjustmentService');

const fakeInventory = ({ counts = [], records = [] } = {}) => {
  const calls = [];
  return {
    calls,
    gateway: {
      table: (key) => ({ fields: { category: '品类', season: '当季' } }),
      listAll: async () => records,
      update: async (key, id, values) => { calls.push({ type: 'update', key, id, values }); },
    },
    candidatesFromLiveRecords: async () => counts,
    applyChange: async (input) => { calls.push({ type: 'change', ...input }); },
  };
};

test('AC-PAIR-1 目标数量与当前一致 ⇒ 不写任何库存', async () => {
  const inventory = fakeInventory({ counts: [{ size: 42, doorBoxCount: 1, sampleCount: 1 }] });
  const service = new InventoryPairAdjustmentService({ inventory });
  const result = await service.adjustPairs({
    productRecordId: 'p1', requestId: 'req',
    rows: [{ size: 42, state: '门盒', quantity: 1 }, { size: 42, state: '样品', quantity: 1 }],
  });
  assert.equal(result.changed, 0);
  assert.equal(inventory.calls.length, 0);
});

test('AC-PAIR-2 数量/尺码/状态差异逐项走 applyChange（增/减）', async () => {
  const inventory = fakeInventory({
    counts: [
      { size: 42, doorBoxCount: 1, sampleCount: 1 },
      { size: 43, doorBoxCount: 1, sampleCount: 0 },
    ],
  });
  const service = new InventoryPairAdjustmentService({ inventory });
  const result = await service.adjustPairs({
    productRecordId: 'p1', requestId: 'req',
    rows: [
      { size: 42, state: '门盒', quantity: 2 },
      { size: 42, state: '样品', quantity: 0 },
      { size: 44, state: '门盒', quantity: 1 },
    ],
  });
  assert.equal(result.changed, 4);
  const changes = inventory.calls.filter((call) => call.type === 'change');
  assert.deepEqual(changes.map((call) => [call.size, call.state, call.kind, call.quantity]).sort(), [
    [42, '样品', 'STOCK_MANUAL_DECREASE', 1],
    [42, '门盒', 'STOCK_MANUAL_INCREASE', 1],
    [43, '门盒', 'STOCK_MANUAL_DECREASE', 1],
    [44, '门盒', 'STOCK_MANUAL_INCREASE', 1],
  ].sort());
});

test('AC-PAIR-3 批量当季：只更新当前品类的实时库存', async () => {
  const records = [
    { record_id: 'l1', fields: { 品类: '休闲鞋', 当季: false } },
    { record_id: 'l2', fields: { 品类: '休闲鞋', 当季: true } },
    { record_id: 'l3', fields: { 品类: '单鞋', 当季: false } },
  ];
  const inventory = fakeInventory({ records });
  const service = new InventoryPairAdjustmentService({ inventory });
  const result = await service.setSeason({ category: '休闲鞋', season: true });
  assert.equal(result.updated, 1);
  assert.ok(inventory.calls.some((call) => call.type === 'update' && call.id === 'l1'));
  assert.ok(!inventory.calls.some((call) => call.id === 'l2'));
  assert.ok(!inventory.calls.some((call) => call.id === 'l3'));
});
