// 销售动作注册表。键 = 飞书「行为管理」表里的「行为编码」。
//
// 🔴 2026-10-07 口径大改（业务负责人拍板，逐字）：
//   「【类型 = 只看库存】（行为表里就两条：现货 SALE_CASH / 预定 SALE_PREPAID）
//     库存里有这双 → 现货（当场交付 + 扣库存）
//     库存里没有 → 预定（不交付；等货到了再交付、那时才扣库存）
//    【资金 = 只听你怎么说】（与类型完全无关）
//    【交付 = 由类型决定】现货已交付 / 预定未交付」
//
// ⇒ **行为管理表里只有两条**：`SALE_CASH`（现货）/ `SALE_PREPAID`（预定）。
//   · 「未付」（原 `SALE_UNPAID`）**不再是交易类型** —— 它只是"现货 + 钱没结清"的状态，
//     资金那一维由 payments / owed 表达（见 `services/salesOrderService`），**与类型无关**。
//   · 「预付」这个名字她已改成「**预定**」，编码 `SALE_PREPAID` **不变**（不发明新编码）。
//   · ⚠️ **类型的判据是"实时库存里有没有这一双"**，不是她嘴上说的性质 ——
//     判据本体在 `config/salesTradeTypePolicy.js`（`salesTradeTypeForStock`），
//     本注册表只回答「这个类型 → 交付状态」。
//
// 一笔销售的两件事仍然互相独立：
//   · 交易类型（现货 / 预定）  → 决定**交付**状态（本文件）
//   · 支付方式（现金 / 微信 / 支付宝 / 工商银行 / 抖音团购券） → 决定**到账**状态
//
// 所以团购券不是一种"交易类型"，它只是一种会延期结算的支付方式：
// 用券买走一双鞋，仍然是现货、当场交付，只是钱要等平台结算。
//
// 交货状态只有两种初始组合：
//   现货  → 当场交付，钱收没收清由资金那一维说     delivery 已交付
//   预定  → 货没拿走（钱可能全款也可能一分没付）    delivery 未交付
//
// 收款明细不在这里声明：已收多少写在 payments 上，应收减已收的差额由后端自动补一条
// 「未收款」（见 salesOrderService）。这样两种类型天然落到同一套资金逻辑里。
//
// ⚠️ 「录单时要跑哪些解析」（货品信息 / 实时库存）**不在这里**：
//    那条规则单独放在 `config/salesTradeTypePolicy.js`。本注册表只管"类型 → 交付状态"。
const SALES_MOVEMENTS = Object.freeze({
  SALE_CASH: Object.freeze({ label: '现货', delivery: '已交付' }),
  SALE_PREPAID: Object.freeze({ label: '预定', delivery: '未交付' }),
});

// 只认这两个编码。「销售主表.交易类型」是关联「行为管理」的字段，而那张表里还有
// 销售退货 / 换货 / 赔货 这些**售后**条目——它们不是交易类型，指到它们必须报错，
// 不能静默按现货入账。
const SALES_TRADE_TYPE_CODES = Object.freeze(Object.keys(SALES_MOVEMENTS));

// AI 只输出中文类型；中文与编码的对照关系只在这儿维护一处。
//   · 「预定」= 她现在的说法（行为表里那一条的名字）；
//   · 「预付」= **同一条记录的旧说法**：老草稿 / 模型偶尔还会这么写，映射到同一个编码，
//     避免"同一个事实两种编码"。⚠️ 落到卡片上时一律用 `SALES_MOVEMENTS` 的**规范标签**。
//   · 「未付」**刻意不在表里** —— 它不再是类型；模型若这么写，编码为空，
//     类型的结论交给库存判据（`salesTradeTypeForStock`），不会被当成一种交易类型。
const SALES_TRADE_TYPE_CODES_BY_LABEL = Object.freeze({
  现货: 'SALE_CASH',
  预定: 'SALE_PREPAID',
  预付: 'SALE_PREPAID',
});

const tradeTypeCodeFromLabel = (label) =>
  SALES_TRADE_TYPE_CODES_BY_LABEL[String(label || '').trim()] || '';

const isSalesTradeType = (code) => SALES_TRADE_TYPE_CODES.includes(String(code || ''));

const deliveryForTradeType = (code) => SALES_MOVEMENTS[String(code || '')]?.delivery || '';

const tradeTypeLabel = (code) => SALES_MOVEMENTS[String(code || '')]?.label || '';

// 「这一行的交易类型要不要**交付并扣库存**」——**唯一**判据就是这个注册表的 `delivery`。
//
// 为什么要单独给一个布尔出参（2026-10-07：一张单可以同时有现货与预定）：
//   交付现在是**逐明细行**决定的（现货行交付、预定行不交付），调用点会长成
//   `items.filter(deliversForTradeType(...))` 这种形状 —— 若让调用点自己写
//   `deliveryForTradeType(code) !== '未交付'`，那个「未交付」中文串就会散进业务逻辑里。
//   认不出的编码（空 / 未知）沿用既有兜底 **交付**，
//   与改动前 `delivery_status: deliveryForTradeType(code) || '已交付'` 逐字同义。
const deliversForTradeType = (code) => deliveryForTradeType(code) !== '未交付';

module.exports = {
  SALES_MOVEMENTS,
  SALES_TRADE_TYPE_CODES,
  SALES_TRADE_TYPE_CODES_BY_LABEL,
  tradeTypeCodeFromLabel,
  isSalesTradeType,
  deliveryForTradeType,
  deliversForTradeType,
  tradeTypeLabel,
};
