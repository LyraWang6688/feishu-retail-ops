'use strict';

/**
 * 抖音团购券 · **平台结算到账**（业务负责人 2026-11-08 口径）。
 *
 * 判据（**按日期汇总，三个金额一分不差才改**）：
 *   ① 我方：该「创建日」下所有「待平台结算」记录的「交易金额」合计；
 *   ② 平台账单：`bill_date = 创建日` 的账单里 `amount.goods` 合计；
 *   ③ 平台提现：`withdraw_time` 落在「结算日」的提现 `amount` 合计；
 *      **结算日 = 创建日 + 该券自己的结算规则**（读「团购券管理.结算规则」，如「核销日+5个自然日」；
 *      业务负责人 2026-11-10：「结算日不要硬编码，按照团购券里的配置来」）；
 *   ⇒ ①②③ **完全相等（精确到分）** 才把该批记录改成「已收款」+ 写「收付日」；
 *     差 **1 分**都不改，只在运营群报差异（业务负责人 2026-11-08：「必须一分不差」）。
 *
 * 三条硬约束：
 *   · **只碰「待平台结算」**：未收款 / 已收款一个字不动；
 *   · **对不上不动数据**：宁可晚结，也不提前把没收到的钱记成已收；
 *   · **单笔失败不中断**：其余照常结清，失败笔在群里点名、下次自动重试。
 */

const { logInfo, logWarn } = require('../utils/logger');
const { createVoucherSettlementConfig } = require('../config/voucherSettlement');
const { parseSettleDays, sumBillCents, createSettlementRuleLoader } = require('./voucherSettlementRules');

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

const fill = (template, values) => String(template || '').replace(/\{(\w+)\}/g, (match, key) => (
  Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
));


/** 飞书字段值 → 纯文本（单选/文本可能是字符串，关联/多选可能是数组）。 */
const textOf = (value) => {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value.map((item) => (item && typeof item === 'object' ? item.text ?? '' : item)).join('');
  }
  if (typeof value === 'object') return value.text ?? '';
  return String(value);
};

/** epoch 毫秒 → 上海自然日 `YYYY-MM-DD`。 */
const shanghaiDayOf = (epochMs) => {
  const value = Number(epochMs);
  if (!Number.isFinite(value) || value <= 0) return '';
  return new Date(value + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
};

/** `YYYY-MM-DD` + N 天（纯日期运算，不经过本地时区）。 */
const addDays = (dayKey, days) => {
  const base = new Date(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return '';
  base.setUTCDate(base.getUTCDate() + Number(days));
  return base.toISOString().slice(0, 10);
};

/** 金额 → 分（整数）。取不到按 0（群里如实显示，不编）。 */
const toCents = (value) => {
  const raw = typeof value === 'number' ? String(value) : textOf(value).replace(/[^\d.-]/g, '');
  const number = Number(raw);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
};

const money = (cents) => (Number(cents || 0) / 100).toFixed(2);

/** 提现记录 `amount` 合计（分）。 */
const sumWithdrawCents = (withdrawData) => {
  const records = Array.isArray(withdrawData?.bill_withdraw_records) ? withdrawData.bill_withdraw_records : [];
  return records.reduce((sum, record) => sum + Number(record?.amount || 0), 0);
};

const createVoucherSettlementService = ({
  gateway,
  payments,
  laike,
  sendText,
  config = createVoucherSettlementConfig(),
  now = () => Date.now(),
  logger = { logInfo, logWarn },
} = {}) => {
  if (!gateway) throw new Error('VoucherSettlementService requires gateway');
  if (!payments || typeof payments.settlePlatformReceipt !== 'function') {
    throw new Error('VoucherSettlementService requires payments.settlePlatformReceipt');
  }
  if (!laike || typeof laike.settleBill !== 'function' || typeof laike.settleWithdraw !== 'function') {
    throw new Error('VoucherSettlementService requires laike.settleBill / laike.settleWithdraw');
  }

  const loadSettlementRules = createSettlementRuleLoader({ gateway, logger });

  /**
   * 把「待平台结算」按「创建日 + 结算天数」分组。
   * 没有券关联 / 规则解析不出 ⇒ 进 `ruleMissing`（**不结、不猜**）。
   */
  const groupPending = (records, fields, rules) => {
    const groups = new Map();
    const ruleMissing = [];
    records.forEach((record) => {
      if (textOf(record.fields?.[fields.status]).trim() !== config.pendingStatus) return;
      const day = shanghaiDayOf(record.fields?.[fields.createdAt]);
      if (!day) return;
      const methodName = textOf(record.fields?.[fields.method]).trim();
      const voucherId = rules.voucherIdByMethod.get(methodName) || '';
      const days = voucherId ? rules.daysByVoucherId.get(voucherId) : null;
      if (!Number.isInteger(days)) {
        ruleMissing.push({
          recordId: record.record_id,
          receiptId: textOf(record.fields?.[fields.receiptId]),
          method: methodName,
          reason: voucherId ? 'rule_unparsable' : 'voucher_unmapped',
        });
        return;
      }
      const settleDay = addDays(day, days);
      if (!settleDay) return;
      const sku = rules.skuByVoucherId.get(voucherId) || '';
      if (!groups.has(settleDay)) {
        groups.set(settleDay, { settleDay, creationDays: new Set(), skus: new Set(), unknownSku: false, records: [] });
      }
      const group = groups.get(settleDay);
      group.creationDays.add(day);
      if (sku) group.skus.add(sku); else group.unknownSku = true;
      group.records.push(record);
    });
    return { groups, ruleMissing };
  };

  const renderMessage = ({ settledGroups, mismatches, failed, ruleMissing }) => {
    const texts = config.texts || {};
    const lines = [String(texts.groupTitle || '')];
    settledGroups.forEach((group) => {
      lines.push(fill(texts.lineOf?.day, {
        day: group.day,
        settleDay: group.settleDay,
        count: group.count,
        amount: money(group.amountCents),
        bill: money(group.billCents),
        withdraw: money(group.withdrawCents),
      }));
    });
    mismatches.forEach((item) => {
      lines.push(fill(texts.lineOf?.mismatch, {
        day: item.day,
        settleDay: item.settleDay,
        amount: money(item.amountCents),
        bill: money(item.billCents),
        withdraw: money(item.withdrawCents),
      }));
    });
    if (ruleMissing.length) {
      lines.push(fill(texts.lineOf?.ruleMissing, {
        ids: ruleMissing.map((item) => item.receiptId || item.recordId).join('、'),
      }));
    }
    if (failed.length) {
      lines.push(fill(texts.lineOf?.failed, {
        count: failed.length,
        ids: failed.map((item) => item.receiptId || item.recordId).join('、'),
      }));
    }
    if (settledGroups.length) lines.push(String(texts.lineOf?.footer || ''));
    return lines.filter(Boolean).join('\n');
  };

  const notify = async (payload) => {
    const chatId = String(config.chatId || '').trim();
    if (!chatId) {
      logger.logWarn('voucher.settlement.chat_missing', { env: 'NOTIFY_GROUP_CHAT_ID / PURCHASE_CHAT_ID' });
      return { sent: false, reason: 'chat_missing' };
    }
    if (typeof sendText !== 'function') return { sent: false, reason: 'no_sender' };
    const text = renderMessage(payload);
    try {
      await sendText(chatId, text);
      logger.logInfo('voucher.settlement.notified', { chat_id: chatId, text_length: text.length });
      return { sent: true, text };
    } catch (error) {
      logger.logWarn('voucher.settlement.notify_failed', { error: String(error?.message || error).slice(0, 200) });
      return { sent: false, reason: 'send_failed' };
    }
  };

  /**
   * 跑一次（定时器每个 tick 都会调；**天然幂等**：结清过的记录不再是「待平台结算」）。
   */
  const run = async () => {
    const startedAt = now();
    if (!config.enabled) {
      logger.logInfo('voucher.settlement.skipped', { reason: 'disabled' });
      return { ok: true, skipped: 'disabled' };
    }
    if (!config.accountId) {
      logger.logWarn('voucher.settlement.account_missing', { env: 'DOUYIN_LAIKE_ACCOUNT_ID' });
      return { ok: false, reason: 'account_missing' };
    }

    const fields = gateway.table('paymentRecord').fields;
    const records = await gateway.listAll('paymentRecord');
    const todayKey = shanghaiDayOf(startedAt);
    const rules = await loadSettlementRules();
    const { groups, ruleMissing } = groupPending(records, fields, rules);

    const settledGroups = [];
    const mismatches = [];
    const failed = [];

    for (const [, group] of [...groups.entries()].sort()) {
      // ⭐ 2026-11-10：**按「结算日」对平**（不同券规则不同 ⇒ 同一创建日会拆到不同结算日，
      //   不能拿「创建日的账单」去比「某个子组的金额」）。
      const settleDay = group.settleDay;
      const creationDays = [...group.creationDays].sort();
      const day = creationDays.join('、');
      if (settleDay > todayKey) continue; // 还没到结算日
      const groupRecords = group.records;
      const amountCents = groupRecords.reduce((sum, record) => sum + toCents(record.fields?.[fields.amount]), 0);

      let billCents = 0;
      let billOk = true;
      let billReason = '';
      for (const billDay of creationDays) {
        const bill = await laike.settleBill({ accountId: config.accountId, billDate: billDay });
        if (!bill.ok) {
          billOk = false;
          billReason = bill.reason;
          break;
        }
        billCents += sumBillCents(bill.data, group.unknownSku ? null : group.skus);
      }
      const withdraw = await laike.settleWithdraw({ accountId: config.accountId, startDate: settleDay, endDate: settleDay });
      if (!billOk || !withdraw.ok) {
        mismatches.push({
          day, settleDay, amountCents,
          billCents: billOk ? billCents : 0,
          withdrawCents: withdraw.ok ? sumWithdrawCents(withdraw.data) : 0,
          reason: 'platform_query_failed',
        });
        logger.logWarn('voucher.settlement.platform_query_failed', {
          day,
          bill_reason: billReason,
          withdraw_reason: withdraw.ok ? '' : withdraw.reason,
        });
        continue;
      }

      const withdrawCents = sumWithdrawCents(withdraw.data);

      // 🔴 业务负责人 2026-11-08：「必须一分不差，差 1 分也不改、只报差异」。
      if (amountCents !== billCents || amountCents !== withdrawCents) {
        mismatches.push({ day, settleDay, amountCents, billCents, withdrawCents, reason: 'amount_mismatch' });
        logger.logWarn('voucher.settlement.mismatch', { day, settle_day: settleDay, amount_cents: amountCents, bill_cents: billCents, withdraw_cents: withdrawCents });
        continue;
      }

      let count = 0;
      for (const record of groupRecords) {
        const recordId = record.record_id;
        const receiptId = textOf(record.fields?.[fields.receiptId]);
        try {
          await payments.settlePlatformReceipt(recordId, startedAt, {
            correlation: { payment_record_id: recordId, settle_day: settleDay },
          });
          count += 1;
          logger.logInfo('voucher.settlement.item_settled', { payment_record_id: recordId, settle_day: settleDay, amount_cents: toCents(record.fields?.[fields.amount]) });
        } catch (error) {
          failed.push({ recordId, receiptId, settleDay });
          logger.logWarn('voucher.settlement.item_failed', {
            payment_record_id: recordId, settle_day: settleDay, error: String(error?.message || error).slice(0, 200),
          });
        }
      }
      if (count) settledGroups.push({ day, settleDay, count, amountCents, billCents, withdrawCents });
    }

    const summary = {
      today: todayKey,
      settledGroups: settledGroups.length,
      settledCount: settledGroups.reduce((sum, group) => sum + group.count, 0),
      mismatchCount: mismatches.length,
      failedCount: failed.length,
      ruleMissingCount: ruleMissing.length,
    };
    logger.logInfo('voucher.settlement.done', summary);

    const hasNews = settledGroups.length || mismatches.length || failed.length || ruleMissing.length;
    const notified = hasNews
      ? await notify({ settledGroups, mismatches, failed, ruleMissing })
      : { sent: false };
    return { ok: true, ...summary, mismatches, ruleMissing, notified: notified.sent === true };
  };

  return { run, groupPending, loadSettlementRules, renderMessage, shanghaiDayOf, addDays, toCents, parseSettleDays };
};

module.exports = {
  createVoucherSettlementService,
  shanghaiDayOf,
  addDays,
  toCents,
  parseSettleDays,
  sumBillCents,
  sumWithdrawCents,
};
