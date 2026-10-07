// 「已入账」终态卡上那个【确认成交】按钮：**出现判据 + 用户可见文案 + 本地任务状态**（配置先行）。
//
// ── 业务口径（业务负责人 2026-10-07，逐字）────────────────────────────────────
//   「一旦判定这一单是**预订或者现货未收**，入账之后就会给用户发一个消息卡片，
//    确认该笔交易是否成交。**只有当用户点击"是"的时候，才会触发我们后续的流程**。」
//   ★ 她拍板的实现方式（**甲**）：「把【确认成交】按钮**做在那张已经在你手里的卡上**
//     （就是"销售订单处理中/已入账"那张**终态卡**）—— **不新发消息**，你在原卡上点」
//   ⇒ 「卡片」= 机器人**已经发出去的**那张「销售订单已入账」终态卡（`stage: 'posted'`）。
//
// 为什么单独一个配置文件（`AGENTS.md`《底层工程原则》「配置先行」）：
//   · 按钮文案 / 提示 / 已成交 / 货没到 —— **全是用户可见文案**，改说法不该动逻辑；
//   · 「这一单要不要这个按钮」是一条**业务判据**，换口径不该改一行 service。
//
// ⚠️ 本文件**只做两件事**：① 解析文案与状态名；② 纯函数判据 `needsConfirmDeal`。
//    点击之后"钱 + 货"怎么写**不在这里** —— 那走既有的「成交」那一条路
//    （`services/salesThreadProgressService.js` 的 complete 分支 →
//      `SecondDeliveryService.confirm` → `PaymentService` / `SalesDeliveryService`）。
//
// ⚠️ 取值规则走 `config/envValue`（**没设** → 默认值；**设了**（含空串）→ 就是显式取值）；
//    **调用时才解析**（`resolveSalesConfirmDealConfig(process.env)`），
//    不在模块加载时求值 —— 2026-10-06 的 dotenv 加载顺序事故就是这么来的。

const { readRaw, readString } = require('./envValue');
const { itemTradeTypeCode } = require('./salesTradeTypePolicy');
const { deliversForTradeType } = require('./salesMovements');

// 卡片动作名（**内部契约**，不是文案）：卡片渲染与机器人分派**共用这一个常量**，
// 不各写一份而慢慢写歪（与 `larkCards.SECOND_DELIVERY_ACTION` 同一规矩）。
const SALES_CONFIRM_DEAL_ACTIONS = Object.freeze({
  CONFIRM: 'confirm_sale_deal',
});

// 本地任务记录（`data/lark_mvp_tasks`）上的状态。
// ⚠️ 只写本地任务记录，**一个字都不写业务表**；状态名是排查口径，所以放配置里。
const CONFIRM_DEAL_TASK_STATUS = Object.freeze({
  // 钱货两清 —— 真的成交了（第二次点击直接短路）。
  SETTLED: 'confirm_deal_settled',
  // 货还没到（库存不足）：**一个字节都没写**（不写钱、不写交付、卡片不变灰）。
  SHORT_STOCK: 'confirm_deal_short_stock',
  // 货做完了，钱按她的口径**回问一句**（没替她挑收款方式），同样没写钱。
  ASKING: 'confirm_deal_asking',
  // 尝试写入但失败了（原因写在 `confirm_deal_reason`）。
  FAILED: 'confirm_deal_failed',
});

// 「收款明细.收款状态」里那条**占位**的取值（表里的选项，与 `salesOrderService`
// / `paymentService` 里的字面量同一个事实）。它**不是**用户可见文案。
const PAYMENT_STATUS_UNPAID = '未收款';

const BUTTON_LABEL_KEY = 'SALES_CONFIRM_DEAL_BUTTON_LABEL';
const HINT_KEY = 'SALES_CONFIRM_DEAL_HINT';
const SETTLED_TITLE_KEY = 'SALES_CONFIRM_DEAL_SETTLED_TITLE';
const SETTLED_TEXT_KEY = 'SALES_CONFIRM_DEAL_SETTLED_TEXT';
const SETTLED_CLOCK_KEY = 'SALES_CONFIRM_DEAL_SETTLED_CLOCK';
const SETTLED_MESSAGE_KEY = 'SALES_CONFIRM_DEAL_SETTLED_MESSAGE';
// ⭐ 成交那句说明的**续句**：这一单还有几双没交出去（交付只成了一半时）。
//    为什么单独一个键：它是**可变的一句话**（有几双、要不要去工作台核对），
//    与"销售单号 + 已成交"那句事实分开配；没有未交付时**一个字都不加**。
const SETTLED_UNDELIVERED_KEY = 'SALES_CONFIRM_DEAL_SETTLED_UNDELIVERED';
const ORDER_NO_FALLBACK_KEY = 'SALES_CONFIRM_DEAL_ORDER_NO_FALLBACK';
const SHORT_STOCK_KEY = 'SALES_CONFIRM_DEAL_SHORT_STOCK';
const ASKING_TOAST_KEY = 'SALES_CONFIRM_DEAL_ASKING_TOAST';
const ALREADY_TOAST_KEY = 'SALES_CONFIRM_DEAL_ALREADY_TOAST';
const SUCCESS_TOAST_KEY = 'SALES_CONFIRM_DEAL_SUCCESS_TOAST';
const NOTHING_TEXT_KEY = 'SALES_CONFIRM_DEAL_NOTHING_TEXT';
const FAILED_TOAST_KEY = 'SALES_CONFIRM_DEAL_FAILED_TOAST';

// 默认值（= 改完之后她第一眼见到的样子）。
const DEFAULTS = Object.freeze({
  // ⭐ 卡面上**只有一个**按钮，文案就是这六个字 —— 她明确「选项只能点"是"」，
  //    **不许**加"取消 / 否 / 稍后"这第二个选项。
  buttonLabel: '确认成交',
  // 按钮上方那行小字：说清"点了才会继续"，免得她以为不点也会走。
  hint: '点一次「确认成交」才会继续走后续流程。',
  // 点完之后那张卡的标题与那一行说明。
  settledTitle: '销售订单已成交',
  settledText: '✅ 已成交{clock}',
  settledClock: '（{clock} 点击）',
  settledMessage: '销售单号：{orderNo}；已成交。',
  // ⭐ 成交后那句说明的续句：**还有几双没交出去**（`{count}` = 没交成的条数）。
  //    为什么必须写出来（业务负责人 2026-10-07 的问题 4）：交付是**逐条**做的，
  //    一单里"A 双交成功、B 双没货"时这一单仍算成交（部分交付，既有语义），
  //    但如果卡面上只写"已成交"，那几双就从她的视线里消失了 —— 她只会在客户来取货时才发现。
  //    所以：成交那行说明要把"仍未交付 N 双"带上；没有未交付时**一个字都不加**。
  settledUndelivered: '仍未交付 {count} 双，请到工作台核对。',
  // 单号读不出来时的兜底说法（与终态卡既有那句同一口径，不显示一个空单号）。
  orderNoFallback: '请在销售主表核对',
  // ⭐ 预定单**货还没到**（交付时库存不足）时那句回话：她说要"明确说清"。
  //    刻意**不带**底层错误原文（"库存里没有这一行"这种机器话），而是一句她能照做的话。
  shortStock: '这双还没到货（或库存不够），先走到货入库，到货之后再到这张卡上点「确认成交」。',
  // 货做完了、钱问一句（她没说收款方式）：复述她定的口径，不替她挑方式。
  askingToast: '货已经记成交了；这笔钱是怎么收的？说一句我再记账',
  // 这一单已经成交（第二次点击 / 网络重试）。
  alreadyToast: '这一单已经成交，无需重复处理',
  successToast: '已成交：{summary}',
  // 成交里"没什么可做的"时那句汇总（钱货本来就齐了）。
  nothingText: '无待处理项',
  failedToast: '这次确认成交没做完：{reason}',
});

/**
 * 读一份配置。任何一项：环境变量**没设** → 默认值；**设了**（含空串）→ 用设的值。
 * ⚠️ 「只差一个词就没人看得懂」的那几项（按钮 / 提示 / 货没到 / 已成交说明）空串时回退默认 ——
 *    它们是她那一刻唯一看得见的说明，留空只会让她看不懂这张卡。
 */
const resolveSalesConfirmDealConfig = (env = process.env) => {
  const read = (key, fallback) => {
    const raw = readRaw(env, key);
    return raw === null ? fallback : readString(env, key, fallback);
  };
  const readVisible = (key, fallback) => {
    const value = read(key, fallback);
    return String(value).trim() ? value : fallback;
  };
  return {
    buttonLabel: readVisible(BUTTON_LABEL_KEY, DEFAULTS.buttonLabel),
    hint: read(HINT_KEY, DEFAULTS.hint),
    settledTitle: readVisible(SETTLED_TITLE_KEY, DEFAULTS.settledTitle),
    settledText: readVisible(SETTLED_TEXT_KEY, DEFAULTS.settledText),
    settledClock: read(SETTLED_CLOCK_KEY, DEFAULTS.settledClock),
    settledMessage: readVisible(SETTLED_MESSAGE_KEY, DEFAULTS.settledMessage),
    // ⚠️ 与 `settledMessage` 同一处理（空串回退默认）：这句是"还有几双没交出去"的**唯一**提醒，
    //    留空等于把那几双又藏起来 —— 那正是这次要修的问题。
    settledUndelivered: readVisible(SETTLED_UNDELIVERED_KEY, DEFAULTS.settledUndelivered),
    orderNoFallback: readVisible(ORDER_NO_FALLBACK_KEY, DEFAULTS.orderNoFallback),
    shortStock: readVisible(SHORT_STOCK_KEY, DEFAULTS.shortStock),
    askingToast: readVisible(ASKING_TOAST_KEY, DEFAULTS.askingToast),
    alreadyToast: readVisible(ALREADY_TOAST_KEY, DEFAULTS.alreadyToast),
    successToast: readVisible(SUCCESS_TOAST_KEY, DEFAULTS.successToast),
    nothingText: readVisible(NOTHING_TEXT_KEY, DEFAULTS.nothingText),
    failedToast: readVisible(FAILED_TOAST_KEY, DEFAULTS.failedToast),
  };
};

/** ⚠️ 文案占位符填充（`{orderNo}` / `{clock}` / `{summary}` / `{reason}`）：本模块**导出**它，
 *  因为这几段文案的填充点（卡片渲染、机器人接线）都读同一份默认文案 ——
 *  换一个词不该在两处各改一次（语义与 `config/secondDeliveryCard` 那个 `fill` 逐字相同）。 */
const fill = (template, values = {}) => String(template ?? '')
  .replace(/\{([^{}]*)\}/g, (whole, key) => (
    values[key] === undefined || values[key] === null ? '' : String(values[key])));

/**
 * ⭐ **「这一单要不要【确认成交】按钮」——全仓唯一判据**（纯函数，可单测）。
 *
 * 与业务负责人的两句话一一对应：「判定这一单是**预订或者现货未收**」：
 *   ① **货没交完**（预定 = 不交付，见 `config/salesMovements` 的 `delivery`）；
 *   ② **钱没结清**（她明说过的欠款 / 已经挂着的那条「未收款」占位）。
 * 两条都不成立 ⇒ 现货已交付已结清 = **干净的单一，不许打扰她**（她明确要求）。
 *
 * ⚠️ 「钱没结清」的判据**刻意不拿「成交 − 已收」去猜**：入账层只在她**明说欠多少**时
 *    才补那条「未收款」占位（`salesOrderService`：「她说欠才算欠；后端不拿差额去猜是还价还是欠款」）。
 *    ⇒ 「有未收款」⇔「`draft.owed` 非空」。这也是**业务表里真有一条待收**的判据，
 *      所以按钮不会出现在"其实没什么可做"的单上（那种点了只会回"已经成交"）。
 *
 * @param {{draft?: object, deliveryFailures?: Array}} input
 *   `deliveryFailures` = 本地任务上记着的上一次交付失败（`task.delivery_failures`）：
 *   **货其实没交出去**的单也要这个按钮，否则那几双永远没有回到这张卡的入口。
 * @returns {{needed: boolean, reason: 'delivery_failed'|'undelivered'|'unsettled'|'completed'}}
 */
const needsConfirmDeal = ({ draft = {}, deliveryFailures = [] } = {}) => {
  if (Array.isArray(deliveryFailures) && deliveryFailures.length) {
    return { needed: true, reason: 'delivery_failed' };
  }
  const items = Array.isArray(draft?.items) ? draft.items : [];
  const codes = items.map((item) => itemTradeTypeCode(item, draft?.trade_type_code));
  // ① 货：有「不交付」的行（预定）⇒ 还没交完。判据从注册表来，这里不写死编码。
  if (codes.some((code) => !deliversForTradeType(code))) {
    return { needed: true, reason: 'undelivered' };
  }
  // ② 钱：她说过的欠款 / 已经挂着「未收款」占位。
  if (hasOutstandingMoney(draft)) return { needed: true, reason: 'unsettled' };
  return { needed: false, reason: 'completed' };
};

/** 「钱没结清」= 她明说欠多少，或这条单上已经挂着一条「未收款」。 */
const hasOutstandingMoney = (draft = {}) => {
  const owed = Number(String(draft?.owed ?? '').trim());
  if (Number.isFinite(owed) && owed > 0) return true;
  return (Array.isArray(draft?.payments) ? draft.payments : [])
    .some((payment) => String(payment?.status || '').trim() === PAYMENT_STATUS_UNPAID);
};

// 环境变量名 → 默认值。给「`.env.example` 与默认值逐字一致」那条回归用
// （新加一句文案忘了写进 `.env.example` → 当场红；与 `SALES_MISSING_INFO_*` 同一套路）。
const SALES_CONFIRM_DEAL_DEFAULTS_BY_KEY = Object.freeze({
  [BUTTON_LABEL_KEY]: DEFAULTS.buttonLabel,
  [HINT_KEY]: DEFAULTS.hint,
  [SETTLED_TITLE_KEY]: DEFAULTS.settledTitle,
  [SETTLED_TEXT_KEY]: DEFAULTS.settledText,
  [SETTLED_CLOCK_KEY]: DEFAULTS.settledClock,
  [SETTLED_MESSAGE_KEY]: DEFAULTS.settledMessage,
  [SETTLED_UNDELIVERED_KEY]: DEFAULTS.settledUndelivered,
  [ORDER_NO_FALLBACK_KEY]: DEFAULTS.orderNoFallback,
  [SHORT_STOCK_KEY]: DEFAULTS.shortStock,
  [ASKING_TOAST_KEY]: DEFAULTS.askingToast,
  [ALREADY_TOAST_KEY]: DEFAULTS.alreadyToast,
  [SUCCESS_TOAST_KEY]: DEFAULTS.successToast,
  [NOTHING_TEXT_KEY]: DEFAULTS.nothingText,
  [FAILED_TOAST_KEY]: DEFAULTS.failedToast,
});

module.exports = {
  SALES_CONFIRM_DEAL_ACTIONS,
  CONFIRM_DEAL_TASK_STATUS,
  PAYMENT_STATUS_UNPAID,
  BUTTON_LABEL_KEY,
  HINT_KEY,
  SETTLED_TITLE_KEY,
  SETTLED_TEXT_KEY,
  SETTLED_CLOCK_KEY,
  SETTLED_MESSAGE_KEY,
  SETTLED_UNDELIVERED_KEY,
  ORDER_NO_FALLBACK_KEY,
  SHORT_STOCK_KEY,
  ASKING_TOAST_KEY,
  ALREADY_TOAST_KEY,
  SUCCESS_TOAST_KEY,
  NOTHING_TEXT_KEY,
  FAILED_TOAST_KEY,
  SALES_CONFIRM_DEAL_DEFAULTS: DEFAULTS,
  SALES_CONFIRM_DEAL_DEFAULTS_BY_KEY,
  resolveSalesConfirmDealConfig,
  needsConfirmDeal,
  hasOutstandingMoney,
  fill,
};
