const test = require('node:test');
const assert = require('node:assert/strict');
const { SalesFollowupService } = require('../src/services/salesFollowupService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

test('workbench groups pending payment and delivery by one sales order', async () => {
  const records = {
    salesEntry: [{ record_id: 'order_1', fields: { '资金状态': '已写入', 销售单号: 'XSD-001' } }],
    // 尺码已改为关联「尺码管理」：夹具用关联 ID，并让假网关能查到尺码表。
    salesDetail: [
      { record_id: 'detail_1', fields: { 销售单号: ['order_1'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 实收金额: 89 } },
      { record_id: 'detail_2', fields: { 销售单号: ['order_1'], 编号: ['product_2'], 尺码: ['size_39'], 履约状态: '未交付', 实收金额: 59 } },
      { record_id: 'detail_3', fields: { 销售单号: ['order_1'], 编号: ['product_3'], 尺码: ['size_40'], 履约状态: '未交付', 实收金额: 39 } },
    ],
    sizeManagement: [38, 39, 40].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } })),
    paymentRecord: [{ record_id: 'receipt_1', fields: { 关联销售单: ['order_1'], 收款金额: 50, 收款方式: ['method_1'] } }],
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
//（`progressFromRecords` 见到未知收款状态会抛）。
// ⚠️ `listOrders` 现在有**逐单兜底**（一条坏单只跳过它、记 warn），但**正常单必须靠语义层认出来**
//    —— 兜底不该被用来把"本该算得出来"的单吞掉。本用例钉的是语义层这一半。
// ⚠️ 这里只造"收款行被改成已退款"这一件事：**明细**的售后状态（已退货/已换货/已赔货）
//    是另一处（曾经也缺）的口径 —— 已在 2026-10-08 的小修里堵上，见下面的用例。
test('⭐ 原单的收款被售后退货改成「已退款」后，跟进查询仍然出得来（不再是未知收款状态）', async () => {
  const records = {
    salesEntry: [{ record_id: 'order_1', fields: { 资金状态: '已写入', 销售单号: 'XSD-001' } }],
    salesDetail: [
      { record_id: 'detail_1', fields: { 销售单号: ['order_1'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 实收金额: 89 } },
    ],
    sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }],
    // 退货口径：**原收款行**的状态被改成「已退款」（金额 / 方向 / 收款方式都不动）
    paymentRecord: [{ record_id: 'receipt_1', fields: { 关联销售单: ['order_1'], 收款金额: 89, 收款状态: '已退款', 收款方式: ['method_1'] } }],
    paymentMethod: [{ record_id: 'method_1', fields: { 收款方式: '微信' } }],
    product: [{ record_id: 'product_1', fields: { 编号: 'P1' } }],
  };
  const gateway = { listAll: async (key) => records[key] || [], table: (key) => V1_BITABLE_SCHEMA.tables[key] };
  const result = await new SalesFollowupService({ gateway }).listOrders();
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].paid_amount, 89, '按已结清算（口径见 config/afterSales 的注释）');
  assert.equal(result.orders[0].pending_amount, 0);
});

// ⭐ 2026-10-08 小修（业务负责人批准的"小修"）：**含售后明细的单不再让整页失败**。
//   线上事实（2026-10-08 01:41 +8）：
//     level=error event=workbench.sales.orders.failed
//     request_id=fe605d92-b824-4e4f-b86c-ab3c44502829 error="未知销售明细履约状态：已换货"
//   ⇒ 只要有一单含「已退货 / 已换货 / 已赔货」的明细，`GET /api/workbench/sales/orders` 整页 500。
//   修法（语义层）：`progressFromRecords` 按 `config/afterSales.isAfterSalesFulfillment` 认这三种状态，
//   在履约这一维按"已结清"算 ⇒ 不再计待交付（不是靠下面的兜底把它吞掉）。
test('⭐ 含「已换货」明细的订单不再让整页查询失败（明细行仍如实显示已换货）', async () => {
  const records = {
    salesEntry: [{ record_id: 'order_1', fields: { 资金状态: '已写入', 销售单号: 'XSD-HH' } }],
    salesDetail: [
      // 原明细行：售后把它改成了「已换货」（config/afterSales 的 originalFulfillmentStatus）
      { record_id: 'detail_1', fields: { 销售单号: ['order_1'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已换货', 实收金额: 220 } },
      // 换出去的新鞋：售后新建的明细行，「履约状态」= 已交付
      { record_id: 'detail_2', fields: { 销售单号: ['order_1'], 编号: ['product_2'], 尺码: ['size_39'], 履约状态: '已交付', 实收金额: 220 } },
    ],
    sizeManagement: [38, 39].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } })),
    paymentRecord: [{ record_id: 'receipt_1', fields: { 关联销售单: ['order_1'], 收款金额: 440, 收款状态: '已收款', 收款方式: ['method_1'] } }],
    paymentMethod: [{ record_id: 'method_1', fields: { 收款方式: '微信' } }],
    product: [1, 2].map((index) => ({ record_id: `product_${index}`, fields: { 编号: `P${index}` } })),
  };
  const gateway = { listAll: async (key) => records[key] || [], table: (key) => V1_BITABLE_SCHEMA.tables[key] };
  const result = await new SalesFollowupService({ gateway }).listOrders();
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].order_no, 'XSD-HH');
  assert.equal(result.orders[0].pending_delivery_quantity, 0,
    '换过的那一双 + 换出去的新鞋：履约这一维都已结清');
  assert.equal(result.orders[0].fulfillment_status, '已交付');
  // 明细行上仍**如实**显示各自的履约状态（工作台看得到"这一双换过"这个事实）
  assert.deepEqual(result.orders[0].details.map((detail) => detail.fulfillment_status), ['已换货', '已交付']);
});

// ⭐ 2026-10-08 小修（接口层兜底）：**单条订单出问题不许整页失败**。
//   跳过该单 + 记一条 warn（含 order_no / 原因），其余照常返回。
//   ⚠️ 这条兜底**不是静默吞错**：计算器对预期之外的状态照旧大声抛，这里如实把原因写进 warn。
test('⭐ 单条订单数据不自洽时：跳过该单 + 记 warn（含单号与原因），其余订单照常返回', async () => {
  const records = {
    salesEntry: [
      { record_id: 'order_bad', fields: { 资金状态: '已写入', 销售单号: 'XSD-BAD' } },
      { record_id: 'order_ok', fields: { 资金状态: '已写入', 销售单号: 'XSD-OK' } },
    ],
    salesDetail: [
      // 预期之外的履约状态（既不是 未交付/已交付，也不是三种售后取值）
      { record_id: 'detail_bad', fields: { 销售单号: ['order_bad'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已撤单', 实收金额: 100 } },
      { record_id: 'detail_ok', fields: { 销售单号: ['order_ok'], 编号: ['product_2'], 尺码: ['size_39'], 履约状态: '已交付', 实收金额: 80 } },
    ],
    sizeManagement: [38, 39].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } })),
    paymentRecord: [],
    paymentMethod: [],
    product: [1, 2].map((index) => ({ record_id: `product_${index}`, fields: { 编号: `P${index}` } })),
  };
  const gateway = { listAll: async (key) => records[key] || [], table: (key) => V1_BITABLE_SCHEMA.tables[key] };
  const captured = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { captured.push(args.map((value) => String(value)).join(' ')); };
  let result;
  try {
    result = await new SalesFollowupService({ gateway }).listOrders();
  } finally {
    console.warn = originalWarn;
  }
  // 坏单被跳过，好单照常返回（整页不失败）
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].order_no, 'XSD-OK');
  // 跳过这件事**可见**：一条 warn，带单号与原因
  const skipped = captured.filter((line) => line.includes('"event":"workbench.sales.orders.order_skipped"'));
  assert.equal(skipped.length, 1, `应恰好记一条 order_skipped warn，实际：${captured.join('\n')}`);
  assert.match(skipped[0], /XSD-BAD/);
  assert.match(skipped[0], /未知销售明细履约状态：已撤单/);
});
