const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { InventoryService } = require('../src/services/inventoryService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const gatewayFor = (live) => {
  const records = new Map([['liveInventory', live]]);
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
  assert.equal(gateway.records.get('inventoryLedger')[0].fields['数量变化'], -1);
});

test('purchase adds one live record per pair', async () => {
  const gateway = gatewayFor([]);
  const inventory = new InventoryService({ gateway, store: store() });
  await inventory.applyPurchase({ purchaseInboundRecordId: 'inbound_1', productRecordId: 'product_1', size: 38,
    quantity: 2, state: '仓库' });
  assert.equal(gateway.records.get('liveInventory').length, 2);
  assert.ok(gateway.records.get('liveInventory').every((row) => row.fields['所属状态'] === '仓库'));
});
