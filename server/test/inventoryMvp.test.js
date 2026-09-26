const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { InventoryService } = require('../src/services/inventoryService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const behavior = (recordId, name, direction) => ({ record_id: recordId,
  fields: { 行为名称: name, 库存方向: direction, 是否启用: true } });

const gatewayFor = (live, behaviors = [
  behavior('behavior_sale', '销售减少', '减少'),
  behavior('behavior_purchase', '采购增加', '增加'),
]) => {
  const records = new Map([['liveInventory', live], ['behavior', behaviors]]);
  let seq = 0;
  return { records, table: (key) => V1_BITABLE_SCHEMA.tables[key], validateTables: async () => [],
    listAll: async (key) => records.get(key) || [],
    create: async (key, values) => {
      const recordId = `rec_${++seq}`;
      const fields = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)
        .map(([name, value]) => [V1_BITABLE_SCHEMA.tables[key].fields[name], value]));
      if (!records.has(key)) records.set(key, []);
      records.get(key).push({ record_id: recordId, fields });
      return { recordId };
    },
    delete: async (key, id) => records.set(key, records.get(key).filter((row) => row.record_id !== id)),
    get: async (key, id) => (records.get(key) || []).find((row) => row.record_id === id),
    update: async (key, id, values) => {
      const record = (records.get(key) || []).find((row) => row.record_id === id);
      Object.assign(record.fields, Object.fromEntries(Object.entries(values)
        .map(([name, value]) => [V1_BITABLE_SCHEMA.tables[key].fields[name], value])));
      return record;
    },
  };
};
const store = () => new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-mvp-')), idField: 'operation_id' });
const unit = (id, state) => ({ record_id: id, fields: { 编号: ['product_1'], 尺码: 38, 所属状态: state } });

test('sale deducts one matching door-box unit, preserves sample, and is idempotent', async () => {
  const gateway = gatewayFor([unit('door_1', '门盒'), unit('door_2', '门盒'), unit('sample_1', '样品')]);
  const inventory = new InventoryService({ gateway, store: store() });
  const request = { salesDetailRecordId: 'detail_1', productRecordId: 'product_1', size: 38, quantity: 1, state: '门盒' };
  await inventory.applySale(request);
  await inventory.applySale(request);
  assert.deepEqual(gateway.records.get('liveInventory').map((row) => row.record_id).sort(), ['door_2', 'sample_1']);
  assert.equal(gateway.records.get('inventoryLedger').length, 1);
  assert.deepEqual(gateway.records.get('inventoryLedger')[0].fields, {
    编号: ['product_1'], 尺码: 38, 变动数量: 1,
    库存行为: ['behavior_sale'], 关联销售: ['detail_1'],
  });
});

test('sale matches live inventory when Feishu returns product links as record_ids', async () => {
  const linked = [{ record_ids: ['product_1'], text: '6681-1|黑灰|A', type: 'text' }];
  const gateway = gatewayFor([
    { record_id: 'sample_42', fields: { 编号: linked, 尺码: '42', 所属状态: ['样品'] } },
    { record_id: 'door_44', fields: { 编号: linked, 尺码: '44', 所属状态: ['门盒'] } },
  ]);
  const inventory = new InventoryService({ gateway, store: store() });
  const result = await inventory.applySale({ salesDetailRecordId: 'detail_42',
    productRecordId: 'product_1', size: 42, quantity: 1 });
  assert.deepEqual(result.liveRecordIds, ['sample_42']);
  assert.equal(result.sampleConsumedQuantity, 1);
  assert.deepEqual(result.remainingSizes, [
    { size: 44, doorBoxCount: 1, sampleCount: 0, warehouseCount: 0 },
  ]);
});

test('purchase adds one live record per pair', async () => {
  const gateway = gatewayFor([]);
  const inventory = new InventoryService({ gateway, store: store() });
  await inventory.applyPurchase({ purchaseInboundRecordId: 'inbound_1', productRecordId: 'product_1', size: 38,
    quantity: 2, state: '仓库' });
  assert.equal(gateway.records.get('liveInventory').length, 2);
  assert.ok(gateway.records.get('liveInventory').every((row) => row.fields['所属状态'] === '仓库'));
  assert.deepEqual(gateway.records.get('inventoryLedger')[0].fields, {
    编号: ['product_1'], 尺码: 38, 变动数量: 2,
    库存行为: ['behavior_purchase'], 关联采购: ['inbound_1'],
  });
  assert.ok(gateway.records.get('liveInventory').every((row) => !Object.hasOwn(row.fields, '更新时间')));
});

test('a missing or opposite behavior direction never writes stock records', async () => {
  for (const direction of [null, '增加']) {
    const gateway = gatewayFor([unit('door_1', '门盒')], [behavior('behavior_sale', '销售减少', direction)]);
    const inventory = new InventoryService({ gateway, store: store() });
    await assert.rejects(inventory.applySale({ salesDetailRecordId: 'detail_1', productRecordId: 'product_1',
      size: 38, quantity: 1 }), /库存方向设置为“减少”/);
    assert.equal(gateway.records.get('inventoryLedger'), undefined);
    assert.equal(gateway.records.get('liveInventory').length, 1);
  }
});

test('inventory preflight checks both sale and purchase behavior settings', async () => {
  const gateway = gatewayFor([], [
    behavior('behavior_sale', '销售减少', '减少'),
    { ...behavior('behavior_purchase', '采购增加', '增加'), fields: {
      行为名称: '采购增加', 库存方向: '增加', 是否启用: false,
    } },
  ]);
  const inventory = new InventoryService({ gateway, store: store() });
  await assert.rejects(inventory.validateStockBehaviors(), /请启用行为管理中的“采购增加”/);
  assert.equal(gateway.records.get('inventoryLedger'), undefined);
});

test('sale consumes a sample only after door-box stock is exhausted and reports remaining sizes', async () => {
  const gateway = gatewayFor([
    unit('sample_1', '样品'),
    { record_id: 'door_40', fields: { 编号: ['product_1'], 尺码: 40, 所属状态: '门盒' } },
    { record_id: 'warehouse_41', fields: { 编号: ['product_1'], 尺码: 41, 所属状态: '仓库' } },
  ]);
  const inventory = new InventoryService({ gateway, store: store() });
  const request = { salesDetailRecordId: 'detail_1', productRecordId: 'product_1', size: 38, quantity: 1 };
  const result = await inventory.applySale(request);
  assert.deepEqual(result.liveRecordIds, ['sample_1']);
  assert.equal(result.sampleConsumedQuantity, 1);
  assert.deepEqual(result.remainingSizes, [
    { size: 40, doorBoxCount: 1, sampleCount: 0, warehouseCount: 0 },
    { size: 41, doorBoxCount: 0, sampleCount: 0, warehouseCount: 1 },
  ]);
  await inventory.applySale(request);
  assert.equal(gateway.records.get('inventoryLedger').length, 1);
  assert.deepEqual(gateway.records.get('liveInventory').map((row) => row.record_id), ['door_40', 'warehouse_41']);
});

test('a sale never consumes warehouse stock and does not write a ledger when total floor stock is short', async () => {
  const gateway = gatewayFor([unit('sample_1', '样品'), unit('warehouse_1', '仓库')]);
  const inventory = new InventoryService({ gateway, store: store() });
  await assert.rejects(inventory.applySale({ salesDetailRecordId: 'detail_1', productRecordId: 'product_1',
    size: 38, quantity: 2 }), /门盒和样品库存不足/);
  assert.equal(gateway.records.get('inventoryLedger'), undefined);
  assert.equal(gateway.records.get('liveInventory').length, 2);
});

test('sample replacement moves one selected door-box pair without changing total quantity and is idempotent', async () => {
  const gateway = gatewayFor([
    { record_id: 'door_40', fields: { 编号: ['product_1'], 尺码: 40, 所属状态: '门盒' } },
    { record_id: 'door_41', fields: { 编号: ['product_1'], 尺码: 41, 所属状态: '门盒' } },
  ], [behavior('behavior_sample', '门盒转样品', '不影响')]);
  const inventory = new InventoryService({ gateway, store: store() });
  const request = { salesDetailRecordId: 'detail_sold_sample', productRecordId: 'product_1', size: 40 };
  const first = await inventory.promoteToSample(request);
  const again = await inventory.promoteToSample(request);
  assert.deepEqual(again, first);
  assert.equal(gateway.records.get('liveInventory').length, 2);
  assert.equal(gateway.records.get('liveInventory')[0].fields['所属状态'], '样品');
  assert.equal(gateway.records.get('liveInventory')[1].fields['所属状态'], '门盒');
  assert.equal(gateway.records.get('inventoryLedger').length, 1);
  assert.deepEqual(gateway.records.get('inventoryLedger')[0].fields, {
    编号: ['product_1'], 尺码: 40, 变动数量: 0,
    库存行为: ['behavior_sample'], 关联销售: ['detail_sold_sample'],
  });
  await assert.rejects(inventory.promoteToSample({ ...request, size: 41 }), /已选择其他补样品尺码/);
});

test('sample replacement refuses an unconfigured behavior before writing records', async () => {
  const gateway = gatewayFor([unit('door_1', '门盒')], [behavior('behavior_sample', '门盒转样品', null)]);
  const inventory = new InventoryService({ gateway, store: store() });
  await assert.rejects(inventory.promoteToSample({ salesDetailRecordId: 'detail_1',
    productRecordId: 'product_1', size: 38 }), /库存方向设置为“不影响”/);
  assert.equal(gateway.records.get('inventoryLedger'), undefined);
  assert.equal(gateway.records.get('liveInventory')[0].fields['所属状态'], '门盒');
});
