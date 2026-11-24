'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccessorySaleOrderService } = require('../src/services/accessorySaleOrderService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const makeGateway = () => {
  const payments = [];
  const details = [];
  return {
    payments, details,
    async listAll(tableKey) { return tableKey === 'paymentRecord' ? payments.map((row) => ({ record_id: row.id, fields: { [V1_BITABLE_SCHEMA.tables.paymentRecord.fields.receiptId]: row.receiptId } })) : []; },
    async create(tableKey, fields) { const id = 'pay_' + (payments.length + 1); payments.push({ id, fields }); return { recordId: id }; },
    async update(tableKey, id, fields) { const row = payments.find((item) => item.id === id); if (row) Object.assign(row.fields, fields); return {}; },
    async createBatch(tableKey, rows) { return rows.map((fields, index) => { const id = 'line_' + (details.length + 1); details.push({ id, fields }); return { recordId: id }; }); },
  };
};

test('配品销售：一笔 S交易明细 + 多条明细，编号 PX 主号 + 行号', async () => {
  const gateway = makeGateway();
  const service = createAccessorySaleOrderService({ gateway, now: () => Date.parse('2026-11-24T14:00:00.000Z') });
  const result = await service.create({
    items: [{ accessoryRecordId: 'acc_belt', quantity: 1 }, { accessoryRecordId: 'acc_pad', quantity: 1 }],
    amount: 58, methodRecordId: 'pm_wechat', saleDate: Date.parse('2026-11-24T13:00:00.000Z'), operatorOpenId: 'ou_a',
  });
  assert.equal(result.ok, true);
  assert.equal(result.orderNo, 'PX-20261124-0001');
  assert.equal(gateway.payments.length, 1);
  assert.equal(gateway.payments[0].fields.amount, 58);
  assert.equal(gateway.details.length, 2);
  assert.deepEqual(gateway.details.map((row) => row.fields.orderNo), ['PX-20261124-0001-01', 'PX-20261124-0001-02']);
  assert.equal(gateway.details[0].fields.payment[0], 'pay_1');
  assert.equal(gateway.details[0].fields.operator[0].id, 'ou_a');
});

test('配品销售：金额 / 名称 / 重复配品校验', async () => {
  const service = createAccessorySaleOrderService({ gateway: makeGateway(), now: () => Date.now() });
  assert.equal((await service.create({ items: [{ accessoryRecordId: 'a', quantity: 1 }], amount: 0, methodRecordId: 'm' })).code, 'invalid_amount');
  assert.equal((await service.create({ items: [], amount: 1, methodRecordId: 'm' })).code, 'invalid_items');
  assert.equal((await service.create({ items: [{ accessoryRecordId: 'a', quantity: 1 }, { accessoryRecordId: 'a', quantity: 1 }], amount: 2, methodRecordId: 'm' })).code, 'duplicate_item');
});
