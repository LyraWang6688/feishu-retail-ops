'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSalesQueryService } = require('../src/services/salesQueryService');

const TODAY = Date.parse('2026-11-18T12:00:00+08:00');
const at = (day, hour = 10) => new Date(`2026-11-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00+08:00`).getTime();
const fixture = () => ({
  all_payments: [
    { record_id: 'p_paid', status: '已收款', amount: 100, method: '微信扫码', received_at: at(18, 10), sales_entry_record_id: 'e1' },
    { record_id: 'p_pending', status: '待平台结算', amount: 50, method: '抖音团购券', received_at: at(18, 11), sales_entry_record_id: 'e1' },
    { record_id: 'p_pending_wait', status: '待平台结算', amount: 30, method: '抖音团购券', received_at: null, created_at: at(18, 14), sales_entry_record_id: 'e1' },
    { record_id: 'p_noshoe', status: '已收款', amount: 19, method: '微信扫码', received_at: at(18, 12), receipt_id: 'PX-p_noshoe', sales_entry_record_id: '' },
    { record_id: 'p_yesterday', status: '已收款', amount: 999, method: '现金', received_at: at(17, 12), sales_entry_record_id: 'e1' },
    { record_id: 'p_unpaid', status: '未收款', amount: 88, method: '现金', received_at: at(18, 13), sales_entry_record_id: 'e1' },
  ],
  orders: [
    {
      order_no: 'A-1', recorded_at: at(18, 9), payable_amount: 150, accessory_amount: 10,
      payments: [
        { method: '微信扫码', amount: 100, status: '已收款', trade_direction: '收入' },
        { method: '抖音团购券', amount: 50, status: '待平台结算', trade_direction: '收入' },
      ],
      details: [
        { number: 'A|黑|男', color: '黑', size: 40, actual_amount: 100, fulfillment_status: '已交付', sold_at: at(18, 9), category_name: '棉鞋', category_type: '男' },
        { number: 'B|白|女', color: '白', size: 38, actual_amount: 30, fulfillment_status: '未交付', sold_at: at(18, 9), category_name: '单鞋', category_type: '女' },
        { number: 'C|红|女', color: '红', size: 39, actual_amount: 20, fulfillment_status: '已退货', sold_at: at(18, 9), category_name: '单鞋', category_type: '女' },
      ],
    },
    {
      order_no: 'A-2', recorded_at: at(17, 9), payable_amount: 99,
      payments: [{ method: '现金', amount: 99, status: '已收款', trade_direction: '收入' }],
      details: [{ number: 'D|黑|男', color: '黑', size: 41, actual_amount: 99, fulfillment_status: '已交付', sold_at: at(17, 9), category_name: '布鞋', category_type: '男' }],
    },
  ],
});

test('AC-SQ1 营业总额含已收款+待平台结算，按支付方式分组，非鞋类计入总额', async () => {
  const svc = createSalesQueryService({ gateway: {}, deliveryRead: { listDeliveryData: async () => fixture() }, now: () => TODAY });
  const data = await svc.getSalesQuery({ from: '2026-11-18', to: '2026-11-18' });
  assert.equal(data.summary.revenue, 169);
  assert.deepEqual(data.summary.accessory_sales, { amount: 29 }, '配品总额 + 独立配品交易金额');
  assert.deepEqual(data.summary.payment_methods, [
    { method: '微信扫码', amount: 119, count: 2 },
    { method: '抖音团购券', amount: 50, count: 1 },
  ]);
  assert.deepEqual(data.summary.pending_methods, [
    { method: '抖音团购券', amount: 30, count: 1 },
  ], '没有收付日的待结算券只提示，不计入营业总额');
  assert.equal(data.summary.payment_methods[0].count, 2, '同一交易方式按 S交易明细行数计笔数');
});

test('AC-SQ2 销售数量只算已交付/未交付，排除退货，并按品类/类别拆数量金额', async () => {
  const svc = createSalesQueryService({ gateway: {}, deliveryRead: { listDeliveryData: async () => fixture() }, now: () => TODAY });
  const data = await svc.getSalesQuery({ from: '2026-11-18', to: '2026-11-18' });
  assert.equal(data.summary.delivered.count, 1);
  assert.equal(data.summary.undelivered.count, 1);
  assert.equal(data.summary.delivered.amount, 100);
  assert.equal(data.summary.undelivered.amount, 30);
  assert.deepEqual(Object.fromEntries(data.summary.by_category.map((row) => [row.name, [row.delivered_count, row.undelivered_count]])), {
    男: [1, 0], 女: [0, 1],
  });
  assert.deepEqual(Object.fromEntries(data.summary.by_type.map((row) => [row.name, [row.delivered_count, row.undelivered_count]])), {
    棉鞋: [1, 0], 单鞋: [0, 1],
  });
});

test('AC-SQ3 销售单区块按录单日筛选、总金额取销售主表，明细保留全部状态', async () => {
  const svc = createSalesQueryService({ gateway: {}, deliveryRead: { listDeliveryData: async () => fixture() }, now: () => TODAY });
  const data = await svc.getSalesQuery({ from: '2026-11-18', to: '2026-11-18' });
  assert.deepEqual(data.orders.map((order) => order.order_no), ['A-1']);
  assert.equal(data.orders[0].total_amount, 150);
  assert.deepEqual(data.orders[0].details.map((detail) => detail.fulfillment_status), ['已交付', '未交付', '已退货']);
  assert.equal(data.orders[0].payments.length, 2);
});
