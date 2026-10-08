const test = require('node:test');
const assert = require('node:assert/strict');
const { SalesFollowupService } = require('../src/services/salesFollowupService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

test('workbench groups pending payment and delivery by one sales order', async () => {
  const records = {
    salesEntry: [{ record_id: 'order_1', fields: { '资金状态': '已写入', 销售单号: 'XSD-001' } }],
    // 尺码已改为关联「尺码管理」：夹具用关联 ID，并让假网关能查到尺码表。
    salesDetail: [
      { record_id: 'detail_1', fields: { 销售单号: ['order_1'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 成交金额: 89 } },
      { record_id: 'detail_2', fields: { 销售单号: ['order_1'], 编号: ['product_2'], 尺码: ['size_39'], 履约状态: '未交付', 成交金额: 59 } },
      { record_id: 'detail_3', fields: { 销售单号: ['order_1'], 编号: ['product_3'], 尺码: ['size_40'], 履约状态: '未交付', 成交金额: 39 } },
    ],
    sizeManagement: [38, 39, 40].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } })),
    paymentRecord: [{ record_id: 'receipt_1', fields: { 关联销售单: ['order_1'], 收款金额: 50, 交易方式: ['method_1'] } }],
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
  assert.deepEqual(result.orders[0].details.map((detail) => detail.size), [38, 39, 40]);
  assert.deepEqual(result.orders[0].details.map((detail) => detail.fulfillment_status), ['已交付', '未交付', '未交付']);
});

// ⭐ 2026-10-08 退货"改原收款状态"之后，这一单在跟进/工作台查询里**不许炸**
//（`progressFromRecords` 见到未知收款状态会抛；这条路径没有 try/catch —— 一单炸 = 整页 502）。
// ⚠️ 这里只造"收款行被改成已退款"这一件事：**明细**的售后状态（已退货/已换货/已赔货）
//    是**另一处**的既有缺口，见报告（本用例刻意不碰它）。
test('⭐ 原单的收款被售后退货改成「已退款」后，跟进查询仍然出得来（不再是未知收款状态）', async () => {
  const records = {
    salesEntry: [{ record_id: 'order_1', fields: { 资金状态: '已写入', 销售单号: 'XSD-001' } }],
    salesDetail: [
      { record_id: 'detail_1', fields: { 销售单号: ['order_1'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 成交金额: 89 } },
    ],
    sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }],
    // 退货口径：**原收款行**的状态被改成「已退款」（金额 / 方向 / 交易方式都不动）
    paymentRecord: [{ record_id: 'receipt_1', fields: { 关联销售单: ['order_1'], 收款金额: 89, 收款状态: '已退款', 交易方式: ['method_1'] } }],
    paymentMethod: [{ record_id: 'method_1', fields: { 收款方式: '微信' } }],
    product: [{ record_id: 'product_1', fields: { 编号: 'P1' } }],
  };
  const gateway = { listAll: async (key) => records[key] || [], table: (key) => V1_BITABLE_SCHEMA.tables[key] };
  const result = await new SalesFollowupService({ gateway }).listOrders();
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].paid_amount, 89, '按已结清算（口径见 config/afterSales 的注释）');
  assert.equal(result.orders[0].pending_amount, 0);
});
