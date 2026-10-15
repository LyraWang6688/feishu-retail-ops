/**
 * ⭐⭐ **「一单多货品」的配置**（业务负责人 2026-10-15 确认的清单 ✓ · 设计见
 *   `docs/multi-item-order-design-2026-10-15.md` §10）。
 *
 * 为什么要单独一个文件（不改 `scanWrite.js`）：
 *   · **配置先行** ✓ —— 一个模块只回答"参数是多少"，引擎里一行阈值都不许写死 ✗；
 *   · **与 `scanWrite.js` 解耦** ✓ —— 老的"单货品即时提交"那套（`REPLENISH` / `PURCHASE_RETURN`）
 *     **一个字都不动**（既有判据是哨兵）；将来采购申请单也能共用这一份 ✓；
 *   · **两条链只差配置** ✓（补货 / 退货的差异全在下面 `chains` 里）——
 *     🔴 引擎（`services/multiItemOrderService.js`）里**不许出现 `if (补货) … else …`** ✗。
 *
 * 🔴 **布尔一律 `readFlag`（显式布尔）**：
 *   不写 `process.env.X || fallback` —— `||` 会把"她清空变量想关掉"当成"没配"而静默回退 ⇒ **关不掉** ✗
 *   （`config/envValue.js` 的文件头写了这个坑）。空串 = **false**（= 关掉），认不出的值**当场抛错**。
 *
 * ⚠️ **既有键一个不改名** ✗（`SCAN_REPLENISH_*` / `SCAN_RETURN_*` / `SCAN_PURCHASE_AMOUNT_REQUIRED`）
 *   —— 改了就要动线上 `.env`，那是红线。本文件里的"链配置"**从 `SCAN_WRITE` 直接复用**那些值，
 *   所以两边**永远不会漂移** ✓。
 */

const { readFlag, readInt, readString } = require('./envValue');
const { SCAN_WRITE } = require('./scanWrite');

/** 共用块（与哪条链无关的那些）。 */
const resolveShared = (env) => ({
  // 🔴 **总开关**：她 2026-10-15 晚**改口径**了（逐字）：「**直接走新逻辑（一单多货品），不需要影子**」
  //    ⇒ 默认 **`true`**（真实写入 ✓）——影子阶段取消 ✗（第 1 步那个"只算不写"不再需要）。
  //    ⚠️ 改前逐字：`readFlag(env, 'SCAN_MULTI_ITEM_ENABLED', false)`（先影子跑）
  //      改后逐字：下面这一行（默认 `true`）
  //      依据：她那句（上）＋「好的，**按照（20 货品 / 50 行）**」⇒ 上限值不变 ✓。
  enabled: readFlag(env, 'SCAN_MULTI_ITEM_ENABLED', true),
  // 每单上限（她确认 ✓ 是可配置项，不是写死 ✗）。与 `SESSION.maxLines`（销售本单上限）**同形**，
  // 但**各管各的**：一个是"本单几双"，一个是"一单多货品最多几行"。
  maxProducts: readInt(env, 'SCAN_MULTI_ITEM_MAX_PRODUCTS', 20, { min: 1, max: 200 }),
  maxLines: readInt(env, 'SCAN_MULTI_ITEM_MAX_LINES', 50, { min: 1, max: 500 }),
  // ⭐ 2026-10-16（渲染半）：**提交时那个载荷的字段名** —— 配置先行（换名不用改代码 ✓）。
  //   ⚠️ 显式 `readString`（**禁 `||` 兜底** ✗）：空串 = 空字段名 ⇒ 下游按空处理，不会偷偷回落。
  field: readString(env, 'SCAN_MULTI_ITEM_FIELD', 'multi_items'),
  // 幂等键口径：**一单一把**（`orderKey` 就是这把键；提交成功后轮换 ⇒ 第 2 单不会被第 1 单吸收 ✓）。
  submitKeyTemplate: readString(env, 'SCAN_MULTI_ITEM_KEY_TEMPLATE', 'multi_item:{sessionId}:{seq}'),
  // ⭐ **明细幂等键模板**：必须**同时含「货品 + 尺码」** —— 否则两个货品同尺码会撞车 ✗
  //   （设计 §14 风险 6；今天的拼法是"按行序"，单货品不出问题）。
  detailKeyTemplate: readString(
    env, 'SCAN_MULTI_ITEM_DETAIL_KEY', 'purchase_request:{taskId}:{productKey}:{size}',
  ),
  // 异步（**第二步才开** ⇒ 默认 `false`）；两个键照销售那条 `SALE.asyncWrite` 同形 ✓。
  asyncEnabled: readFlag(env, 'SCAN_MULTI_ITEM_ASYNC_ENABLED', false),
  asyncTimeoutMs: readInt(env, 'SCAN_MULTI_ITEM_ASYNC_TIMEOUT_MS', 180000, { min: 1000, max: 600000 }),
  // ⭐ 批次号：**复用既有生成器**（`config/purchaseBatchNo.js`）⇒ 这里**不新造** ✗（只留一个说明键，
  //   免得后来人以为漏了）。值不参与逻辑，只用于自检/文档。
  batchNoSource: 'config/purchaseBatchNo.js',
  // 全部用户可见文案（渲染层 / 引擎都不许散写中文 ✗）。
  texts: {
    emptyDraft: '这一单还什么都没有，先加一件再提交。',
    duplicateLine: '同一个货号的同一个尺码只能出现一次（{product} / {size} 码重复了）。',
    tooManyProducts: '一单最多 {max} 个货品（现在 {count} 个）——拆成两单提交。',
    tooManyLines: '一单最多 {max} 行（现在 {count} 行）——拆成两单提交。',
    quantityInvalid: '{size} 码的数量不对：只能是 1~{max} 的整数。',
    productMissing: '这一件读不到货号 / 尺码，先回上一步重扫一次。',
    sizeUnknown: '有一个尺码认不出来（{product}）——先回上一步重扫一次。',
    stockExceeded: '{size} 码最多退 {stock} 双（她填了 {declared} 双）——已按能退的记。',
    stockUnknown: '{size} 码的库存现在取不到，先别退这一码。',
    amountRequired: '退货要填整单实际金额（一个数就够，不用按货品拆）。',
    chainUnknown: '认不出这一次要办的是哪一种单（补货 / 退货），先回上一步重进。',
    shadowLogged: '影子模式：这一单只做了校验与算账，一个字都没写。',
  },
});

/**
 * 链配置 —— **两条链只差这一块** ✓（引擎里不许按链分支 ✗）。
 * ⚠️ 值全部**复用既有配置**（`SCAN_WRITE`）：前缀 / 行为编码 / 数量上下限 —— 一个都不改名 ✗。
 */
const resolveChains = (env) => ({
  replenish: Object.freeze({
    id: 'replenish',
    label: '补货',
    // 本单草稿的键前缀（= 既有那把 `scan_replenish:<会话>:<轮次>` 的前缀 ✓ 不改名）
    orderKeyPrefix: SCAN_WRITE.session.replenishKeyPrefix,
    taskIdPrefix: SCAN_WRITE.replenish.taskIdPrefix,
    behaviorCode: SCAN_WRITE.replenish.behaviorCode,
    defaultQuantity: SCAN_WRITE.replenish.defaultQuantity,
    maxQuantity: SCAN_WRITE.replenish.maxQuantity,
    // 可补范围：**货品信息里可售的那些**（与今天单货品那条逐字一致 ✓）
    scope: 'product_master',
    // 补货超库存不是问题（报货本来就为了补货）⇒ 不设上限策略
    exceedPolicy: 'none',
    // **补货不写金额**（她 2026-10-15 已裁 ✓）—— 与 `SCAN_PURCHASE_AMOUNT` 那条口径一致：
    //   那个开关是"退货必填"，补货那条链**不消费**它 ✓
    amountRequired: false,
    // 落库找哪个既有写入件（**只调既有件** ✓ 不直连 gateway ✗）
    writer: 'purchase',
    // 🔴 载荷里**要不要**那几个形状位 —— 由**配置**说，引擎里不许 `if (补货) … else …` ✗
    payload: Object.freeze({
      // 补货那条链的老形状里有 `is_batch: true`（"这一次是一批明细"✓）；退货那条链没有
      isBatch: true,
      // 补货的明细带「采购行为」两列；退货**不写行为列**（与 `AC-R2` 同口径 ✓）
      withBehavior: true,
    }),
  }),
  return: Object.freeze({
    id: 'return',
    label: '退货',
    orderKeyPrefix: SCAN_WRITE.session.returnKeyPrefix,
    taskIdPrefix: SCAN_WRITE.purchaseReturn.taskIdPrefix,
    behaviorCode: SCAN_WRITE.purchaseReturn.behaviorCode,
    defaultQuantity: SCAN_WRITE.purchaseReturn.defaultQuantity,
    maxQuantity: SCAN_WRITE.purchaseReturn.maxQuantity,
    // 可退范围：**实时库存里实际有数量的尺码**（她 2026-10-15 口径 ✓；#611/#614 钉着渲染层那一半）
    scope: readString(env, 'SCAN_RETURN_SCOPE', 'live_stock_only'),
    // 超库存怎么办：**`cap+report` = 退能退的 + 差额如实回报**（她认的既有口径 `AC-R5` ✓）。
    //   ⚠️ 不做 `reject`：那会把"能退的两双"一起挡住 ✗（除非她改这个值）。
    exceedPolicy: readString(env, 'SCAN_RETURN_EXCEED_POLICY', 'cap+report'),
    // 整单金额**必填**（沿用既有键名 ✓ 不动线上 .env）
    amountRequired: readFlag(env, 'SCAN_PURCHASE_AMOUNT_REQUIRED', SCAN_WRITE.purchaseAmount.required),
    writer: 'purchaseReturn',
    payload: Object.freeze({
      isBatch: false,
      withBehavior: false,
    }),
  }),
});

/** 事件名（日志口径；排查时按它们 grep ✓）。 */
const resolveEvents = (env) => Object.freeze({
  shadowSubmit: readString(env, 'SCAN_MULTI_ITEM_EVENT_SHADOW', 'multi_item_order.shadow_submit'),
  submitted: readString(env, 'SCAN_MULTI_ITEM_EVENT_SUBMITTED', 'multi_item_order.submitted'),
  reused: readString(env, 'SCAN_MULTI_ITEM_EVENT_REUSED', 'multi_item_order.reused'),
  rejected: readString(env, 'SCAN_MULTI_ITEM_EVENT_REJECTED', 'multi_item_order.rejected'),
  draftOpened: readString(env, 'SCAN_MULTI_ITEM_EVENT_DRAFT_OPENED', 'multi_item_order.draft_opened'),
});

/**
 * ⭐ 提交成功后**作废「实时库存」内存快照**时用的理由串（`invalidateInventorySnapshot(reqId, reason)` ✓）。
 *
 * ⚠️ 值**与单货品那条路逐字相同**（`routes/scanPage.js` 里那两处既有字面量）——
 *   同一个业务动作在日志里**只有一个理由** ✓（按它 grep，两条路都看得见 ✓）。
 * ⚠️ 为什么放进配置、而不是在路由里再写一遍那两个字面量：路由里那两处字面量是**既有邻近哨兵**
 *   （`test/scanSaleE2E.test.js` 的 `AC-SR4`：按"`scan_replenish_submitted` 之后 400 字内要有
 *   `markRealmUsed(`"判）的**锚点** —— 在它前面多写一处同样的字面量会把那个锚点挤开 ✗
 *   （本刀**真踩到过**，见 PR 说明）。**配置先行**在这里同时解决了两件事 ✓。
 */
const resolveInvalidateReasons = (env) => Object.freeze({
  replenish: readString(env, 'SCAN_MULTI_ITEM_INVALIDATE_REPLENISH', 'scan_replenish_submitted'),
  return: readString(env, 'SCAN_MULTI_ITEM_INVALIDATE_RETURN', 'scan_purchase_return_submitted'),
});

/**
 * 解析一份配置（**每次调用都重新读 env** ⇒ 用例可以传不同的 env 验"改配置即改行为" ✓）。
 * @param {object} [env] 默认 `process.env`
 */
const resolveMultiItemOrderConfig = (env = process.env) => {
  const shared = resolveShared(env);
  return Object.freeze({
    ...shared,
    // 会话：**沿用既有那份**（`data/scan_sessions/`）—— 不新建存储 ✗
    session: Object.freeze({
      dir: SCAN_WRITE.session.dir,
      idField: SCAN_WRITE.session.idField,
      ttlMs: SCAN_WRITE.session.ttlMs,
      statuses: SCAN_WRITE.session.statuses,
      // 草稿存在会话记录的这一段里（设计 §4.3）
      ordersField: readString(env, 'SCAN_MULTI_ITEM_ORDERS_FIELD', 'orders'),
      draftStatus: 'draft',
      submittingStatus: 'submitting',
      submittedStatus: 'submitted',
      failedStatus: 'failed',
    }),
    chains: resolveChains(env),
    events: resolveEvents(env),
    // ⭐ 提交成功后作废「实时库存」快照的理由串（值 = 单货品那条路**逐字**同一串 ✓）
    invalidateReasons: resolveInvalidateReasons(env),
  });
};

/** 默认那一份（进程级；跟 `process.env` 走）。 */
const MULTI_ITEM_ORDER = resolveMultiItemOrderConfig();

module.exports = {
  resolveMultiItemOrderConfig,
  MULTI_ITEM_ORDER,
  // 只读导出共用块，方便测试与排查
  resolveShared,
  resolveChains,
};
