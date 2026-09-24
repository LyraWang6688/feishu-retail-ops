const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { InventoryService } = require('../src/services/inventoryService');

const TABLES = {
  inventoryLedger: { fields: {
    product: '编号', size: '尺码', quantityChange: '数量变化', salesDetail: '关联销售明细',
    purchaseInbound: '关联采购入库', occurredAt: '发生时间',
  } },
  liveInventory: { fields: {
    stockKey: '库存键', product: '编号', size: '尺码', quantity: '数量', updatedAt: '更新时间',
  } },
};

const mapFields = (tableKey, semanticFields) => Object.fromEntries(
  Object.entries(semanticFields).map(([key, value]) => [TABLES[tableKey].fields[key] || key, value])
);

const makeGateway = (liveRecords = [], options = {}) => {
  const calls = [];
  const records = new Map([['liveInventory', liveRecords]]);
  const failed = new Set();
  let serial = 0;
  return {
    calls,
    records,
    table: (key) => TABLES[key],
    create: async (tableKey, fields) => {
      const recordId = `rec_${tableKey}_${++serial}`;
      calls.push({ operation: 'create', tableKey, fields, recordId });
      if (!records.has(tableKey)) records.set(tableKey, []);
      records.get(tableKey).push({ record_id: recordId, fields: mapFields(tableKey, fields) });
      return { recordId };
    },
    update: async (tableKey, recordId, fields) => {
      calls.push({ operation: 'update', tableKey, recordId, fields });
      const record = records.get(tableKey).find((item) => item.record_id === recordId);
      Object.assign(record.fields, mapFields(tableKey, fields));
      if (options.failOnceAfterUpdate === tableKey && !failed.has(tableKey)) {
        failed.add(tableKey);
        throw new Error(`simulated response loss after ${tableKey} update`);
      }
      return record;
    },
    listAll: async (tableKey) => records.get(tableKey) || [],
  };
};

const makeStore = () => new JsonTaskStore({
  dir: fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-test-')),
  idField: 'operation_id',
});

test('sale creates a negative ledger row and decreases matching live inventory', async () => {
  const gateway = makeGateway([
    { record_id: 'live_1', fields: { 编号: ['product_1'], 尺码: 38, 数量: 5, 库存键: 'P1|38' } },
  ]);
  const service = new InventoryService({ gateway, store: makeStore() });
  const result = await service.applySale({
    salesDetailRecordId: 'sale_detail_1', productRecordId: 'product_1', size: 38, quantity: 1, occurredAt: 1000,
  });
  assert.equal(result.quantity, 4);
  assert.equal(gateway.records.get('inventoryLedger')[0].fields['数量变化'], -1);
  assert.deepEqual(gateway.records.get('inventoryLedger')[0].fields['关联销售明细'], ['sale_detail_1']);
  assert.equal(gateway.records.get('liveInventory')[0].fields['数量'], 4);
});

test('purchase creates live inventory when product and size do not exist', async () => {
  const gateway = makeGateway();
  const service = new InventoryService({ gateway, store: makeStore() });
  const result = await service.applyPurchase({
    purchaseInboundRecordId: 'purchase_detail_1', productRecordId: 'product_2', size: 39, quantity: 2,
  });
  assert.equal(result.quantity, 2);
  assert.equal(gateway.records.get('liveInventory')[0].fields['数量'], 2);
  assert.deepEqual(gateway.records.get('inventoryLedger')[0].fields['关联采购入库'], ['purchase_detail_1']);
});

test('sale does not create negative live inventory when stock key is missing', async () => {
  const service = new InventoryService({ gateway: makeGateway(), store: makeStore() });
  await assert.rejects(() => service.applySale({
    salesDetailRecordId: 'sale_detail_1', productRecordId: 'product_1', size: 38, quantity: 1,
  }), /不能执行销售扣减/);
});

test('retry does not create a second ledger row or apply quantity twice', async () => {
  const gateway = makeGateway([
    { record_id: 'live_1', fields: { 编号: ['product_1'], 尺码: 38, 数量: 5, 库存键: 'P1|38' } },
  ]);
  const service = new InventoryService({ gateway, store: makeStore() });
  const input = { salesDetailRecordId: 'sale_detail_1', productRecordId: 'product_1', size: 38, quantity: 1 };
  await service.applySale(input);
  await service.applySale(input);
  assert.equal(gateway.records.get('inventoryLedger').length, 1);
  assert.equal(gateway.records.get('liveInventory')[0].fields['数量'], 4);
});

test('retry recovers when live inventory update committed but its response was lost', async () => {
  const gateway = makeGateway(
    [{ record_id: 'live_1', fields: { 编号: ['product_1'], 尺码: 38, 数量: 5 } }],
    { failOnceAfterUpdate: 'liveInventory' }
  );
  const service = new InventoryService({ gateway, store: makeStore() });
  const input = { salesDetailRecordId: 'sale_detail_1', productRecordId: 'product_1', size: 38, quantity: 1 };

  await assert.rejects(() => service.applySale(input), /simulated response loss/);
  const result = await service.applySale(input);

  assert.equal(result.quantity, 4);
  assert.equal(gateway.records.get('inventoryLedger').length, 1);
  assert.equal(gateway.records.get('liveInventory')[0].fields['数量'], 4);
});

test('duplicate live inventory keys are rejected', async () => {
  const gateway = makeGateway([
    { record_id: 'live_1', fields: { 编号: ['product_1'], 尺码: 38, 数量: 5 } },
    { record_id: 'live_2', fields: { 编号: ['product_1'], 尺码: 38, 数量: 1 } },
  ]);
  const service = new InventoryService({ gateway, store: makeStore() });
  await assert.rejects(() => service.applyPurchase({
    purchaseInboundRecordId: 'purchase_detail_1', productRecordId: 'product_1', size: 38, quantity: 1,
  }), /重复库存键/);
});
