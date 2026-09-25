const test = require('node:test');
const assert = require('node:assert/strict');
const { SalesFollowupService } = require('../src/services/salesFollowupService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

test('workbench groups pending payment and delivery by one sales order', async () => {
  const records = {
    salesEntry: [{ record_id: 'order_1', fields: { 确认状态: '已入账', 销售单号: 'XSD-001' } }],
    salesDetail: [
      { record_id: 'detail_1', fields: { 销售单号: ['order_1'], 编号: ['product_1'], 尺码: 38, 数量: 1, 交付数量: 1, 成交金额: 89 } },
      { record_id: 'detail_2', fields: { 销售单号: ['order_1'], 编号: ['product_2'], 尺码: 39, 数量: 1, 交付数量: 0, 成交金额: 59 } },
      { record_id: 'detail_3', fields: { 销售单号: ['order_1'], 编号: ['product_3'], 尺码: 40, 数量: 1, 交付数量: 0, 成交金额: 39 } },
    ],
    paymentRecord: [{ record_id: 'receipt_1', fields: { 关联销售单: ['order_1'], 收款金额: 50, 支付方式: ['method_1'] } }],
    paymentMethod: [{ record_id: 'method_1', fields: { 收款方式: '微信' } }],
    product: [1, 2, 3].map((index) => ({ record_id: `product_${index}`, fields: { 编号: `P${index}` } })),
  };
  const gateway = { listAll: async (key) => records[key] || [], table: (key) => V1_BITABLE_SCHEMA.tables[key] };
  const result = await new SalesFollowupService({ gateway }).listOrders();
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].receivable_amount, 187);
  assert.equal(result.orders[0].paid_amount, 50);
  assert.equal(result.orders[0].pending_amount, 137);
  assert.equal(result.orders[0].pending_delivery_quantity, 2);
  assert.equal(result.orders[0].fulfillment_status, '部分交付');
  assert.equal(result.orders[0].payment_status, '部分收款');
  assert.deepEqual(result.orders[0].details.map((detail) => detail.actual_amount), [89, 59, 39]);
});
