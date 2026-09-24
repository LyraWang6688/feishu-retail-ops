const test = require('node:test');
const assert = require('node:assert/strict');
const { V1PostingService, allocatePaidAmounts } = require('../src/services/v1PostingService');

const TABLES = {
  salesEntry: { fields: { orderNo: '销售单号' } },
  purchaseBatch: { fields: { batchNo: '到货批次号' } },
  salesDetail: {
    fields: {
      product: '编号', quantity: '数量', size: '尺码', paidAmount: '实付金额', gift: '赠品',
      paymentMethod: '支付方式', salesEntry: '销售单号', behavior: '销售行为',
    },
  },
  purchaseInbound: {
    fields: { product: '编号', quantity: '数量', size: '尺码', batch: '采购到货批次', unitCost: '入库单价' },
  },
};

const mapFields = (tableKey, semanticFields) => Object.fromEntries(
  Object.entries(semanticFields).map(([key, value]) => [TABLES[tableKey]?.fields?.[key] || key, value])
);

const makeGateway = () => {
  const calls = [];
  const records = new Map();
  let serial = 0;
  return {
    calls,
    records,
    table: (key) => TABLES[key] || { fields: {} },
    get: async (tableKey, recordId) => ({
      record_id: recordId,
      fields: tableKey === 'salesEntry' ? { 销售单号: 'XS-001' } : { 到货批次号: 'DH-001' },
    }),
    create: async (tableKey, fields) => {
      const recordId = `rec_${tableKey}_${++serial}`;
      calls.push({ operation: 'create', tableKey, fields, recordId });
      if (!records.has(tableKey)) records.set(tableKey, []);
      records.get(tableKey).push({ record_id: recordId, fields: mapFields(tableKey, fields) });
      return { recordId };
    },
    update: async (tableKey, recordId, fields) => {
      calls.push({ operation: 'update', tableKey, recordId, fields });
      return { record_id: recordId };
    },
    listAll: async (tableKey) => records.get(tableKey) || [],
  };
};

const makeReferences = () => ({
  resolveProduct: async (item) => ({ recordId: `product_${item.itemNo || item.productNumber}` }),
  resolveBehavior: async (code) => ({ recordId: `behavior_${code}` }),
  resolvePaymentMethod: async (name) => (name ? { recordId: `pay_${name}` } : null),
});

test('sale confirmation writes sales detail without requiring inventory or money tables', async () => {
  const gateway = makeGateway();
  const service = new V1PostingService({ gateway, references: makeReferences(), inventory: {} });
  const result = await service.postSale({
    salesEntryRecordId: 'rec_sale_entry', paymentMethod: '微信', totalPaid: 230,
    items: [{ productNumber: '8088-26棕', size: 38, quantity: 1, gift: true }],
  });
  assert.equal(result.inventoryApplied, false);
  assert.equal(result.detailRecordIds.length, 1);
  assert.equal(gateway.calls.some((call) => call.tableKey === 'salesDetail' && call.operation === 'create'), true);
  assert.equal(gateway.calls.some((call) => call.tableKey === 'inventoryLedger'), false);
});

test('sales inventory integration receives the created detail as its idempotent source', async () => {
  const gateway = makeGateway();
  const inventoryCalls = [];
  const service = new V1PostingService({
    gateway,
    references: makeReferences(),
    inventory: { applySale: async (input) => (inventoryCalls.push(input), { quantity: 4 }) },
    enableSalesInventory: true,
  });
  const result = await service.postSale({
    salesEntryRecordId: 'rec_sale_entry', paymentMethod: '微信', totalPaid: 230,
    items: [{ productNumber: '8088-26棕', size: 38, quantity: 1 }],
  });
  assert.equal(result.inventoryApplied, true);
  assert.equal(inventoryCalls.length, 1);
  assert.equal(inventoryCalls[0].salesDetailRecordId, result.detailRecordIds[0]);
  assert.equal(inventoryCalls[0].productRecordId, 'product_8088-26棕');
});

test('V1 sale posting still rejects more than one sales detail', async () => {
  const service = new V1PostingService({ gateway: makeGateway(), references: makeReferences(), inventory: {} });
  await assert.rejects(() => service.postSale({
    salesEntryRecordId: 'rec_sale_entry', paymentMethod: '现金', totalPaid: 200,
    items: [
      { productNumber: 'A100', size: 38, quantity: 1 },
      { productNumber: 'A100', size: 38, quantity: 1 },
    ],
  }), /只能包含一条商品明细/);
});

test('purchase confirmation writes inbound detail without requiring money or payable tables', async () => {
  const gateway = makeGateway();
  const service = new V1PostingService({ gateway, references: makeReferences(), inventory: {} });
  const result = await service.postPurchase({
    batchRecordId: 'rec_batch', supplierRecordId: 'rec_supplier', operatorOpenId: 'ou_user',
    items: [{ itemNo: 'A100', size: 38, quantity: 2, unitCost: 60 }],
    payment: { amount: 100, method: '微信' },
  });
  assert.equal(result.inventoryApplied, false);
  assert.equal(result.inboundRecordIds.length, 1);
  assert.equal(gateway.calls.some((call) => call.tableKey === 'purchaseInbound' && call.operation === 'create'), true);
});

test('purchase inventory integration receives each created inbound detail', async () => {
  const gateway = makeGateway();
  const inventoryCalls = [];
  const service = new V1PostingService({
    gateway,
    references: makeReferences(),
    inventory: { applyPurchase: async (input) => (inventoryCalls.push(input), { quantity: 2 }) },
    enablePurchaseInventory: true,
  });
  const result = await service.postPurchase({
    batchRecordId: 'rec_batch', supplierRecordId: 'rec_supplier',
    items: [{ itemNo: 'A100', size: 38, quantity: 2, unitCost: 60 }],
  });
  assert.equal(result.inventoryApplied, true);
  assert.equal(inventoryCalls[0].purchaseInboundRecordId, result.inboundRecordIds[0]);
});

test('payment allocation keeps cent totals exact', () => {
  const items = allocatePaidAmounts([
    { quantity: 1, unitPrice: 100 },
    { quantity: 1, unitPrice: 200 },
  ], 299.99);
  assert.equal(items.reduce((sum, item) => sum + item.paidAmount, 0), 299.99);
});
