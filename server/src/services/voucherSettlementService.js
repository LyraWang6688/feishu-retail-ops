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
 *
 * ⭐ 2026-11-14（补两处真缺口）：
 *   · **部分成功后仍可续对账**：对平通过时先把「记录 id → 金额」落盘
 *     （`voucherSettlementBatches`，目录 `VOUCHER_SETTLEMENT_BATCH_DIR`），再逐笔结算；
 *     下一轮把已结清的记录一起计入我方金额、只续做未结项。
 *   · **账单/提现拉全分页**：游标分页；中途失败 / 游标缺失 / 超过页数上限 ⇒ **不结**
 *     （宁可晚结，也不拿"只拉了第一页"的金额改收款状态）。
 */

const { logInfo, logWarn } = require('../utils/logger');
const { createVoucherSettlementConfig } = require('../config/voucherSettlement');
const { parseSettleDays, sumBillCents, createSettlementRuleLoader } = require('./voucherSettlementRules');
const { createVoucherSettlementBatchStore, loadActiveBatches } = require('./voucherSettlementBatches');
const { createSettlementPaging } = require('./voucherSettlementPaging');
const { createSettlementMessages } = require('./voucherSettlementMessages');

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

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
  batchStore,
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
  const settlements = batchStore || createVoucherSettlementBatchStore({ dir: config.batchDir });

  const collectPages = createSettlementPaging({
    logger,
    pageSize: config.pageSize,
    pageLimit: config.pageLimit,
  });

  const { renderMessage, notify } = createSettlementMessages({ config, sendText, logger });

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

    const activeBatches = await loadActiveBatches(settlements, logger);
    const batchBySettleDay = new Map(activeBatches.map((batch) => [String(batch.settleDay || batch.batch_id), batch]));

    const settledGroups = [];
    const mismatches = [];
    const failed = [];
    const batchFailed = [];
    let resumedGroups = 0;

    for (const [, group] of [...groups.entries()].sort()) {
      // ⭐ 2026-11-10：**按「结算日」对平**（不同券规则不同 ⇒ 同一创建日会拆到不同结算日，
      //   不能拿「创建日的账单」去比「某个子组的金额」）。
      const settleDay = group.settleDay;
      if (settleDay > todayKey) continue; // 还没到结算日
      const batch = batchBySettleDay.get(settleDay) || null;
      if (batch) resumedGroups += 1;

      // 我方金额 = 批次里已对平过的记录（含已结清的）∪ 当前仍待结的记录（同 id 只算一次）。
      const recordAmounts = new Map(batch && batch.record_amounts ? Object.entries(batch.record_amounts) : []);
      group.records.forEach((record) => {
        if (!recordAmounts.has(record.record_id)) {
          recordAmounts.set(record.record_id, toCents(record.fields?.[fields.amount]));
        }
      });
      const creationDays = [...new Set([...(batch?.creation_days || []), ...group.creationDays])].sort();
      const skus = new Set([...(batch?.skus || []), ...group.skus]);
      const unknownSku = Boolean(batch?.unknown_sku) || group.unknownSku;
      const day = creationDays.join('、');
      const amountCents = [...recordAmounts.values()].reduce((sum, value) => sum + Number(value || 0), 0);

      let billCents = 0;
      let billOk = true;
      let billReason = '';
      for (const billDay of creationDays) {
        // eslint-disable-next-line no-await-in-loop
        const billPage = await collectPages({
          label: 'settle_bill',
          listKey: 'ledger_records',
          fetchPage: ({ cursor, size }) => laike.settleBill({
            accountId: config.accountId, billDate: billDay, cursor, size,
          }),
        });
        if (!billPage.ok) {
          billOk = false;
          billReason = billPage.reason || 'upstream_failed';
          break;
        }
        billCents += sumBillCents({ ledger_records: billPage.records }, unknownSku ? null : skus);
      }
      const withdrawPage = await collectPages({
        label: 'settle_withdraw',
        listKey: 'bill_withdraw_records',
        fetchPage: ({ cursor, size }) => laike.settleWithdraw({
          accountId: config.accountId, startDate: settleDay, endDate: settleDay, cursor, size,
        }),
      });
      if (!billOk || !withdrawPage.ok) {
        mismatches.push({
          day,
          settleDay,
          amountCents,
          billCents: billOk ? billCents : 0,
          withdrawCents: withdrawPage.ok ? sumWithdrawCents({ bill_withdraw_records: withdrawPage.records }) : 0,
          reason: 'platform_query_failed',
        });
        logger.logWarn('voucher.settlement.platform_query_failed', {
          day,
          bill_reason: billReason,
          withdraw_reason: withdrawPage.ok ? '' : withdrawPage.reason,
        });
        continue;
      }

      const withdrawCents = sumWithdrawCents({ bill_withdraw_records: withdrawPage.records });

      // 🔴 业务负责人 2026-11-08：「必须一分不差，差 1 分也不改、只报差异」。
      if (amountCents !== billCents || amountCents !== withdrawCents) {
        mismatches.push({
          day, settleDay, amountCents, billCents, withdrawCents, reason: 'amount_mismatch',
        });
        logger.logWarn('voucher.settlement.mismatch', {
          day, settle_day: settleDay, amount_cents: amountCents, bill_cents: billCents, withdraw_cents: withdrawCents, resumed: Boolean(batch),
        });
        continue;
      }

      // ⭐⭐ 2026-11-14：**先落对账进度、再逐笔结算** —— 中途崩了，下一轮仍能按整批金额对平。
      const batchPayload = {
        batch_id: settleDay,
        settleDay,
        creation_days: creationDays,
        skus: [...skus],
        unknown_sku: unknownSku,
        record_amounts: Object.fromEntries(recordAmounts),
        approved_at: new Date(startedAt).toISOString(),
        done: false,
      };
      try {
        await settlements.save(batchPayload);
      } catch (error) {
        batchFailed.push({ day, settleDay });
        logger.logWarn('voucher.settlement.batch_save_failed', {
          settle_day: settleDay, error: String(error?.message || error).slice(0, 200),
        });
        continue;
      }

      let count = 0;
      let groupFailures = 0;
      for (const record of group.records) {
        const recordId = record.record_id;
        const receiptId = textOf(record.fields?.[fields.receiptId]);
        try {
          // eslint-disable-next-line no-await-in-loop
          await payments.settlePlatformReceipt(recordId, startedAt, {
            correlation: { payment_record_id: recordId, settle_day: settleDay },
          });
          count += 1;
          logger.logInfo('voucher.settlement.item_settled', { payment_record_id: recordId, settle_day: settleDay, amount_cents: toCents(record.fields?.[fields.amount]) });
        } catch (error) {
          groupFailures += 1;
          failed.push({ recordId, receiptId, settleDay });
          logger.logWarn('voucher.settlement.item_failed', {
            payment_record_id: recordId, settle_day: settleDay, error: String(error?.message || error).slice(0, 200),
          });
        }
      }
      if (count) settledGroups.push({ day, settleDay, count, amountCents, billCents, withdrawCents });
      if (groupFailures === 0) {
        try {
          await settlements.markDone(settleDay, new Date(now()).toISOString());
        } catch (error) {
          logger.logWarn('voucher.settlement.batch_done_failed', { settle_day: settleDay, error: String(error?.message || error).slice(0, 200) });
        }
      }
    }

    // 批次还在、但当天已没有任何待结记录 ⇒ 早已结清（或记录被删）：收尾标记 done。
    for (const batch of activeBatches) {
      const batchDay = String(batch.settleDay || batch.batch_id);
      if (groups.has(batchDay)) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await settlements.markDone(batch.batch_id, new Date(now()).toISOString());
      } catch (error) {
        logger.logWarn('voucher.settlement.batch_done_failed', { settle_day: batchDay, error: String(error?.message || error).slice(0, 200) });
      }
    }

    const summary = {
      today: todayKey,
      settledGroups: settledGroups.length,
      settledCount: settledGroups.reduce((sum, group) => sum + group.count, 0),
      mismatchCount: mismatches.length,
      failedCount: failed.length,
      ruleMissingCount: ruleMissing.length,
      batchFailedCount: batchFailed.length,
      resumedGroups,
    };
    logger.logInfo('voucher.settlement.done', summary);

    const hasNews = settledGroups.length || mismatches.length || failed.length || ruleMissing.length || batchFailed.length;
    const notified = hasNews
      ? await notify({ settledGroups, mismatches, failed, ruleMissing, batchFailed })
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
