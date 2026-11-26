'use strict';

/**
 * 售后结算「计划」解释器（2026-11-26）：只算、不写库。
 */
const { AFTER_SALES_SETTLEMENT } = require('../config/afterSalesSettlement');

const num = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

const planReturnSettlement = ({
  detailAmount, paidAmount, unpaidAmount, detailCount,
  config = AFTER_SALES_SETTLEMENT,
} = {}) => {
  const amount = num(detailAmount);
  const paid = num(paidAmount);
  const unpaid = num(unpaidAmount);
  const count = Number(detailCount) > 0 ? Number(detailCount) : 1;
  const ctx = { detailAmount: amount, paidAmount: paid, unpaidAmount: unpaid, detailCount: count };
  const rule = config.returnRules.find((item) => item.when(ctx)) || config.returnRules[config.returnRules.length - 1];
  const singleDetail = count === 1;

  let refundAmount = 0;
  if (rule.createRefund) {
    refundAmount = rule.amount === 'paid_capped' ? Math.min(amount, paid) : amount;
  }
  const remainder = Math.max(0, amount - refundAmount);
  let writeOffAmount = 0;
  if (rule.writeOff === 'unpaid_when_single_detail' && singleDetail) {
    writeOffAmount = unpaid;
  } else if (rule.writeOff === 'remainder_when_single_detail' && singleDetail) {
    writeOffAmount = Math.min(unpaid, remainder);
  }

  return {
    rule: rule.id,
    refundAmount,
    writeOffAmount,
    createRefund: rule.createRefund && refundAmount > 0,
    writeOffMode: config.writeOff.mode,
  };
};

module.exports = { planReturnSettlement };
