'use strict';

/**
 * 「销售 → 每日现金」配置（配置先行）。
 *
 * 「销售汇总」字段：
 *   · 销售日（datetime）
 *   · 开门零钱（number，业务上 = 期初金额）
 *   · 拿走现金（number）
 *   · 关门零钱（formula，业务上 = 实时金额；只读）
 *   · 销售金额（lookup；只读）
 *
 * 公式字段不在本功能里计算 / 修改；本页只读展示「关门零钱」。
 */
const { readInt, readString } = require('./envValue');

const SALES_DAILY_CASH = Object.freeze({
  timeZone: readString(process.env, 'SALES_DAILY_CASH_TIME_ZONE', 'Asia/Shanghai').trim() || 'Asia/Shanghai',
  maxAmount: readInt(process.env, 'SALES_DAILY_CASH_MAX_AMOUNT', 100000000, { min: 0, max: 1000000000 }),
});

module.exports = { SALES_DAILY_CASH };
