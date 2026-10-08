// 【团购券待结算】区块 + 「确认到账」按钮的**全部口径**（配置先行；配置先行那条纪律的落地件）。
//
// 业务负责人 2026-10-08 逐字口径（见 docs/push-blocks-caliber-2026-10-08.md 第六节）：
//   「**销售还需要加上抖音团购券**，是收款明细里**待平台结算**的记录，**左栏说明**是按照
//     **5 个自然日**今日该到账的待结算金额，**右栏**是用户的**确认按钮**，
//     点击之后这笔待平台结算就会**变为已收款**」
//   「抖音团购券是从收款明细里的**创建时间**开始算，比如创建时间是 1001，那么就是 1006
//     应该 1001 维度下的所有待平台结算的总额，然后用户点了按钮之后，就会把这些记录状态的
//     收款状态改为**已收款**，同时更新收款明细里的**收款时间**」
//   「**逾期未点的要展示**，展示的维度是**按照结算日**，比如今天应该结算多少，
//     昨天应该结算多少，这样算的」
//   「标题叫【**团购券待结算**】，按钮文案为「**确认到账**」」；金额用券的「**平台结算款**」
//
// ⚠️ 本文件**只放会改的口径**（天数 / 状态名 / 文案 / 配色 / 按钮动作名 / 取值正则），
//    service 里**一行中文都不写**。她说要换天数、换按钮文案、换逾期说法 —— 只改这里。
//
// ⚠️ 取值规则（"空串算不算关"那一套）在 `config/envValue`，与 `config/pendingDealPush` 共用。
//    单测直接传 env 进来（不碰全局 process.env），并发跑用例不会互相污染。

const { V1_BITABLE_SCHEMA } = require('./v1BitableSchema');
const { readString, readFlag, readInt } = require('./envValue');

// ── 按钮的动作名（**卡片渲染与服务端分派共用同一份**）────────────────────────────
// ⚠️ 必须是显式的、可检索的字符串：线上日志里 `action: '<这个值>'` 一眼就能对上是哪张卡。
// ⚠️ 卡片按钮只带**结算日**（`settle_day`），**不带名单** —— 服务端按结算日**重新查**，
//    不信任卡片上那份旧名单（名单可能已经过期 / 卡片是昨天发的）。
const ACTION_KEY = 'VOUCHER_SETTLE_CONFIRM_ACTION';
const VOUCHER_SETTLEMENT_ACTIONS_ENV_KEY = ACTION_KEY;
const DEFAULT_VOUCHER_SETTLE_ACTION = 'confirm_voucher_settlement';

// 按钮 value 里那个"结算日"字段名（卡片渲染与服务端解析共用一份，不会两处写歪）。
const VOUCHER_SETTLE_DAY_FIELD_ENV_KEY = 'VOUCHER_SETTLE_DAY_FIELD';
const DEFAULT_SETTLE_DAY_FIELD = 'settle_day';

// ── 业务事实（状态名 / 天数 / 方向）────────────────────────────────────────────
// ⚠️ 这些是**表里的取值**，不是显示文案：改一个值需要她先改表，所以每个都可配、但默认钉死现值。
const VOUCHER_PENDING_STATUS_ENV_KEY = 'VOUCHER_SETTLE_PENDING_STATUS';
const DEFAULT_PENDING_STATUS = '待平台结算';
const VOUCHER_SETTLED_STATUS_ENV_KEY = 'VOUCHER_SETTLE_SETTLED_STATUS';
const DEFAULT_SETTLED_STATUS = '已收款';
// 收款明细.交易方向（只写「收入」：钱真到账才算一次收款事实）。
const VOUCHER_TRADE_DIRECTION_ENV_KEY = 'VOUCHER_SETTLE_TRADE_DIRECTION';
const DEFAULT_TRADE_DIRECTION = '收入';
// 「结算日 = 核销日 + N 个自然日」里的 N（她的口径是 5）。
const VOUCHER_SETTLE_DAYS_ENV_KEY = 'VOUCHER_SETTLE_DAYS';
const DEFAULT_SETTLE_DAYS = 5;
// 券目录只取这一种「销售状态」的券（与 `listGroupBuyVouchers` 同一条口径）。
const VOUCHER_ON_SALE_STATUS_ENV_KEY = 'VOUCHER_SETTLE_ON_SALE_STATUS';
const DEFAULT_ON_SALE_STATUS = '在售';

// ── 显示文案 ─────────────────────────────────────────────────────────────────
// 区块标题（她点名的【团购券待结算】）；空串 = **整块不出现**（她哪天说不要了就把这块关掉）。
const VOUCHER_SETTLE_TITLE_ENV_KEY = 'PENDING_DEAL_PUSH_VOUCHER_TITLE';
const DEFAULT_TITLE = '【团购券待结算】';
// 左栏文字段的默认模板：`{settleDay} 应结算 ¥{amount}`（两栏里的第 1 栏）。
const VOUCHER_SETTLE_ROW_TEMPLATE_ENV_KEY = 'PENDING_DEAL_PUSH_VOUCHER_ROW_TEMPLATE';
const DEFAULT_ROW_TEMPLATE = '{settleDay} 应结算 {amount}';
// 逾期后缀（结算日 < 今天时附在后面）；`{days}` = 逾期天数。
const VOUCHER_SETTLE_OVERDUE_TEMPLATE_ENV_KEY = 'PENDING_DEAL_PUSH_VOUCHER_OVERDUE_TEMPLATE';
const DEFAULT_OVERDUE_TEMPLATE = '（逾期 {days} 天）';
// 右栏按钮文案（她点名「确认到账」）。
const VOUCHER_SETTLE_BUTTON_TEXT_ENV_KEY = 'PENDING_DEAL_PUSH_VOUCHER_BUTTON_TEXT';
const DEFAULT_BUTTON_TEXT = '确认到账';
// 标题行里那个 `{count}`（与既有区块同一形状：`{title}{count} 笔`）。
const VOUCHER_SETTLE_TITLE_TEMPLATE_ENV_KEY = 'PENDING_DEAL_PUSH_VOUCHER_TITLE_TEMPLATE';
const DEFAULT_TITLE_TEMPLATE = '{title}{count} 笔';
// 纯文本降级里的两栏形状（左栏文字 · 右栏按钮文案）——与卡片那条**同一套段**。
const VOUCHER_SETTLE_TEXT_PARTS_ENV_KEY = 'PENDING_DEAL_PUSH_VOUCHER_TEXT_PARTS';
const DEFAULT_TEXT_PARTS = Object.freeze(['{text}', '{button}']);
const VOUCHER_SETTLE_TEXT_SEPARATOR_ENV_KEY = 'PENDING_DEAL_PUSH_VOUCHER_TEXT_SEPARATOR';
const DEFAULT_TEXT_SEPARATOR = ' · ';
// 卡片的配色：标题栏 + 金额高亮（沿用销售区那套配色，可各自配）。
const VOUCHER_SETTLE_AMOUNT_COLOR_ENV_KEY = 'PENDING_DEAL_PUSH_VOUCHER_AMOUNT_COLOR';
const DEFAULT_AMOUNT_COLOR = 'red';
// 金额段的标记骨架（卡片版）：与销售区同一形状 —— 先按 `amountTemplate` 高亮，再塞进 `{amount}`。
const VOUCHER_SETTLE_AMOUNT_TEMPLATE_ENV_KEY = 'PENDING_DEAL_PUSH_VOUCHER_AMOUNT_TEMPLATE';
const DEFAULT_AMOUNT_TEMPLATE = "<font color='{color}'>{amount}</font>";
// 明细读不出来时的占位（**绝不静默丢一行**：宁可显示占位，也不让一个结算日消失）。
const VOUCHER_SETTLE_MISSING_AMOUNT_TEXT_ENV_KEY = 'PENDING_DEAL_PUSH_VOUCHER_MISSING_AMOUNT_TEXT';
const DEFAULT_MISSING_AMOUNT_TEXT = '（金额未读到）';
// 按钮点击之后回的那句话（业务负责人要的"回一句人话"）。
// `{count}` = 本次确认笔数、`{amount}` = 合计金额、`{settleDay}` = 结算日。
const VOUCHER_SETTLE_CONFIRMED_TEMPLATE_ENV_KEY = 'VOUCHER_SETTLE_CONFIRMED_TEMPLATE';
const DEFAULT_CONFIRMED_TEMPLATE = '已确认 {count} 笔、共 {amount}（结算日 {settleDay}）';
// 幂等：这一批已经确认过了（**不再写一次**）。
const VOUCHER_SETTLE_ALREADY_TEMPLATE_ENV_KEY = 'VOUCHER_SETTLE_ALREADY_TEMPLATE';
const DEFAULT_ALREADY_TEMPLATE = '这一批已经确认过了（结算日 {settleDay}）';
// 部分失败 / 完全失败：如实说写了几笔、错在哪（**不静默**）。
const VOUCHER_SETTLE_PARTIAL_TEMPLATE_ENV_KEY = 'VOUCHER_SETTLE_PARTIAL_TEMPLATE';
const DEFAULT_PARTIAL_TEMPLATE = '已确认 {count} 笔、共 {amount}；{failed} 笔失败：{error}';
const VOUCHER_SETTLE_FAILED_TEMPLATE_ENV_KEY = 'VOUCHER_SETTLE_FAILED_TEMPLATE';
const DEFAULT_FAILED_TEMPLATE = '确认失败：{error}';
// 卡片缺结算日（老卡片 / 手拼的 value）——明确回绝，不去猜是哪一天。
const VOUCHER_SETTLE_MISSING_DAY_TEMPLATE_ENV_KEY = 'VOUCHER_SETTLE_MISSING_DAY_TEMPLATE';
const DEFAULT_MISSING_DAY_TEMPLATE = '这张卡片上没有结算日，无法确认到账，请用今天 9 点那条推送上的按钮';
// 确认成功后**卡面**那句话（把按钮换成它；她点完要看得见变化）。
const VOUCHER_SETTLE_CARD_DONE_TEXT_ENV_KEY = 'PENDING_DEAL_PUSH_VOUCHER_CARD_DONE_TEXT';
const DEFAULT_CARD_DONE_TEXT = '（已确认到账）';

// ── 金额解析：从「收款明细.交易方式」的名字里取出券的**售价** ───────────────────
// 真表上的名字形如 `抖音代金券（89.9）`，售价和面值都没写在名字里，只有那个价。
// ⇒ 取名字里**最后一个**数字当售价，再去「团购券管理」按售价匹配券（取它的**平台结算款**）。
// ⚠️ 解析不到券 ⇒ **退回该笔「收款金额」** + 一条 warn（**不静默、不编数**）。
const VOUCHER_PRICE_PATTERN_ENV_KEY = 'VOUCHER_SETTLE_PRICE_PATTERN';
const DEFAULT_PRICE_PATTERN = '(\\d+(?:\\.\\d+)?)(?!.*\\d)';
// 售价与券表里的售价按"分"比（避免 89.9 这类小数在浮点上比不相等）。
const VOUCHER_PRICE_SCALE_ENV_KEY = 'VOUCHER_SETTLE_PRICE_SCALE';
const DEFAULT_PRICE_SCALE = 2;

const PENDING_DEAL_PUSH_VOUCHER_ENABLED_ENV_KEY = 'PENDING_DEAL_PUSH_VOUCHER_ENABLED';

const VOUCHER_SETTLE_TEMPLATE_PLACEHOLDERS = Object.freeze({
  rowTemplate: Object.freeze(['settleDay', 'amount']),
  overdueTemplate: Object.freeze(['days']),
  titleTemplate: Object.freeze(['title', 'count']),
  textPart: Object.freeze(['text', 'button']),
  amountTemplate: Object.freeze(['color', 'amount']),
  confirmedTemplate: Object.freeze(['count', 'amount', 'settleDay']),
  alreadyTemplate: Object.freeze(['settleDay']),
  partialTemplate: Object.freeze(['count', 'amount', 'failed', 'error']),
  failedTemplate: Object.freeze(['error']),
  missingDayTemplate: Object.freeze([]),
});

/** 模板占位符写错（`{setteDay}` 这种）**启动时**就抛 —— 静默渲染成空串是最难查的一类。 */
const assertTemplate = (label, template, allowed) => {
  const text = String(template ?? '');
  for (const match of text.matchAll(/\{([^{}]*)\}/g)) {
    if (!allowed.includes(match[1])) {
      throw new Error(`${label} 里有无法识别的占位符 {${match[1]}}`
        + `（可用：${allowed.map((name) => `{${name}}`).join(' ')}）`);
    }
  }
  const rest = text.replace(/\{[^{}]*\}/g, '');
  if (rest.includes('{') || rest.includes('}')) {
    throw new Error(`${label} 里的占位符没有闭合（大括号必须成对，形如 {settleDay}）`);
  }
  return text;
};

const resolveTextParts = (env) => {
  const raw = readString(env, VOUCHER_SETTLE_TEXT_PARTS_ENV_KEY, null);
  const parts = raw === null
    ? [...DEFAULT_TEXT_PARTS]
    : String(raw).split('|').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) {
    throw new Error(`${VOUCHER_SETTLE_TEXT_PARTS_ENV_KEY} 至少要有一段（多段用 | 分隔），不能是空的`);
  }
  parts.forEach((part) => assertTemplate(
    VOUCHER_SETTLE_TEXT_PARTS_ENV_KEY, part, VOUCHER_SETTLE_TEMPLATE_PLACEHOLDERS.textPart,
  ));
  return parts;
};

// 两张表里要用的**语义键**：名字漂移时必须让部署闸门（`v1:schema-check:*`）当场报红，
// 而不是等 9 点推送静默出一块空的（那正是"最难查的一类"）。
// ⚠️ 这里只**读**语义键名，不复制字段名 —— 真源仍是 `config/v1BitableSchema`。
const PAYMENT_FIELDS = Object.freeze({
  status: 'status', amount: 'amount', method: 'method', receivedAt: 'receivedAt',
  createdAt: 'createdAt', salesEntry: 'salesEntry', tradeDirection: 'tradeDirection',
});
const VOUCHER_FIELDS = Object.freeze({
  name: 'name', purchasePrice: 'purchasePrice', faceValue: 'faceValue',
  settlementAmount: 'settlementAmount', status: 'status',
});

/** 语义键 → 真表字段名（读不到就是配置缺了；调用方拿不到字段名时**照推 + warn**）。 */
const paymentFieldNames = (tableKey = 'paymentRecord') => {
  const fields = V1_BITABLE_SCHEMA.tables?.[tableKey]?.fields || {};
  const resolved = {};
  for (const [key, semantic] of Object.entries(PAYMENT_FIELDS)) resolved[key] = fields[semantic] || '';
  return resolved;
};
const voucherFieldNames = (tableKey = 'groupBuyVoucher') => {
  const fields = V1_BITABLE_SCHEMA.tables?.[tableKey]?.fields || {};
  const resolved = {};
  for (const [key, semantic] of Object.entries(VOUCHER_FIELDS)) resolved[key] = fields[semantic] || '';
  return resolved;
};

/**
 * 一次把整份配置读出来。**启动时**（或第一次用到时）读一次：写错要在那一刻就吵，
 * 而不是等第二天 9 点推送时才失败（那时没人看日志）。
 */
const resolveVoucherSettlementConfig = (env = process.env) => ({
  // 那一块显不显示（默认**开** —— 她 2026-10-08 明确批准了这个功能）。
  enabled: readFlag(env, PENDING_DEAL_PUSH_VOUCHER_ENABLED_ENV_KEY, true),
  action: readString(env, VOUCHER_SETTLEMENT_ACTIONS_ENV_KEY, DEFAULT_VOUCHER_SETTLE_ACTION),
  settleDayField: readString(env, VOUCHER_SETTLE_DAY_FIELD_ENV_KEY, DEFAULT_SETTLE_DAY_FIELD),
  // 业务事实（表里的取值）
  pendingStatus: readString(env, VOUCHER_PENDING_STATUS_ENV_KEY, DEFAULT_PENDING_STATUS),
  settledStatus: readString(env, VOUCHER_SETTLED_STATUS_ENV_KEY, DEFAULT_SETTLED_STATUS),
  tradeDirection: readString(env, VOUCHER_TRADE_DIRECTION_ENV_KEY, DEFAULT_TRADE_DIRECTION),
  settleDays: readInt(env, VOUCHER_SETTLE_DAYS_ENV_KEY, DEFAULT_SETTLE_DAYS, { min: 0, max: 365 }),
  voucherOnSaleStatus: readString(env, VOUCHER_ON_SALE_STATUS_ENV_KEY, DEFAULT_ON_SALE_STATUS),
  priceScale: readInt(env, VOUCHER_PRICE_SCALE_ENV_KEY, DEFAULT_PRICE_SCALE, { min: 0, max: 6 }),
  // 币种符号（金额格式化）——她换币种时不用改代码。
  currencySymbol: readString(env, 'VOUCHER_SETTLE_CURRENCY_SYMBOL', '¥'),
  // 文案
  title: readString(env, VOUCHER_SETTLE_TITLE_ENV_KEY, DEFAULT_TITLE),
  titleTemplate: assertTemplate('voucher.titleTemplate',
    readString(env, VOUCHER_SETTLE_TITLE_TEMPLATE_ENV_KEY, DEFAULT_TITLE_TEMPLATE),
    VOUCHER_SETTLE_TEMPLATE_PLACEHOLDERS.titleTemplate),
  rowTemplate: assertTemplate('voucher.rowTemplate',
    readString(env, VOUCHER_SETTLE_ROW_TEMPLATE_ENV_KEY, DEFAULT_ROW_TEMPLATE),
    VOUCHER_SETTLE_TEMPLATE_PLACEHOLDERS.rowTemplate),
  overdueTemplate: assertTemplate('voucher.overdueTemplate',
    readString(env, VOUCHER_SETTLE_OVERDUE_TEMPLATE_ENV_KEY, DEFAULT_OVERDUE_TEMPLATE),
    VOUCHER_SETTLE_TEMPLATE_PLACEHOLDERS.overdueTemplate),
  buttonText: readString(env, VOUCHER_SETTLE_BUTTON_TEXT_ENV_KEY, DEFAULT_BUTTON_TEXT),
  textParts: resolveTextParts(env),
  textSeparator: readString(env, VOUCHER_SETTLE_TEXT_SEPARATOR_ENV_KEY, DEFAULT_TEXT_SEPARATOR),
  amountColor: readString(env, VOUCHER_SETTLE_AMOUNT_COLOR_ENV_KEY, DEFAULT_AMOUNT_COLOR),
  amountTemplate: assertTemplate('voucher.amountTemplate',
    readString(env, VOUCHER_SETTLE_AMOUNT_TEMPLATE_ENV_KEY, DEFAULT_AMOUNT_TEMPLATE),
    VOUCHER_SETTLE_TEMPLATE_PLACEHOLDERS.amountTemplate),
  missingAmountText: readString(env, VOUCHER_SETTLE_MISSING_AMOUNT_TEXT_ENV_KEY, DEFAULT_MISSING_AMOUNT_TEXT),
  cardDoneText: readString(env, VOUCHER_SETTLE_CARD_DONE_TEXT_ENV_KEY, DEFAULT_CARD_DONE_TEXT),
  // 点击之后的话
  messages: {
    confirmed: assertTemplate('voucher.confirmedTemplate',
      readString(env, VOUCHER_SETTLE_CONFIRMED_TEMPLATE_ENV_KEY, DEFAULT_CONFIRMED_TEMPLATE),
      VOUCHER_SETTLE_TEMPLATE_PLACEHOLDERS.confirmedTemplate),
    already: assertTemplate('voucher.alreadyTemplate',
      readString(env, VOUCHER_SETTLE_ALREADY_TEMPLATE_ENV_KEY, DEFAULT_ALREADY_TEMPLATE),
      VOUCHER_SETTLE_TEMPLATE_PLACEHOLDERS.alreadyTemplate),
    partial: assertTemplate('voucher.partialTemplate',
      readString(env, VOUCHER_SETTLE_PARTIAL_TEMPLATE_ENV_KEY, DEFAULT_PARTIAL_TEMPLATE),
      VOUCHER_SETTLE_TEMPLATE_PLACEHOLDERS.partialTemplate),
    failed: assertTemplate('voucher.failedTemplate',
      readString(env, VOUCHER_SETTLE_FAILED_TEMPLATE_ENV_KEY, DEFAULT_FAILED_TEMPLATE),
      VOUCHER_SETTLE_TEMPLATE_PLACEHOLDERS.failedTemplate),
    missingDay: assertTemplate('voucher.missingDayTemplate',
      readString(env, VOUCHER_SETTLE_MISSING_DAY_TEMPLATE_ENV_KEY, DEFAULT_MISSING_DAY_TEMPLATE),
      VOUCHER_SETTLE_TEMPLATE_PLACEHOLDERS.missingDayTemplate),
  },
  // 金额解析（从收款方式名字里取售价）
  pricePattern: readString(env, VOUCHER_PRICE_PATTERN_ENV_KEY, DEFAULT_PRICE_PATTERN),
  paymentFields: paymentFieldNames(),
  voucherFields: voucherFieldNames(),
});

module.exports = {
  VOUCHER_SETTLEMENT_ACTIONS_ENV_KEY,
  VOUCHER_SETTLE_DAY_FIELD_ENV_KEY,
  VOUCHER_PENDING_STATUS_ENV_KEY,
  VOUCHER_SETTLED_STATUS_ENV_KEY,
  VOUCHER_TRADE_DIRECTION_ENV_KEY,
  VOUCHER_SETTLE_DAYS_ENV_KEY,
  VOUCHER_ON_SALE_STATUS_ENV_KEY,
  VOUCHER_SETTLE_TITLE_ENV_KEY,
  VOUCHER_SETTLE_ROW_TEMPLATE_ENV_KEY,
  VOUCHER_SETTLE_OVERDUE_TEMPLATE_ENV_KEY,
  VOUCHER_SETTLE_BUTTON_TEXT_ENV_KEY,
  VOUCHER_SETTLE_TITLE_TEMPLATE_ENV_KEY,
  VOUCHER_SETTLE_TEXT_PARTS_ENV_KEY,
  VOUCHER_SETTLE_TEXT_SEPARATOR_ENV_KEY,
  VOUCHER_SETTLE_AMOUNT_COLOR_ENV_KEY,
  VOUCHER_SETTLE_AMOUNT_TEMPLATE_ENV_KEY,
  VOUCHER_SETTLE_MISSING_AMOUNT_TEXT_ENV_KEY,
  VOUCHER_SETTLE_CONFIRMED_TEMPLATE_ENV_KEY,
  VOUCHER_SETTLE_ALREADY_TEMPLATE_ENV_KEY,
  VOUCHER_SETTLE_PARTIAL_TEMPLATE_ENV_KEY,
  VOUCHER_SETTLE_FAILED_TEMPLATE_ENV_KEY,
  VOUCHER_SETTLE_MISSING_DAY_TEMPLATE_ENV_KEY,
  VOUCHER_PRICE_PATTERN_ENV_KEY,
  PENDING_DEAL_PUSH_VOUCHER_ENABLED_ENV_KEY,
  DEFAULT_VOUCHER_SETTLE_ACTION,
  DEFAULT_SETTLE_DAY_FIELD,
  DEFAULT_PENDING_STATUS,
  DEFAULT_SETTLED_STATUS,
  DEFAULT_TRADE_DIRECTION,
  DEFAULT_SETTLE_DAYS,
  DEFAULT_TITLE,
  DEFAULT_BUTTON_TEXT,
  DEFAULT_ROW_TEMPLATE,
  DEFAULT_OVERDUE_TEMPLATE,
  DEFAULT_CARD_DONE_TEXT,
  PAYMENT_FIELDS,
  VOUCHER_FIELDS,
  paymentFieldNames,
  voucherFieldNames,
  resolveVoucherSettlementConfig,
  assertTemplate,
};
