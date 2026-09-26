const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { SalesOrderService } = require('../src/services/salesOrderService');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { InventoryService } = require('../src/services/inventoryService');
const { PaymentService } = require('../src/services/paymentService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const fake = () => {
  const records = new Map([['salesEntry', [{ record_id: 'order_1', fields: { 销售单号: 'XSD-001', 确认状态: '待确认' } }]]]);
  let seq = 0;
  const gateway = {
    records, table: (key) => V1_BITABLE_SCHEMA.tables[key], validateTables: async () => [],
    listAll: async (key) => records.get(key) || [],
    get: async (key, id) => (records.get(key) || []).find((row) => row.record_id === id),
    create: async (key, values) => {
      const recordId = `rec_${++seq}`;
      const fields = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)
        .map(([name, value]) => [V1_BITABLE_SCHEMA.tables[key].fields[name], value]));
      if (!records.has(key)) records.set(key, []);
      records.get(key).push({ record_id: recordId, fields });
      return { recordId };
    },
    update: async (key, id, values) => {
      const record = await gateway.get(key, id);
      Object.assign(record.fields, Object.fromEntries(Object.entries(values)
        .map(([name, value]) => [V1_BITABLE_SCHEMA.tables[key].fields[name], value])));
      return record;
    },
    delete: async (key, id) => records.set(key, (records.get(key) || []).filter((row) => row.record_id !== id)),
  };
  return gateway;
};
const references = { resolveProduct: async (item) => ({ recordId: `product_${item.itemNo}` }),
  resolvePaymentMethod: async (method) => ({ recordId: `method_${method}` }) };

test('first sale creates one master, multiple details and one receipt; retry creates nothing twice', async () => {
  const gateway = fake();
  const service = new SalesOrderService({ gateway, references });
  const input = { salesEntryRecordId: 'order_1', totalPaid: 230, paymentMethod: '微信',
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 100 }, { itemNo: 'B200', size: 39, quantity: 1, actualAmount: 130 }] };
  await service.confirm(input);
  await service.confirm(input);
  assert.equal(gateway.records.get('salesEntry').length, 1);
  assert.equal(gateway.records.get('salesDetail').length, 2);
  assert.equal(gateway.records.get('paymentRecord').length, 1);
  assert.equal(gateway.records.get('inventoryLedger'), undefined);
});

test('mixed payment creates two receipts for the same order and retry is idempotent', async () => {
  const gateway = fake();
  const service = new SalesOrderService({ gateway, references });
  const input = { salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 41, quantity: 1, actualAmount: 250, gift: true, giftDescription: '鞋垫一双' }],
    payments: [{ method: '微信', amount: 150 }, { method: '现金', amount: 100 }] };
  await service.confirm(input);
  await service.confirm(input);
  assert.equal(gateway.records.get('salesDetail').length, 1);
  assert.equal(gateway.records.get('salesDetail')[0].fields['赠品'], '鞋垫一双');
  assert.equal(gateway.records.get('paymentRecord').length, 2);
  assert.deepEqual(gateway.records.get('paymentRecord').map((record) => record.fields['收款金额']), [150, 100]);
  assert.equal(gateway.records.get('inventoryLedger'), undefined);
});

test('platform voucher has no receipt time until verified settlement', async () => {
  const gateway = fake();
  const payments = new PaymentService({ gateway, references });
  const cash = await payments.record({ salesEntryRecordId: 'order_1', method: '微信', amount: 169 });
  const voucher = await payments.record({ salesEntryRecordId: 'order_1', method: '抖音团购券',
    amount: 85.4, status: '待平台结算' });
  assert.equal((await gateway.get('paymentRecord', cash.recordId)).fields['收款状态'], '已收清');
  assert.ok((await gateway.get('paymentRecord', cash.recordId)).fields['收款时间'] > 0);
  assert.equal((await gateway.get('paymentRecord', voucher.recordId)).fields['收款状态'], '待平台结算');
  assert.equal((await gateway.get('paymentRecord', voucher.recordId)).fields['收款时间'], undefined);
  await payments.settlePlatformReceipt(voucher.recordId, 1234567890000);
  assert.equal((await gateway.get('paymentRecord', voucher.recordId)).fields['收款状态'], '已收清');
  assert.equal((await gateway.get('paymentRecord', voucher.recordId)).fields['收款时间'], 1234567890000);
});

test('sale records cash and pending voucher on one order without treating voucher as received', async () => {
  const gateway = fake();
  const sale = new SalesOrderService({ gateway, references });
  await sale.confirm({ salesEntryRecordId: 'order_1',
    items: [{ itemNo: '2A831-18', size: 44, quantity: 1, actualAmount: 254.4 }],
    payments: [{ method: '微信', amount: 169 },
      { method: '抖音团购券', amount: 85.4, status: '待平台结算' }] });
  const receipts = gateway.records.get('paymentRecord');
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].fields['收款时间'] > 0, true);
  assert.equal(receipts[1].fields['收款时间'], undefined);
  assert.equal(gateway.records.get('salesEntry')[0].fields['收款状态'], '待平台结算');
  await sale.confirm({ salesEntryRecordId: 'order_1',
    items: [{ itemNo: '2A831-18', size: 44, quantity: 1, actualAmount: 254.4 }],
    payments: [{ method: '微信', amount: 169 },
      { method: '抖音团购券', amount: 85.4, status: '待平台结算' }] });
  assert.equal(gateway.records.get('paymentRecord').length, 2);
});

test('invalid initial receipt cannot silently become unpaid', async () => {
  const gateway = fake();
  const service = new SalesOrderService({ gateway, references });
  await assert.rejects(service.confirm({ salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 41, quantity: 1, actualAmount: 100 }],
    payments: [{ method: '微信', amount: '' }] }), /收款金额/);
  assert.equal(gateway.records.get('paymentRecord'), undefined);
  assert.equal(gateway.records.get('salesEntry')[0].fields['确认状态'], '入账失败');
});

test('unpaid sale can be delivered once, then later payment does not touch inventory', async () => {
  const gateway = fake();
  const sales = new SalesOrderService({ gateway, references });
  const posted = await sales.confirm({ salesEntryRecordId: 'order_1', items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 100 }] });
  assert.equal(gateway.records.get('paymentRecord'), undefined);
  const calls = [];
  const delivery = new SalesDeliveryService({ gateway, inventory: { applySale: async (input) => { calls.push(input); return { quantity: 0 }; } } });
  const request = { salesEntryRecordId: 'order_1', detailRecordIds: posted.detailRecordIds };
  await delivery.deliver(request);
  await delivery.deliver(request);
  assert.equal(calls.length, 1);
  assert.equal(gateway.records.get('salesEntry')[0].fields['履约状态'], '已交付');
  const payment = new PaymentService({ gateway, references });
  await payment.record({ salesEntryRecordId: 'order_1', method: '微信', amount: 100 });
  assert.equal(gateway.records.get('paymentRecord').length, 1);
  assert.equal(calls.length, 1);
});

test('confirmed sale delivery writes positive stock movement and removes exactly one door-box unit', async () => {
  const gateway = fake();
  gateway.records.set('behavior', [{ record_id: 'behavior_sale', fields: {
    行为名称: '销售减少', 库存方向: '减少', 是否启用: true,
  } }]);
  gateway.records.set('liveInventory', [
    { record_id: 'door_1', fields: { 编号: ['product_A100'], 尺码: 38, 所属状态: '门盒' } },
    { record_id: 'sample_1', fields: { 编号: ['product_A100'], 尺码: 38, 所属状态: '样品' } },
  ]);
  const sale = new SalesOrderService({ gateway, references });
  const posted = await sale.confirm({ salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 220 }],
    payments: [{ method: '微信', amount: 220 }] });
  assert.equal(gateway.records.get('inventoryLedger'), undefined);
  const inventory = new InventoryService({ gateway, store: new JsonTaskStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sale-delivery-')), idField: 'operation_id',
  }) });
  const delivery = new SalesDeliveryService({ gateway, inventory });
  await delivery.deliver({ salesEntryRecordId: 'order_1', detailRecordIds: posted.detailRecordIds });
  assert.deepEqual(gateway.records.get('liveInventory').map((row) => row.record_id), ['sample_1']);
  assert.deepEqual(gateway.records.get('inventoryLedger')[0].fields, {
    编号: ['product_A100'], 尺码: 38, 变动数量: 1,
    库存行为: ['behavior_sale'], 关联销售: posted.detailRecordIds,
  });
  assert.equal(gateway.records.get('salesEntry')[0].fields['履约状态'], '已交付');
});

test('newly created detail and receipt are resolved by record ID when list results lag', async () => {
  const gateway = fake();
  const listAll = gateway.listAll;
  gateway.listAll = async (key) => ['salesDetail', 'paymentRecord'].includes(key) ? [] : listAll(key);
  const sale = new SalesOrderService({ gateway, references });
  const posted = await sale.confirm({ salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 89 }],
    payments: [{ method: '微信', amount: 89 }] });
  const order = await gateway.get('salesEntry', 'order_1');
  assert.equal(order.fields['收款状态'], '已收清');
  const delivery = new SalesDeliveryService({ gateway, inventory: {
    applySale: async () => ({ sampleConsumedQuantity: 0 }),
  } });
  await delivery.deliver({ salesEntryRecordId: 'order_1', detailRecordIds: posted.detailRecordIds,
    paymentRecordIds: posted.paymentRecordIds });
  assert.equal(order.fields['履约状态'], '已交付');
  assert.equal(order.fields['收款状态'], '已收清');
  assert.equal((await gateway.get('salesDetail', posted.detailRecordIds[0])).fields['交付数量'], 1);
});

test('Feishu record_ids link shape reuses an existing order, receipt, and detail before delivery', async () => {
  const gateway = fake();
  const sale = new SalesOrderService({ gateway, references });
  const input = { salesEntryRecordId: 'order_1',
    items: [
      { itemNo: 'A100', size: 42, quantity: 1, actualAmount: 89 },
      { itemNo: 'B200', size: 42, quantity: 1, actualAmount: 59 },
      { itemNo: 'C300', size: 40, quantity: 1, actualAmount: 39 },
    ], payments: [{ method: '微信', amount: 187 }] };
  const first = await sale.confirm(input);
  const receipt = await gateway.get('paymentRecord', first.paymentRecordIds[0]);
  const linked = (recordId) => [{ record_ids: [recordId], text: 'display', type: 'text' }];
  for (const [index, recordId] of first.detailRecordIds.entries()) {
    const detail = await gateway.get('salesDetail', recordId);
    detail.fields['销售单号'] = linked('order_1');
    detail.fields['编号'] = linked(`product_${input.items[index].itemNo}`);
  }
  receipt.fields['关联销售单'] = linked('order_1');
  receipt.fields['支付方式'] = linked('method_微信');
  (await gateway.get('salesEntry', 'order_1')).fields['确认状态'] = '入账失败';

  const retried = await sale.confirm(input);
  assert.deepEqual(retried.detailRecordIds, first.detailRecordIds);
  assert.deepEqual(retried.paymentRecordIds, first.paymentRecordIds);
  assert.equal(gateway.records.get('salesDetail').length, 3);
  assert.equal(gateway.records.get('paymentRecord').length, 1);
  const stockCalls = [];
  const delivery = new SalesDeliveryService({ gateway, inventory: {
    applySale: async (request) => { stockCalls.push(request); return { sampleConsumedQuantity: 0 }; },
  } });
  await delivery.deliver({ salesEntryRecordId: 'order_1', detailRecordIds: first.detailRecordIds,
    paymentRecordIds: first.paymentRecordIds });
  assert.equal(stockCalls.length, 3);
  assert.deepEqual(stockCalls.map((call) => call.productRecordId),
    ['product_A100', 'product_B200', 'product_C300']);
  assert.equal((await gateway.get('salesEntry', 'order_1')).fields['履约状态'], '已交付');
});
