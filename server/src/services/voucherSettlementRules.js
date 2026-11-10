'use strict';

/** 券结算规则：读「团购券管理.结算周期」+「支付方式管理.团购券管理」并解析天数。 */
const { getConfigRows } = require('./configTableCache');
const {} = require('./v1BitableGateway');
const { strictLinkedRecordIds } = require('./strictLinkIds');

const textOf = (value) => {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value.map((item) => (item && typeof item === 'object' ? item.text ?? '' : item)).join('');
  }
  if (typeof value === 'object') return value.text ?? '';
  return String(value);
};

/** 「结算规则」文本 → 天数（「5」「核销日+5个自然日」「T+3」⇒ 5/5/3）。解析不出 ⇒ null。 */
const parseSettleDays = (ruleText) => {
  const text = String(ruleText || '').trim();
  if (!text) return null;
  const match = /^\d+$/.test(text)
    ? [text, text]
    : (text.match(/(\d+)\s*(?:个)?\s*(?:自然日|天|日)/) || text.match(/\+\s*(\d+)/));
  if (!match) return null;
  const days = Number(match[1]);
  return Number.isInteger(days) && days >= 0 && days <= 90 ? days : null;
};

/** 账单里 `amount.goods` 合计（分）；给了 skus 就只算这些券。 */
const sumBillCents = (billData, skus = null) => {
  const records = Array.isArray(billData?.ledger_records) ? billData.ledger_records : [];
  const only = skus instanceof Set && skus.size ? skus : null;
  return records.reduce((sum, record) => {
    if (only && !only.has(String(record?.sku_id || ''))) return sum;
    return sum + Number(record?.amount?.goods || 0);
  }, 0);
};

/** 读「支付方式管理」+「团购券管理」，返回券天数 / SKU / 支付方式→券。 */
const createSettlementRuleLoader = ({ gateway, logger }) => async () => {
  const methodTable = gateway.table('paymentMethod');
  const voucherTable = gateway.table('groupBuyVoucher');
  const daysByVoucherId = new Map();
  const skuByVoucherId = new Map();
  try {
    const vouchers = await getConfigRows({
      gateway, tableKey: 'groupBuyVoucher', loader: () => gateway.listAll('groupBuyVoucher'),
    });
    for (const voucher of vouchers) {
      const rule = textOf(voucher.fields?.[voucherTable.fields.settleRule]);
      daysByVoucherId.set(voucher.record_id, parseSettleDays(rule));
      if (voucherTable.fields.externalId) {
        skuByVoucherId.set(voucher.record_id, textOf(voucher.fields?.[voucherTable.fields.externalId]).trim());
      }
    }
  } catch (error) {
    logger.logWarn('voucher.settlement.vouchers_unreadable', { error: String(error?.message || error).slice(0, 200) });
  }
  const voucherIdByMethod = new Map();
  try {
    const methods = await getConfigRows({
      gateway, tableKey: 'paymentMethod', loader: () => gateway.listAll('paymentMethod'),
    });
    for (const method of methods) {
      const name = textOf(method.fields?.[methodTable.fields.name]).trim();
      if (!name) continue;
      const voucherId = String(strictLinkedRecordIds(method.fields?.[methodTable.fields.voucher])[0] || '');
      if (voucherId) voucherIdByMethod.set(name, voucherId);
    }
  } catch (error) {
    logger.logWarn('voucher.settlement.methods_unreadable', { error: String(error?.message || error).slice(0, 200) });
  }
  return { daysByVoucherId, skuByVoucherId, voucherIdByMethod };
};

module.exports = { parseSettleDays, sumBillCents, createSettlementRuleLoader };
