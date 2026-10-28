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

const TABLE_FIELD_KEYS = Object.freeze({
  salesEntry: Object.freeze(['orderNo', 'recordedAt', 'totalAmount']),
  salesDetail: Object.freeze(['salesEntry', 'product', 'size', 'fulfillmentStatus']),
  paymentRecord: Object.freeze(['salesEntry', 'method', 'amount', 'status']),
  product: Object.freeze(['itemNo', 'color']),
  color: Object.freeze(['name']),
  sizeManagement: Object.freeze(['size']),
  paymentMethod: Object.freeze(['name']),
});

module.exports = { TABLE_FIELD_KEYS, UNPAID_PAYMENT_STATUS };
