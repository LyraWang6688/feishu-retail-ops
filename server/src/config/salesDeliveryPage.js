'use strict';

/**
 * 「销售 → 交割单」页面**只读数据源**的字段清单（配置先行）。
 *
 * 口径（业务负责人 2026-10-29 定稿）：
 *   · 判断只看两张表：销售明细（履约状态）+ 收款明细（收款状态），按销售单号关联；
 *   · 销售主表只用于把两边统一到「销售单号」；货品信息/颜色管理/尺码管理/收款方式管理只用于显示。
 *
 * ⚠️ 只读；这里一个写入点都没有，也不改任何业务表。
 */
/** 业务负责人 2026-10-29：待付 = 同一销售单号下「收款状态 = 未收款」的金额合计。 */
const UNPAID_PAYMENT_STATUS = '未收款';
/** 页面只读「销售明细.库存数量」公式列（v1 schema 暂无语义键，页面配置里单独登记）。 */
const SALES_DETAIL_STOCK_FIELD = '库存数量';

const DELIVERY_PAYMENT = Object.freeze({
  paidStatus: '已收款',
  platformPendingStatus: '待平台结算',
  errors: Object.freeze({
    badRequestId: '付款请求缺少有效 request_id',
    missingOrder: '付款缺少销售主表 record_id',
    badAmount: '收款金额必须是大于 0 的两位小数',
    missingMethod: '付款缺少收款方式',
    methodNotFound: '收款方式不存在',
    orderNotFound: '销售订单不存在',
    orderNotPosted: '销售订单尚未确认入账',
    noPending: '没有待收款记录',
    multiplePending: '存在多条待收款记录，请先人工核对',
    badPendingAmount: '待收款金额无效',
    overPending: (amount) => `本次付款超过待付金额 ￥${amount}`,
    requestMismatch: 'request_id 对应的付款内容不一致',
    retryPending: '这次付款结果待核对，请勿重新提交',
  }),
});

const TABLE_FIELD_KEYS = Object.freeze({
  salesEntry: Object.freeze(['orderNo', 'recordedAt', 'totalAmount']),
  salesDetail: Object.freeze(['salesEntry', 'product', 'size', 'fulfillmentStatus', 'stockQuantity']),
  paymentRecord: Object.freeze(['salesEntry', 'method', 'amount', 'status']),
  product: Object.freeze(['itemNo', 'color']),
  color: Object.freeze(['name']),
  sizeManagement: Object.freeze(['size']),
  paymentMethod: Object.freeze(['name']),
});

module.exports = { TABLE_FIELD_KEYS, UNPAID_PAYMENT_STATUS, DELIVERY_PAYMENT, SALES_DETAIL_STOCK_FIELD };
