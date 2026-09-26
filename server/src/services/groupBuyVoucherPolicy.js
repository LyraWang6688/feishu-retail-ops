const { GROUP_BUY_VOUCHERS } = require('../config/groupBuyVouchers');

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
  .matchAll(/(?:[¥￥]\s*)?(\d+(?:\.\d{1,2})?)\s*(?:元|块)?\s*(微信|现金|支付宝)/g)]
  .map((match) => ({ amount: Number(match[1]), method: match[2] }));

// The model extracts facts, but this policy owns voucher economics and status.
// It intentionally handles one voucher on one shoe only; ambiguous cases must
// go back to the cashier rather than creating an incorrect receipt.
const applyGroupBuyVoucherPolicy = ({ sourceText, items, payments, agreedTotal }) => {
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
  const voucher = GROUP_BUY_VOUCHERS[`${mention.purchasePrice}|${mention.faceValue}`];
  if (!voucher) {
    issues.push(`未配置 ${mention.purchasePrice} 元抵 ${mention.faceValue} 元的团购券结算金额`);
    return { issues };
  }
  if (items.length !== 1 || Number(items[0].quantity) !== 1) {
    issues.push('团购券暂只支持一单一双；多双鞋请逐双说明券后成交金额');
    return { issues };
  }
  if (/定金|预付|尾款|未付|欠款|赊账/.test(source)) {
    issues.push('团购券与预付或未付款同时出现，请人工核对成交金额和待收款');
    return { issues };
  }

  const spokenCash = explicitCashPayments(source);
  // The spoken cash facts, not the model's guessed payment array, are the
  // authority. This also prevents an AI-labelled 100-yuan voucher from being
  // written as a second cash receipt.
  if (!spokenCash.length) issues.push('请说明团购券之外实际收到的金额和支付方式');
  const cashPayments = spokenCash.map((payment) => ({ ...payment, status: '已收清' }));
  if (cashPayments.some((payment) => !Number.isFinite(cents(payment.amount)) || cents(payment.amount) <= 0)) {
    issues.push('实际支付金额无效');
  }
  if (issues.length) return { issues };

  const cashCents = cashPayments.reduce((sum, payment) => sum + cents(payment.amount), 0);
  const settlementCents = cents(voucher.settlementAmount);
  const netCents = cashCents + settlementCents;
  const grossCents = cashCents + cents(voucher.faceValue);
  const reportedAmounts = [items[0].actual_amount, agreedTotal].filter((value) => Number(value) > 0);
  if (reportedAmounts.some((value) => ![netCents, grossCents].includes(cents(value)))) {
    issues.push('口述售价与微信金额及团购券抵扣不一致，请说明成交价');
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
