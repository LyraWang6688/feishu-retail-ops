'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { InventoryPairAdjustmentService } = require('../src/services/inventoryPairAdjustmentService');

const fakeInventory = ({ counts = [], records = [] } = {}) => {
  const calls = [];
  const effectiveRecords = records.length ? records : counts.flatMap((item) => {
    const rows = [];
    for (let i = 0; i < Number(item.doorBoxCount || 0); i += 1) {
      rows.push({ record_id: `r${item.size}_door_${i}`, fields: { 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: [`size${item.size}`] }], 所属状态: '门盒' } });
    }
    for (let i = 0; i < Number(item.sampleCount || 0); i += 1) {
      rows.push({ record_id: `r${item.size}_sample_${i}`, fields: { 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: [`size${item.size}`] }], 所属状态: '样品' } });
    }
    return rows;
  });
  return {
    calls,
    gateway: {
      table: (key) => ({
        fields: {
          category: '品类', season: '当季', product: '编号', size: '尺码', state: '所属状态',
          operator: '操作人', behavior: '库存行为', quantityChange: '变动数量', stockKey: '库存键',
        },
      }),
      listAll: async () => effectiveRecords,
      update: async (key, id, values) => { calls.push({ type: 'update', key, id, values }); },
      createBatch: async (key, rows) => {
        calls.push({ type: 'ledger', key, rows });
        return rows.map((row, index) => ({ recordId: `ledger_${index}` }));
      },
    },
    sizeReferences: {
      resolveLinkedCell: async (cell) => {
        const id = Array.isArray(cell) ? cell[0] : cell;
        const recordId = typeof id === 'object' ? (id?.record_ids || [])[0] : id;
        const matched = String(recordId || '').match(/^size(\d+)$/);
        if (!matched) throw new Error('size missing');
        return { recordId, size: Number(matched[1]) };
      },
    },
    candidatesFromLiveRecords: async () => counts,
    applyChange: async (input) => { calls.push({ type: 'change', ...input }); },
    resolveStockBehavior: async (code) => ({ recordId: `behavior_${code}` }),
  };
};

test('AC-PAIR-1 目标数量与当前一致 ⇒ 不写任何库存', async () => {
  const inventory = fakeInventory({
    counts: [{ size: 42, doorBoxCount: 1, sampleCount: 1 }],
    records: [
      { record_id: 'l1', fields: { 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: ['size42'] }], 所属状态: '门盒' } },
      { record_id: 'l2', fields: { 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: ['size42'] }], 所属状态: '样品' } },
    ],
  });
  const service = new InventoryPairAdjustmentService({ inventory });
  const result = await service.adjustPairs({
    productRecordId: 'p1', requestId: 'req',
    rows: [{ size: 42, state: '门盒', quantity: 1 }, { size: 42, state: '样品', quantity: 1 }],
  });
  assert.equal(result.changed, 0);
  assert.equal(inventory.calls.length, 0);
});

test('AC-PAIR-1b 总数不变、只改样品→门盒：原地改状态，不增删库存', async () => {
  const inventory = fakeInventory({
    counts: [{ size: 42, doorBoxCount: 1, sampleCount: 1 }],
    records: [
      { record_id: 'l1', fields: { 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: ['size42'] }], 所属状态: '门盒' } },
      { record_id: 'l2', fields: { 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: ['size42'] }], 所属状态: '样品' } },
    ],
  });
  const service = new InventoryPairAdjustmentService({ inventory });
  const result = await service.adjustPairs({
    productRecordId: 'p1', requestId: 'req',
    rows: [{ size: 42, state: '门盒', quantity: 2 }],
  });
  assert.equal(result.changed, 1);
  assert.equal(inventory.calls.filter((call) => call.type === 'change').length, 0, '不调用 applyChange');
  assert.deepEqual(inventory.calls.filter((call) => call.type === 'update').map((call) => [call.id, call.values.state]), [['l2', '门盒']]);
  const ledger = inventory.calls.find((call) => call.type === 'ledger');
  assert.ok(ledger, '状态调整必须写库存流水');
  assert.deepEqual(ledger.rows[0].behavior, ['behavior_STOCK_TO_DOORBOX']);
});

test('AC-PAIR-1c 状态为空的行也能原地改成门盒', async () => {
  const inventory = fakeInventory({
    counts: [{ size: 42, doorBoxCount: 0, sampleCount: 0 }],
    records: [
      { record_id: 'l1', fields: { 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: ['size42'] }], 所属状态: [] } },
    ],
  });
  const service = new InventoryPairAdjustmentService({ inventory });
  const result = await service.adjustPairs({
    productRecordId: 'p1', requestId: 'req',
    rows: [{ size: 42, state: '门盒', quantity: 1 }],
  });
  assert.equal(result.changed, 1);
  assert.deepEqual(inventory.calls.filter((call) => call.type === 'update').map((call) => [call.id, call.values.state]), [['l1', '门盒']]);
  const ledger = inventory.calls.find((call) => call.type === 'ledger');
  assert.ok(ledger, '空状态改成门盒也要写库存流水');
  assert.deepEqual(ledger.rows[0].behavior, ['behavior_STOCK_TO_DOORBOX']);
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
  const changes = inventory.calls.filter((call) => call.type === 'change');
  assert.deepEqual(changes.map((call) => [call.size, call.kind, call.quantity]).sort(), [
    [43, 'STOCK_MANUAL_DECREASE', 1],
    [44, 'STOCK_MANUAL_INCREASE', 1],
  ].sort());
  const increase = changes.find((call) => call.size === 44);
  assert.equal(increase.state, '门盒', '新增行必须用用户选择的状态');
  assert.equal(increase.statePolicy, 'explicit', '人工调整不套自动入库规则');
  assert.ok(result.changed >= 2, '数量调整后还会补状态标签');
});

test('AC-PAIR-3b 批量库存：season=false 写 STOCK_FREEZE 流水', async () => {
  const inventory = fakeInventory({
    records: [
      { record_id: 'l1', fields: { 品类: '休闲鞋', 当季: true, 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: ['size42'] }] } },
    ],
  });
  const service = new InventoryPairAdjustmentService({ inventory });
  const result = await service.setSeason({ category: '休闲鞋', season: false });
  assert.equal(result.updated, 1);
  const ledger = inventory.calls.find((call) => call.type === 'ledger');
  assert.ok(ledger);
  assert.deepEqual(ledger.rows[0].behavior, ['behavior_STOCK_FREEZE']);
});

test('AC-PAIR-3 批量当季：只更新当前品类的实时库存', async () => {
  const records = [
    { record_id: 'l1', fields: { 品类: '休闲鞋', 当季: false, 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: ['size42'] }] } },
    { record_id: 'l2', fields: { 品类: '休闲鞋', 当季: true, 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: ['size42'] }] } },
    { record_id: 'l3', fields: { 品类: '单鞋', 当季: false, 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: ['size42'] }] } },
  ];
  const inventory = fakeInventory({ records });
  const service = new InventoryPairAdjustmentService({ inventory });
  const result = await service.setSeason({ category: '休闲鞋', season: true });
  assert.equal(result.updated, 1);
  assert.ok(inventory.calls.some((call) => call.type === 'update' && call.id === 'l1'));
  assert.ok(!inventory.calls.some((call) => call.id === 'l2'));
  assert.ok(!inventory.calls.some((call) => call.id === 'l3'));
  const ledger = inventory.calls.find((call) => call.type === 'ledger');
  assert.ok(ledger, '当季调整必须写库存流水');
  assert.equal(ledger.rows.length, 1);
  assert.deepEqual(ledger.rows[0].behavior, ['behavior_STOCK_RELEASE']);
  assert.equal(ledger.rows[0].quantityChange, 0);
});
