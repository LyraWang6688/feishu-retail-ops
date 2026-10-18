'use strict';

/**
 * 销售写计划（配置先行 · 业务负责人 2026-10-18 定的「现货 / 预定」唯一分叉处）。
 *
 * 为什么要有它：生产表改完之后，**每张表写哪些字段、哪些步骤、成功判据**是固定的；
 * 现货与预定只在「要不要在提交这一刻动库存 / 履约」上不同。把这些写进配置后：
 *   · 写链路只按 `plan.steps` 执行，不再在 service 里散落 `if (现货) … else …`；
 *   · 新增交易类型 = 往这里加一份计划（不改 service）；
 *   · 测试/排查可以直接打印「这一单按哪份计划写、成功需要哪几步」。
 *
 * ⚠️ 交易类型的**判据**仍只有一处：`config/salesTradeTypePolicy.salesTradeTypeForStock`
 *    （实时库存里有没有这一双）。本文件只回答「这个类型 → 怎么写」。
 */

const { SALES_MOVEMENTS } = require('./salesMovements');

/** 每张表这次真正要写的字段（语义键，列名由 v1BitableSchema 解析）。 */
const TABLE_FIELDS = Object.freeze({
  salesEntry: Object.freeze({
    main: Object.freeze(['orderNo', 'writeStatus']),
    final: Object.freeze(['totalAmount', 'gift', 'writeStatus']),
  }),
  salesDetail: Object.freeze([
    'salesEntry', 'product', 'size', 'actualAmount', 'fulfillmentStatus', 'tradeType',
    'detailId', 'saleDate',
  ]),
  paymentRecord: Object.freeze([
    'salesEntry', 'method', 'amount', 'status', 'receivedAt', 'tradeDirection',
    'tradeType', 'receiptId',
  ]),
  inventoryLedger: Object.freeze(['product', 'size', 'quantityChange', 'behavior', 'salesDetail']),
  liveInventory: Object.freeze(['status']),
});

const BASE_STEPS = Object.freeze([
  Object.freeze({ key: 'main', tables: ['salesEntry'], fields: TABLE_FIELDS.salesEntry.main }),
  Object.freeze({
    key: 'children',
    parallel: true,
    tables: ['salesDetail', 'paymentRecord'],
    fields: TABLE_FIELDS.salesDetail,
  }),
  Object.freeze({
    key: 'finalize',
    tables: ['salesEntry'],
    fields: TABLE_FIELDS.salesEntry.final,
  }),
]);

const INVENTORY_STEPS = Object.freeze([
  Object.freeze({
    key: 'inventory',
    parallel: false,
    tables: ['inventoryLedger', 'liveInventory'],
    fields: TABLE_FIELDS.inventoryLedger,
  }),
  Object.freeze({
    key: 'fulfillment',
    parallel: false,
    tables: ['salesDetail'],
    fields: Object.freeze(['fulfillmentStatus']),
  }),
]);

const planOf = (code, extra) => Object.freeze({
  id: extra.id,
  tradeTypeCode: code,
  label: SALES_MOVEMENTS[code].label,
  delivery: SALES_MOVEMENTS[code].delivery,
  deliverOnSubmit: SALES_MOVEMENTS[code].deliverOnSubmit === true,
  // 明细行**创建时**的履约状态（现货也要等「提交即交付」那一步才改成已交付）
  initialFulfillmentStatus: '未交付',
  deliveredFulfillmentStatus: '已交付',
  steps: Object.freeze([...BASE_STEPS.slice(0, 2), ...(extra.inventory ? INVENTORY_STEPS : []), BASE_STEPS[2]]),
  // 成功判据：这些步骤都成功，才允许把「写入状态」收口成「成功」
  successRequires: Object.freeze(extra.inventory
    ? ['main', 'children', 'inventory', 'fulfillment', 'finalize']
    : ['main', 'children', 'finalize']),
  writesInventory: extra.inventory === true,
});

const PLANS = Object.freeze({
  SALE_CASH: planOf('SALE_CASH', { id: 'spot', inventory: true }),
  SALE_PREPAID: planOf('SALE_PREPAID', { id: 'preorder', inventory: false }),
});

/** 认不出的编码（老页面 / 还没定类型）⇒ null（调用方按"不猜"处理）。 */
const planForTradeType = (code) => PLANS[String(code || '').trim()] || null;

/** 按「实时库存有没有这一双」拿计划（判据复用既有 policy，不在这里另写一份）。 */
const planForStock = (inStock) => {
  // 延迟 require：避免与 config/salesMovements → policy 的加载顺序互相拖拽
  // eslint-disable-next-line global-require
  const { salesTradeTypeForStock } = require('./salesTradeTypePolicy');
  return planForTradeType(salesTradeTypeForStock({ inStock }));
};

/** 一单里逐行取计划（混合单 = 现货行 + 预定行各按自己的计划）。 */
const plansForItems = (items = []) => items.map((item) => planForTradeType(item?.tradeTypeCode));

const plansOfOrder = (items = []) => plansForItems(items).filter(Boolean);

/**
 * ⭐⭐ 2026-10-18（第 4 步提速）：**每一步落在哪一屏** —— 唯一真源。
 *
 * 她说过的流程只有两屏（货品页 → 资金页 → 成功页），而这个文件是"写什么"的真源
 * ⇒ 把「哪一屏写哪几步」也放这里，service 里就**不再散落 `if (是不是资金页)`**：
 *   · 货品页：**只写 main**（销售主表 + 单号 + 写入状态=未完成）—— 明细 / 收款 / 流水一行都不写；
 *   · 资金页：children（明细 + 收款，**批量**）→ inventory（**批量**扣）→ fulfillment（履约=已交付）
 *     → finalize（**一次**写 总金额 + 赠品 + 写入状态）。
 * ⚠️ 顺序就是数组顺序（资金页那几步**不许**前挪：收口必须在库存/履约之后）。
 */
const PAGE_STEPS = Object.freeze({
  goods: Object.freeze(['main']),
  money: Object.freeze(['children', 'inventory', 'fulfillment', 'finalize']),
});

/** 这一屏要跑哪几步（认不出的屏名 ⇒ 空数组，调用方按"什么都不做"处理，不猜）。 */
const stepsForPage = (page) => PAGE_STEPS[String(page || '').trim()] || Object.freeze([]);

/**
 * ⭐⭐ 2026-10-18（第 4 步提速）：**会话标记**（本地草稿里的进度位，不写业务表）。
 *   · `masterOnly`     —— 货品页只把主表建好了（明细/收款/流水都还没写）；
 *   · `childrenStarted` —— 资金页那一跑**已经开始**写明细/收款（**写之前**就置上
 *     ⇒ 重试时不许再假设"这一单还没有明细"，必须走"读已有 + 认领"的安全路径）。
 * ⚠️ 取值只在这里（配置先行）；service 只读常量，不写死字符串。
 */
const SESSION_FLAGS = Object.freeze({
  masterOnly: 'master_only',
  childrenStarted: 'children_started',
});

/** 这一单是否需要动库存（任一现货行 ⇒ 需要）。 */
const requiresInventory = (items = []) => plansOfOrder(items).some((plan) => plan.writesInventory);

/** 成功判据的并集（混合单：有现货行 ⇒ 库存/履约也必须成功）。 */
const successRequiresFor = (items = []) => {
  const plans = plansOfOrder(items);
  if (!plans.length) return Object.freeze([]);
  return Object.freeze([...new Set(plans.flatMap((plan) => plan.successRequires))]);
};

/** 明细行创建时的履约状态（认不出类型 ⇒ 未交付，交给后续交付判）。 */
const initialFulfillmentStatusFor = (code) => (
  planForTradeType(code)?.initialFulfillmentStatus || '未交付'
);

/** 「这一行提交这一刻要不要交付并扣库存」——编码判据来自计划，可售品属性仍由调用方判。 */
const deliversOnSubmitFor = (code) => planForTradeType(code)?.deliverOnSubmit === true;

module.exports = {
  TABLE_FIELDS,
  SALES_WRITE_PLANS: PLANS,
  PAGE_STEPS,
  SESSION_FLAGS,
  stepsForPage,
  planForTradeType,
  planForStock,
  plansForItems,
  plansOfOrder,
  requiresInventory,
  successRequiresFor,
  initialFulfillmentStatusFor,
  deliversOnSubmitFor,
};
