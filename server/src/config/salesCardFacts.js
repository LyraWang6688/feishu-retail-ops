// 销售卡片上「类型 · 履约状态 · 收款情况」这三段的**文案与渲染**（配置先行）。
//
// 业务负责人口径（2026-10-07，逐字）：
//   「【卡片 = 分开说】类型 · 履约状态 · 收款情况（已收多少、还欠多少）」
//
// 为什么单独一个配置文件：
//   · 这三段是**用户可见文案**（改说法不该动逻辑）；
//   · 「类型」现在是**算出来的**（查完实时库存再定，见 `config/salesTradeTypePolicy`），
//     卡片只负责把它**念出来**；「履约状态」由类型推出来，「收款情况」由资金那一维算出来
//     —— 三件事互相独立，正是她说的"分开说"。
//
// ⚠️ 本文件**只渲染、不判断业务**：
//   · "这一行是什么类型" 取 `itemTradeTypeCode`（配置里的唯一取法）；
//   · "要不要交付" 取 `deliversForTradeType`（注册表的 `delivery`）；
//   · "已收 / 还欠" 只做**加法与减法**（成交额 − 已收），不做任何"猜欠款"——
//     入账层只认她明说的欠款（见 `services/salesOrderService`），这里显示的是
//     **同一份事实**：已收来自 payments，应收来自 agreed_total。
//
// ⚠️ 取值规则走 `config/envValue`（没设 → 默认值；设了（含空串）→ 显式取值）。
//     **调用时才解析**，不在模块加载时求值（避免 dotenv 加载顺序事故）。
// ⚠️ 「未付」**不许**再作为一种类型出现在这三段里：类型只有现货 / 预定两种，
//     钱没结清由「收款情况」那一段说（她明说：「它只是现货 + 钱没结清的状态」）。

const { readRaw, readString } = require('./envValue');
const { itemTradeTypeCode } = require('./salesTradeTypePolicy');
const { deliversForTradeType, tradeTypeLabel } = require('./salesMovements');

const TRADE_TYPE_LINE_KEY = 'SALES_CARD_TRADE_TYPE_LINE';
const FULFILLMENT_LINE_KEY = 'SALES_CARD_FULFILLMENT_LINE';
const PAYMENT_LINE_KEY = 'SALES_CARD_PAYMENT_LINE';
const UNDETERMINED_TEXT_KEY = 'SALES_CARD_UNDETERMINED_TEXT';

// 「待平台结算」是**收款明细的状态值**（表里的取值，不是文案）：
// 团购券那笔钱由平台结算，不算"她已经收到的钱"，但仍然不是欠款。
const PENDING_SETTLEMENT_STATUS = '待平台结算';

const DEFAULTS = Object.freeze({
  // 三段各一行（占位符见下面 TEMPLATE_PLACEHOLDERS，写错名字在**解析时**抛错）。
  tradeTypeLine: '类型：{type}',
  fulfillmentLine: '履约状态：{fulfillment}',
  paymentLine: '收款情况：{payment}',
  // 类型还没定（颜色还没选 / 库存还没查）时那两个字。
  undetermined: '待定',
  // 一张单里出现多种类型时的分隔（例：`现货 / 预定`）。
  tradeTypeSeparator: ' / ',
  // 履约状态：三种取值**与注册表的 `delivery` 必须一致**（`salesCardFacts.test.js` 钉住）。
  fulfillment: Object.freeze({
    delivered: '已交付',
    undelivered: '未交付',
    partial: '部分交付',
  }),
  payment: Object.freeze({
    // 已收：`已收 微信 ￥100；现金 ￥50`；一分没收 → `尚未收款`。
    received: '已收 {items}',
    // `{method}` 自带尾空格（没有方式时是空串）；`{amount}` 自带 ￥。
    receivedItem: '{method}{amount}',
    receivedEmpty: '尚未收款',
    // 还欠：`还欠 ￥128`；一分不欠 → `已结清`（金额读不出来时用占位符）。
    owed: '还欠 {amount}',
    settled: '已结清',
    // 两个子句之间的分隔。
    separator: '；',
    // 金额读不出来时的占位（**绝不**显示成 ￥0 —— 那是在说"这单不用收钱"）。
    amountPlaceholder: '待录入',
    yuan: '￥',
  }),
});

const TEMPLATE_PLACEHOLDERS = Object.freeze({
  tradeTypeLine: Object.freeze(['type']),
  fulfillmentLine: Object.freeze(['fulfillment']),
  paymentLine: Object.freeze(['payment']),
});

const assertTemplate = (label, template, allowed) => {
  const text = String(template ?? '');
  for (const match of text.matchAll(/\{([^{}]*)\}/g)) {
    if (!allowed.includes(match[1])) {
      throw new Error(`${label} 里有无法识别的占位符 {${match[1]}}`
        + `（可用：${allowed.map((name) => `{${name}}`).join(' ')}）`);
    }
  }
  return text;
};

const resolveSalesCardFactsConfig = (env = process.env) => {
  const read = (key, fallback) => {
    const raw = readRaw(env, key);
    return raw === null ? fallback : readString(env, key, fallback);
  };
  const undetermined = read(UNDETERMINED_TEXT_KEY, DEFAULTS.undetermined);
  return {
    tradeTypeLine: assertTemplate(TRADE_TYPE_LINE_KEY,
      read(TRADE_TYPE_LINE_KEY, DEFAULTS.tradeTypeLine), TEMPLATE_PLACEHOLDERS.tradeTypeLine),
    fulfillmentLine: assertTemplate(FULFILLMENT_LINE_KEY,
      read(FULFILLMENT_LINE_KEY, DEFAULTS.fulfillmentLine), TEMPLATE_PLACEHOLDERS.fulfillmentLine),
    paymentLine: assertTemplate(PAYMENT_LINE_KEY,
      read(PAYMENT_LINE_KEY, DEFAULTS.paymentLine), TEMPLATE_PLACEHOLDERS.paymentLine),
    // 空串 = 用默认（它是"还没定"那一刻唯一可见的解释，留空只会让人看不懂）。
    undetermined: undetermined.trim() ? undetermined : DEFAULTS.undetermined,
    tradeTypeSeparator: DEFAULTS.tradeTypeSeparator,
    fulfillment: DEFAULTS.fulfillment,
    payment: DEFAULTS.payment,
  };
};

const fill = (template, values) => String(template ?? '')
  .replace(/\{([^{}]*)\}/g, (whole, key) => (
    values[key] === undefined || values[key] === null ? '' : String(values[key])));

const yuanText = (value, payment) => {
  if (value === null || value === undefined || value === '') return payment.amountPlaceholder;
  const number = Number(value);
  if (!Number.isFinite(number)) return payment.amountPlaceholder;
  const fixed = Math.round(number * 100) / 100;
  // 整数不显示 `.00`（与她原话里的写法一致：￥100 而不是 ￥100.00）。
  return `${payment.yuan}${Number.isInteger(fixed) ? fixed : fixed.toFixed(2)}`;
};

const moneyText = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
};

/**
 * 三段（**类型 / 履约状态 / 收款情况**）的取值。
 * 全部来自**这一份草稿上的事实**，不读表、不请求远端。
 *
 * @returns {{ type: string, fulfillment: string, payment: string, lines: string[] }}
 */
const salesCardFactsFor = (draft = {}, config = resolveSalesCardFactsConfig()) => {
  const items = Array.isArray(draft.items) ? draft.items : [];
  const codes = items.map((item) => itemTradeTypeCode(item, draft.trade_type_code));
  // 认不出来的编码 = "这一行还没定"（多颜色、颜色还没选，库存还没查）。
  const undetermined = codes.some((code) => !code);

  // ── 类型 ──
  const labels = [...new Set(codes.map((code) => tradeTypeLabel(code)).filter(Boolean))];
  if (undetermined || !labels.length) labels.push(config.undetermined);
  const type = labels.join(config.tradeTypeSeparator);

  // ── 履约状态 ──
  // 预定 → 不交付；现货 → 交付；一张单里两种都有 → 部分交付。
  // ⚠️ 交付状态由**类型**推出来（`config/salesMovements.delivery`），这里不另立判据。
  let fulfillment = config.undetermined;
  if (!undetermined && codes.length) {
    const deliverable = codes.filter((code) => deliversForTradeType(code)).length;
    fulfillment = deliverable === 0 ? config.fulfillment.undelivered
      : deliverable === codes.length ? config.fulfillment.delivered
        : config.fulfillment.partial;
  }

  // ── 收款情况 ──
  const payments = Array.isArray(draft.payments) ? draft.payments : [];
  const received = payments.filter((payment) => payment.status !== PENDING_SETTLEMENT_STATUS);
  const receivedCents = Math.round(received
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0) * 100);
  const platformCents = Math.round(payments
    .filter((payment) => payment.status === PENDING_SETTLEMENT_STATUS)
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0) * 100);
  const totalCents = Math.round(Number(draft.agreed_total || 0) * 100);
  const receivedText = received.length
    ? fill(config.payment.received, {
      items: received.map((payment) => {
        const method = String(payment.method || '').trim();
        return fill(config.payment.receivedItem, {
          method: method ? `${method} ` : '',
          amount: yuanText(payment.amount, config.payment),
        });
      }).join(config.payment.separator),
    })
    : config.payment.receivedEmpty;
  // 还欠 = 成交额 − 已收 − 待平台结算（封底 0）。成交额读不出来 → 用她明说的欠款，
  // 两者都没有才显示占位符（**绝不**显示 ￥0 —— 那是在说"这单不用收钱"）。
  const statedOwed = moneyText(draft.owed);
  const outstandingCents = totalCents > 0
    ? Math.max(0, totalCents - receivedCents - platformCents)
    : (statedOwed === null ? null : Math.round(statedOwed * 100));
  const owedClause = outstandingCents === 0
    ? config.payment.settled
    : fill(config.payment.owed, {
      amount: outstandingCents === null
        ? config.payment.amountPlaceholder
        : yuanText(outstandingCents / 100, config.payment),
    });
  const payment = `${receivedText}${config.payment.separator}${owedClause}`;

  return {
    type,
    fulfillment,
    payment,
    lines: [
      fill(config.tradeTypeLine, { type }),
      fill(config.fulfillmentLine, { fulfillment }),
      fill(config.paymentLine, { payment }),
    ],
  };
};

module.exports = {
  TRADE_TYPE_LINE_KEY,
  FULFILLMENT_LINE_KEY,
  PAYMENT_LINE_KEY,
  UNDETERMINED_TEXT_KEY,
  PENDING_SETTLEMENT_STATUS,
  SALES_CARD_FACTS_DEFAULTS: DEFAULTS,
  resolveSalesCardFactsConfig,
  salesCardFactsFor,
  yuanText,
};
