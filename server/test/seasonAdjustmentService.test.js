'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { createSeasonAdjustmentService } = require('../src/services/seasonAdjustmentService');

const make = ({ failLedgerOnce = false } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'season-adjust-'));
  const store = new JsonTaskStore({ dir, idField: 'operation_id' });
  const live = [
    { record_id: 'l1', fields: { 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: ['s39'] }], 所属状态: '门盒', 当季: false } },
    { record_id: 'l2', fields: { 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: ['s39'] }], 所属状态: '门盒', 当季: false } },
    { record_id: 'l3', fields: { 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: ['s40'] }], 所属状态: '样品', 当季: true } },
  ];
  let ledgerFail = failLedgerOnce;
  const ledger = [];
  const ledgerTokens = [];
  const mapLive = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [V1_BITABLE_SCHEMA.tables.liveInventory.fields[key] || key, value]));
  const mapLedger = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [V1_BITABLE_SCHEMA.tables.inventoryLedger.fields[key] || key, value]));
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async () => live,
    get: async (table, id) => live.find((row) => row.record_id === id) || null,
    update: async (table, id, values) => { Object.assign(live.find((row) => row.record_id === id).fields, mapLive(values)); },
    updateBatch: async (table, updates) => { for (const update of updates) Object.assign(live.find((row) => row.record_id === update.recordId).fields, mapLive(update.values)); },
    create: async (table, values, options = {}) => {
      if (table === 'inventoryLedger') ledgerTokens.push(options.clientToken);
      if (table === 'inventoryLedger' && ledgerFail) { ledgerFail = false; throw new Error('ledger down'); }
      const id = 'ledger_' + (ledger.length + 1);
      ledger.push({ record_id: id, fields: mapLedger(values) });
      return { recordId: id };
    },
  };
  const inventory = {
    gateway,
    sizeReferences: { resolveByNumber: async (size) => ({ recordId: 's' + size }) },
    resolveStockBehavior: async (code) => ({ recordId: 'b_' + code }),
    readLiveInventoryForProduct: async () => live,
  };
  return { service: createSeasonAdjustmentService({ inventory, store }), live, ledger, ledgerTokens };
};

test('当季扫码调整：只改当季/仓库员，写转释放和转冻结流水', async () => {
  const { service, live, ledger } = make();
  const result = await service.submit({
    requestId: 'req_1', operatorOpenId: 'ou_a',
    changes: [
      { productRecordId: 'p1', size: 39, state: '门盒', currentSeason: false, quantity: 2 },
      { productRecordId: 'p1', size: 40, state: '样品', currentSeason: true, quantity: 1 },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(live.find((row) => row.record_id === 'l1').fields['当季'], true);
  assert.equal(live.find((row) => row.record_id === 'l1').fields['仓库员'][0].id, 'ou_a');
  assert.equal(live.find((row) => row.record_id === 'l2').fields['所属状态'], '门盒');
  assert.equal(live.find((row) => row.record_id === 'l3').fields['当季'], false);
  assert.deepEqual(ledger.map((row) => row.fields['库存行为']), [
    ['b_STOCK_RELEASE'], ['b_STOCK_RELEASE'], ['b_STOCK_FREEZE'],
  ]);
  assert.ok(ledger.every((row) => row.fields['变动数量'] === 0));
});

test('AC-SEASON-BLANK 空值行（没勾过「当季」）按非当季匹配，能翻成当季', async () => {
  const { service, live, ledger } = make();
  // 真表现状：334 条行的「当季」是**空**（null），不是 false。
  live.push({ record_id: 'l4', fields: { 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: ['s41'] }], 所属状态: '门盒' } });
  assert.equal(live.find((row) => row.record_id === 'l4').fields['当季'], undefined, '夹具必须是空值，不是 false');
  const result = await service.submit({
    requestId: 'req_blank', operatorOpenId: 'ou_a',
    changes: [{ productRecordId: 'p1', size: 41, state: '门盒', currentSeason: false, quantity: 1 }],
  });
  assert.equal(result.ok, true, '空值行必须能调（改前报 stock_shortage）');
  assert.equal(live.find((row) => row.record_id === 'l4').fields['当季'], true);
  assert.equal(ledger.filter((row) => row.fields['库存行为'][0] === 'b_STOCK_RELEASE').length, 1);
});

test('AC-SEASON-BLANK-2 当季=true 的行不会被「非当季」的提交误伤', async () => {
  const { service, live } = make();
  // 一条空值行（41 门盒）+ 原本就有 l3（40 样品 · 当季=true）
  live.push({ record_id: 'l5', fields: { 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: ['s41'] }], 所属状态: '门盒' } });
  const result = await service.submit({
    requestId: 'req_blank2', operatorOpenId: 'ou_a',
    changes: [{ productRecordId: 'p1', size: 41, state: '门盒', currentSeason: false, quantity: 1 }],
  });
  assert.equal(result.ok, true);
  assert.equal(live.find((row) => row.record_id === 'l5').fields['当季'], true, '空值行被翻成当季');
  assert.equal(live.find((row) => row.record_id === 'l3').fields['当季'], true, '原本 true 的行必须原样');
});

test('当季扫码调整：流水失败后重试只补流水，不重复改当季', async () => {
  const { service, live, ledger, ledgerTokens } = make({ failLedgerOnce: true });
  const changes = [{ productRecordId: 'p1', size: 39, state: '门盒', currentSeason: false, quantity: 2 }];
  await assert.rejects(() => service.submit({ requestId: 'req_2', operatorOpenId: 'ou_a', changes }), /ledger down/);
  assert.equal(live.find((row) => row.record_id === 'l1').fields['当季'], true);
  const again = await service.execute(service.operationIdOf('req_2'));
  assert.equal(again.ok, true);
  assert.equal(ledger.length, 2);
  assert.equal(ledgerTokens[0], ledgerTokens[1], '同一行的重试必须复用同一个 client_token');
});
