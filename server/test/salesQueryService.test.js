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
      gift: '袜子×1', accessory: '鞋油×1、乳胶垫×1',
      payments: [
        { method: '微信扫码', amount: 100, status: '已收款', trade_direction: '收入' },
        { method: '抖音团购券', amount: 50, status: '待平台结算', trade_direction: '收入' },
      ],
      details: [
        { number: 'A|黑|男', product_record_id: 'recA', color: '黑', size: 40, actual_amount: 100, fulfillment_status: '已交付', sold_at: at(18, 9), category_name: '棉鞋', category_type: '男' },
        { number: 'B|白|女', product_record_id: 'recB', color: '白', size: 38, actual_amount: 30, fulfillment_status: '未交付', sold_at: at(18, 9), category_name: '单鞋', category_type: '女' },
        { number: 'C|红|女', product_record_id: 'recC', color: '红', size: 39, actual_amount: 20, fulfillment_status: '已退货', sold_at: at(18, 9), category_name: '单鞋', category_type: '女' },
      ],
    },
    {
      order_no: 'A-2', recorded_at: at(17, 9), payable_amount: 99,
      payments: [{ method: '现金', amount: 99, status: '已收款', trade_direction: '收入' }],
      details: [{ number: 'D|黑|男', product_record_id: 'recD', color: '黑', size: 41, actual_amount: 99, fulfillment_status: '已交付', sold_at: at(17, 9), category_name: '布鞋', category_type: '男' }],
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
  assert.equal(data.orders[0].gift, '袜子×1');
  assert.equal(data.orders[0].accessory, '鞋油×1、乳胶垫×1');
  assert.equal(data.orders[0].accessory_amount, 10);
  assert.deepEqual(data.orders[0].details.map((detail) => detail.fulfillment_status), ['已交付', '未交付', '已退货']);
  assert.equal(data.orders[0].payments.length, 2);
});

test('AC-SQ4b recordId 优先：同货号同编号的两条记录不合并', async () => {
  const data = fixture();
  const base = data.orders[0].details[0];
  const makeDelivery = () => {
    data.orders = [
      { ...data.orders[0], order_no: 'A-1', details: [{ ...base, product_record_id: 'recA' }] },
      { ...data.orders[0], order_no: 'A-2', details: [{ ...base, product_record_id: 'recB' }] },
    ];
    return data;
  };
  const svc = createSalesQueryService({ gateway: {}, deliveryRead: { listDeliveryData: async () => makeDelivery() }, now: () => TODAY });
  const result = await svc.getSalesQuery({
    from: '2026-11-18', to: '2026-11-18', productRecordId: 'recA',
  });
  assert.deepEqual(result.orders.map((order) => order.order_no), ['A-1'], '只返回选中 recordId 的订单');
});

test('AC-SQ4 货品筛选：保留包含该货品的整张订单，不裁剪其他明细，概览不改', async () => {
  const svc = createSalesQueryService({ gateway: {}, deliveryRead: { listDeliveryData: async () => fixture() }, now: () => TODAY });
  const data = await svc.getSalesQuery({ from: '2026-11-18', to: '2026-11-18', productRecordId: 'recA' });
  assert.deepEqual(data.orders.map((order) => order.order_no), ['A-1'], '订单里只要有这个货品就保留整张订单');
  assert.deepEqual(data.orders[0].details.map((detail) => detail.number), ['A|黑|男', 'B|白|女', 'C|红|女'], '其他货品明细不能被裁掉');
  assert.equal(data.summary.revenue, 169, '经营概览仍按全部销售统计');
});

test('AC-SQ5 订单卡透传「录单人 / 售后人」：没售后人的订单是空串', async () => {
  const data = fixture();
  data.orders[0].sender = '赵瑞玲';
  data.orders[0].after_sales_by = '王颖、邯美皮鞋2号';
  const svc = createSalesQueryService({ gateway: {}, deliveryRead: { listDeliveryData: async () => data }, now: () => TODAY });
  const out = await svc.getSalesQuery({ from: '2026-11-17', to: '2026-11-18' });
  const withPeople = out.orders.find((order) => order.order_no === 'A-1');
  assert.equal(withPeople.sender, '赵瑞玲');
  assert.equal(withPeople.after_sales_by, '王颖、邯美皮鞋2号');
  const withoutPeople = out.orders.find((order) => order.order_no === 'A-2');
  assert.equal(withoutPeople.sender, '', '没录单人 ⇒ 空串，不拿别的补');
  assert.equal(withoutPeople.after_sales_by, '', '没售后人 ⇒ 空串，前端据此不渲染');
});
