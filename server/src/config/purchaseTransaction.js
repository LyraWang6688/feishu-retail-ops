/**
 * 验收 / 退货 → P交易明细（2026-11-20 业务负责人定稿）。
 * 只写：交易明细ID = 批次号-供应商名；报货批次号 = 供应主表关联。
 * P发生明细已删除，不再使用。
 */
module.exports = Object.freeze({
  targetTableKey: 'paymentTransaction',
  idTemplate: '{batchNo}-{supplierName}',
  events: Object.freeze({
    created: 'purchase.payment_transaction.created',
    skipped: 'purchase.payment_transaction.skipped',
    failed: 'purchase.payment_transaction.failed',
  }),
});
