'use strict';

/**
 * 交割单页付款写库（SalesDeliveryPaymentService）验收。
 * 口径：付清改原未收款；没付清新增已收款 + 原未收款改剩余；券沿用待平台结算。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { createSalesDeliveryPaymentService } = require('../src/services/salesDeliveryPaymentService');
const { DELIVERY_PAYMENT, UNPAID_PAYMENT_STATUS } = require('../src/config/salesDeliveryPage');

const pending = (id, amount) => ({
  record_id: id,
  fields: { [V1_BITABLE_SCHEMA.tables.paymentRecord.fields.status]: [UNPAID_PAYMENT_STATUS], [V1_BITABLE_SCHEMA.tables.paymentRecord.fields.amount]: amount },
});
const paid = (id, amount) => ({
  record_id: id,
  fields: { [V1_BITABLE_SCHEMA.tables.paymentRecord.fields.status]: [DELIVERY_PAYMENT.paidStatus], [V1_BITABLE_SCHEMA.tables.paymentRecord.fields.amount]: amount },
});

const harness = ({ rows, methods = {}, voucherMethods = new Set() } = {}) => {
  const writes = [];
  const updates = [];
  const records = rows || [pending('pay_pending', 220)];
  const gateway = {
    get: async (key, id) => (key === 'salesEntry' ? {
      record_id: id,
      fields: { [V1_BITABLE_SCHEMA.tables.salesEntry.fields.writeStatus]: '成功' },
    } : null),
    update: async (key, id, fields) => { updates.push({ key, id, fields }); return { recordId: id }; },
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
  };
  const payments = {
    recordsForSale: async () => records,
    references: {
      resolvePaymentMethod: async (name) => ({
        recordId: `method_${name}`,
        record: { fields: { [V1_BITABLE_SCHEMA.tables.paymentMethod.fields.voucher]: voucherMethods.has(name) ? ['voucher_1'] : [] } },
      }),
    },
    collectPendingReceipt: async (id, input) => { writes.push({ action: 'collect', id, input }); return { recordId: id }; },
    record: async (input) => { writes.push({ action: 'create', input }); return { recordId: 'pay_new' }; },
  };
  const storeData = new Map();
  const store = {
    get: async (id) => storeData.get(id) || null,
    create: async (value) => { storeData.set(value.task_id, { ...value }); },
    update: async (id, patch) => { storeData.set(id, { ...(storeData.get(id) || {}), ...patch }); },
  };
  const service = createSalesDeliveryPaymentService({ gateway, payments, store, now: () => 1700000000000 });
  return { service, writes, updates, storeData };
};

test('AC-DP1 付清（非券）：改原未收款记录，不新增记录', async () => {
  const { service, writes, updates } = harness();
  const result = await service.pay({ salesEntryRecordId: 'order_1', amount: 220, method: '微信扫码', requestId: '11111111-1111-4111-8111-111111111111' });
  assert.deepEqual(result, { recordId: 'pay_pending', pendingAmount: 0, status: DELIVERY_PAYMENT.paidStatus });
  assert.equal(writes.filter((item) => item.action === 'create').length, 0);
  assert.equal(writes.filter((item) => item.action === 'collect').length, 1);
  assert.equal(writes.find((item) => item.action === 'collect').input.amount, 220);
});

test('AC-DP2 没付清（非券）：新增已收款 + 原未收款改剩余', async () => {
  const { service, writes, updates } = harness({ rows: [pending('pay_pending', 100), paid('pay_paid', 100)] });
  const result = await service.pay({ salesEntryRecordId: 'order_1', amount: 50, method: '现金', requestId: '22222222-2222-4222-8222-222222222222' });
  assert.deepEqual(result, { recordId: 'pay_new', pendingAmount: 50, status: DELIVERY_PAYMENT.paidStatus });
  assert.equal(writes.filter((item) => item.action === 'create').length, 1);
  assert.equal(writes.find((item) => item.action === 'create').input.amount, 50);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].fields[V1_BITABLE_SCHEMA.tables.paymentRecord.fields.amount], 50);
});

test('AC-DP3 付清（团购券）：原未收款改待平台结算，不写收款日/方向', async () => {
  const { service, writes, updates } = harness({ voucherMethods: new Set(['抖音代金券（89.9）']) });
  const result = await service.pay({ salesEntryRecordId: 'order_1', amount: 220, method: '抖音代金券（89.9）', requestId: '33333333-3333-4333-8333-333333333333' });
  assert.equal(result.status, DELIVERY_PAYMENT.platformPendingStatus);
  assert.equal(writes.filter((item) => item.action === 'collect').length, 0);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].fields[V1_BITABLE_SCHEMA.tables.paymentRecord.fields.status], DELIVERY_PAYMENT.platformPendingStatus);
  assert.equal(updates[0].fields[V1_BITABLE_SCHEMA.tables.paymentRecord.fields.receivedAt], undefined);
  assert.equal(updates[0].fields[V1_BITABLE_SCHEMA.tables.paymentRecord.fields.tradeDirection], undefined);
});

test('AC-DP4 多条未收款 / 超过待付：写之前拒绝', async () => {
  const multiple = harness({ rows: [pending('a', 100), pending('b', 100)] });
  await assert.rejects(() => multiple.service.pay({ salesEntryRecordId: 'order_1', amount: 50, method: '现金', requestId: '44444444-4444-4444-8444-444444444444' }), /多条待收款/);
  const over = harness();
  await assert.rejects(() => over.service.pay({ salesEntryRecordId: 'order_1', amount: 300, method: '现金', requestId: '55555555-5555-4555-8555-555555555555' }), /超过待付/);
  assert.equal(over.writes.length, 0);
});
