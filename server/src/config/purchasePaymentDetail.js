/**
 * 验收 → P发生明细（2026-11-19 业务负责人定稿）。
 * 每验收完一家供应商写一条；发生额 = 该供应商本次验收的货款金额；
 * 发生行为是 Lookup、最新余额先留空，创建/更新时间为飞书自动字段。
 */
module.exports = Object.freeze({
  targetTableKey: 'paymentDetail',
  idTemplate: '{batchNo}-{supplierName}',
  events: Object.freeze({
    created: 'purchase.payment_detail.created',
    skipped: 'purchase.payment_detail.skipped',
    failed: 'purchase.payment_detail.failed',
  }),
});
