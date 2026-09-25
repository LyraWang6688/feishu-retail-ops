const test = require('node:test');
const assert = require('node:assert/strict');
const { SalesOrderService } = require('../src/services/salesOrderService');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
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
  };
  return gateway;
};
const references = { resolveProduct: async (item) => ({ recordId: `product_${item.itemNo}` }),
  resolvePaymentMethod: async (method) => ({ recordId: `method_${method}` }) };

test('first sale creates one master, multiple details and one receipt; retry creates nothing twice', async () => {
  const gateway = fake();
  const service = new SalesOrderService({ gateway, references });
  const input = { salesEntryRecordId: 'order_1', totalPaid: 230, paymentMethod: '微信',
    items: [{ itemNo: 'A100', size: 38, quantity: 1 }, { itemNo: 'B200', size: 39, quantity: 1 }] };
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
    items: [{ itemNo: 'A100', size: 41, quantity: 1, gift: true, giftDescription: '鞋垫一双' }],
    payments: [{ method: '微信', amount: 150 }, { method: '现金', amount: 100 }] };
  await service.confirm(input);
  await service.confirm(input);
  assert.equal(gateway.records.get('salesDetail').length, 1);
  assert.equal(gateway.records.get('salesDetail')[0].fields['赠品'], '鞋垫一双');
  assert.equal(gateway.records.get('paymentRecord').length, 2);
  assert.deepEqual(gateway.records.get('paymentRecord').map((record) => record.fields['收款金额']), [150, 100]);
  assert.equal(gateway.records.get('inventoryLedger'), undefined);
});

test('invalid initial receipt cannot silently become unpaid', async () => {
  const gateway = fake();
  const service = new SalesOrderService({ gateway, references });
  await assert.rejects(service.confirm({ salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 41, quantity: 1 }],
    payments: [{ method: '微信', amount: '' }] }), /收款金额/);
  assert.equal(gateway.records.get('paymentRecord'), undefined);
  assert.equal(gateway.records.get('salesEntry')[0].fields['确认状态'], '入账失败');
});

test('unpaid sale can be delivered once, then later payment does not touch inventory', async () => {
  const gateway = fake();
  const sales = new SalesOrderService({ gateway, references });
  const posted = await sales.confirm({ salesEntryRecordId: 'order_1', items: [{ itemNo: 'A100', size: 38, quantity: 1 }] });
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
