'use strict';

/**
 * 「供应 → 往来款」配置：显示规则 / 余额来源 / 交易标签与金额字段。
 * 业务口径变了只改这里，不在 service 里写业务 if-else。
 */
const { readInt } = require('./envValue');

const SUPPLIER_BALANCE = Object.freeze({
  // P交易明细的只读字段（公式 / Lookup / 关联字段不能混进可写 fields）。
  transactionFields: Object.freeze({
    // 2026-11-27：生产「P交易明细」已无「供应商名」列；用「供应商合并」公式
    //（关联供应商 → Lookup → 交易明细ID 兜底）取展示名。请求不存在的列会让整次读取
    // 报 FieldNameNotFound(1254045)，供应分析直接 502。
    supplierName: '供应商合并',
    tradeDate: '交易日',
    tradeDirection: '交易方向',
    transactionAmount: '交易额',
    goodsAmount: '货单金额',
    behavior: '发生行为',
    latestBalance: '最新余额',
  }),

  // 最近交易明细窗口（天）。
  windowDays: readInt(process.env, 'SUPPLIER_BALANCE_WINDOW_DAYS', 30, { min: 1, max: 365 }),

  // 满足任意一条就显示供应商。
  visibility: Object.freeze({
    includeWhen: Object.freeze([
      Object.freeze({ rule: 'numberNotZero', field: 'balance' }),
      // 余额刚好为 0、但最近窗口内有交易的供应商仍要出现在交易流水。
      Object.freeze({ rule: 'hasRecentTransactions' }),
    ]),
  }),

  // 余额来源：有交易取最新交易的最新余额；否则取初始化期初余额；兜底 0。
  balanceRules: Object.freeze([
    Object.freeze({ when: 'hasTransactions', field: 'latestBalance' }),
    Object.freeze({ when: 'always', field: 'initialBalance' }),
  ]),

  // P 交易明细的两组字段，按顺序匹配。
  transactionFamilies: Object.freeze([
    Object.freeze({
      match: Object.freeze({ field: 'tradeDirection', values: Object.freeze(['付', '收']) }),
      labels: Object.freeze({ 付: '付款', 收: '收款' }),
      amountField: 'transactionAmount',
    }),
    Object.freeze({
      match: Object.freeze({ field: 'behavior', nonEmpty: true }),
      labels: Object.freeze({ contains: Object.freeze({ 退货: '退货' }), default: '报货' }),
      amountField: 'goodsAmount',
    }),
  ]),
});

module.exports = { SUPPLIER_BALANCE };
