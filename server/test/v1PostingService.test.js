const test = require('node:test');
const assert = require('node:assert/strict');
const { V1PostingService, allocatePaidAmounts } = require('../src/services/v1PostingService');

const TABLES = {
  salesEntry: { fields: { orderNo: '销售单号' } },
  purchaseBatch: { fields: { batchNo: '到货批次号' } },
  liveInventory: { fields: { quantity: '数量' } },
  salesDetail: {
    fields: {
      product: '编号',
      quantity: '数量',
      size: '尺码',
      paidAmount: '实付金额',
      gift: '赠品',
      paymentMethod: '支付方式',
      salesEntry: '销售单号',
      behavior: '销售行为',
    },
  },
  purchaseInbound: {
    fields: { product: '编号', quantity: '数量', size: '尺码', batch: '采购到货批次', unitCost: '入库单价' },
  },
  inventoryLedger: {
    fields: {
      sourceRecordId: '来源记录ID',
      sourceNo: '来源单号',
      quantityChange: '数量变化',
      beforeQuantity: '变化前数量',
      afterQuantity: '变化后数量',
    },
  },
  moneyLedger: {
    fields: {
      sourceNo: '来源单号',
      direction: '收支方向',
      amount: '金额',
      supplier: '供应商',
      paymentMethod: '收款方式',
    },
  },
  supplierPayable: {
    fields: { sourceNo: '来源单号', payableChange: '应付变化', supplier: '供应商' },
  },
};

const mapFields = (tableKey, semanticFields) =>
  Object.fromEntries(
    Object.entries(semanticFields).map(([key, value]) => [TABLES[tableKey]?.fields?.[key] || key, value])
  );

const makeGateway = (options = {}) => {
  const calls = [];
  const records = new Map();
  const failed = new Set();
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
      if (options.failOnceAfterCommit === tableKey && !failed.has(tableKey)) {
        failed.add(tableKey);
        throw new Error(`simulated response loss after ${tableKey} commit`);
      }
      return { recordId };
    },
    update: async (tableKey, recordId, fields) => {
      calls.push({ operation: 'update', tableKey, recordId, fields });
      const record = records.get(tableKey)?.find((item) => item.record_id === recordId);
      if (record) Object.assign(record.fields, mapFields(tableKey, fields));
      if (options.failOnceAfterUpdateCommit === tableKey && !failed.has(`update:${tableKey}`)) {
        failed.add(`update:${tableKey}`);
        throw new Error(`simulated response loss after ${tableKey} update commit`);
      }
      return { record_id: recordId };
    },
    listAll: async (tableKey) => records.get(tableKey) || [],
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
    items: [{ productNumber: 'A100', size: 38, quantity: 2, gift: false }],
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
        totalPaid: 200,
        items: [{ productNumber: 'A100', size: 38, quantity: 2 }],
      }),
    /库存不足/
  );
  assert.equal(gateway.calls.some((call) => call.operation === 'create'), false);
});

test('V1 sale posting rejects more than one sales detail', async () => {
  const gateway = makeGateway();
  const service = new V1PostingService({ gateway, references: makeReferences(3) });
  await assert.rejects(
    () =>
      service.postSale({
        salesEntryRecordId: 'rec_sale_entry',
        paymentMethod: '现金',
        totalPaid: 200,
        items: [
          { productNumber: 'A100', size: 38, quantity: 1 },
          { productNumber: 'A100', size: 38, quantity: 1 },
        ],
      }),
    /只能包含一条商品明细/
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

test('sale retry reuses a committed inventory ledger after the response is lost', async () => {
  const gateway = makeGateway({ failOnceAfterCommit: 'inventoryLedger' });
  const service = new V1PostingService({ gateway, references: makeReferences(5) });
  const input = {
    salesEntryRecordId: 'rec_sale_entry',
    operatorOpenId: 'ou_user',
    paymentMethod: '微信',
    totalPaid: 200,
    occurredAt: 1790172000000,
    items: [{ productNumber: 'A100', size: 38, quantity: 2 }],
  };

  await assert.rejects(() => service.postSale(input), /simulated response loss/);
  const result = await service.postSale(input);

  assert.equal(result.detailRecordIds.length, 1);
  assert.equal(gateway.records.get('salesDetail').length, 1);
  assert.equal(gateway.records.get('inventoryLedger').length, 1);
  assert.equal(gateway.records.get('moneyLedger').length, 1);
});

test('sale retry reuses a committed money flow after the response is lost', async () => {
  const gateway = makeGateway({ failOnceAfterCommit: 'moneyLedger' });
  const service = new V1PostingService({ gateway, references: makeReferences(5) });
  const input = {
    salesEntryRecordId: 'rec_sale_entry',
    operatorOpenId: 'ou_user',
    paymentMethod: '现金',
    totalPaid: 100,
    occurredAt: 1790172000000,
    items: [{ productNumber: 'A100', size: 38, quantity: 1 }],
  };

  await assert.rejects(() => service.postSale(input), /simulated response loss/);
  const result = await service.postSale(input);

  assert.ok(result.moneyRecordId);
  assert.equal(gateway.records.get('salesDetail').length, 1);
  assert.equal(gateway.records.get('inventoryLedger').length, 1);
  assert.equal(gateway.records.get('moneyLedger').length, 1);
});

test('sale retry tolerates a committed live inventory update after the response is lost', async () => {
  const gateway = makeGateway({ failOnceAfterUpdateCommit: 'liveInventory' });
  const service = new V1PostingService({ gateway, references: makeReferences(5) });
  const input = {
    salesEntryRecordId: 'rec_sale_entry',
    operatorOpenId: 'ou_user',
    paymentMethod: '微信',
    totalPaid: 100,
    occurredAt: 1790172000000,
    items: [{ productNumber: 'A100', size: 38, quantity: 1 }],
  };

  await assert.rejects(() => service.postSale(input), /simulated response loss/);
  await service.postSale(input);

  assert.equal(gateway.records.get('salesDetail').length, 1);
  assert.equal(gateway.records.get('inventoryLedger').length, 1);
  assert.equal(gateway.records.get('moneyLedger').length, 1);
});

test('sale retry rejects a changed draft after a partial write', async () => {
  const gateway = makeGateway({ failOnceAfterCommit: 'salesDetail' });
  const service = new V1PostingService({ gateway, references: makeReferences(5) });
  const original = {
    salesEntryRecordId: 'rec_sale_entry',
    paymentMethod: '微信',
    totalPaid: 100,
    occurredAt: 1790172000000,
    items: [{ productNumber: 'A100', size: 38, quantity: 1 }],
  };

  await assert.rejects(() => service.postSale(original), /simulated response loss/);
  await assert.rejects(
    () => service.postSale({ ...original, items: [{ ...original.items[0], quantity: 2 }] }),
    /与当前草稿不一致/
  );
  assert.equal(gateway.records.get('salesDetail').length, 1);
  assert.equal(gateway.records.get('inventoryLedger'), undefined);
});

test('purchase retry reuses a committed payable after the response is lost', async () => {
  const gateway = makeGateway({ failOnceAfterCommit: 'supplierPayable' });
  const service = new V1PostingService({ gateway, references: makeReferences(3) });
  const input = {
    batchRecordId: 'rec_batch',
    supplierRecordId: 'rec_supplier',
    operatorOpenId: 'ou_user',
    occurredAt: 1790172000000,
    items: [{ itemNo: 'A100', size: 38, quantity: 2, unitCost: 60 }],
  };

  await assert.rejects(() => service.postPurchase(input), /simulated response loss/);
  const result = await service.postPurchase(input);

  assert.ok(result.payableRecordId);
  assert.equal(gateway.records.get('purchaseInbound').length, 1);
  assert.equal(gateway.records.get('inventoryLedger').length, 1);
  assert.equal(gateway.records.get('supplierPayable').length, 1);
});

test('paid purchase retry does not duplicate cash or payable movements', async () => {
  const gateway = makeGateway({ failOnceAfterCommit: 'moneyLedger' });
  const service = new V1PostingService({ gateway, references: makeReferences(3) });
  const input = {
    batchRecordId: 'rec_batch',
    supplierRecordId: 'rec_supplier',
    operatorOpenId: 'ou_user',
    occurredAt: 1790172000000,
    items: [{ itemNo: 'A100', size: 38, quantity: 2, unitCost: 60 }],
    payment: { amount: 100, method: '微信' },
  };

  await assert.rejects(() => service.postPurchase(input), /simulated response loss/);
  const result = await service.postPurchase(input);

  assert.ok(result.paymentResult.moneyRecordId);
  assert.equal(gateway.records.get('purchaseInbound').length, 1);
  assert.equal(gateway.records.get('inventoryLedger').length, 1);
  assert.equal(gateway.records.get('moneyLedger').length, 1);
  assert.deepEqual(
    gateway.records.get('supplierPayable').map((record) => record.fields['应付变化']),
    [120, -100]
  );
});

test('paid purchase retry rejects changed payment details after a partial write', async () => {
  const gateway = makeGateway({ failOnceAfterCommit: 'moneyLedger' });
  const service = new V1PostingService({ gateway, references: makeReferences(3) });
  const input = {
    batchRecordId: 'rec_batch',
    supplierRecordId: 'rec_supplier',
    operatorOpenId: 'ou_user',
    occurredAt: 1790172000000,
    items: [{ itemNo: 'A100', size: 38, quantity: 2, unitCost: 60 }],
    payment: { amount: 100, method: '微信' },
  };

  await assert.rejects(() => service.postPurchase(input), /simulated response loss/);
  await assert.rejects(
    () => service.postPurchase({ ...input, payment: { amount: 80, method: '现金' } }),
    /与当前付款信息不一致/
  );
  assert.equal(gateway.records.get('moneyLedger').length, 1);
  assert.deepEqual(
    gateway.records.get('supplierPayable').map((record) => record.fields['应付变化']),
    [120]
  );
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
