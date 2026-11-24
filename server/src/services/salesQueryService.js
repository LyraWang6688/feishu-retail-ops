'use strict';

const { createSalesDeliveryReadService } = require('./salesDeliveryReadService');
const { SALES_QUERY } = require('../config/salesQuery');
const { ACCESSORY_SALE } = require('../config/accessorySale');

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const toDate = (value) => {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value);
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return new Date(Number(raw) < 1e12 ? Number(raw) * 1000 : Number(raw));
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
};
const dayKey = (date) => new Date(date.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
const todayKey = (now = new Date()) => dayKey(now);
const inRange = (value, from, to) => {
  const date = toDate(value);
  if (!date) return false;
  const key = dayKey(date);
  return key >= from && key <= to;
};

const createSalesQueryService = ({ gateway, deliveryRead, now = () => new Date() } = {}) => {
  if (!gateway && !deliveryRead) throw new Error('SalesQueryService requires gateway');
  const reader = deliveryRead || createSalesDeliveryReadService({ gateway });

  const getSalesQuery = async ({ from = '', to = '', productRecordId = '' } = {}) => {
    const today = todayKey(toDate(now()) || new Date());
    const fromText = String(from || today).trim();
    const toText = String(to || today).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromText) || !/^\d{4}-\d{2}-\d{2}$/.test(toText) || fromText > toText) {
      const error = new Error(SALES_QUERY.invalidRangeMessage);
      error.statusCode = 400;
      throw error;
    }
    const data = await reader.listDeliveryData({ query: true, from: fromText, to: toText });
    const payments = (data.all_payments || []).filter((row) => (
      SALES_QUERY.paymentStatuses.includes(row.status)
      && row.received_at != null
      && inRange(row.received_at, fromText, toText)
    ));
    const methodMap = new Map();
    for (const payment of payments) {
      const method = payment.method || SALES_QUERY.unknownMethod;
      const bucket = methodMap.get(method) || { amount: 0, count: 0 };
      bucket.amount += Number(payment.amount || 0);
      bucket.count += 1;
      methodMap.set(method, bucket);
    }
    const paymentMethods = [...methodMap.entries()]
      .map(([method, bucket]) => ({ method, amount: Math.round(bucket.amount * 100) / 100, count: bucket.count }))
      .sort((a, b) => b.amount - a.amount || a.method.localeCompare(b.method));
    const revenue = Math.round(paymentMethods.reduce((sum, item) => sum + item.amount, 0) * 100) / 100;
    const pendingMap = new Map();
    for (const payment of data.all_payments || []) {
      if (payment.status !== SALES_QUERY.pendingStatus || payment.received_at != null) continue;
      if (!inRange(payment.created_at, fromText, toText)) continue;
      const method = payment.method || SALES_QUERY.unknownMethod;
      const bucket = pendingMap.get(method) || { amount: 0, count: 0 };
      bucket.amount += Number(payment.amount || 0);
      bucket.count += 1;
      pendingMap.set(method, bucket);
    }
    const pendingMethods = [...pendingMap.entries()]
      .map(([method, bucket]) => ({ method, amount: Math.round(bucket.amount * 100) / 100, count: bucket.count }))
      .sort((a, b) => b.amount - a.amount || a.method.localeCompare(b.method));

    const allDetailRows = Array.isArray(data.all_details)
      ? data.all_details
      : (data.orders || []).flatMap((order) => (order.details || []).map((detail) => ({
        ...detail, recorded_at: order.recorded_at, order_no: order.order_no,
      })));
    const salesDetails = [];
    for (const detail of allDetailRows) {
      if (!SALES_QUERY.fulfillmentStatuses.includes(detail.fulfillment_status)) continue;
      if (!inRange(detail.sold_at ?? detail.recorded_at, fromText, toText)) continue;
      salesDetails.push(detail);
    }
    const emptyBucket = (name) => ({ name, delivered_count: 0, undelivered_count: 0, delivered_amount: 0, undelivered_amount: 0 });
    const groupDetails = (key) => {
      const map = new Map();
      for (const row of salesDetails) {
        const name = String(row[key] || '').trim() || SALES_QUERY.unknownGroup;
        if (!map.has(name)) map.set(name, emptyBucket(name));
        const bucket = map.get(name);
        const amount = Number(row.actual_amount || 0);
        if (row.fulfillment_status === SALES_QUERY.deliveredStatus) {
          bucket.delivered_count += 1;
          bucket.delivered_amount += amount;
        } else {
          bucket.undelivered_count += 1;
          bucket.undelivered_amount += amount;
        }
      }
      return [...map.values()]
        .map((item) => ({
          ...item,
          delivered_amount: Math.round(item.delivered_amount * 100) / 100,
          undelivered_amount: Math.round(item.undelivered_amount * 100) / 100,
        }))
        .sort((a, b) => b.delivered_count + b.undelivered_count - (a.delivered_count + a.undelivered_count)
          || a.name.localeCompare(b.name));
    };
    const delivered = salesDetails.filter((row) => row.fulfillment_status === SALES_QUERY.deliveredStatus);
    const undelivered = salesDetails.filter((row) => row.fulfillment_status === SALES_QUERY.undeliveredStatus);
    const sumAmount = (rows) => Math.round(rows.reduce((sum, row) => sum + Number(row.actual_amount || 0), 0) * 100) / 100;

    const productId = String(productRecordId || '').trim();
    const ordersInRange = (data.orders || [])
      .filter((order) => inRange(order.recorded_at, fromText, toText))
      // 销售明细按货品筛选时，保留包含该货品的整张订单（订单头与全部明细都不裁剪）。
      // 只认 recordId：同货号/同编号的重复记录只有 recordId 能区分；number 不参与过滤。
      .filter((order) => !productId || (order.details || []).some(
        (detail) => detail.product_record_id === productId,
      ));
    const bundledAccessoryAmount = ordersInRange.reduce((sum, order) => sum + Number(order.accessory_amount || 0), 0);
    const accessoryReceiptPrefix = `${ACCESSORY_SALE.receiptPrefix}-`;
    const standaloneAccessoryAmount = payments
      .filter((payment) => !payment.sales_entry_record_id
        && String(payment.receipt_id || '').startsWith(accessoryReceiptPrefix))
      .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    const accessorySalesAmount = Math.round((bundledAccessoryAmount + standaloneAccessoryAmount) * 100) / 100;
    const orders = ordersInRange
      .sort((a, b) => (toDate(b.recorded_at)?.getTime() || 0) - (toDate(a.recorded_at)?.getTime() || 0))
      .slice(0, SALES_QUERY.defaultOrderLimit)
      .map((order) => ({
        order_no: order.order_no,
        recorded_at: order.recorded_at,
        total_amount: order.payable_amount,
        gift: order.gift || '',
        accessory: order.accessory || '',
        accessory_amount: Number(order.accessory_amount || 0),
        payments: (order.payments || []).map((payment) => ({
          method: payment.method,
          amount: Number(payment.amount || 0),
          status: payment.status,
          trade_direction: payment.trade_direction || '',
        })),
        details: (order.details || []).map((detail) => ({
          number: detail.number || detail.product || '',
          color: detail.color || '',
          delisted: detail.delisted === true,
          size: detail.size,
          actual_amount: Number(detail.actual_amount || 0),
          fulfillment_status: detail.fulfillment_status || '',
        })),
      }));

    return {
      range: { from: fromText, to: toText },
      summary: {
        revenue,
        accessory_sales: { amount: accessorySalesAmount },
        payment_methods: paymentMethods,
        pending_methods: pendingMethods,
        delivered: { count: delivered.length, amount: sumAmount(delivered) },
        undelivered: { count: undelivered.length, amount: sumAmount(undelivered) },
        by_category: groupDetails('category_type'),
        by_type: groupDetails('category_name'),
      },
      orders,
    };
  };

  return { getSalesQuery };
};

module.exports = { createSalesQueryService };
