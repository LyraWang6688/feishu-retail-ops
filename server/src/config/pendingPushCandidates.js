// 「9 点待处理单推送」**三块候选**的判据与取值口径（配置先行；业务负责人 2026-10-08 定）。
//
// 为什么单独一份配置、而不是塞进 `config/pendingDealPush`：
//   · `pendingDealPush` 管的是**这条消息长什么样**（模板 / 分区标题 / 配色 / 重试 / 开关）；
//     这里管的是**哪些记录进候选、金额按哪一列算** —— 两件事会各自演进（解耦 / 模块化）。
//   · ⚠️ 尤其因为 `resolvePendingDealPushConfig({})` 的返回值被既有用例**严格全等**盯住
//     （`pendingDealPush.test.js` 的"配置默认值"用例）：往那个对象里加键就会把用例打红。
//     新增口径放这里，既有配置的**形状一个字不变**。
//
// 三块的口径（逐字，见 `docs/push-blocks-caliber-2026-10-08.md`）：
//   ① 【预定】      = 「销售明细」里 **履约状态 = 未交付** 的明细行（**逐件一行**）；
//                     金额 = **该销售单号的待收款**（走 `salesProgressService.progressFromRecords`）。
//   ② 【现货待收】  = 「收款明细」里 **收款状态 = 未收款** 且 **交易类型含「现货」**（一条一行）；
//                     金额 = **该条收款明细的「收款金额」**。
//   ③ 【采购】      = 「报货批次」里 **到货状态 = 未到货**（判据在 `config/purchaseArrivalStatus`，
//                     那一处已经是唯一实现，这里**不再写第二份**）；
//                     文字 = 供应商 + 报货日 + 录入数量。
//
// ⚠️ 字面量（表里的取值）**只在这里写一次**：service 里一行中文都不写。
//    与既有配置的关系（"别新造第二份"）：
//      · 「未交付」同时是 `salesProgressService.progressFromRecords` 的默认值 —— 那边是**读**，
//        这里是**筛**，两处指同一个取值；默认值刻意与它同名同值（改一处要一起改）。
//      · 「未收款」**直接复用** `config/salesConfirmDeal.PAYMENT_STATUS_UNPAID`（同一个事实）。
//      · 「待平台结算」**直接复用** `config/salesCardFacts.PENDING_SETTLEMENT_STATUS`
//        —— 第二步（团购券块）要它；本次只把它**转发**出来，不在本文件重写一遍。
//
// ⚠️ 时间字段一律由飞书自动生成（`createdAt` = 「报货日」/ 收款明细的创建时间）⇒ 这里只**读**。

const { readString } = require('./envValue');
// 「收款明细.收款状态 = 未收款」那条取值：同一个事实在 `salesConfirmDeal` 里已经有一份声明。
// 这里**转发**，不再写一遍中文字面量（两份迟早走歪，见 AGENTS.md 第 11 条①）。
const { PAYMENT_STATUS_UNPAID } = require('./salesConfirmDeal');
// 「收款明细.收款状态 = 待平台结算」同理：声明在 `salesCardFacts`（第二步团购券块要用）。
const { PENDING_SETTLEMENT_STATUS } = require('./salesCardFacts');

// ── ① 【预定】：销售明细的履约状态 ──────────────────────────────────────────
// 与 `salesProgressService.progressFromRecords` 的默认档同名同值（那一处是读取时的兜底）。
const PENDING_PUSH_DELIVERED_STATUS = '已交付';
const PENDING_PUSH_UNDELIVERED_STATUS = '未交付';

// ── ② 【现货待收】：收款明细的「交易类型」里认哪个词 ────────────────────────
// 那一列在真表上是**查表引用**（指到销售单那一侧的「交易类型」= 现货 / 预定），
// 一格可能写着多个（一单里两种货都有）⇒ 判据是「**含**」而不是「等于」。
const PENDING_PUSH_CASH_TRADE_TYPE_KEYWORD_ENV_KEY = 'PENDING_PUSH_CASH_TRADE_TYPE_KEYWORD';
const DEFAULT_PENDING_PUSH_CASH_TRADE_TYPE_KEYWORD = '现货';

/**
 * 一次把三块要用到的口径读出来。**只读一次、集中在启动时**（与 `pendingDealPush` 同一条纪律：
 * 配置写错要在服务起来的那一刻就吵，而不是等第二天 9 点推送时才失败）。
 *
 * ⚠️ 环境变量设成空串 = 这一项用默认值（`readString` 的统一规矩）——
 *    这里**不给**"空串 = 不要这一块"的开关：三块是业务负责人点名要的，
 *    要停某一块应该走它自己的区块/大区配置（`PENDING_DEAL_PUSH_BLOCK_ORDER` / `..._AREA_ORDER`），
 *    而不是把判据字面量清空（那样会静默少推一类，正是最难查的那类事故）。
 *    ⚠️ 但**判据关键词**（`cashTradeTypeKeyword`）在 `readString` 的规矩下"显式空串"是
 *    一个合法取值 —— 那会让判据永远不匹配 ⇒ **整块静默变空**。所以这一项显式**拒空**：
 *    空串（或只有空白）→ 用默认值（它不是一个可以"关掉"的旋钮，而是一个"叫什么名字"的取值）。
 */
const resolvePendingPushCandidateConfig = (env = process.env) => Object.freeze({
  // ① 预定
  undeliveredStatus: PENDING_PUSH_UNDELIVERED_STATUS,
  deliveredStatus: PENDING_PUSH_DELIVERED_STATUS,
  // ② 现货待收
  unpaidPaymentStatus: PAYMENT_STATUS_UNPAID,
  // 第二步（团购券块）会用；这里只是转发既有声明，不在本文件重写。
  platformPendingPaymentStatus: PENDING_SETTLEMENT_STATUS,
  cashTradeTypeKeyword: readString(env, PENDING_PUSH_CASH_TRADE_TYPE_KEYWORD_ENV_KEY, null)?.trim()
    || DEFAULT_PENDING_PUSH_CASH_TRADE_TYPE_KEYWORD,
});

module.exports = {
  PENDING_PUSH_CASH_TRADE_TYPE_KEYWORD_ENV_KEY,
  DEFAULT_PENDING_PUSH_CASH_TRADE_TYPE_KEYWORD,
  PENDING_PUSH_UNDELIVERED_STATUS,
  PENDING_PUSH_DELIVERED_STATUS,
  resolvePendingPushCandidateConfig,
};
