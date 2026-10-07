const { findVoucher } = require('../config/groupBuyVouchers');

const yuan = (cents) => cents / 100;
const cents = (value) => Math.round(Number(value) * 100);
const isVoucherMethod = (method) => /团购|代金券|券|抖音/.test(String(method || ''));
const hasVoucherWords = (text) => /团购券|代金券|抵\s*\d+|代\s*\d+/.test(text);

const voucherCount = (value) => {
  if (!value) return 1;
  if (value === '一') return 1;
  if (value === '两' || value === '二') return 2;
  return Number(value);
};

const voucherMentions = (sourceText) => {
  const pattern = /(?:(一|两|二|三|\d+)\s*张\s*)?(\d{1,3})(?:[.．](\d{1,2})|块(\d{1,2}))?\s*(?:元|块)?\s*(?:抵|代)\s*(\d{1,4})(?:\s*元)?/g;
  return [...String(sourceText || '').matchAll(pattern)].map((match) => {
    const fraction = match[3] || match[4] || '';
    const purchaseCents = Number(match[2]) * 100 + (fraction ? Number(fraction.padEnd(2, '0')) : 0);
    return { count: voucherCount(match[1]), purchasePrice: yuan(purchaseCents), faceValue: Number(match[5]) };
  });
};

const explicitCashPayments = (sourceText) => [...String(sourceText || '')
  .matchAll(/(?:[¥￥]\s*)?(\d+(?:\.\d{1,2})?)\s*(?:元|块)?\s*(微信|现金|支付宝)|(微信|现金|支付宝)\s*(?:支付了?|付了?|收了?)?\s*[:：]?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*(?:元|块)?/g)]
  .map((match) => ({ amount: Number(match[1] || match[4]), method: match[2] || match[3] }));

const explicitSalePrices = (sourceText) => [...String(sourceText || '')
  .matchAll(/(?:成交价|成交金额|这双鞋(?:的)?(?:卖价|售价|价格)|鞋(?:子)?(?:的)?(?:卖价|售价))\s*(?:是|为|共|合计)?\s*[:：]?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*(?:元|块)?/g)]
  .map((match) => Number(match[1]));

// The model extracts facts, but this policy owns voucher economics and status.
// It intentionally handles one voucher on one shoe only; ambiguous cases must
// go back to the cashier rather than creating an incorrect receipt.
const applyGroupBuyVoucherPolicy = ({ sourceText, items, payments, vouchers = [] }) => {
  const source = String(sourceText || '');
  const mentions = voucherMentions(source);
  const couponInPayments = payments.some((payment) => isVoucherMethod(payment.method));
  if (!hasVoucherWords(source) && !couponInPayments) return null;

  const issues = [];
  if (mentions.length !== 1 || mentions[0].count !== 1) {
    issues.push('团购券暂只支持一单一张，请明确券种和数量');
    return { issues };
  }
  const mention = mentions[0];
  // 券目录来自「团购券管理」表（只取在售），不在代码里写死。
  const voucher = findVoucher(vouchers, mention);
  if (!voucher) {
    issues.push(`未配置 ${mention.purchasePrice} 元抵 ${mention.faceValue} 元的团购券结算金额`);
    return { issues };
  }
  if (items.length !== 1 || Number(items[0].quantity) !== 1) {
    issues.push('团购券暂只支持一单一双；多双鞋请逐双说明券后成交金额');
    return { issues };
  }
  // ⚠️ 判据是"她说了钱没结清的说法"（定金 / 尾款 / 欠款…），**不是交易类型** ——
  //    「未付 / 预付」在这里都只是她的话（资金那一维），2026-10-07 起不再是一种类型。
  if (/定金|预付|预定|尾款|未付|欠款|赊账/.test(source)) {
    issues.push('团购券与"定/尾款、欠款"这类没结清的钱同时出现，请人工核对成交金额和待收款');
    return { issues };
  }

  const spokenCash = explicitCashPayments(source);
  // The spoken cash facts, not the model's guessed payment array, are the
  // authority. This also prevents an AI-labelled 100-yuan voucher from being
  // written as a second cash receipt.
  // Pure voucher use must be explicit; a named cash method without an amount
  // is genuinely incomplete, not a zero-cash sale.
  if (!spokenCash.length && /(微信|现金|支付宝)/.test(source)) {
    issues.push('请说明团购券之外实际收到的金额和支付方式');
  } else if (!spokenCash.length && !/只用|只有|仅用|纯券|没有补差|不补差|(?:是|用)一张/.test(source)) {
    issues.push('请确认是否只用团购券、没有补现金额');
  }
  const cashPayments = spokenCash.map((payment) => ({ ...payment, status: '已收款' }));
  if (cashPayments.some((payment) => !Number.isFinite(cents(payment.amount)) || cents(payment.amount) <= 0)) {
    issues.push('实际支付金额无效');
  }
  if (issues.length) return { issues };

  const cashCents = cashPayments.reduce((sum, payment) => sum + cents(payment.amount), 0);
  const settlementCents = cents(voucher.settlementAmount);
  const netCents = cashCents + settlementCents;
  const grossCents = cashCents + cents(voucher.faceValue);
  // AI may mistake the cash top-up for the full shoe price. Only a price
  // explicitly stated as the shoe's sale price in the user's words can
  // contradict the deterministic cash + voucher calculation.
  if (explicitSalePrices(source).some((value) => ![netCents, grossCents].includes(cents(value)))) {
    issues.push('明确说出的成交价与实际支付及团购券抵扣不一致，请核对');
    return { issues };
  }

  return {
    items: [{ ...items[0], actual_amount: yuan(netCents) }],
    agreedTotal: yuan(netCents),
    payments: [...cashPayments, { method: '抖音团购券', amount: voucher.settlementAmount, status: '待平台结算' }],
    voucher: { purchase_price: voucher.purchasePrice, face_value: voucher.faceValue,
      settlement_amount: voucher.settlementAmount },
    issues,
  };
};

module.exports = { applyGroupBuyVoucherPolicy, voucherMentions };
