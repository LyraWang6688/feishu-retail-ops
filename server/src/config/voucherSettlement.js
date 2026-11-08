'use strict';

/**
 * 抖音团购券 · **平台结算到账**的配置（配置先行：天数/时点/账号/群/文案都在这里）。
 *
 * 业务负责人 2026-11-08 口径：
 *   · 「平台结算规则应该是 5 天」；
 *   · 「**按日期匹配**，以日期维度看需要结算多少钱，不需要具体到券码或者单号」；
 *   · 「**必须一分不差，差 1 分也不改、只报差异**」；
 *   · 跑的时间：**每天 14:00（上海）**。
 *
 * 判据（三个金额完全相等，单位精确到分）：
 *   · 我方：该「创建日」下所有「待平台结算」记录的「交易金额」合计；
 *   · 平台账单：`bill_date = 创建日` 的账单里 `amount.goods` 合计；
 *   · 平台提现：`withdraw_time` 落在「结算日（创建日+5）」这一天的提现 `amount` 合计；
 *   ⇒ 三者相等才把该批记录改成「已收款」；差一分都不改，只在群里报差异。
 */

const { readFlag, readInt, readString } = require('./envValue');
const { resolvePurchaseChatId } = require('./groupPurchase');

const DEFAULT_SETTLE_DAYS = 5;
const DEFAULT_HOUR = 14;

const TEXTS = Object.freeze({
  groupTitle: '【团购券已结算】',
  lineOf: {
    day: '· 创建 {day}（结算 {settleDay}）：{count} 笔 · ¥{amount}（账单 ¥{bill} / 提现 ¥{withdraw}）',
    mismatch: '⚠️ 差异未结 · 创建 {day}（结算 {settleDay}）：我方 ¥{amount} / 账单 ¥{bill} / 提现 ¥{withdraw}',
    failed: '⚠️ {count} 笔没结清（下次自动重试）：{ids}',
    footer: '已改为「已收款」并写入收付日',
  },
  accountMissing: '团购券结算未执行：没配置 DOUYIN_LAIKE_ACCOUNT_ID（来客账号 ID）',
  chatMissing: '团购券结算已执行，但没配置运营群（PURCHASE_CHAT_ID / VOUCHER_SETTLEMENT_CHAT_ID）⇒ 本次不通知',
});

const resolveVoucherSettlementChatId = (env = process.env) => {
  const explicit = readString(env, 'VOUCHER_SETTLEMENT_CHAT_ID', '').trim();
  return explicit || resolvePurchaseChatId(env);
};

const createVoucherSettlementConfig = (env = process.env) => ({
  enabled: readFlag(env, 'VOUCHER_SETTLEMENT_ENABLED', true),
  settleDays: readInt(env, 'VOUCHER_SETTLEMENT_DAYS', DEFAULT_SETTLE_DAYS, { min: 1, max: 30 }),
  hour: readInt(env, 'VOUCHER_SETTLEMENT_HOUR', DEFAULT_HOUR, { min: 0, max: 23 }),
  intervalMs: readInt(env, 'VOUCHER_SETTLEMENT_INTERVAL_MS', 10 * 60 * 1000, { min: 60 * 1000, max: 24 * 60 * 60 * 1000 }),
  // 来客账号（品牌号）：对账要按它查账单/提现。
  accountId: readString(env, 'DOUYIN_LAIKE_ACCOUNT_ID', '').trim(),
  pendingStatus: '待平台结算',
  settledStatus: '已收款',
  chatId: resolveVoucherSettlementChatId(env),
  texts: TEXTS,
});

module.exports = {
  createVoucherSettlementConfig,
  resolveVoucherSettlementChatId,
  DEFAULT_SETTLE_DAYS,
  DEFAULT_HOUR,
  TEXTS,
};
