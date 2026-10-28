'use strict';

/**
 * 「销售 → 交割单」页的**只读数据服务**（2026-10-29 定稿）。
 *
 * 🔴 判断只看两张表：
 *   · 销售明细：`履约状态 != 已交付` ⇒ 货没交清；
 *   · 收款明细：`收款状态 == 未收款` ⇒ 钱没交清；
 *   · 按「销售单号」把两边对起来（销售主表只用于把两边统一到销售单号）。
 * 货品信息 / 颜色管理 / 尺码管理 / 收款方式管理只用于显示（货号/颜色/尺码/收款方式）。
 *
 * 返回形状兼容 `features/sales-delivery` 的纯函数：
 *   `{ methods, orders: [{ sales_entry_record_id, order_no, recorded_at, payable_amount, pending_amount, details, payments }] }`
 *
 * 🔴 只读：本文件没有任何写入方法，也不新增写库路径。
 */
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { TABLE_FIELD_KEYS, UNPAID_PAYMENT_STATUS, SALES_DETAIL_STOCK_FIELD } = require('../config/salesDeliveryPage');
const { createPaymentMethodsService, orderWithPreferred } = require('./paymentMethodsService');
const { SCAN_WRITE } = require('../config/scanWrite');
const { resolveOrderReadRetryConfig, isRetriableOrderReadError } = require('../config/orderReadRetry');
const { logWarn } = require('../utils/logger');

const createSalesDeliveryReadService = ({ gateway, paymentMethods, orderReadRetry, sleep } = {}) => {
  if (!gateway) throw new Error('SalesDeliveryReadService requires gateway');
  const retry = orderReadRetry || resolveOrderReadRetryConfig();
  const wait = sleep || ((ms) => (ms > 0 ? new Promise((resolve) => { setTimeout(resolve, ms); }) : Promise.resolve()));

  /** 只读：瞬时错误按既有判据重试；确定性错误/次数用完 ⇒ 抛原错。 */
  const listAllWithRetry = async (tableKey, options = {}) => {
    const maxRetries = Math.max(0, Number(retry?.maxRetries) || 0);
    const delayMs = Math.max(0, Number(retry?.delayMs) || 0);
    for (let attempt = 0; ; attempt += 1) {
      const startedAt = Date.now();
      try {
        return await gateway.listAll(tableKey, options);
      } catch (error) {
        const left = maxRetries - attempt;
        if (!isRetriableOrderReadError(error) || left <= 0) throw error;
        const waitMs = delayMs * (attempt + 1);
        logWarn('workbench.sales.orders.read_retry', {
          table_key: tableKey, reason: 'read_retry', operation: 'sales_delivery',
          attempt: attempt + 1, of: maxRetries + 1, delay_ms: waitMs,
          duration_ms: Date.now() - startedAt, error: error?.message,
        });
        await wait(waitMs);
      }
    }
  };

  const fieldOptions = (tableKey) => {
    const fields = gateway.table?.(tableKey)?.fields || {};
    const names = (TABLE_FIELD_KEYS[tableKey] || []).map((key) => fields[key]).filter(Boolean);
    return names.length ? { fieldNames: names } : {};
  };

  const listDeliveryData = async () => {
    const methodsService = paymentMethods || createPaymentMethodsService(gateway);
    const [orders, details, payments, products, colors, sizes, methodList] = await Promise.all([
      listAllWithRetry('salesEntry', fieldOptions('salesEntry')),
      listAllWithRetry('salesDetail', fieldOptions('salesDetail')),
      listAllWithRetry('paymentRecord', fieldOptions('paymentRecord')),
      listAllWithRetry('product', fieldOptions('product')),
      listAllWithRetry('color', fieldOptions('color')),
      listAllWithRetry('sizeManagement', fieldOptions('sizeManagement')),
      methodsService.listWithVouchers(),
    ]);

    const orderFields = gateway.table('salesEntry').fields;
    const detailFields = gateway.table('salesDetail').fields;
    const paymentFields = gateway.table('paymentRecord').fields;
    const productFields = gateway.table('product').fields;
    const colorFields = gateway.table('color').fields;
    const sizeFields = gateway.table('sizeManagement').fields;

    const orderNoById = new Map(orders
      .map((order) => [order.record_id, textValue(order.fields?.[orderFields.orderNo]).trim()])
      .filter(([, orderNo]) => orderNo !== ''));
    const recordedAtById = new Map(orders.map((order) => [order.record_id, order.fields?.[orderFields.recordedAt] ?? null]));
    // 业务负责人 2026-10-29：应付 = 销售主表.总金额；同一单号取第一条非空总金额。
    const totalAmountById = new Map(orders.map((order) => [order.record_id, order.fields?.[orderFields.totalAmount] ?? null]));
    const colorNameById = new Map(colors.map((item) => [item.record_id, textValue(item.fields?.[colorFields.name]).trim()]));
    const sizeValueById = new Map(sizes.map((item) => [item.record_id, textValue(item.fields?.[sizeFields.size]).trim()]));
    const methodRows = methodList?.ok ? methodList.items : [];
    const methodNameById = new Map(methodRows.map((item) => [item.recordId, item.name]));
    const productById = new Map(products.map((item) => [item.record_id, {
      productNo: textValue(item.fields?.[productFields.itemNo]).trim(),
      colorId: linkedRecordIds(item.fields?.[productFields.color])[0] || '',
    }]));

    // 按「销售单号」合并：同一单号即使来自不同销售主表记录，也归成一组（业务口径）。
    const groups = new Map();
    const groupOf = (orderId) => {
      const orderNo = orderNoById.get(orderId) || orderId;
      if (!groups.has(orderNo)) groups.set(orderNo, { salesEntryRecordId: orderId, orderNo, recordedAt: recordedAtById.get(orderId) ?? null, totalAmount: totalAmountById.get(orderId) ?? null, rawDetails: [], rawPayments: [] });
      return groups.get(orderNo);
    };
    for (const detail of details) {
      const orderId = linkedRecordIds(detail.fields?.[detailFields.salesEntry])[0] || '';
      if (orderId) groupOf(orderId).rawDetails.push(detail);
    }
    for (const payment of payments) {
      const orderId = linkedRecordIds(payment.fields?.[paymentFields.salesEntry])[0] || '';
      if (orderId) groupOf(orderId).rawPayments.push(payment);
    }

    const result = [];
    for (const group of groups.values()) {
      const detailRows = group.rawDetails.map((detail) => {
        const productId = linkedRecordIds(detail.fields?.[detailFields.product])[0] || '';
        const product = productById.get(productId);
        const sizeId = linkedRecordIds(detail.fields?.[detailFields.size])[0] || '';
        const sizeText = sizeValueById.get(sizeId) || '';
        return {
          record_id: detail.record_id,
          // 页面显示「货号」= 货品信息.货号（不是 编号 公式）。
          product: product?.productNo || '',
          product_record_id: productId,
          color: product?.colorId ? (colorNameById.get(product.colorId) || '') : '',
          size: sizeText === '' ? null : (Number.isFinite(Number(sizeText)) ? Number(sizeText) : sizeText),
          fulfillment_status: textValue(detail.fields?.[detailFields.fulfillmentStatus]) || '',
          stock_quantity: (() => {
            const stockField = detailFields.stockQuantity || SALES_DETAIL_STOCK_FIELD;
            const raw = textValue(detail.fields?.[stockField]).trim();
            return raw === '' || !Number.isFinite(Number(raw)) ? null : Number(raw);
          })(),
        };
      });
      const paymentRows = group.rawPayments.map((payment) => ({
        record_id: payment.record_id,
        status: textValue(payment.fields?.[paymentFields.status]) || '',
        amount: Number(textValue(payment.fields?.[paymentFields.amount])) || 0,
        method: methodNameById.get(linkedRecordIds(payment.fields?.[paymentFields.method])[0] || '') || '',
      }));
      // 业务负责人 2026-10-29：待付 = 同一销售单号下「收款状态 = 未收款」的收款金额合计。
      const pendingAmount = paymentRows
        .filter((payment) => payment.status === UNPAID_PAYMENT_STATUS)
        .reduce((total, payment) => total + payment.amount, 0);
      result.push({
        sales_entry_record_id: group.salesEntryRecordId,
        order_no: group.orderNo,
        recorded_at: group.recordedAt,
        details: detailRows,
        payments: paymentRows,
        payable_amount: group.totalAmount == null || group.totalAmount === '' ? null : Number(group.totalAmount),
        pending_amount: pendingAmount,
      });
    }

    return {
      methods: orderWithPreferred(methodRows.map((item) => item.name), SCAN_WRITE.sale.defaultPaymentMethod),
      orders: result,
    };
  };

  return { listDeliveryData, listAllWithRetry };
};

module.exports = { createSalesDeliveryReadService };
