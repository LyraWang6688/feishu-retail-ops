// 「9 点待处理单推送」**三块候选**的判据与取值口径（配置先行；业务负责人 2026-10-08 定）。
//
// 为什么单独一份配置、而不是塞进 `config/pendingDealPush`：
//   · `pendingDealPush` 管的是**这条消息长什么样**（模板 / 分区标题 / 配色 / 重试 / 开关）；
//     这里管的是**哪些记录进候选、金额按哪一列算** —— 两件事会各自演进（解耦 / 模块化）。
//   · ⚠️ 尤其因为 `resolvePendingDealPushConfig({})` 的返回值被既有用例**严格全等**盯住
//     （`pendingDealPush.test.js` 的"配置默认值"用例）：往那个对象里加键就会把用例打红。
//     新增口径放这里，既有配置的**形状一个字不变**。
//
// ⭐ 2026-10-08 晚业务负责人**纠正了聚合单位**（逐字）：
//   「首先是现货未收：你只需要去交易明细里看交易类型，如果类型是现货但未收款，那就属于现货未收。
//    对于预定的：你需要去销售明细里找**预定但未交付**的，同时再去收款明细里找到**这笔销售单号
//    对应的未收款金额**，就很简单」，补充：「**直接按照销售单号去进行聚合**就可以了」。
//
// ⇒ 两块都改成「**一张销售单一行**」（旧版是"一条明细一行 / 一条收款明细一行"，那是错的）：
//   ① 【预定】      = 「销售明细」里 **交易类型 = 预定** 且 **履约状态 ≠ 已交付** 的件；
//                     一行 = **一张销售单**，文字 = 该单**符合上述条件的那几件**（货号 颜色 尺码 并列）；
//                     金额 = **该销售单号在「收款明细」里所有 `收款状态 = 未收款` 的金额之和**。
//   ② 【现货未收】  = 「收款明细」里 **交易类型 = 现货** 且 **收款状态 = 未收款** 的记录；
//                     一行 = **一张销售单**（同一单多条未收款 ⇒ 一行），文字 = 该单的 货号 颜色 尺码；
//                     金额 = **同一口径**（该销售单号下所有 `收款状态 = 未收款` 的金额之和）。
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
//      · **交易类型用「行为编码」**（`SALE_PREPAID` / `SALE_CASH`）—— 从既有注册表取，
//        本文件**不新造编码**，service 里也**不写**「现货 / 预定」这种中文字面量
//        （那两列在真表上是**关联 / 查表引用**，指到「行为管理」，编码才是契约）。
//
// ⚠️ 时间字段一律由飞书自动生成（`createdAt` = 「报货日」/ 收款明细的创建时间）⇒ 这里只**读**。

// 「收款明细.收款状态 = 未收款」那条取值：同一个事实在 `salesConfirmDeal` 里已经有一份声明。
// 这里**转发**，不再写一遍中文字面量（两份迟早走歪，见 AGENTS.md 第 11 条①）。
const { PAYMENT_STATUS_UNPAID } = require('./salesConfirmDeal');
// 「收款明细.收款状态 = 待平台结算」同理：声明在 `salesCardFacts`（第二步团购券块要用）。
const { PENDING_SETTLEMENT_STATUS } = require('./salesCardFacts');
// 「交易类型」两个行为编码的唯一映射处：`salesTradeTypePolicy` 的
// 「实时库存里有这双 → 现货 `SALE_CASH` / 没有 → 预定 `SALE_PREPAID`」。
// ⚠️ 那两个编码本身声明在 `config/salesMovements` 的注册表里；这里**只引用、不新造**。
const { SALES_TRADE_TYPE_BY_STOCK } = require('./salesTradeTypePolicy');

// ── ① 【预定】：销售明细的履约状态 ──────────────────────────────────────────
// 与 `salesProgressService.progressFromRecords` 的默认档同名同值（那一处是读取时的兜底）。
const PENDING_PUSH_DELIVERED_STATUS = '已交付';
const PENDING_PUSH_UNDELIVERED_STATUS = '未交付';

// ── ①② 交易类型的两条**行为编码**（判据；不是中文）─────────────────────────────
//   · 销售明细.交易类型 是**关联「行为管理」**的字段：格里是记录 id ⇒ 按「行为编码」比。
//   · 收款明细.交易类型 是**查表引用**（指向销售单那一侧的「交易类型」）：格里可能是
//     `{ text }` ⇒ 由 `config/salesMovements` 的中文↔编码对照表收敛成同一个编码。
//   两条路都落到**同一个编码**上，所以判据只有一份（见 `PendingPushCandidateService`）。
const PENDING_PUSH_PREPAID_TRADE_TYPE_CODE = SALES_TRADE_TYPE_BY_STOCK.outOfStock; // SALE_PREPAID
const PENDING_PUSH_CASH_TRADE_TYPE_CODE = SALES_TRADE_TYPE_BY_STOCK.inStock; // SALE_CASH

/**
 * 一次把三块要用到的口径读出来。**只读一次、集中在启动时**（与 `pendingDealPush` 同一条纪律：
 * 配置写错要在服务起来的那一刻就吵，而不是等第二天 9 点推送时才失败）。
 *
 * ⚠️ 交易类型的两个编码**不做成环境变量**：它们是**行为表的契约**（`config/salesMovements`
 *    的注册表说了算，改编码要同步那张表），不是一个可以随手换的说法 —— 换掉它等于换一种业务。
 *    ⚠️ 也**没有**"清空某一块判据 ⇒ 这块静默变空"的旋钮：三块是业务负责人点名要的，
 *    要停某一块应该走它自己的区块/大区配置（`PENDING_DEAL_PUSH_BLOCK_ORDER` / `..._AREA_ORDER`），
 *    而不是把判据字面量清空（那样会静默少推一类，正是最难查的那类事故）。
 */
const resolvePendingPushCandidateConfig = (env = process.env) => Object.freeze({
  // ① 预定（销售明细侧）
  undeliveredStatus: PENDING_PUSH_UNDELIVERED_STATUS,
  deliveredStatus: PENDING_PUSH_DELIVERED_STATUS,
  prepaidTradeTypeCode: PENDING_PUSH_PREPAID_TRADE_TYPE_CODE,
  // ② 现货未收（收款明细侧）
  unpaidPaymentStatus: PAYMENT_STATUS_UNPAID,
  // 第二步（团购券块）会用；这里只是转发既有声明，不在本文件重写。
  platformPendingPaymentStatus: PENDING_SETTLEMENT_STATUS,
  cashTradeTypeCode: PENDING_PUSH_CASH_TRADE_TYPE_CODE,
});

module.exports = {
  PENDING_PUSH_UNDELIVERED_STATUS,
  PENDING_PUSH_DELIVERED_STATUS,
  PENDING_PUSH_PREPAID_TRADE_TYPE_CODE,
  PENDING_PUSH_CASH_TRADE_TYPE_CODE,
  resolvePendingPushCandidateConfig,
};
