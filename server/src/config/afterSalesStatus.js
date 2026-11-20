'use strict';

/**
 * 售后状态判据（只保留跨链路共用的纯配置）。
 *
 * 旧售后执行器（`services/afterSalesService.js`）与它的动作配置已整体删除；
 * 这里只留下订单列表 / 二次交付要用的两个判据，避免把已删执行器的配置再带回来。
 */
const AFTER_SALES_FULFILLMENT = Object.freeze({
  RETURNED: '已退货',
  EXCHANGED: '已换货',
  COMPENSATED: '已赔货',
  DELIVERED: '已交付',
});

const AFTER_SALES_FULFILLMENT_EXCLUDED = Object.freeze([
  AFTER_SALES_FULFILLMENT.RETURNED,
  AFTER_SALES_FULFILLMENT.EXCHANGED,
  AFTER_SALES_FULFILLMENT.COMPENSATED,
]);

/** 这一条明细的履约状态是不是「退过 / 换过 / 赔过」（唯一判据，两边共用）。 */
const isAfterSalesFulfillment = (status) => AFTER_SALES_FULFILLMENT_EXCLUDED
  .includes(String(status ?? '').trim());

const AFTER_SALES_PAYMENT_STATUS = Object.freeze({
  REFUNDED: '已退款',
  RETAINED: '已留存',
});

const AFTER_SALES_SETTLED_PAYMENT_STATUSES = Object.freeze([
  AFTER_SALES_PAYMENT_STATUS.REFUNDED,
  AFTER_SALES_PAYMENT_STATUS.RETAINED,
]);

/** 这个收款状态是不是「售后已经处理完、不再挂账」（进度口径里按已结清算）。 */
const isSettledAfterSalesPaymentStatus = (status) => AFTER_SALES_SETTLED_PAYMENT_STATUSES
  .includes(String(status ?? '').trim());

module.exports = {
  AFTER_SALES_FULFILLMENT,
  AFTER_SALES_FULFILLMENT_EXCLUDED,
  isAfterSalesFulfillment,
  AFTER_SALES_PAYMENT_STATUS,
  AFTER_SALES_SETTLED_PAYMENT_STATUSES,
  isSettledAfterSalesPaymentStatus,
};
