/**
 * 「销售交割单」页的**数据层**：真实只读接口 + 归一化（无 DOM）。
 *
 * 接口：`GET /api/workbench/sales/delivery`（销售域只读；只看销售明细 + 收款明细）。
 * 归一化后只保留页面要用的字段（字段名来自 `config/sales-delivery.js` 的 `SALES_DELIVERY_FIELDS`）
 * ⇒ filter / group / sort / render 都不认识接口的原始字段名。
 */

import { textOf, timestampOf } from './format.js';

const numberOrZero = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};
const numberOrNull = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** 三个 tab 的日期唯一来源：销售主表「录单日」（created_at）；没有就归「销售日未填」。 */
export const soldAtOf = (recordedAt = null) => {
  const at = timestampOf(recordedAt);
  return at == null
    ? { at: null, source: 'missing' }
    : { at, source: 'sales_entry_recorded_at' };
};

export const normalizeDetail = (line = {}, fields = {}) => ({
  recordId: textOf(line[fields.recordId]).trim(),
  product: textOf(line[fields.product]).trim(),
  accessory: textOf(line[fields.accessory]).trim(),
  color: textOf(line[fields.color]).trim(),
  size: textOf(line[fields.size]).trim(),
  fulfillmentStatus: textOf(line[fields.fulfillmentStatus]).trim(),
  stockQuantity: numberOrNull(line[fields.stockQuantity]),
  actualAmount: numberOrNull(line[fields.actualAmount]),
});

export const normalizePayment = (payment = {}, fields = {}) => ({
  recordId: textOf(payment[fields.recordId]).trim(),
  method: textOf(payment[fields.method]).trim(),
  amount: numberOrZero(payment[fields.amount]),
  status: textOf(payment[fields.status]).trim(),
});

export const normalizeOrder = (order = {}, fields = {}) => {
  const details = (Array.isArray(order[fields.details]) ? order[fields.details] : [])
    .map((line) => normalizeDetail(line, fields.detail || {}));
  const payments = (Array.isArray(order[fields.payments]) ? order[fields.payments] : [])
    .map((payment) => normalizePayment(payment, fields.payment || {}));
  const soldAt = soldAtOf(order[fields.recordedAt]);
  return {
    recordId: textOf(order[fields.recordId]).trim(),
    salesEntryRecordId: textOf(order[fields.salesEntryRecordId]).trim(),
    orderNo: textOf(order[fields.orderNo]).trim(),
    recordedAt: order[fields.recordedAt] ?? null,
    soldAt: soldAt.at,
    soldAtSource: soldAt.source,
    payableAmount: numberOrNull(order[fields.payableAmount]),
    pendingAmount: numberOrZero(order[fields.pendingAmount]),
    pendingDeliveryQuantity: numberOrZero(order[fields.pendingDeliveryQuantity]),
    details,
    payments,
  };
};

export const normalizeOrders = (orders = [], fields = {}) => (Array.isArray(orders) ? orders : [])
  .filter(Boolean)
  .map((order) => normalizeOrder(order, fields))
  .filter((order) => order.orderNo !== '');

/** 拉一次真实只读接口；网络错误原样抛给页面（显示失败态/重试）。 */
export const fetchDeliveryData = async (apiClient, config, fields) => {
  const data = await apiClient.get(config.api.delivery);
  return {
    methods: Array.isArray(data?.[fields.methods])
      ? data[fields.methods].map((item) => textOf(item).trim()).filter(Boolean)
      : [],
    orders: normalizeOrders(data?.orders, fields),
  };
};
