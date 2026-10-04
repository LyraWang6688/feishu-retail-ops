// 销售动作注册表。键 = 飞书「行为管理」表里的「行为编码」。
//
// 一笔销售的性质由两件事决定，它们互相独立：
//   · 交易类型（现货 / 未付 / 预付）→ 决定**交付**状态
//   · 支付方式（现金 / 微信 / 支付宝 / 工商银行 / 抖音团购券）→ 决定**到账**状态
//
// 所以团购券不是一种"交易类型"，它只是一种会延期结算的支付方式：
// 用券买走一双鞋，仍然是现货、当场交付，只是钱要等平台结算。
//
// 交货状态只有三种初始组合，不是三条流程：
//   现货  → 当场交付，钱收清          delivery 已交付
//   未付  → 当场交付，钱还没给        delivery 已交付
//   预付  → 货没拿走（只付了定金）    delivery 未交付  ← 只有这一种
//
// 收款明细不在这里声明：已收多少写在 payments 上，应收减已收的差额由后端自动补一条
// 「未收款」（见 salesOrderService）。这样"现货 / 未付 / 预付"天然落到同一套逻辑里。
const SALES_MOVEMENTS = Object.freeze({
  SALE_CASH: Object.freeze({ label: '现货', delivery: '已交付' }),
  SALE_UNPAID: Object.freeze({ label: '未付', delivery: '已交付' }),
  SALE_PREPAID: Object.freeze({ label: '预付', delivery: '未交付' }),
});

// 只认这三个编码。「销售主表.交易类型」是关联「行为管理」的字段，而那张表里还有
// 销售退货 / 换货 / 赔货 这些**售后**条目——它们不是交易类型，指到它们必须报错，
// 不能静默按现货入账。
const SALES_TRADE_TYPE_CODES = Object.freeze(Object.keys(SALES_MOVEMENTS));

// AI 只输出中文类型；中文与编码的对照关系只在这儿维护一处。
const SALES_TRADE_TYPE_CODES_BY_LABEL = Object.freeze({
  现货: 'SALE_CASH',
  未付: 'SALE_UNPAID',
  预付: 'SALE_PREPAID',
});

const tradeTypeCodeFromLabel = (label) =>
  SALES_TRADE_TYPE_CODES_BY_LABEL[String(label || '').trim()] || '';

const isSalesTradeType = (code) => SALES_TRADE_TYPE_CODES.includes(String(code || ''));

const deliveryForTradeType = (code) => SALES_MOVEMENTS[String(code || '')]?.delivery || '';

const tradeTypeLabel = (code) => SALES_MOVEMENTS[String(code || '')]?.label || '';

module.exports = {
  SALES_MOVEMENTS,
  SALES_TRADE_TYPE_CODES,
  tradeTypeCodeFromLabel,
  isSalesTradeType,
  deliveryForTradeType,
  tradeTypeLabel,
};
