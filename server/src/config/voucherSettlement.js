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
 *   · 平台账单：`bill_date = 创建日` 的账单里 `amount.goods` 合计（**拉全分页**）；
 *   · 平台提现：`withdraw_time` 落在「结算日（创建日+5）」这一天的提现 `amount` 合计（**拉全分页**）；
 *   ⇒ 三者相等才把该批记录改成「已收款」；差一分都不改，只在群里报差异。
 *
 * ⭐ 2026-11-14（部分成功后续对账）：一旦某批**对平通过**，先把这一批的
 *   「记录 id → 金额」落到 `batchDir`（对账进度）**再逐笔结算**；下一轮把
 *   已结清但仍在批次里的记录一起计入「我方金额」，只续做未结项——
 *   否则首轮 100 元里成功 50、失败 50，下一轮 50 ≠ 平台 100，**永远对不上**。
 */

const path = require('node:path');
const { readFlag, readInt, readString } = require('./envValue');
const { resolveNotification } = require('./notifications');

const DEFAULT_HOUR = 14;

const TEXTS = Object.freeze({
  groupTitle: '【团购券已结算】',
  lineOf: {
    day: '· 创建 {day}（结算 {settleDay}）：{count} 笔 · ¥{amount}（账单 ¥{bill} / 提现 ¥{withdraw}）',
    mismatch: '⚠️ 差异未结 · 创建 {day}（结算 {settleDay}）：我方 ¥{amount} / 账单 ¥{bill} / 提现 ¥{withdraw}',
    failed: '⚠️ {count} 笔没结清（下次自动重试）：{ids}',
    ruleMissing: '⚠️ 未配置结算规则（未结清）：{ids}（请在「团购券管理」补「结算规则」或补券关联）',
    batchFailed: '⚠️ 对账进度落盘失败（本次未结，下一轮重试）：{ids}',
    footer: '已改为「已收款」并写入收付日',
  },
  accountMissing: '团购券结算未执行：没配置 DOUYIN_LAIKE_ACCOUNT_ID（来客账号 ID）',
  chatMissing: '团购券结算已执行，但没配置运营群（NOTIFY_GROUP_CHAT_ID / PURCHASE_CHAT_ID）⇒ 本次不通知',
});

const resolveVoucherSettlementChatId = (env = process.env) => (
  String(resolveNotification('voucher_settlement', env).receiveId || '').trim()
);

const createVoucherSettlementConfig = (env = process.env) => ({
  enabled: readFlag(env, 'VOUCHER_SETTLEMENT_ENABLED', true),
  // ⚠️ 2026-11-10：结算天数**不再有全局默认值** —— 每张券读「团购券管理.结算规则」。
  //   这条老旋钮只为兼容线上 `.env` 保留读取位置，**逻辑不再使用**。
  legacySettleDays: readInt(env, 'VOUCHER_SETTLEMENT_DAYS', 0, { min: 0, max: 90 }),
  hour: readInt(env, 'VOUCHER_SETTLEMENT_HOUR', DEFAULT_HOUR, { min: 0, max: 23 }),
  intervalMs: readInt(env, 'VOUCHER_SETTLEMENT_INTERVAL_MS', 10 * 60 * 1000, { min: 60 * 1000, max: 24 * 60 * 60 * 1000 }),
  // 来客账号（品牌号）：对账要按它查账单/提现。
  accountId: readString(env, 'DOUYIN_LAIKE_ACCOUNT_ID', '').trim(),
  // 对账进度（已对平、未结完的批次）落盘目录：重启/下一轮据此只续做未结项。
  // ⚠️ 空串也回落到默认目录：空串 ⇒ 进程内 store ⇒ 重启就丢对账进度（静默）。
  batchDir: readString(env, 'VOUCHER_SETTLEMENT_BATCH_DIR', '').trim() || path.join(__dirname, '../../data/voucher_settlement'),
  // 账单/提现分页：单页条数（来客接口最大 100）与页数上限（防上游死循环）。
  pageSize: readInt(env, 'VOUCHER_SETTLEMENT_PAGE_SIZE', 100, { min: 1, max: 100 }),
  pageLimit: readInt(env, 'VOUCHER_SETTLEMENT_MAX_PAGES', 50, { min: 1, max: 200 }),
  pendingStatus: '待平台结算',
  settledStatus: '已收款',
  chatId: resolveVoucherSettlementChatId(env),
  texts: TEXTS,
});

module.exports = {
  createVoucherSettlementConfig,
  resolveVoucherSettlementChatId,
  DEFAULT_HOUR,
  TEXTS,
};
