/**
 * 「工作台 · 订单列表」的可配参数（**配置先行**）。
 *
 * 业务负责人 2026-10-09 明确要的东西（逐字）：
 *   「我们建一个**订单列表**吧……订单列表实际上就是**看销售情况**，包含这几项：
 *    **1. 销售单号  2. 具体销售明细  3. 收款情况**」
 *   「**工作台要对移动端友好**。……如果它在移动端进行**补收款、售后，以及二次交付**，
 *    这些都是可以的」
 *
 * 为什么单独一个配置模块（与 `inventoryAdjustment.js` / `workbenchQuery.js` 同一套理由）：
 * 这些是**默认值 / 阈值 / 文案 / 开关**，不是逻辑。她改一个"默认收款方式"、或者
 * 把某一条动作先关掉，**只应该改这一个文件**，而不是去接线层里翻字面量。
 *
 * ⚠️ 这个文件里的东西**只服务工作台这一页**：
 *    · `DEFAULT_COLLECTION_METHOD` 是**这一页**的默认收款方式（业务负责人 2026-10-08 定的「微信」）；
 *    · 🔴 **群聊链路一个字都不碰** —— 群里那套的口径是「用户会主动说收款方式，系统不猜、也不设默认」
 *      （见 AGENTS.md 第 16 条(1)）。所以这个常量在 `src/**` 里的读取点**只有两处**：
 *      本文件（定义）＋ `services/workbenchOrderActionService.js`（工作台接线层），
 *      有一条源码哨兵钉着它（`test/workbenchOrders.test.js` 的 AC3b）。
 */

const { readFlag, readInt } = require('./envValue');

/**
 * 工作台【订单列表】**补收款 / 二次交付**的默认收款方式。
 * ⭐ 业务负责人 2026-10-08 定：「微信」。
 * ⚠️ 只是"默认值、可改"（页面上是个下拉），不是"按默认方式收口"。
 * ⚠️ **售后退款**不走这个默认值：退款方式必须**她自己选**（业务负责人 2026-10-06：
 *    「钱退现金」记录里就要写现金，不沿用原单）——所以售后那个下拉的第一项是"请选择"。
 */
const DEFAULT_COLLECTION_METHOD = '微信';

/** 「原话」列里，工作台生成的这一笔的来源前缀（与群聊里她那句真话区分得开）。 */
const WORKBENCH_ORIGINAL_TEXT_PREFIX = '工作台操作';

const WORKBENCH_ORDERS_TEXTS = Object.freeze({
  // 开关关掉时给她看的话（人话，不是变量名）
  afterSalesDisabled: '工作台的售后操作现在关着，先找管理员打开再说',
  secondDeliveryDisabled: '工作台的二次交付现在关着，先找管理员打开再说',
  // 入参缺项（都是她会看懂的句子）
  needRequestId: '这次提交缺少有效的 request_id（页面会自动带上；请刷新页面后重试）',
  needOrder: '缺少要处理的销售单',
  needDetails: '请先勾选要处理的销售明细',
  needRestockState: '请选一下退回的鞋回哪儿（门盒 / 样品）',
  needNewProduct: '请选择换 / 赔出去的那双鞋（货号）',
  needNewSize: '请填新鞋的尺码',
  needNewAmount: '请填这一双的实收金额（留空时按原实收金额 / 货品单价取，取不到就要填）',
  needRefundMethod: '请选一下这笔钱走哪个方式（现金 / 微信）',
  needSingleDetailForSameItem: '「同款换码 / 同款赔」一次只能选一条销售明细（要处理多条请分开做）',
  orderNotFound: '这张销售单不存在（可能已被删除）',
  orderNoMissing: '这张销售单没有单号，不能做售后',
});

/**
 * 售后「资金走向」下拉的候选 —— **取值与群聊链路同一套**（`config/afterSales` 的
 * `settlements: ['cash','prepaid']`），这里只提供**轮播文案**，不新增取值。
 * ⚠️ `prepaid`（钱留在我们这里）当前只有**退货**走得通：落点是原收款记录的「已留存」；
 *    换货 / 赔货的 prepaid 在既有执行器里会**大声拒绝**（表被删了），页面照实显示那句话。
 */
const WORKBENCH_SETTLEMENT_LABELS = Object.freeze({
  cash: '退给她 / 她补差价（现金或微信）',
  prepaid: '钱留在我们这里（已留存，仅退货）',
});

/**
 * ⭐ 2026-10-09 追加：「订单列表 · **采购**子 tab」的「**验收到货**」入口（业务负责人逐字：
 *   「**采购**，按照**采购订单**，有**验收到货**的按钮」）。
 *
 * 这一组是**服务端**给页面的人话（页面把 `error` 原样显示出来）。
 * ⚠️ 它们**不是业务状态**：到货状态的取值仍在 `config/purchaseArrivalStatus.js`，
 *    这里一句都不新增、不改。
 *    （原文还提过 `config/purchaseAcceptance.js` 的「确认状态」——那份配置与那一列
 *      已于 2026-10-09 随生产表删列一起退场。）
 */
const WORKBENCH_ARRIVAL_TEXTS = Object.freeze({
  needBatchNo: '请选择要验收的采购批次（这一行没有报货批次号）',
  noRequestRows: '这一批没找到采购申请明细（采购退货单不能验收到货）',
});

/**
 * ⭐⭐ 2026-10-11（业务负责人 20:30 确认）：工作台「订单列表 → 待补充」里那条
 * **待补样品**待办的**人话**（服务端 → 页面直接显示）。
 *
 * 业务事实：**样品被卖掉、她又没指定用哪个码的门盒补** ⇒ 待办；她选一个码 ⇒ 补掉（门盒→样品，1 双）。
 * ⚠️ 这些不是业务状态（状态取值仍在各自的配置里），只是"这一步成没成、为什么没成"的话。
 */
const WORKBENCH_SAMPLE_FILL_TEXTS = Object.freeze({
  needSize: '请先选一个门盒尺码，再补样品',
  noDoorBox: '{size} 码已没有门盒库存，请换一个尺码',
  notPending: '这一条不是"待补样品"的待办（可能已经补过，或这一单没有卖掉样品）',
  done: '{size} 码已从门盒转为样品，库存总数不变。',
  reused: '这一条已经补过了：{size} 码（没有重复调整）。',
});

/**
 * 「她填错了」这一类拒绝（= HTTP 400，**一个字节都没写**）的 reason 白名单。
 * ⚠️ 其余（读不到 / 算不出 / 入库失败）按"业务没做成"处理（502），
 *    但**原因照样原样回到页面** —— 判据是"页面上看不看得见原因"，不是状态码。
 */
const WORKBENCH_ARRIVAL_INPUT_REASONS = Object.freeze([
  'no_batch_no',
  'no_request_rows',
  'amount_missing',
  'amount_invalid',
  'acceptance_text_missing',
]);

/**
 * ⭐⭐ 2026-10-12：**订单列表的读取优化**（业务负责人：「它一直说正在读取订单」）。
 *
 * 她在服务器上实测：`/api/workbench/sales/orders` 真实耗时 **3.6s ~ 26s**；逐张表整表读 ——
 * `salesEntry 188 条 3243ms` · `salesDetail 173 条 2629ms` · `paymentMethod **6 条** 1851ms` ·
 * `paymentRecord 158 条 5527ms` · `product 562 条 7805ms` · `accessory 21 条 1517ms`（合计 ≈22.6s）。
 * ⇒ **瓶颈不是"数据多"，是飞书 API 每张表 1.5~7.8 秒的固定开销**（6 条的小表也要 1.9s）。
 *
 * 对策两条，都在这里配置化：
 *   ① **缓存**（`WORKBENCH_ORDERS_CACHE_MS`）—— 连着点几下 / 页面来回切 ⇒ 命中缓存 ≈0 秒；
 *      写库之后由路由层**主动失效**（六条写入路径，见 `test/workbenchOrdersPerformance.test.js`）；
 *   ② **只取需要的字段**（`ORDER_FIELD_KEYS`）—— 交给飞书 `field_names`，payload 更小。
 */

/** 默认 TTL：30 秒（业务负责人给的区间是 30~60 秒）。 */
const DEFAULT_ORDERS_CACHE_MS = 30000;

/**
 * 「订单列表」页面**真正用到的列**（语义键，**一处定义**）——
 * 依据是逐条核过 `services/salesFollowupService.js` 与它调用的三个纯函数：
 *   · `salesEntry`    ：`orderNo`（单号）+ `funds`（「资金状态」，`postedOf` 判"已入账"）；
 *   · `salesDetail`   ：`salesEntry`（关联销售单）· `size` · `fulfillmentStatus` · `actualAmount`
 *                       · `product` / `accessory`（两种可售品的关联列，取值 = `config/sellableKinds`
 *                       的 `detailLinkField`）；
 *   · `paymentRecord` ：`salesEntry` · `amount` · `status` · `method` · `receivedAt`；
 *   · `paymentMethod` ：`name`； · `product`：`number` · `color`； · `accessory`：`name`。
 *
 * ⚠️ **多一个都不许**（验收标准③）：这张清单就是"页面上真正用到的列"——加列必须有消费点。
 * ⚠️ 只写**语义键**，飞书列名由 schema（`gateway.table(key).fields`）解析。
 */
const ORDER_FIELD_KEYS = Object.freeze({
  salesEntry: Object.freeze(['orderNo', 'funds']),
  salesDetail: Object.freeze(['salesEntry', 'size', 'fulfillmentStatus', 'actualAmount', 'product', 'accessory']),
  paymentRecord: Object.freeze(['salesEntry', 'amount', 'status', 'method', 'receivedAt']),
  paymentMethod: Object.freeze(['name']),
  product: Object.freeze(['number', 'color']),
  accessory: Object.freeze(['name']),
});

/**
 * ⭐⭐ 2026-10-16（性能）：**支撑表的按需列**（订单列表读路径上"顺手读"的那两张）。
 *
 * 为什么与 `ORDER_FIELD_KEYS` **分开**（而不是加进去）：
 *   · `ORDER_FIELD_KEYS` 的语义是"**页面上真正用到的列**"，它有一条既有判据
 *     （`test/workbenchOrdersPerformance.test.js` 的 AC5a）**逐字**钉着它的形状
 *     —— 往里加列会把那条判据**放宽**，而这次只做性能、不许放宽判据；
 *   · 这两张不是"页面的列"，而是**判据的输入**：
 *     · `liveInventory`：「实时库存」整表快照（待补样品的候选：按码数门盒 / 样品 / 仓库）
 *       —— 只用 **编号 / 尺码 / 所属状态** 三列（`sampleReplacementCandidates` 的全部消费点）；
 *       ⚠️ `record_id` 不需要写进来（它是记录自带的，不是"列"）。
 *     · `sizeManagement`：**故意不列** —— `SizeReferenceService` 要的是「尺码」这一列，
 *       而它的读取口径归它自己（本文件不认识那个 service 的实现细节）；
 *       它那次读**已经**只服务一张 20~30 行的小表，加列收益可忽略。
 *
 * ⚠️ 与 `ORDER_FIELD_KEYS` 同一套用法：语义键 → 飞书列名；**一个都映射不到就不传**
 *   （宁可慢，不许少列）。
 */
const ORDER_SUPPORT_FIELD_KEYS = Object.freeze({
  liveInventory: Object.freeze(['product', 'size', 'state']),
});

/**
 * 开关（**显式布尔**，见 `config/envValue.readFlag`：没设 = 默认；设成空串 = 关掉）。
 * ⚠️ 开关只放后端这一处 —— 页面不复制一份，免得两边漂移（关了之后页面会照实显示原因）。
 */
const readWorkbenchOrdersConfig = (env = process.env) => ({
  defaultCollectionMethod: DEFAULT_COLLECTION_METHOD,
  originalTextPrefix: WORKBENCH_ORIGINAL_TEXT_PREFIX,
  settlementLabels: WORKBENCH_SETTLEMENT_LABELS,
  afterSalesEnabled: readFlag(env, 'WORKBENCH_ORDERS_AFTER_SALES_ENABLED', true),
  secondDeliveryEnabled: readFlag(env, 'WORKBENCH_ORDERS_SECOND_DELIVERY_ENABLED', true),
  // ⭐ 订单列表缓存 TTL（毫秒）：**显式整数**（`readInt`：空串 = 默认；非法 / 越界**当场抛错**）。
  //   `0` 是**合法值** = 显式关掉缓存（每次真读）—— 线上排查数据时用得上。
  ordersCacheMs: readInt(env, 'WORKBENCH_ORDERS_CACHE_MS', DEFAULT_ORDERS_CACHE_MS, { min: 0, max: 600000 }),
});

module.exports = {
  WORKBENCH_SAMPLE_FILL_TEXTS,
  DEFAULT_COLLECTION_METHOD,
  WORKBENCH_ORIGINAL_TEXT_PREFIX,
  WORKBENCH_ORDERS_TEXTS,
  WORKBENCH_SETTLEMENT_LABELS,
  WORKBENCH_ARRIVAL_TEXTS,
  WORKBENCH_ARRIVAL_INPUT_REASONS,
  DEFAULT_ORDERS_CACHE_MS,
  ORDER_FIELD_KEYS,
  ORDER_SUPPORT_FIELD_KEYS,
  readWorkbenchOrdersConfig,
};
