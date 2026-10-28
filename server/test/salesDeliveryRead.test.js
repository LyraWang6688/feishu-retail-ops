'use strict';

/**
 * 「销售 · 交割单」真实只读数据（`SalesFollowupService.listDeliveryData`）验收。
 *
 * 口径（2026-10-29 业务负责人定稿）：
 *   · 判断只看 销售明细（履约状态）+ 收款明细（收款状态），按销售单号关联；
 *   · 销售主表只用于把两边统一到「销售单号」；货品信息/颜色/尺码/收款方式只用于显示；
 *   · 只读，不写任何表。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSalesDeliveryReadService } = require('../src/services/salesDeliveryReadService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const table = (key) => V1_BITABLE_SCHEMA.tables[key];

const fakeGateway = (records) => ({
  listAll: async (key) => records[key] || [],
  table,
});

const baseRecords = () => ({
  salesEntry: [{ record_id: 'order_1', fields: { 销售单号: 'XSD-1', 录单日: '2026-10-19T09:00:00+08:00', 总金额: 100 } }],
  salesDetail: [{
    record_id: 'detail_1',
    fields: {
      销售单号: ['order_1'], 编号: ['product_1'], 尺码: ['size_41'],
      履约状态: '未交付', 库存数量: 1, 实收金额: 100, 销售日: '2026-10-18T10:00:00+08:00',
    },
  }],
  paymentRecord: [
    { record_id: 'pay_1', fields: { 关联销售单: ['order_1'], 收款方式: ['method_1'], 收款金额: 40, 收款状态: '已收款' } },
    { record_id: 'pay_2', fields: { 关联销售单: ['order_1'], 收款方式: ['method_2'], 收款金额: 60, 收款状态: '未收款' } },
  ],
  product: [{ record_id: 'product_1', fields: { 货号: 'XHB8095', 颜色: ['color_1'] } }],
  color: [{ record_id: 'color_1', fields: { 颜色: '黑色' } }],
  sizeManagement: [{ record_id: 'size_41', fields: { 尺码: 41 } }],
  paymentMethod: [
    { record_id: 'method_1', fields: { 收款方式: '微信扫码' } },
    { record_id: 'method_2', fields: { 收款方式: '现金' } },
  ],
});

test('AC-DR1 真实只读：销售明细 + 收款明细 → 页面订单形状（货号/颜色/尺码/金额/收款方式）', async () => {
  const service = createSalesDeliveryReadService({ gateway: fakeGateway(baseRecords()) });
  const data = await service.listDeliveryData();
  assert.deepEqual(data.methods.sort(), ['微信扫码', '现金'].sort());
  assert.equal(data.orders.length, 1);
  const [order] = data.orders;
  assert.equal(order.order_no, 'XSD-1');
  assert.equal(order.sales_entry_record_id, 'order_1');
  assert.equal(order.recorded_at, '2026-10-19T09:00:00+08:00');
  assert.equal(order.details.length, 1);
  assert.deepEqual({
    product: order.details[0].product,
    product_record_id: order.details[0].product_record_id,
    color: order.details[0].color,
    size: order.details[0].size,
    fulfillment_status: order.details[0].fulfillment_status,
    stock_quantity: order.details[0].stock_quantity,
  }, {
    product: 'XHB8095', // 货品信息.货号（不是 编号 公式）
    product_record_id: 'product_1',
    color: '黑色',
    size: 41,
    fulfillment_status: '未交付',
    stock_quantity: 1,
  });
  assert.deepEqual(order.payments.map((payment) => [payment.status, payment.amount, payment.method]), [
    ['已收款', 40, '微信扫码'],
    ['未收款', 60, '现金'],
  ]);
  // 业务负责人 2026-10-29：应付 = 销售主表.总金额；待付 = 未收款合计。
  assert.equal(order.payable_amount, 100);
  assert.equal(order.pending_amount, 60);
});

test('AC-DR2 同一销售单号（不同销售主表记录）合并成一组（业务口径）', async () => {
  const records = baseRecords();
  records.salesEntry = [
    { record_id: 'order_1', fields: { 销售单号: 'XSD-SAME' } },
    { record_id: 'order_2', fields: { 销售单号: 'XSD-SAME' } },
  ];
  records.salesDetail.push({
    record_id: 'detail_2',
    fields: { 销售单号: ['order_2'], 编号: ['product_2'], 尺码: ['size_42'], 履约状态: '已交付', 实收金额: 200, 销售日: '2026-10-19T10:00:00+08:00' },
  });
  records.paymentRecord.push({ record_id: 'pay_3', fields: { 关联销售单: ['order_2'], 收款方式: ['method_1'], 收款金额: 200, 收款状态: '已收款' } });
  records.product.push({ record_id: 'product_2', fields: { 货号: 'QPL-8957', 颜色: ['color_2'] } });
  records.color.push({ record_id: 'color_2', fields: { 颜色: '咖色' } });
  records.sizeManagement.push({ record_id: 'size_42', fields: { 尺码: 42 } });

  const data = await createSalesDeliveryReadService({ gateway: fakeGateway(records) }).listDeliveryData();
  assert.equal(data.orders.length, 1, '同一销售单号必须合并成一组');
  assert.equal(data.orders[0].order_no, 'XSD-SAME');
  assert.equal(data.orders[0].details.length, 2);
  assert.equal(data.orders[0].payments.length, 3);
});

test('AC-DR3 只读：不调用任何写入方法', async () => {
  const writes = [];
  const gateway = {
    ...fakeGateway(baseRecords()),
    create: (...args) => { writes.push(['create', ...args]); },
    update: (...args) => { writes.push(['update', ...args]); },
    delete: (...args) => { writes.push(['delete', ...args]); },
  };
  await createSalesDeliveryReadService({ gateway }).listDeliveryData();
  assert.deepEqual(writes, []);
});
