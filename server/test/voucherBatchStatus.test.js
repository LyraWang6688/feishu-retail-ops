'use strict';

/**
 * 一单多货/异步链路走 `PaymentService.recordInitialBatch`。
 * 券行未显式给状态时必须默认「待平台结算」（不能落成「已收款」）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentService } = require('../src/services/paymentService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const gatewayOf = () => {
  const records = new Map([
    ['salesEntry', [{ record_id: 'order_1', fields: { 销售单号: 'XSD-001' } }]],
    ['paymentRecord', []],
  ]);
  let seq = 0;
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => records.get(key) || [],
    get: async (key, id) => (records.get(key) || []).find((row) => row.record_id === id),
    create: async (key, values) => {
      const recordId = `rec_${++seq}`;
      const fields = Object.fromEntries(Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => [V1_BITABLE_SCHEMA.tables[key].fields[name], value]));
      if (!records.has(key)) records.set(key, []);
      records.get(key).push({ record_id: recordId, fields });
      return { recordId };
    },
  };
  return { gateway, records };
};

const voucherReferences = (link) => ({
  resolvePaymentMethod: async () => ({
    recordId: 'method_voucher',
    record: { fields: link ? { 团购券管理: ['voucher_1'] } : {} },
  }),
});

test('AC-VBS-1 recordInitialBatch：券行未显式状态 ⇒ 待平台结算，不写收款时间/方向', async () => {
  const { gateway, records } = gatewayOf();
  const service = new PaymentService({ gateway, references: voucherReferences(true) });
  await service.recordInitialBatch('order_1', [{ method: '抖音代金券（89.9）', amount: 85.4 }]);
  const row = records.get('paymentRecord')[0];
  assert.equal(row.fields['钱款状态'], '待平台结算');
  assert.equal(row.fields['收付日'], undefined);
  assert.equal(row.fields['收支方向'], undefined);
});

test('AC-VBS-2 recordInitialBatch：普通方式仍默认已收款，写收款时间/方向', async () => {
  const { gateway, records } = gatewayOf();
  const service = new PaymentService({ gateway, references: voucherReferences(false) });
  await service.recordInitialBatch('order_1', [{ method: '支付宝', amount: 158 }]);
  const row = records.get('paymentRecord')[0];
  assert.equal(row.fields['钱款状态'], '已收款');
  assert.ok(row.fields['收付日'] > 0);
  assert.equal(row.fields['收支方向'], '收入');
});

test('AC-VBS-3 recordInitialBatch：显式给状态时以调用方为准', async () => {
  const { gateway, records } = gatewayOf();
  const service = new PaymentService({ gateway, references: voucherReferences(true) });
  await service.recordInitialBatch('order_1', [{ method: '抖音代金券（89.9）', amount: 85.4, status: '已收款' }]);
  const row = records.get('paymentRecord')[0];
  assert.equal(row.fields['钱款状态'], '已收款');
});
