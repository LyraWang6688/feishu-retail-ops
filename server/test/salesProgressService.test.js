const test = require('node:test');
const assert = require('node:assert/strict');
const { progressFromRecords } = require('../src/services/salesProgressService');

const detailFields = { actualAmount: '成交金额', fulfillmentStatus: '履约状态' };
const paymentFields = { amount: '收款金额', status: '收款状态' };
const shoe = (amount, delivered = false) => ({ fields: {
  成交金额: amount, 履约状态: delivered ? '已交付' : '未交付',
} });
const receipt = (amount, status) => ({ fields: { 收款金额: amount, 收款状态: status } });

test('platform voucher is not cash received or a customer balance', () => {
  const result = progressFromRecords([shoe(254.4, true)],
    [receipt(169, '已收清'), receipt(85.4, '待平台结算')], detailFields, paymentFields);
  assert.equal(result.paidAmount, 169);
  assert.equal(result.platformPendingAmount, 85.4);
  assert.equal(result.pendingAmount, 0);
  assert.equal(result.paymentStatus, '待平台结算');
  assert.equal(result.orderStatus, '已确认');
  const settled = progressFromRecords([shoe(254.4, true)],
    [receipt(169, '已收清'), receipt(85.4, '已收清')], detailFields, paymentFields);
  assert.equal(settled.paidAmount, 254.4);
  assert.equal(settled.paymentStatus, '已收款');
});

test('cash sale is fully paid and delivered only when both facts exist', () => {
  const result = progressFromRecords([shoe(220, true)], [receipt(220)], detailFields, paymentFields);
  assert.equal(result.paymentStatus, '已收款');
  assert.equal(result.fulfillmentStatus, '已交付');
  assert.equal(result.orderStatus, '已完成');
  assert.equal(result.pendingAmount, 0);
});

test('deposit creates pending collection and pending delivery without placeholder receipt', () => {
  const result = progressFromRecords([shoe(180)],
    [receipt(50, '已收款'), receipt(130, '未收款')], detailFields, paymentFields);
  assert.equal(result.pendingAmount, 130);
  assert.equal(result.paymentStatus, '部分收款');
  assert.equal(result.pendingDeliveryQuantity, 1);
  assert.equal(result.fulfillmentStatus, '未交付');
});

test('delivered unpaid order remains in collection queue', () => {
  const result = progressFromRecords([shoe(260, true)], [], detailFields, paymentFields);
  assert.equal(result.pendingAmount, 260);
  assert.equal(result.paymentStatus, '未收款');
  assert.equal(result.fulfillmentStatus, '已交付');
});

test('multiple shoes and mixed receipts stay on one order', () => {
  const result = progressFromRecords([shoe(89, true), shoe(59), shoe(39, true)],
    [receipt(100), receipt(87)], detailFields, paymentFields);
  assert.equal(result.receivableAmount, 187);
  assert.equal(result.paidAmount, 187);
  assert.equal(result.pendingDeliveryQuantity, 1);
  assert.equal(result.fulfillmentStatus, '部分交付');
});

test('an old detail with no actual amount is not shown as zero-amount debt', () => {
  const result = progressFromRecords([shoe('')], [], detailFields, paymentFields);
  assert.equal(result.receivableAmount, null);
  assert.equal(result.pendingAmount, null);
  assert.equal(result.paymentStatus, '');
});

// ⭐ 2026-10-08 售后退货口径：退货"改原收款状态"会把**原单**的收款行改成 已退款 / 已留存
//（业务负责人逐字：「把收款改成"已退款"……用户留存，那就是已留存」）。
// 这两个取值必须被进度口径**认出来**，否则原单的每一次进度计算都会抛「未知收款状态」。
test('⭐ 售后的「已退款 / 已留存」不再是"未知收款状态"（按已结清算，且不制造假欠款）', () => {
  for (const status of ['已退款', '已留存']) {
    const result = progressFromRecords([shoe(250, true)], [receipt(250, status)], detailFields, paymentFields);
    assert.equal(result.paidAmount, 250, `${status}：金额仍算作已结清（与改动前一致）`);
    assert.equal(result.pendingAmount, 0, `${status}：不许把退过款的单算成"客户还欠钱"`);
    assert.equal(result.paymentStatus, '已收款');
  }
  // 混合：一笔已退款 + 一笔未收款占位 → 只把占位算成待收（退款那笔不参与待收）
  const mixed = progressFromRecords([shoe(300)],
    [receipt(300, '已退款'), receipt(0, '未收款')], detailFields, paymentFields);
  assert.equal(mixed.pendingAmount, 0);
  // 别的取值仍然要**大声抛**（不许把未知状态当成已知）
  assert.throws(() => progressFromRecords([shoe(250, true)], [receipt(250, '红包')], detailFields, paymentFields),
    /未知收款状态：红包/);
});

// ⭐ 2026-10-08 小修（线上工单 bug，业务负责人批准的"小修"）：
//   售后会把**原销售明细行**的「履约状态」改成 已退货 / 已换货 / 已赔货
//   （判据 = config/afterSales.isAfterSalesFulfillment；取值见 AFTER_SALES_FULFILLMENT）。
//   这三种取值以前会抛「未知销售明细履约状态」⇒ **一条明细把整页工作台订单列表打成 500**：
//     2026-10-08 01:41（+8）event=workbench.sales.orders.failed
//     request_id=fe605d92-b824-4e4f-b86c-ab3c44502829 error="未知销售明细履约状态：已换货"
//   口径（唯一的判据来源是 config/afterSales，别新造一份中文）：
//     **这条明细在履约这一维"已结清" ⇒ 不再计待交付**，归到既有的「已交付」档。
test('⭐ 售后的「已退货 / 已换货 / 已赔货」不再是"未知销售明细履约状态"（按这一维已结清算）', () => {
  const inStatus = (amount, status) => ({ fields: { 成交金额: amount, 履约状态: status } });
  for (const status of ['已退货', '已换货', '已赔货']) {
    // 同一张单：一条已交付 + 一条售后件。与"那一条写已交付"逐字段对照 ——
    // 这就是"归到既有档位、不改待交付/待收算法"的证据。
    const afterSales = progressFromRecords([shoe(250, true), inStatus(120, status)],
      [receipt(250)], detailFields, paymentFields);
    const sameAsDelivered = progressFromRecords([shoe(250, true), shoe(120, true)],
      [receipt(250)], detailFields, paymentFields);
    assert.deepEqual(afterSales, sameAsDelivered, `${status}：口径必须与"这一条=已交付"完全一致`);
    assert.equal(afterSales.pendingDeliveryQuantity, 0, `${status}：不再计待交付`);
    assert.equal(afterSales.fulfillmentStatus, '已交付', `${status}：这一维按已结清算`);
    assert.equal(afterSales.receivableAmount, 370, `${status}：待收口径不变（金额照记）`);
  }
  // 一张**全是**售后件的单：不许算成"没有明细 ⇒ 未交付"（那与事实相反）。
  const onlyAfterSales = progressFromRecords([inStatus(0, '已赔货')], [], detailFields, paymentFields);
  assert.equal(onlyAfterSales.quantity, 1);
  assert.equal(onlyAfterSales.pendingDeliveryQuantity, 0);
  assert.equal(onlyAfterSales.fulfillmentStatus, '已交付');
  // ⚠️ 但**预期之外**的履约状态仍然要**大声抛**（不许把"兜底"做进计算器）。
  assert.throws(() => progressFromRecords([shoe(250, true), inStatus(120, '已撤单')], [], detailFields, paymentFields),
    /未知销售明细履约状态：已撤单/);
});
