'use strict';

/**
 * 售后「可用于退款」配置（2026-11-08，业务负责人：支付方式也配置化）。
 *
 * 口径：
 *   · 唯一数据源 = 「支付方式管理」表；
 *   · 可选列（默认名「可用于退款」，列名可用 env `PAYMENT_METHOD_REFUNDABLE_FIELD` 改）；
 *   · **列不存在** ⇒ 全部可用（向后兼容：生产还没加这列时行为不变）；
 *   · 列存在 ⇒ 只有勾了的方式能用于「直接退款」（下拉不出现 + 提交被拦）。
 *
 * AC-RM1 列不存在 ⇒ listRefundable = 全部；list 形状不变
 * AC-RM2 列存在 ⇒ 只留勾了的（false / 空 都算不能退）
 * AC-RM3 prepare 校验：未勾的方式 ⇒ 400 人话「不能用于退款」，零写入
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPaymentMethodsService } = require('../src/services/paymentMethodsService');
const { invalidateConfigTable } = require('../src/services/configTableCache');
const { AfterSalesReturnService } = require('../src/services/afterSalesReturnService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const gatewayOf = (rows) => ({ listAll: async () => rows });

test('AC-RM1 列不存在 ⇒ 全部可用（今天的行为不变）', async () => {
  invalidateConfigTable('paymentMethod');
  const service = createPaymentMethodsService(gatewayOf([
    { record_id: 'a', fields: { 交易方式: '现金' } },
    { record_id: 'b', fields: { 交易方式: '微信转账' } },
  ]));
  const all = await service.listRefundable();
  assert.deepEqual(all.items.map((item) => item.name), ['现金', '微信转账'], '没有那列 ⇒ 全部可用');
  const plain = await service.list();
  assert.deepEqual(plain.items, ['现金', '微信转账'], 'list 形状不变');
});

test('AC-RM2 列存在 ⇒ 只留勾了「可用于退款」的', async () => {
  invalidateConfigTable('paymentMethod');
  const service = createPaymentMethodsService(gatewayOf([
    { record_id: 'a', fields: { 交易方式: '现金', 可用于退款: true } },
    { record_id: 'b', fields: { 交易方式: '微信转账', 可用于退款: false } },
    { record_id: 'c', fields: { 交易方式: '支付宝' } },
  ]));
  const out = await service.listRefundable();
  assert.deepEqual(out.items.map((item) => item.name), ['现金'], 'false / 空 都不算可退款');
  const detailed = await service.listWithVouchers();
  assert.equal(detailed.items.find((item) => item.name === '现金').refundable, true);
  assert.equal(detailed.items.find((item) => item.name === '微信转账').refundable, false);
});

const makeGateway = () => {
  const tables = {
    salesEntry: { fields: { orderNo: '销售单号', afterSalesType: '售后类型', afterSalesCount: '售后次数' } },
    salesDetail: { fields: { salesEntry: '销售单号', product: '编号', size: '尺码', fulfillmentStatus: '履约状态', actualAmount: '实收金额' } },
    sizeManagement: { fields: { size: '尺码' } },
    paymentRecord: { fields: { salesEntry: '关联销售单', method: '支付方式', tradeDirection: '收支方向', amount: '交易金额', status: '钱款状态', receiptId: '交易明细ID', receivedAt: '收付日' } },
  };
  const state = {
    entry: { record_id: 'e1', fields: { 销售单号: 'XSD-20261028-0005', 售后类型: [], 售后次数: 0 } },
    detail: { record_id: 'd1', fields: { 销售单号: [{ record_ids: ['e1'] }], 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: ['s1'] }], 履约状态: '已交付', 实收金额: 100 } },
    size: { record_id: 's1', fields: { 尺码: 40 } },
    calls: { create: [], update: [] },
  };
  return {
    state,
    gateway: {
      table: (key) => tables[key],
      get: async (key) => (key === 'salesEntry' ? state.entry : key === 'salesDetail' ? state.detail : state.size),
      listAll: async () => [],
      create: async (key, fields) => { state.calls.create.push({ key, fields }); return { recordId: 'new_1' }; },
      update: async (key, id, fields) => { state.calls.update.push({ key, id, fields }); return { record_id: id }; },
    },
  };
};

test('AC-RM3 未勾「可用于退款」的方式 ⇒ prepare 400，零写入', async () => {
  invalidateConfigTable('paymentMethod');
  const { gateway, state } = makeGateway();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'after-sales-refund-'));
  const service = new AfterSalesReturnService({
    gateway,
    store: new JsonTaskStore({ dir, idField: 'request_id' }),
    paymentMethods: createPaymentMethodsService({
      listAll: async () => ([
        { record_id: 'pm_cash', fields: { 交易方式: '现金', 可用于退款: true } },
        { record_id: 'pm_transfer', fields: { 交易方式: '微信转账', 可用于退款: false } },
      ]),
    }),
  });
  await assert.rejects(() => service.execute({
    action: 'return', requestId: '11111111-2222-4333-8444-555555555555',
    salesEntryRecordId: 'e1', detailRecordId: 'd1', moneyMode: 'refund', paymentMethod: '微信转账',
  }), (error) => error.statusCode === 400 && /不能用于退款/.test(error.message));
  assert.equal(state.calls.create.length + state.calls.update.length, 0, '零写入');
});
