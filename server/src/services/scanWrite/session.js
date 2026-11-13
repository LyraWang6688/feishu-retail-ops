'use strict';

/**
 * scanWrite 的会话/草稿动作（从 `scanWriteService.js` 搬出，只搬不改）。
 *
 * 这里只读写**本地会话**（`scanSessionService`），业务表一个字都不写。
 * 依赖由外部注入：queue / sessions / config / fail / userMessageFor /
 * positiveAmount / positiveInteger / sessionKeyOf / logInfo。
 */
const { SELLABLE_KINDS } = require('../../config/sellableKinds');
const { salesTradeTypeForStock } = require('../../config/salesTradeTypePolicy');
const { fillText } = require('../../config/scanWrite');
const { logInfo: defaultLogInfo } = require('../../utils/logger');

const createScanWriteSession = ({
  queue, sessions, config, fail, userMessageFor,
  positiveAmount, positiveInteger, sessionKeyOf,
  logInfo = defaultLogInfo,
  now = () => Date.now(),
}) => {
  const texts = config.texts;

  const addSaleLine = async ({
    openId, kind = '', productRecordId = '', number = '', itemNo = '', color = '',
    size, amount = '', gift = '', inStock, requestId = '',
    sessionKey = '',
  }) => {
    const sessionId = sessionKeyOf(openId, sessionKey);
    if (!config.sale.enabled) {
      return fail({ code: 'disabled', message: texts.writeDisabledBody, requestId });
    }
    const kindKey = String(kind || '').trim() || 'shoe';
    const sellableKind = SELLABLE_KINDS[kindKey];
    if (!sellableKind) {
      return fail({ code: 'unknown_kind', message: texts.internalFailedBody, requestId });
    }
    const parsedAmount = positiveAmount(amount);
    if (!parsedAmount.ok) {
      const error = new Error(texts.amountInvalidBody);
      error.scanUserMessage = error.message;
      return fail({ code: 'amount_invalid', message: userMessageFor(error), requestId, error });
    }
    const giftText = String(gift ?? '').trim().slice(0, config.sale.giftMaxLength);

    const parsedSize = positiveInteger(size);
    if (parsedSize === null) {
      const error = new Error(texts.sizeMissingBody);
      error.scanUserMessage = texts.sizeMissingBody;
      return fail({ code: 'size_missing', message: userMessageFor(error), requestId, error });
    }
    const tradeTypeCode = typeof inStock === 'boolean' ? salesTradeTypeForStock({ inStock }) : '';
    const added = await queue.run(`sale:${sessionId}`, () => sessions.addLine(sessionId, {
      kind: kindKey,
      number: String(number || '').trim(),
      item_no: String(itemNo || '').trim(),
      color: String(color || '').trim(),
      product_record_id: String(productRecordId || '').trim(),
      size: parsedSize,
      trade_type_code: tradeTypeCode,
      amount: parsedAmount.value,
      gift: giftText,
      added_at: new Date(now()).toISOString(),
    }));
    if (!added.ok) {
      return fail({
        code: added.code,
        message: fillText(texts.tooManyLinesBody, { max: added.limit }),
        requestId,
        extra: { result: { limit: added.limit } },
      });
    }
    logInfo(config.events.lineAdded, {
      session_id: added.session.session_id,
      kind: kindKey,
      number: String(number || ''),
      product_record_id: String(productRecordId || ''),
      size: parsedSize,
      count: added.count,
      request_id: requestId,
    });
    return { ok: true, count: added.count, limit: config.session.maxLines, session: added.session };
  };

  const clearDraft = async ({ openId, sessionKey = '', requestId = '' }) => {
    const sessionId = sessionKeyOf(openId, sessionKey);
    const session = await queue.run(`sale:${sessionId}`, () => sessions.clearSale(sessionId));
    logInfo(config.events.draftCleared, {
      session_id: session?.[config.session.idField] || sessionId,
      request_id: requestId,
    });
    return { ok: true, count: 0, session, request_id: requestId };
  };

  const saveDraftLines = (openId, patch) => sessions.saveSaleProgress(openId, patch);

  return { addSaleLine, clearDraft, saveDraftLines };
};

module.exports = { createScanWriteSession };
