const test = require('node:test');
const assert = require('node:assert/strict');
const { V1PostingService } = require('../src/services/v1PostingService');
const { PurchasePostingService } = require('../src/services/purchasePostingService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

test('posting facade routes sales and purchase to separate owners', async () => {
  const calls = [];
  const posting = new V1PostingService({ gateway: {}, references: {},
    sales: { confirm: async (input) => { calls.push(['sales', input]); return 'sale-result'; } },
    purchase: { post: async (input) => { calls.push(['purchase', input]); return 'purchase-result'; } },
  });
  assert.equal(await posting.postSale({ id: 's1' }), 'sale-result');
  assert.equal(await posting.postPurchase({ id: 'p1' }), 'purchase-result');
  assert.deepEqual(calls, [['sales', { id: 's1' }], ['purchase', { id: 'p1' }]]);
});

test('purchase posting reaches stock only through applyPurchase after inbound creation', async () => {
  const batch = { record_id: 'batch_1', fields: { 到货批次号: 'DH-001' } };
  const records = new Map([['purchaseBatch', [batch]]]);
  const calls = [];
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    validateTables: async () => [],
    listAll: async (key) => records.get(key) || [],
    get: async (key, id) => (records.get(key) || []).find((row) => row.record_id === id),
    update: async (key, id, values) => {
      const row = (records.get(key) || []).find((record) => record.record_id === id);
      Object.assign(row.fields, Object.fromEntries(Object.entries(values).map(([name, value]) =>
        [V1_BITABLE_SCHEMA.tables[key].fields[name], value])));
      return row;
    },
    create: async (key, values) => {
      const recordId = 'inbound_1';
      const fields = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)
        .map(([name, value]) => [V1_BITABLE_SCHEMA.tables[key].fields[name], value]));
      if (!records.has(key)) records.set(key, []);
      records.get(key).push({ record_id: recordId, fields });
      calls.push('inbound-created');
      return { recordId };
    },
  };
  const purchase = new PurchasePostingService({ gateway,
    references: { resolveProduct: async () => ({ recordId: 'product_1' }) },
    inventory: { applyPurchase: async (input) => { calls.push(['inventory', input]); return {}; } },
    enablePurchaseInventory: true,
  });
  const result = await purchase.post({ batchRecordId: 'batch_1', supplierRecordId: 'supplier_1',
    items: [{ itemNo: 'A100', size: 38, quantity: 2 }] });
  assert.equal(result.inventoryApplied, true);
  assert.equal(records.get('purchaseInbound').length, 1);
  assert.equal(calls[0], 'inbound-created');
  assert.equal(calls[1][0], 'inventory');
  assert.equal(calls[1][1].purchaseInboundRecordId, 'inbound_1');
  assert.equal(records.get('salesDetail'), undefined);
  assert.equal(records.get('paymentRecord'), undefined);
});
