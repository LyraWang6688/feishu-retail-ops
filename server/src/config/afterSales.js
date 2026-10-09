// 退换货第二期·第一步：售后执行器的配置（动作枚举 + 幂等标识 + 落库契约）。
//
// 为什么单独成文件（配置先行）：
//   一笔售后「是什么动作」由一组事实决定——交易类型指哪个行为、原明细履约状态改成什么、
//   库存往哪边动、钱怎么走、退回的鞋落在哪个状态。这些是**业务配置**，运营在「行为管理」
//   表里改库存方向、或以后新增一种售后动作时，只应该改这里一处，
//   而不是在执行器里加一串 if-else（AGENTS.md：少写散落的 if-else，优先配置驱动）。
//
// 文件里只放**业务配置与写入契约**（动作语义、幂等标识、字段口径）；
// 真正的接线（默认注入 InventoryService）在 services/afterSalesService.js。

const crypto = require('node:crypto');

// 动作枚举。键就是调用方传进来的 action，值是飞书里的中文口径（只用于日志和人看的文案）。
const AFTER_SALES_ACTIONS = Object.freeze({
  RETURN: 'return',
  EXCHANGE: 'exchange',
  COMPENSATION: 'compensation',
});

// 「行为管理」表里的「行为编码」。编码是契约：表里改中文名不影响代码，
// 但改编码必须同步这里（和 salesMovements / inventoryService 的做法一致）。
//
// ⚠️ 已核对过「行为管理」里这四个行为的**库存方向**：
//   SALE_RETURN 增加 · SALE_EXCHANGE 不影响 · SALE_COMPENSATION 减少 · SALE_CASH 减少
// 现货销售（SALE_CASH）同时是「交易类型」和「库存行为」：换货时新鞋出库走它，方向=减少。
const AFTER_SALES_BEHAVIORS = Object.freeze({
  SALE_RETURN: 'SALE_RETURN',
  SALE_EXCHANGE: 'SALE_EXCHANGE',
  SALE_COMPENSATION: 'SALE_COMPENSATION',
  SALE_CASH: 'SALE_CASH',
});

// 原「销售明细」的「履约状态」目标值。**原主表不动**（业务负责人明确要求）。
// ⚠️ 原主表的「订单状态」那一列已被她 2026-10-06 整列删除，不再有任何写入点。
//
// ⭐ 防后人再走错：「退过没退过」记在【销售明细·履约状态】和【新建的退货单】上，
//    不写原单的「销售状态」—— 那一列的语义是"明细写进去了没有"
//    （未写入 / 部分写入 / 已写入 / 写入失败），**没有「已退货」这个选项**，
//    写了飞书会自动新建选项，把那一列搞乱。
//    （原「销售状态」回写开关已于 2026-10-06 整体删除——业务负责人定过"原主表一字不动"。）
const AFTER_SALES_FULFILLMENT = Object.freeze({
  RETURNED: '已退货',
  EXCHANGED: '已换货',
  COMPENSATED: '已赔货',
  // ⭐ 2026-10-08：**新换出去的那一双**当场就交到她手上了 ⇒ 新建明细行的「履约状态」写它。
  //   为什么只在这一条腿上用：原明细行表达的是"这双被换回了"（已换货）；
  //   而**这次换出去的新鞋**是一件已经交付的商品事实，履约状态不能空着
  //   （真机事实：XSD-20261007-0054 的新明细 reczz28KZzAY4BBi 当时是空的）。
  //   ⚠️ 只有换货动作声明它（见 EXCHANGE 的 newLineFulfillmentStatus）——
  //   退货的复制行、赔货的出货行本次**一个字不改**（既有行为）。
  DELIVERED: '已交付',
});

// ⭐ 2026-10-08：「**退过 / 换过 / 赔过**的明细**不再属于待处理**」——
//    两份"待处理"清单（9 点待处理单推送 / 成交提醒）都按这条把整单排除。
//
// 业务负责人的口径（逐字）：
//   「其实**不需要单号**，需要的是那个**编号和尺码信息**～……然后销售按照**预定和现货待收**分区，
//    **不需要退货和换货的**，销售就是预定和现货待收的」
//
// ⚠️ 这是**口径变更、不是放宽**：改动前这些单**也是**被跳过的 —— `progressFromRecords`
//    见到这三种履约状态会抛「未知销售明细履约状态：已换货」，调用方 catch 之后同样把整单跳过，
//    只是日志把它说成"未知"（今天日志里就有这一条），看着像代码没想过这个取值。
//    现在把它写成明确规则：**判据从这里取，日志如实说 reason（不再出现"未知"的 warn）**。
// ⚠️ 必须在**候选那一处**判（`SecondDeliveryService.listPendingDeliveries`）：
//    两条推送共用同一份候选口径，判两遍迟早走歪。
const AFTER_SALES_FULFILLMENT_EXCLUDED = Object.freeze([
  AFTER_SALES_FULFILLMENT.RETURNED,
  AFTER_SALES_FULFILLMENT.EXCHANGED,
  AFTER_SALES_FULFILLMENT.COMPENSATED,
]);

/** 这一条明细的履约状态是不是"退过 / 换过 / 赔过"（**唯一判据**，两边共用）。 */
const isAfterSalesFulfillment = (status) => AFTER_SALES_FULFILLMENT_EXCLUDED
  .includes(String(status ?? '').trim());

// 钱的方向。写「收款明细.交易方向」：差价为正要收（收入），为负要退（退回）。
// ⚠️ 真表核对（业务负责人 2026-10-08）：「收款明细.交易方向」的选项**只有 收入 / 退回**，
//    她确认就用现成的「退回」，不新增选项（所以这里的取值一个字都不改）。
const AFTER_SALES_MONEY_DIRECTIONS = Object.freeze({
  RECEIVE: '收入',
  REFUND: '退回',
});

// ⭐⭐ 2026-10-08 售后口径（业务负责人逐字，权威；出处 docs/goods-and-money-flows-2026-10-08.md §2/§3）：
//
//   「**退货**：我们就在**原有的销售明细**里面操作：找到当时的销售单，把那双鞋的状态改为"**已退货**"，
//    然后把**收款改成"已退款"**就可以了，如果是用户要资金，那就是**已退款**；
//    用户留存，那就是**已留存**。」
//
// ⇒ 退货的钱**不新建记录**，而是把**原收款记录**的「收款状态」改成 已退款 / 已留存。
// 旧行为（新建一条「交易方向=退回」的收款记录）**整体保留**，做成一个显式枚举：
//   · `updateStatus`（**默认**，按她 2026-10-08 的口径）—— 改原收款行的状态；
//   · `newReturnRow`（**旧行为**，回退用）—— 新建一条 退回 收款行。
// 两种实现都有用例（test/afterSalesService.test.js），翻配置即可回退，不用改代码。
//
// ⚠️ 值只认下面两个，其余**当场抛错**、不静默取默认：
//    这一项决定"钱记在哪一行"，拼错一个字母就悄悄换一种记账口径，属于最难查的静默失效。
const AFTER_SALES_RETURN_FUNDS_MODES = Object.freeze({
  UPDATE_STATUS: 'updateStatus',
  NEW_RETURN_ROW: 'newReturnRow',
});
const AFTER_SALES_RETURN_FUNDS_MODE_ENV = 'AFTER_SALES_RETURN_FUNDS_MODE';
const AFTER_SALES_RETURN_FUNDS_MODE_DEFAULT = AFTER_SALES_RETURN_FUNDS_MODES.UPDATE_STATUS;

/**
 * 退货收款走哪种实现。没设 / 设成空串 → 默认（她的口径）；
 * 设了认不出来的值 → 抛错（不静默）。
 */
const resolveAfterSalesReturnFundsMode = (env = process.env) => {
  const raw = env ? env[AFTER_SALES_RETURN_FUNDS_MODE_ENV] : undefined;
  const value = String(raw ?? '').trim();
  if (!value) return AFTER_SALES_RETURN_FUNDS_MODE_DEFAULT;
  const known = Object.values(AFTER_SALES_RETURN_FUNDS_MODES);
  if (!known.includes(value)) {
    throw new Error(
      `${AFTER_SALES_RETURN_FUNDS_MODE_ENV} 只接受 ${known.join(' / ')}，当前取值认不出；`
      + `留空 = 默认 ${AFTER_SALES_RETURN_FUNDS_MODE_DEFAULT}（业务负责人 2026-10-08 的退货口径：改原收款记录的状态）`,
    );
  }
  return value;
};

// 「收款明细.收款状态」的取值。**真表选项已核（业务负责人 2026-10-08）**：
//   待平台结算 / 已收款 / 未收款 / **已退款** / **已留存**
// ⇒ 她要用的是现成的两个，代码**不新建选项**（新建 = 悄悄污染生产表的选项集）。
//
// 口径（逐字）：「**收款明细表**：如果金额没变，就没有记录；如果是有价差，如果是**增加资金**的话，
//   就是**已收款**，收款方向是**收入**；如果是我们**付差价**的话，方向就是**退回**，状态是**已退款**。」
const AFTER_SALES_PAYMENT_STATUS = Object.freeze({
  // 增加资金（收入）
  RECEIVED: '已收款',
  // 我们付差价（退回）—— 她的口径
  REFUNDED: '已退款',
  // 用户留存（退货时"钱先放我们这儿"）
  RETAINED: '已留存',
});

/**
 * 这一次售后的钱是不是走「改原收款记录的状态」这条腿。
 * **只有退货** + 模式 = `updateStatus` 才是；换货 / 赔货的差价照旧写「收款明细」（她的口径只改了退货）。
 */
const usesOriginalPaymentStatus = ({ action, returnFundsMode } = {}) => (
  String(action ?? '').trim() === AFTER_SALES_ACTIONS.RETURN
  && String(returnFundsMode ?? '').trim() === AFTER_SALES_RETURN_FUNDS_MODES.UPDATE_STATUS
);

// ⭐ 售后写在「收款明细.收款状态」上的两个"已经处理完"的状态。
//
// 为什么单列出来：**销售进度口径**（`services/salesProgressService.progressFromRecords`）
// 只认识 已收款 / 待平台结算 / 未收款 —— 见到别的取值会**当场抛「未知收款状态」**。
// 而退货"改状态"这一支恰恰会把**原单**的收款行改成这两个取值 ⇒ 不认它们，
// 那一单的进度计算（查单 / 跟进 / 待处理候选）就会炸。
//
// ⚠️ 口径选择（**最小改动**，需业务负责人确认，别当成定论）：
//    这两个状态在进度口径里**按"已结清"算**（与改动前一致 —— 改动前原单的收款行一直是
//    「已收款」，售后那条新行的方向/状态在原单之外）。
//    代价：原单的「已收金额」不会因为退款而变小（退款事实记在**原明细履约状态**与**售后单**上）。
//    另一种做法（退款的金额从"已收"里扣掉）会让这一单重新显示成"客户还欠钱"，
//    反而可能把它重新推进「现货待收」那类待处理清单 —— **比高估更危险**，所以没采用。
const AFTER_SALES_SETTLED_PAYMENT_STATUSES = Object.freeze([
  AFTER_SALES_PAYMENT_STATUS.REFUNDED,
  AFTER_SALES_PAYMENT_STATUS.RETAINED,
]);

/** 这个收款状态是不是"售后已经处理完、不再挂账"（进度口径里按已结清算）。 */
const isSettledAfterSalesPaymentStatus = (status) => AFTER_SALES_SETTLED_PAYMENT_STATUSES
  .includes(String(status ?? '').trim());

// 一个动作的完整语义。
//   tradeTypeCode          新主表 / 新明细行「交易类型」关联的行为编码
//   originalFulfillmentStatus  原明细行的「履约状态」改成什么
//   newLineFulfillmentStatus   **新建明细行**（出货商品那一行）的「履约状态」写什么；
//                              不声明 = 不写（退货/赔货保持既有行为，见各自的条目）
//   requiresRestockState   退回的鞋回哪儿必填（门盒 / 样品）——她没说就由卡片问，执行器不猜
//   acceptsNewLines        newLines 是不是出货商品；退货必须为空
//   movements              库存流水 + 实时库存的动作，每条流水一行（一双一行，与销售明细一致）
//     source: 'returned' 用被退/被换的原始行作为来源
//             'new'      用出货商品行作为来源
//     state:  'restockState' 用调用方指定的门盒/样品；其余是固定值
//
// ⚠️ 这三个行为编码必须先在 inventoryService 的 STOCK_MOVEMENTS 里声明，applyChange 才会认；
//    缺失时它抛「未在库存动作注册表中声明动作」。三条声明已加（2026-10-05 接线）：
//      SALE_RETURN:       { direction: '增加', ledgerSource: 'salesDetail', consumes: null,     triggerSampleReplacement: false }
//      SALE_COMPENSATION: { direction: '减少', ledgerSource: 'salesDetail', consumes: ['门盒'], triggerSampleReplacement: false }
//      SALE_CASH:         { direction: '减少', ledgerSource: 'salesDetail', consumes: ['门盒'], triggerSampleReplacement: false }
//    （新增 kind 后 validateStockBehaviors() 要求假 Base 里也有这三条行为，
//      所以同步补了 inventoryMvp / validateV1Schema 两处测试 fixture —— 不补会红 2 条。）
const AFTER_SALES_ACTION_SPECS = Object.freeze({
  [AFTER_SALES_ACTIONS.RETURN]: Object.freeze({
    label: '退货',
    tradeTypeCode: AFTER_SALES_BEHAVIORS.SALE_RETURN,
    originalFulfillmentStatus: AFTER_SALES_FULFILLMENT.RETURNED,
    requiresRestockState: true,
    acceptsNewLines: false,
    movements: Object.freeze([
      Object.freeze({ source: 'returned', behaviorCode: AFTER_SALES_BEHAVIORS.SALE_RETURN, state: 'restockState' }),
    ]),
  }),
  [AFTER_SALES_ACTIONS.EXCHANGE]: Object.freeze({
    label: '换货',
    tradeTypeCode: AFTER_SALES_BEHAVIORS.SALE_EXCHANGE,
    originalFulfillmentStatus: AFTER_SALES_FULFILLMENT.EXCHANGED,
    // ⭐ 2026-10-08（业务负责人逐字确认：「好的，是的就叫**已交付**～」）：
    //   **新换出去的那双**是当场交到她手上的商品事实 ⇒ 新建明细行的「履约状态」= 已交付。
    //   ⚠️ 赔货那一条 2026-10-08 下午也声明了自己的取值（已赔货，见下）；
    //      只有**退货**的复制行仍然一个字不写（退货的复制行表达"退回来的那双"，
    //      履约状态由**原明细行 = 已退货**表达）。
    newLineFulfillmentStatus: AFTER_SALES_FULFILLMENT.DELIVERED,
    requiresRestockState: true,
    acceptsNewLines: true,
    movements: Object.freeze([
      // 旧鞋回来（+），新鞋出去（−）：两行流水方向相反，数量都是正数。
      Object.freeze({ source: 'returned', behaviorCode: AFTER_SALES_BEHAVIORS.SALE_RETURN, state: 'restockState' }),
      Object.freeze({ source: 'new', behaviorCode: AFTER_SALES_BEHAVIORS.SALE_CASH, state: '门盒' }),
    ]),
  }),
  [AFTER_SALES_ACTIONS.COMPENSATION]: Object.freeze({
    label: '赔货',
    tradeTypeCode: AFTER_SALES_BEHAVIORS.SALE_COMPENSATION,
    originalFulfillmentStatus: AFTER_SALES_FULFILLMENT.COMPENSATED,
    // ⭐⭐ 2026-10-08 赔付口径（业务负责人逐字，权威；出处 docs/goods-and-money-flows-2026-10-08.md §2）：
    //   「**赔付**：如果是赔货，我们就**直接在销售明细里面创建一个赔付对应颜色和编号、尺码**的信息，
    //    **成交金额记为 0**，**标记为赔货**」
    // ⇒ 赔出去的那双**新建一条销售明细行**：
    //   · 编号 / 颜色 / 尺码 = 赔出去的那一双（颜色是「编号」那一列关联的货品自带的，
    //     销售明细契约里**没有**颜色列 —— 见报告）；
    //   · 「成交金额」= **0**（赔货不是卖，不能记成收入）；
    //   · 「履约状态」= **已赔货**。
    // 赔货是直接赔一双出去（坏鞋不回库），所以只有出货这一腿，也不需要 restockState。
    requiresRestockState: false,
    acceptsNewLines: true,
    // 新明细行的「履约状态」= 已赔货（配置先行：执行器里不写中文字面量）。
    newLineFulfillmentStatus: AFTER_SALES_FULFILLMENT.COMPENSATED,
    // ⭐ 新明细行的「成交金额」**由口径固定成 0**，不用调用方传来的那个价格。
    //   为什么固定而不是"让调用方传 0"：调用方（afterSalesFlowService）确实会带新鞋的挂牌价
    //   （它要用那个价算差价），执行器**不能**把挂牌价当成交金额写进赔货行 —— 那会凭空多一笔销售额。
    newLineAmount: 0,
    movements: Object.freeze([
      Object.freeze({ source: 'new', behaviorCode: AFTER_SALES_BEHAVIORS.SALE_COMPENSATION, state: '门盒' }),
    ]),
  }),
});

const actionSpecOf = (action) => {
  const spec = AFTER_SALES_ACTION_SPECS[String(action || '').trim()];
  if (!spec) throw new Error(`未声明的售后动作：${String(action || '').trim() || '(空)'}`);
  return spec;
};

// ---------------------------------------------------------------------------
// 幂等标识
// ---------------------------------------------------------------------------
//
// 这一期**不给销售主表 / 销售明细 / 收款明细加「幂等键」列**（不改生产表结构），
// 所以幂等分两层：
//
//   ① 总闸门（本地 + 动作顺序）：执行器把"这一次售后"的进度写在本地任务记录里
//      （和库存的 data/inventory_operations 同一套 JsonTaskStore），
//        已完成 → 整次跳过，一个字节都不写；
//        做到一半 → 带着已写好的 record_id 继续，不重复写。
//      闸门的分片键：调用方给了 taskId 就用它（每次用户消息一个任务，最准），
//      否则退回 after_sales_<原主表id>_<action>_<批次哈希>。
//
//   ② 「客户往来货款」自己有现成的幂等键字段「业务事件ID」，值用规范里的
//      after_sales:<原主表id>:<action>:<批次哈希>：即使本地记录丢了，也能回查远端认出这一笔。
//
// 批次哈希（本次改动的关键）：
//   键里必须带「这一次退的是哪几条原明细」的短哈希，否则**同一笔销售分两次退不同的鞋**
//   （正常场景）会因为撞上同一个键被大声拒绝。哈希取排序后的原明细 record_id 拼接，
//   于是：
//     · 同一批明细重复调用  → 键相同 → 幂等，只写一次 ✓
//     · 不同批明细（部分退货）→ 键不同 → 允许再做一次 ✓
//     · 同一条明细被退两次  → 键相同 → 仍被拦住（不会重复退）✓
//
// 本地闸门挡不住「飞书 create 成功、本地落盘失败」这一种窗口（要挡住就得有远端键列）。
// 已知并接受；如果哪天要补，就是给三张表加文本列 + 在这里声明 keyField。
const AFTER_SALES_KEY_PREFIX = 'after_sales';

// ⛔ 「客户往来货款」的幂等键字段曾在这里（AFTER_SALES_CREDIT_KEY_FIELD = 'businessEventId'）：
//    那张表被业务负责人**整表删除**（2026-10-08），prepaid 通路随之下线
//    （见 `services/afterSalesService.assertPrepaidAvailable`）⇒ 常量与导出一并删除，
//    免得留一个指向"不存在的表"的配置让人以为它还在用。
//    接回来时：新表的键列写进 `v1BitableSchema`，并在 `v1SchemaScopes` 的
//    V1_IDEMPOTENCY_KEY_TABLES.sales 里加一条。

/**
 * 这一次售后涉及的原明细批次指纹：把 record_id 去重、排序后拼接再取短哈希。
 * 排序是为了「调用方把两条明细的顺序换一下」不产生第二个键（同一批还是同一批）；
 * 用哈希而不是直接拼 id 是为了键长稳定、可安全写进文本列。
 */
const afterSalesBatchHash = (originalSalesDetailRecordIds = []) => {
  const ids = [...new Set((originalSalesDetailRecordIds || [])
    .map((id) => String(id ?? '').trim())
    .filter(Boolean))].sort();
  if (!ids.length) throw new Error('售后幂等标识缺少被退/被换的原明细，拒绝生成');
  return crypto.createHash('sha256').update(ids.join('|')).digest('hex').slice(0, 12);
};

/** 远端幂等标识：after_sales:<原销售主表 record_id>:<action>:<原明细批次哈希>。 */
const afterSalesEventId = ({ originalSalesEntryRecordId, action, originalSalesDetailRecordIds } = {}) => {
  const entryId = String(originalSalesEntryRecordId || '').trim();
  const actionValue = String(action || '').trim();
  if (!entryId || !actionValue) throw new Error('售后幂等标识缺少原单或动作，拒绝生成');
  return `${AFTER_SALES_KEY_PREFIX}:${entryId}:${actionValue}:${afterSalesBatchHash(originalSalesDetailRecordIds)}`;
};

/**
 * 本地任务记录的 id。JsonTaskStore 只接受 [a-zA-Z0-9_-]，
 * 所以这里用下划线而不是冒号（远端文本字段才用冒号格式）。
 * 批次哈希同样进本地 id：否则"先退明细 A、再退明细 B"会撞进同一个分片，
 * 被总闸门当成"同一分片里塞了另一笔售后"而大声拒绝。
 */
const afterSalesOperationId = ({ taskId, originalSalesEntryRecordId, action, originalSalesDetailRecordIds } = {}) => {
  const batch = afterSalesBatchHash(originalSalesDetailRecordIds);
  const safeTaskId = String(taskId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (safeTaskId) return `after_sales_task_${safeTaskId}_${batch}`;
  const entryId = String(originalSalesEntryRecordId || '').trim();
  const actionValue = String(action || '').trim();
  if (!entryId || !actionValue) throw new Error('售后任务 id 缺少原单或动作，拒绝生成');
  return `after_sales_${entryId}_${actionValue}_${batch}`;
};

const readAfterSalesConfig = (env = process.env) => ({
  moneyDirections: AFTER_SALES_MONEY_DIRECTIONS,
  // 🔴 售后**不写**原单「销售状态」——那一列的语义是"明细写进去了没有"，
  //    没有「已退货」这个选项（业务负责人 2026-10-06：原主表一字不动）。
  //    这里曾经有一个 writeOriginalSalesStatus 开关，已整体删除。
  // 新主表的解析状态：走与销售链路**同一套取值**（larkMvpService 里用的那个），不自创新词。
  // 🔴 2026-10-09：**这个值已无任何读取点** —— 「解析状态」那一列被业务负责人从生产
  //    「销售主表」删掉了，`afterSalesService.ensureMaster` 里写它的那一次也随列一起删
  //    （见 `config/v1BitableSchema.salesEntry` 段）。本文件**刻意保留这个键**（不顺手删）：
  //    真实表恢复这一列时它是现成的、语义明确的取值来源（与 `PURCHASE_ARRIVAL_INTAKE_ENABLED`
  //    同一处置 —— 留一个没有读取点的常量，比在逻辑里写死 '解析成功' 好）。
  masterParseStatus: '解析成功',
  // ⚠️ 这里**曾经**有一个 masterConfirmStatus: '已入账' —— 2026-10-06 起售后主表只写四个状态维度，
  //    名字与取值统一由 `config/salesStatusDimensions.js`
  //    （SALES_STATUS_FIELDS / SALES_STATUS_WRITE_VALUES）提供：
  //    售后主表写 userAction=已确认 + sales/funds=未写入（见 afterSalesService.ensureMaster）。
  //    「确认状态（旧）」那一列已被她整列删除，也没有任何代码再指向它。
  //
  // ⭐ 退货收款走哪种实现（她的口径 = updateStatus，**默认**；回退用 newReturnRow）。
  //    取值只从环境变量 `AFTER_SALES_RETURN_FUNDS_MODE` 来，认不出的值当场抛（见上面的解析函数）。
  returnFundsMode: resolveAfterSalesReturnFundsMode(env),
  // ⭐ 「收款明细.收款状态」写什么（她的 2026-10-08 口径，真表选项里都已有）：
  //    · received —— 「增加资金」：新建的收款行状态 = 已收款（方向 收入）
  //    · refunded —— 「我们付差价」：新建的收款行状态 = **已退款**（方向 退回）
  //    · retained —— 「用户留存」：**改原收款行**时用的状态 = 已留存
  //    · legacyReturnRow —— **旧行为**（newReturnRow 模式下那条"退回"新行）的状态。
  //      ⚠️ 刻意与 refunded 分开：回退到旧行为时，那一行的状态要与旧代码**逐字一致**（已收款），
  //      否则"翻开关回退"就不是真的回退。
  paymentStatus: Object.freeze({
    received: AFTER_SALES_PAYMENT_STATUS.RECEIVED,
    refunded: AFTER_SALES_PAYMENT_STATUS.REFUNDED,
    retained: AFTER_SALES_PAYMENT_STATUS.RETAINED,
    legacyReturnRow: '已收款',
  }),
  // 退货"改原收款状态"时，哪些状态的收款行算**这笔钱退得回去**：
  //   · 已收款   —— 钱真收到了；
  //   · 待平台结算 —— 团购券的钱在平台上（还没到我们账上，但那一笔是"要退给她的钱"）。
  // ⚠️ **未收款**（她明说欠款的占位）**不在内**：那笔钱根本没收到，没有"退款"可言，
  //    改它会把"还欠我们钱"记成"已退款"。
  refundablePaymentStatuses: Object.freeze([AFTER_SALES_PAYMENT_STATUS.RECEIVED, '待平台结算']),
  // 客户往来货款：这一次变动的类型（表的选项里已有「退货退款」）。
  // ⛔ 2026-10-08：那张表被她**整表删除**，prepaid 通路随之下线 ⇒ 这个值**当前没有读取点**，
  //    留着是为了重建时直接复用（不要因为"没人用"就删掉，它是业务口径的一部分）。
  prepaidChangeType: '退货退款',
  // 退回的鞋只能回这两个状态之一。
  restockStates: Object.freeze(['门盒', '样品']),
  // 出货商品从哪个状态扣（规格：新鞋从门盒减一行）。
  outgoingState: '门盒',
  settlements: Object.freeze(['cash', 'prepaid']),
});

module.exports = {
  AFTER_SALES_ACTIONS,
  AFTER_SALES_BEHAVIORS,
  AFTER_SALES_FULFILLMENT,
  AFTER_SALES_FULFILLMENT_EXCLUDED,
  isAfterSalesFulfillment,
  AFTER_SALES_MONEY_DIRECTIONS,
  AFTER_SALES_PAYMENT_STATUS,
  AFTER_SALES_SETTLED_PAYMENT_STATUSES,
  isSettledAfterSalesPaymentStatus,
  AFTER_SALES_RETURN_FUNDS_MODES,
  AFTER_SALES_RETURN_FUNDS_MODE_ENV,
  AFTER_SALES_RETURN_FUNDS_MODE_DEFAULT,
  resolveAfterSalesReturnFundsMode,
  usesOriginalPaymentStatus,
  AFTER_SALES_ACTION_SPECS,
  AFTER_SALES_KEY_PREFIX,
  actionSpecOf,
  afterSalesEventId,
  afterSalesOperationId,
  readAfterSalesConfig,
};
