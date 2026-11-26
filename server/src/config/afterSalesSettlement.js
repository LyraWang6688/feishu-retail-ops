'use strict';

/**
 * 售后结算口径（2026-11-26）：退货/换货的「钱」以原单实际收款为准，不再只看明细金额。
 *
 * 业务口径（业务负责人 2026-11-26 确认）：
 *   · 一分未收（未收款）：退货不退款，冲销未收款行（金额改 0，保留行）；
 *   · 部分收款：只退「这条明细能分到的已收部分」（min(明细金额, 已收)）；
 *     整单只有一条明细时，差额冲销；多明细时不动其他明细的未收款；
 *   · 全额已收：保持退款 / 留存；
 *   · 换货：原单未收款时，原「未收款」行改成新鞋金额；已收款按差价。
 *
 * 本文件只放规则/状态分类；执行由 services/afterSalesSettlementPlan.js 解释。
 */
const { readString } = require('./envValue');

const AFTER_SALES_SETTLEMENT = Object.freeze({
  statuses: Object.freeze({
    paid: Object.freeze(['已收款', '待平台结算']),
    unpaid: Object.freeze(['未收款']),
    refunded: '已退款',
    retained: '已留存',
  }),
  returnRules: Object.freeze([
    Object.freeze({
      id: 'zero_amount',
      when: (ctx) => ctx.detailAmount <= 0,
      createRefund: false,
      amount: 0,
      writeOff: 'none',
    }),
    Object.freeze({
      id: 'fully_paid',
      when: (ctx) => ctx.detailAmount > 0 && ctx.paidAmount >= ctx.detailAmount,
      createRefund: true,
      amount: 'detail',
      writeOff: 'none',
    }),
    Object.freeze({
      id: 'unpaid',
      when: (ctx) => ctx.paidAmount <= 0,
      createRefund: false,
      amount: 0,
      writeOff: 'unpaid_when_single_detail',
    }),
    Object.freeze({
      id: 'partial',
      when: () => true,
      createRefund: true,
      amount: 'paid_capped',
      writeOff: 'remainder_when_single_detail',
    }),
  ]),
  writeOff: Object.freeze({
    mode: readString(process.env, 'AFTER_SALES_WRITE_OFF_MODE', 'zero'),
    zeroAmount: 0,
  }),
  exchangeUnpaidAction: 'retarget_unpaid',
});

module.exports = { AFTER_SALES_SETTLEMENT };
