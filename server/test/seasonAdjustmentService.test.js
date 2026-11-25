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
  const mapLive = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [V1_BITABLE_SCHEMA.tables.liveInventory.fields[key] || key, value]));
  const mapLedger = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [V1_BITABLE_SCHEMA.tables.inventoryLedger.fields[key] || key, value]));
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async () => live,
    get: async (table, id) => live.find((row) => row.record_id === id) || null,
    update: async (table, id, values) => { Object.assign(live.find((row) => row.record_id === id).fields, mapLive(values)); },
    updateBatch: async (table, updates) => { for (const update of updates) Object.assign(live.find((row) => row.record_id === update.recordId).fields, mapLive(update.values)); },
    create: async (table, values) => {
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
  return { service: createSeasonAdjustmentService({ inventory, store }), live, ledger };
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

test('当季扫码调整：流水失败后重试只补流水，不重复改当季', async () => {
  const { service, live, ledger } = make({ failLedgerOnce: true });
  const changes = [{ productRecordId: 'p1', size: 39, state: '门盒', currentSeason: false, quantity: 2 }];
  await assert.rejects(() => service.submit({ requestId: 'req_2', operatorOpenId: 'ou_a', changes }), /ledger down/);
  assert.equal(live.find((row) => row.record_id === 'l1').fields['当季'], true);
  const again = await service.execute(service.operationIdOf('req_2'));
  assert.equal(again.ok, true);
  assert.equal(ledger.length, 2);
});
