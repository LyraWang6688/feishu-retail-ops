const test = require('node:test');
const assert = require('node:assert/strict');
const { progressFromRecords } = require('../src/services/salesProgressService');

const detailFields = { actualAmount: '成交金额', quantity: '数量', deliveredQuantity: '交付数量' };
const paymentFields = { amount: '收款金额', status: '收款状态' };
const shoe = (amount, quantity = 1, delivered = 0) => ({ fields: {
  成交金额: amount, 数量: quantity, 交付数量: delivered,
} });
const receipt = (amount, status) => ({ fields: { 收款金额: amount, 收款状态: status } });

test('platform voucher is not cash received or a customer balance', () => {
  const result = progressFromRecords([shoe(254.4, 1, 1)],
    [receipt(169, '已收清'), receipt(85.4, '待平台结算')], detailFields, paymentFields);
  assert.equal(result.paidAmount, 169);
  assert.equal(result.platformPendingAmount, 85.4);
  assert.equal(result.pendingAmount, 0);
  assert.equal(result.paymentStatus, '待平台结算');
  assert.equal(result.orderStatus, '已确认');
  const settled = progressFromRecords([shoe(254.4, 1, 1)],
    [receipt(169, '已收清'), receipt(85.4, '已收清')], detailFields, paymentFields);
  assert.equal(settled.paidAmount, 254.4);
  assert.equal(settled.paymentStatus, '已收清');
});

test('cash sale is fully paid and delivered only when both facts exist', () => {
  const result = progressFromRecords([shoe(220, 1, 1)], [receipt(220)], detailFields, paymentFields);
  assert.equal(result.paymentStatus, '已收清');
  assert.equal(result.fulfillmentStatus, '已交付');
  assert.equal(result.orderStatus, '已完成');
  assert.equal(result.pendingAmount, 0);
});

test('deposit creates pending collection and pending delivery without placeholder receipt', () => {
  const result = progressFromRecords([shoe(180)], [receipt(50)], detailFields, paymentFields);
  assert.equal(result.pendingAmount, 130);
  assert.equal(result.paymentStatus, '部分收款');
  assert.equal(result.pendingDeliveryQuantity, 1);
  assert.equal(result.fulfillmentStatus, '未交付');
});

test('delivered unpaid order remains in collection queue', () => {
  const result = progressFromRecords([shoe(260, 1, 1)], [], detailFields, paymentFields);
  assert.equal(result.pendingAmount, 260);
  assert.equal(result.paymentStatus, '未收款');
  assert.equal(result.fulfillmentStatus, '已交付');
});

test('multiple shoes and mixed receipts stay on one order', () => {
  const result = progressFromRecords([shoe(89, 1, 1), shoe(59), shoe(39, 1, 1)],
    [receipt(100), receipt(87)], detailFields, paymentFields);
  assert.equal(result.receivableAmount, 187);
  assert.equal(result.paidAmount, 187);
  assert.equal(result.pendingDeliveryQuantity, 1);
  assert.equal(result.fulfillmentStatus, '部分交付');
});

test('an old detail with no actual amount is not shown as zero-amount debt', () => {
  const result = progressFromRecords([shoe('', 1, 0)], [], detailFields, paymentFields);
  assert.equal(result.receivableAmount, null);
  assert.equal(result.pendingAmount, null);
  assert.equal(result.paymentStatus, '');
});
