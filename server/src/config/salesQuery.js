/**
 * 销售查询（只读）配置。
 * 2026-11-18 业务负责人确认的口径：
 *   · 营业总额 = S交易明细 收付日在区间内、钱款状态 ∈ {已收款, 待平台结算}
 *   · 销售数量 = 销售明细 销售日在区间内、履约状态 ∈ {已交付, 未交付}
 */
const SALES_QUERY = Object.freeze({
  paymentStatuses: Object.freeze(['已收款', '待平台结算']),
  fulfillmentStatuses: Object.freeze(['已交付', '未交付']),
  deliveredStatus: '已交付',
  undeliveredStatus: '未交付',
  pendingStatus: '待平台结算',
  unknownGroup: '未分类',
  unknownMethod: '未标注方式',
  invalidRangeMessage: '日期范围不合法',
  defaultOrderLimit: 500,
});

module.exports = { SALES_QUERY };
