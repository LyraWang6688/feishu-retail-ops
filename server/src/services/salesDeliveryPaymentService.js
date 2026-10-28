'use strict';

/**
 * 「销售 → 交割单」页：付款写库（只读页唯一写入口，复用既有收款明细模型）。
 *
 * 业务负责人 2026-10-29 定：
 *   · 一次性付清：改原「未收款」记录 —— 状态/收款方式/收款日/交易方向（券则待平台结算，不写日期/方向）；
 *   · 没付清：新增一条已收款（券则待平台结算），原未收款金额改成剩余；
 *   · 收款方式单选；团购券口径沿用 PaymentService；
 *   · 一单只允许一条未收款；多条 => 人工核对；金额 > 待付 / ≤0 => 拒绝。
 *
 * 🔴 不新增收款表、不写销售主表；`关联销售单` 由飞书双向关联自动挂到主表「收款明细」。
 */
const crypto = require('node:crypto');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { relation } = require('./v1ReferenceResolver');
const { postedOf, isPosted } = require('../config/salesStatusDimensions');
const { UNPAID_PAYMENT_STATUS, DELIVERY_PAYMENT } = require('../config/salesDeliveryPage');
const { logWarn } = require('../utils/logger');
const cents = (value) => Math.round(Number(value) * 100);
const E = DELIVERY_PAYMENT.errors;

const createSalesDeliveryPaymentService = ({ gateway, payments, store, now = Date.now } = {}) => {
  if (!gateway || !payments || !store) throw new Error('SalesDeliveryPaymentService requires gateway/payments/store');
  let queue = Promise.resolve();

  const pay = async (input = {}) => {
    const requestId = String(input.requestId || '');
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error(E.badRequestId);
    const salesEntryRecordId = String(input.salesEntryRecordId || '').trim();
    if (!salesEntryRecordId) throw new Error(E.missingOrder);
    const value = Number(input.amount);
    if (!Number.isFinite(value) || value <= 0 || Math.abs(cents(value) - value * 100) > 1e-6) {
      throw new Error(E.badAmount);
    }
    const methodName = String(input.method || '').trim();
    if (!methodName) throw new Error(E.missingMethod);
    const operatorOpenId = String(input.operatorOpenId || '').trim();
    const fingerprint = JSON.stringify([salesEntryRecordId, methodName, value, operatorOpenId]);
    const taskId = `delivery_payment_${crypto.createHash('sha256').update(requestId).digest('hex').slice(0, 24)}`;

    const work = async () => {
      const existing = await store.get(taskId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error(E.requestMismatch);
        if (existing.status === 'completed') return existing.result;
        throw new Error(E.retryPending);
      }

      const method = await payments.references.resolvePaymentMethod(methodName);
      if (!method) throw new Error(E.methodNotFound);
      const order = await gateway.get('salesEntry', salesEntryRecordId);
      if (!order) throw new Error(E.orderNotFound);
      const entryFields = gateway.table('salesEntry').fields;
      if (!isPosted(postedOf(order, entryFields))) throw new Error(E.orderNotPosted);

      const paymentFields = gateway.table('paymentRecord').fields;
      const pendingRows = (await payments.recordsForSale(salesEntryRecordId)).filter((record) =>
        textValue(record.fields?.[paymentFields.status]) === UNPAID_PAYMENT_STATUS);
      if (!pendingRows.length) throw new Error(E.noPending);
      if (pendingRows.length > 1) throw new Error(E.multiplePending);
      const pendingRow = pendingRows[0];
      const pendingAmount = Number(textValue(pendingRow.fields?.[paymentFields.amount]));
      if (!Number.isFinite(pendingAmount) || pendingAmount <= 0) throw new Error(E.badPendingAmount);
      if (cents(value) > cents(pendingAmount)) throw new Error(E.overPending(pendingAmount));

      const methodFields = gateway.table('paymentMethod').fields;
      const isVoucher = linkedRecordIds(method.record?.fields?.[methodFields.voucher]).length > 0;
      const isFull = cents(value) === cents(pendingAmount);

      await store.create({ task_id: taskId, fingerprint, status: 'pending' });
      let result;
      if (isFull) {
        if (isVoucher) {
          await gateway.update('paymentRecord', pendingRow.record_id, {
            [paymentFields.status]: DELIVERY_PAYMENT.platformPendingStatus,
            [paymentFields.method]: method.recordId ? relation(method.recordId) : undefined,
          });
          result = { recordId: pendingRow.record_id, pendingAmount: 0, status: DELIVERY_PAYMENT.platformPendingStatus };
        } else {
          await payments.collectPendingReceipt(pendingRow.record_id, {
            salesEntryRecordId, amount: pendingAmount, method: methodName, receivedAt: now(),
          });
          result = { recordId: pendingRow.record_id, pendingAmount: 0, status: DELIVERY_PAYMENT.paidStatus };
        }
      } else {
        const created = await payments.record({
          salesEntryRecordId, method: methodName, amount: value, receivedAt: now(),
        });
        const remaining = Math.max(0, Math.round((pendingAmount - value) * 100) / 100);
        await gateway.update('paymentRecord', pendingRow.record_id, { [paymentFields.amount]: remaining });
        result = { recordId: created.recordId, pendingAmount: remaining, status: isVoucher ? DELIVERY_PAYMENT.platformPendingStatus : DELIVERY_PAYMENT.paidStatus };
      }
      await store.update(taskId, { status: 'completed', result });
      return result;
    };

    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next.catch((error) => {
      logWarn('workbench.sales.payment.failed', { reason: 'delivery_payment', error: error.message });
      throw error;
    });
  };

  return { pay };
};

module.exports = { createSalesDeliveryPaymentService };
