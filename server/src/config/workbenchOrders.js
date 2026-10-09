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

const { readFlag } = require('./envValue');

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
  needNewAmount: '请填这一双的成交金额（留空时按原成交金额 / 货品单价取，取不到就要填）',
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
 * ⚠️ 它们**不是业务状态**：到货状态 / 确认状态的取值仍在
 *    `config/purchaseArrivalStatus.js` / `config/purchaseAcceptance.js`，
 *    这里一句都不新增、不改。
 */
const WORKBENCH_ARRIVAL_TEXTS = Object.freeze({
  needBatchNo: '请选择要验收的采购批次（这一行没有报货批次号）',
  noRequestRows: '这一批没找到采购申请明细（采购退货单不能验收到货）',
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
 * 开关（**显式布尔**，见 `config/envValue.readFlag`：没设 = 默认；设成空串 = 关掉）。
 * ⚠️ 开关只放后端这一处 —— 页面不复制一份，免得两边漂移（关了之后页面会照实显示原因）。
 */
const readWorkbenchOrdersConfig = (env = process.env) => ({
  defaultCollectionMethod: DEFAULT_COLLECTION_METHOD,
  originalTextPrefix: WORKBENCH_ORIGINAL_TEXT_PREFIX,
  settlementLabels: WORKBENCH_SETTLEMENT_LABELS,
  afterSalesEnabled: readFlag(env, 'WORKBENCH_ORDERS_AFTER_SALES_ENABLED', true),
  secondDeliveryEnabled: readFlag(env, 'WORKBENCH_ORDERS_SECOND_DELIVERY_ENABLED', true),
});

module.exports = {
  DEFAULT_COLLECTION_METHOD,
  WORKBENCH_ORIGINAL_TEXT_PREFIX,
  WORKBENCH_ORDERS_TEXTS,
  WORKBENCH_SETTLEMENT_LABELS,
  WORKBENCH_ARRIVAL_TEXTS,
  WORKBENCH_ARRIVAL_INPUT_REASONS,
  readWorkbenchOrdersConfig,
};
