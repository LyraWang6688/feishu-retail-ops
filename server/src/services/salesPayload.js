'use strict';

/**
 * 销售提交 payload（2026-10-27 · 异步销售链路）。
 *
 * 原则：**先把用户填的信息完整收集、校验、冻结**，再入队；后台只认这份 payload。
 * 这里不写飞书、不读飞书，只做纯函数校验/归并。
 */

const { SCAN_WRITE } = require('../config/scanWrite');
const asText = (value) => String(value ?? '').trim();
const asCents = (value) => {
  const text = asText(value).replace(/[¥,\s]/g, '');
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return null;
  // 金额按分取整，避免浮点累加误差
  return Math.round(n * 100);
};
const centsToYuan = (cents) => Math.round(cents) / 100;

const normalizeLine = (line = {}, index) => {
  const productRecordId = asText(line.productRecordId ?? line.product_record_id);
  const size = Number(line.size ?? line.size_text);
  const amountCents = asCents(line.actualAmount ?? line.actual_amount ?? line.amount);
  const errors = [];
  if (!productRecordId) errors.push({ code: 'line_product_missing', index });
  if (!Number.isInteger(size) || size <= 0) errors.push({ code: 'line_size_missing', index });
  if (amountCents === null) errors.push({ code: 'line_amount_missing', index });
  return {
    errors,
    line: {
      product_record_id: productRecordId,
      size: Number.isInteger(size) ? size : null,
      trade_type: asText(line.tradeTypeCode ?? line.trade_type ?? line.tradeType).toUpperCase() || 'SPOT',
      actual_amount: amountCents === null ? null : centsToYuan(amountCents),
      actual_amount_cents: amountCents,
      // 以下只用于重组写库行，不参与校验
      number: asText(line.number),
      item_no: asText(line.itemNo ?? line.item_no),
      color: asText(line.color),
      gift: asText(line.gift),
      kind: asText(line.kind) || 'shoe',
    },
  };
};

const normalizePayment = (row = {}, index) => {
  const method = asText(row.method ?? row.payment_method);
  const amountCents = asCents(row.amount ?? row.payment_amount);
  const errors = [];
  // 金额为 0 的行 = 她没用到这一行（既有口径：空行不用）
  if (amountCents !== null && amountCents > 0 && !method) errors.push({ code: 'payment_method_missing', index });
  if (amountCents !== null && amountCents > 0 && method) {
    return { errors, payment: { method, amount: centsToYuan(amountCents), amount_cents: amountCents } };
  }
  return { errors, payment: null };
};

/**
 * @returns {{ok:boolean, errors:Array, payload?:object}}
 */
const buildSalePayload = ({ openId, orderNo = '', gift = '', lines = [], payments = [] } = {}) => {
  const errors = [];
  if (!asText(openId)) errors.push({ code: 'open_id_missing' });
  if (!Array.isArray(lines) || lines.length === 0) errors.push({ code: 'lines_empty' });
  const normalizedLines = [];
  for (const [index, line] of (Array.isArray(lines) ? lines : []).entries()) {
    const { errors: lineErrors, line: normalized } = normalizeLine(line, index);
    errors.push(...lineErrors);
    normalizedLines.push(normalized);
  }
  const normalizedPayments = [];
  for (const [index, row] of (Array.isArray(payments) ? payments : []).entries()) {
    const { errors: paymentErrors, payment } = normalizePayment(row, index);
    errors.push(...paymentErrors);
    if (payment) normalizedPayments.push(payment);
  }
  const totalCents = normalizedLines.reduce((sum, line) => sum + (line.actual_amount_cents || 0), 0);
  const paidCents = normalizedPayments.reduce((sum, payment) => sum + payment.amount_cents, 0);
  if (paidCents > totalCents) errors.push({ code: 'payment_over_total' });
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    payload: {
      open_id: asText(openId),
      order_no: asText(orderNo),
      gift: asText(gift),
      lines: normalizedLines.map(({ actual_amount_cents, ...line }) => line),
      payments: normalizedPayments.map(({ amount_cents, ...payment }) => payment),
      derived: {
        total_amount: centsToYuan(totalCents),
        paid_amount: centsToYuan(paidCents),
        owed_amount: centsToYuan(Math.max(0, totalCents - paidCents)),
        payment_status: totalCents > 0 && paidCents >= totalCents
          ? SCAN_WRITE.texts.payloadPaymentStatus.paid
          : SCAN_WRITE.texts.payloadPaymentStatus.unpaid,
      },
    },
  };
};

module.exports = { buildSalePayload };
