'use strict';

/**
 * scanWrite 的纯工具/基础件（从 `scanWriteService.js` 搬出，只搬不改）。
 *
 * 这里不写业务表、不读网关，只做：
 *   - schema 语义键解析
 *   - 金额/分转换、金额人话
 *   - 失败结果与人话
 *   - 会话键归一化
 *
 * 依赖全部由 `createScanWriteHelpers` 注入（schema / config / logError），
 * 避免模块级单例导致用例不能注入。
 */
const { fillText } = require('../../config/scanWrite');
const { logError: defaultLogError } = require('../../utils/logger');

const createScanWriteHelpers = ({ schema, config, logError = defaultLogError }) => {
  const texts = config.texts;

  const fieldOf = (tableKey, semanticKey) => schema?.tables?.[tableKey]?.fields?.[semanticKey] || '';

  const fail = ({ code, message, requestId, error, extra = {} }) => {
    const detail = error ? String(error.message || error) : '';
    if (error) {
      logError(config.events.failed, {
        request_id: requestId, code, error: detail, ...(extra.log || {}),
      });
    }
    return { ok: false, code, message, failure_reason: detail, ...extra.result };
  };

  const userMessageFor = (error) => {
    const raw = String(error?.message || error || '').trim();
    if (error?.scanUserMessage) return error.scanUserMessage;
    if (!raw) return texts.internalFailedBody;
    const unsafe = (config.sale.unsafeErrorMarkers || []).some((marker) => raw.includes(marker));
    if (unsafe) return texts.internalFailedBody;
    return fillText(texts.businessFailedBody, { reason: raw });
  };

  const positiveAmount = (raw) => {
    const text = String(raw ?? '').trim().replace(/[¥￥,\s]/g, '');
    if (!text) return { ok: true, value: null };
    const decimals = Number.isInteger(config.sale.amountDecimals) ? config.sale.amountDecimals : 2;
    const pattern = new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
    if (!pattern.test(text)) return { ok: false };
    const value = Number(text);
    if (!Number.isFinite(value) || value <= 0) return { ok: false };
    return { ok: true, value: Math.round(value * 100) / 100 };
  };

  /** 金额 → 分（整数运算，不拿浮点数比大小）。 */
  const toCents = (value) => Math.round(Number(value || 0) * 100);

  /** 分 → 人话金额（整数不带小数点；带角分才给两位）。 */
  const moneyText = (value) => {
    const number = Number(value || 0);
    const text = Number.isInteger(number) ? String(number) : number.toFixed(2);
    return `${config.sale.moneyPrefix || ''}${text}`;
  };

  const amountMismatchMessage = ({ itemsCents, paymentsCents, strict = false }) => {
    const diffCents = Math.abs(paymentsCents - itemsCents);
    const side = itemsCents === 0 && !strict
      ? fillText(texts.amountMismatchNoItems, { diff: moneyText(diffCents / 100) })
      : fillText(
        paymentsCents > itemsCents ? texts.amountMismatchOver : texts.amountMismatchShort,
        { diff: moneyText(diffCents / 100) },
      );
    return fillText(texts.amountMismatchBody, {
      items: moneyText(itemsCents / 100),
      payments: moneyText(paymentsCents / 100),
      side,
    });
  };

  const amountList = (value) => {
    if (Array.isArray(value)) return value.map((item) => (item === undefined || item === null ? '' : String(item)));
    if (value === undefined || value === null) return [];
    return [String(value)];
  };

  const positiveInteger = (raw) => {
    const text = String(raw ?? '').trim();
    return /^[1-9]\d*$/.test(text) ? Number(text) : null;
  };

  const sessionKeyOf = (openId, sessionKey = '') =>
    String(sessionKey || '').trim() || String(openId || '');

  return {
    fieldOf,
    fail,
    userMessageFor,
    positiveAmount,
    toCents,
    moneyText,
    amountMismatchMessage,
    amountList,
    positiveInteger,
    sessionKeyOf,
  };
};

module.exports = { createScanWriteHelpers };
