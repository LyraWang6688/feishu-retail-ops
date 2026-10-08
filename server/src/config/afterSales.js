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
const AFTER_SALES_MONEY_DIRECTIONS = Object.freeze({
  RECEIVE: '收入',
  REFUND: '退回',
});

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
    //   ⚠️ 只有换货声明这一条：退货/赔货那两条腿的既有行为（新建明细行的履约状态不写）不变。
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
    // 赔货是直接赔一双出去（坏鞋不回库），所以只有出货这一腿，也不需要 restockState。
    requiresRestockState: false,
    acceptsNewLines: true,
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

/** 「客户往来货款」的幂等键字段（语义名，中文列名见 v1BitableSchema.tables.customerCredit）。 */
const AFTER_SALES_CREDIT_KEY_FIELD = 'businessEventId';

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
  masterParseStatus: '解析成功',
  // ⚠️ 这里**曾经**有一个 masterConfirmStatus: '已入账' —— 2026-10-06 起售后主表只写四个状态维度，
  //    名字与取值统一由 `config/salesStatusDimensions.js`
  //    （SALES_STATUS_FIELDS / SALES_STATUS_WRITE_VALUES）提供：
  //    售后主表写 userAction=已确认 + sales/funds=未写入（见 afterSalesService.ensureMaster）。
  //    「确认状态（旧）」那一列已被她整列删除，也没有任何代码再指向它。
  // 收款明细：钱真收/真退之后就是已收款；退款在业务上也用同一个"已结清"口径。
  cashPaymentStatus: '已收款',
  // 客户往来货款：这一次变动的类型（表的选项里已有「退货退款」）。
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
  AFTER_SALES_ACTION_SPECS,
  AFTER_SALES_KEY_PREFIX,
  AFTER_SALES_CREDIT_KEY_FIELD,
  actionSpecOf,
  afterSalesEventId,
  afterSalesOperationId,
  readAfterSalesConfig,
};
