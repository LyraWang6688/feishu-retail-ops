'use strict';

/**
 * 「销售 → 每日现金」配置（配置先行）。
 *
 * 「销售汇总」字段：
 *   · 销售日（datetime）
 *   · 开门现金（number，业务上 = 期初金额）
 *   · 拿走现金（number）
 *   · 入账现金（lookup；只读）
 *   · 实时现金（formula；只读）
 *
 * 公式 / Lookup 字段不在本功能里计算 / 修改；本页只读展示。
 */
const { readInt, readString } = require('./envValue');

const SALES_DAILY_CASH = Object.freeze({
  timeZone: readString(process.env, 'SALES_DAILY_CASH_TIME_ZONE', 'Asia/Shanghai').trim() || 'Asia/Shanghai',
  maxAmount: readInt(process.env, 'SALES_DAILY_CASH_MAX_AMOUNT', 100000000, { min: 0, max: 1000000000 }),
});

module.exports = { SALES_DAILY_CASH };
