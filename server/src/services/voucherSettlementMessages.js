'use strict';

/**
 * 团购券结算 · 运营群通知文案与发送（2026-11-14 从 service 拆出，控制单文件体量）。
 * 文案仍在 `config/voucherSettlement.js` 的 TEXTS 里，本文件只做拼装。
 */

const fill = (template, values) => String(template || '').replace(/\{(\w+)\}/g, (match, key) => (
  Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
));

const money = (cents) => (Number(cents || 0) / 100).toFixed(2);

const createSettlementMessages = ({ config, sendText, logger = { logInfo: () => {}, logWarn: () => {} } }) => {
  const renderMessage = ({ settledGroups, mismatches, failed, ruleMissing, batchFailed = [] }) => {
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
    if (batchFailed.length) {
      lines.push(fill(texts.lineOf?.batchFailed, {
        ids: batchFailed.map((item) => item.day || item.settleDay).join('、'),
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

  return { renderMessage, notify };
};

module.exports = { createSettlementMessages };
