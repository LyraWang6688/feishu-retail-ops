const test = require('node:test');
const assert = require('node:assert/strict');
const { V1PostingService, allocatePaidAmounts } = require('../src/services/v1PostingService');

const TABLES = {
  salesEntry: { fields: { orderNo: '销售单号' } },
  purchaseBatch: { fields: { batchNo: '到货批次号' } },
  liveInventory: { fields: { quantity: '数量' } },
};

const makeGateway = () => {
  const calls = [];
  let serial = 0;
  return {
    calls,
    table: (key) => TABLES[key] || { fields: {} },
    get: async (tableKey, recordId) => ({
      record_id: recordId,
      fields: tableKey === 'salesEntry' ? { 销售单号: 'XS-001' } : { 到货批次号: 'DH-001' },
    }),
    create: async (tableKey, fields) => {
      const recordId = `rec_${tableKey}_${++serial}`;
      calls.push({ operation: 'create', tableKey, fields, recordId });
      return { recordId };
    },
    update: async (tableKey, recordId, fields) => {
      calls.push({ operation: 'update', tableKey, recordId, fields });
      return { record_id: recordId };
    },
  };
};

const makeReferences = (liveQuantity = 10) => ({
  resolveProduct: async (item) => ({ recordId: `product_${item.itemNo || item.productNumber}` }),
  resolveBehavior: async (code) => ({ recordId: `behavior_${code}` }),
  resolvePaymentMethod: async (name) => (name ? { recordId: `pay_${name}` } : null),
  findLiveInventory: async (productRecordId, size) => ({
    record_id: `live_${productRecordId}_${size}`,
    fields: { 数量: liveQuantity },
  }),
});

test('sale posting writes detail, negative stock flow, live inventory and money income', async () => {
  const gateway = makeGateway();
  const service = new V1PostingService({ gateway, references: makeReferences(5) });
  const result = await service.postSale({
    salesEntryRecordId: 'rec_sale_entry',
    operatorOpenId: 'ou_user',
    paymentMethod: '微信',
    totalPaid: 190,
    items: [{ itemNo: 'A100', size: 38, quantity: 2, unitPrice: 100, discountAmount: 10 }],
  });

  assert.equal(result.sourceNo, 'XS-001');
  const detail = gateway.calls.find((call) => call.operation === 'create' && call.tableKey === 'salesDetail');
  assert.equal(detail.fields.paidAmount, 190);
  const ledger = gateway.calls.find((call) => call.operation === 'create' && call.tableKey === 'inventoryLedger');
  assert.equal(ledger.fields.quantityChange, -2);
  assert.equal(ledger.fields.beforeQuantity, 5);
  assert.equal(ledger.fields.afterQuantity, 3);
  const live = gateway.calls.find((call) => call.operation === 'update' && call.tableKey === 'liveInventory');
  assert.equal(live.fields.quantity, 3);
  const money = gateway.calls.find((call) => call.operation === 'create' && call.tableKey === 'moneyLedger');
  assert.equal(money.fields.direction, '收入');
  assert.equal(money.fields.amount, 190);
});

test('sale posting rejects insufficient inventory before creating business details', async () => {
  const gateway = makeGateway();
  const service = new V1PostingService({ gateway, references: makeReferences(1) });
  await assert.rejects(
    () =>
      service.postSale({
        salesEntryRecordId: 'rec_sale_entry',
        paymentMethod: '微信',
        items: [{ itemNo: 'A100', size: 38, quantity: 2, unitPrice: 100 }],
      }),
    /库存不足/
  );
  assert.equal(gateway.calls.some((call) => call.operation === 'create'), false);
});

test('duplicate SKU lines consume virtual inventory in sequence', async () => {
  const gateway = makeGateway();
  const service = new V1PostingService({ gateway, references: makeReferences(3) });
  await service.postSale({
    salesEntryRecordId: 'rec_sale_entry',
    paymentMethod: '现金',
    totalPaid: 200,
    items: [
      { itemNo: 'A100', size: 38, quantity: 1, unitPrice: 100 },
      { itemNo: 'A100', size: 38, quantity: 1, unitPrice: 100 },
    ],
  });
  const ledgers = gateway.calls.filter((call) => call.operation === 'create' && call.tableKey === 'inventoryLedger');
  assert.deepEqual(
    ledgers.map((call) => [call.fields.beforeQuantity, call.fields.afterQuantity]),
    [
      [3, 2],
      [2, 1],
    ]
  );
});

test('purchase posting adds inventory and payable but creates no cash flow until paid', async () => {
  const gateway = makeGateway();
  const service = new V1PostingService({ gateway, references: makeReferences(3) });
  const result = await service.postPurchase({
    batchRecordId: 'rec_batch',
    supplierRecordId: 'rec_supplier',
    operatorOpenId: 'ou_user',
    items: [{ itemNo: 'A100', size: 38, quantity: 2, unitCost: 60 }],
  });

  assert.equal(result.sourceNo, 'DH-001');
  const ledger = gateway.calls.find((call) => call.operation === 'create' && call.tableKey === 'inventoryLedger');
  assert.equal(ledger.fields.quantityChange, 2);
  assert.equal(ledger.fields.afterQuantity, 5);
  const payable = gateway.calls.find((call) => call.operation === 'create' && call.tableKey === 'supplierPayable');
  assert.equal(payable.fields.payableChange, 120);
  assert.equal(gateway.calls.some((call) => call.operation === 'create' && call.tableKey === 'moneyLedger'), false);
});

test('paid purchase creates cash outflow and a negative payable movement', async () => {
  const gateway = makeGateway();
  const service = new V1PostingService({ gateway, references: makeReferences(3) });
  await service.postPurchase({
    batchRecordId: 'rec_batch',
    supplierRecordId: 'rec_supplier',
    operatorOpenId: 'ou_user',
    items: [{ itemNo: 'A100', size: 38, quantity: 2, unitCost: 60 }],
    payment: { amount: 100, method: '微信' },
  });
  const moneyFlow = gateway.calls.find((call) => call.operation === 'create' && call.tableKey === 'moneyLedger');
  assert.equal(moneyFlow.fields.direction, '支出');
  assert.equal(moneyFlow.fields.amount, 100);
  const payables = gateway.calls.filter((call) => call.operation === 'create' && call.tableKey === 'supplierPayable');
  assert.deepEqual(payables.map((call) => call.fields.payableChange), [120, -100]);
});

test('payment allocation keeps cent totals exact', () => {
  const items = allocatePaidAmounts(
    [
      { quantity: 1, unitPrice: 100, discountAmount: 0 },
      { quantity: 1, unitPrice: 50, discountAmount: 0 },
    ],
    140
  );
  assert.equal(items.reduce((sum, item) => sum + item.paidAmount, 0), 140);
});
