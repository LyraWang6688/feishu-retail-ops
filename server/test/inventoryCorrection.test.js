'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { InventoryService } = require('../src/services/inventoryService');

test('库存尺码更正：现货→现货只对调一条实时库存行 + 原流水尺码', async () => {
  const writes = [];
  const gateway = {
    table: (key) => ({
      liveInventory: { fields: { size: '尺码' } },
      inventoryLedger: { fields: { size: '尺码' } },
    }[key]),
    get: async () => ({ record_id: 'ledger_1', fields: {} }),
    update: async (key, id, values) => { writes.push({ key, id, values }); },
    delete: async () => undefined,
  };
  const service = new InventoryService({ gateway });
  service.sizeReferences = { resolveByNumber: async (size) => ({ recordId: 'size_' + size }) };
  service.ensureSchema = async () => {};
  service.resolveStockBehavior = async () => ({ recordId: 'behavior_sale' });
  service.findOperationBySource = async () => ({ ledger_record_id: 'ledger_1' });
  service.readLiveInventoryForProduct = async () => [{
    record_id: 'live_43', fields: { 尺码: [{ record_ids: ['size_43'] }] },
  }];
  service.sortLiveInventoryForConsumption = (rows) => rows;
  service.runForStocks = async (keys, work) => work();

  const result = await service.correctSaleDetailSize({
    salesDetailRecordId: 'detail_1',
    salesEntryRecordId: 'sale_1',
    productRecordId: 'prod_1',
    fromSize: 42,
    toSize: 43,
    fromInStock: true,
    toInStock: true,
    correctionId: 'correction_1',
  });
  assert.deepEqual(result, { inventory: 'row_swapped', ledger: 'updated' });
  assert.ok(writes.some((write) => write.key === 'liveInventory' && write.id === 'live_43'
    && JSON.stringify(write.values) === JSON.stringify({ size: ['size_42'] })));
  assert.ok(writes.some((write) => write.key === 'inventoryLedger' && write.id === 'ledger_1'
    && JSON.stringify(write.values) === JSON.stringify({ size: ['size_43'] })));
});
