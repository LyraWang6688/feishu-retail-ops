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

// 原「销售明细」的「履约状态」目标值。原主表的「订单状态」**不动**（业务负责人明确要求）。
const AFTER_SALES_FULFILLMENT = Object.freeze({
  RETURNED: '已退货',
  EXCHANGED: '已换货',
  COMPENSATED: '已赔货',
});

// 钱的方向。写「收款明细.交易方向」：差价为正要收（收入），为负要退（退回）。
const AFTER_SALES_MONEY_DIRECTIONS = Object.freeze({
  RECEIVE: '收入',
  REFUND: '退回',
});

// 一个动作的完整语义。
//   tradeTypeCode          新主表 / 新明细行「交易类型」关联的行为编码
//   originalFulfillmentStatus  原明细行的「履约状态」改成什么
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

const readAfterSalesConfig = () => ({
  moneyDirections: AFTER_SALES_MONEY_DIRECTIONS,
  // 新主表的解析 / 确认状态：走与销售链路**同一套取值**（larkMvpService 里用的那几个），
  // 不自创新词。售后是用户确认后直接执行的，所以直接落在终态上。
  masterParseStatus: '解析成功',
  masterConfirmStatus: '已入账',
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
  AFTER_SALES_MONEY_DIRECTIONS,
  AFTER_SALES_ACTION_SPECS,
  AFTER_SALES_KEY_PREFIX,
  AFTER_SALES_CREDIT_KEY_FIELD,
  actionSpecOf,
  afterSalesEventId,
  afterSalesOperationId,
  readAfterSalesConfig,
};
