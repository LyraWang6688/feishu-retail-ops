/**
 * 工作台【订单列表】的**唯一配置来源**（配置先行）。
 *
 * 业务负责人 2026-10-09（逐字）：
 *   「我们建一个**订单列表**吧……订单列表实际上就是**看销售情况**，包含这几项：
 *    **1. 销售单号  2. 具体销售明细  3. 收款情况**」
 *   「**工作台要对移动端友好**。……如果它在移动端进行**补收款、售后，以及二次交付**，
 *    这些都是可以的」
 *
 * ⚠️ 这里只放**路由 / 默认值 / 文案 / 候选清单**，不放逻辑。
 * ⚠️ **状态文案一个都不在这里造**：履约状态 / 收款状态直接来自
 *    `GET /api/workbench/sales/orders` 的 `fulfillment_status` / `payment_status`
 *    （既有口径，见 `services/salesProgressService.js`）。
 */

/** 面板文案。 */
export const ORDERS_PAGE = {
  title: '订单列表',
  subtitle: '两个子 tab：销售（按是否钱货两清分类，点开一张单可以补收款、交付、售后、二次交付）· 采购（按采购订单，每行验收到货）',
  empty: '还没有已入账的销售单',
  purchaseEmpty: '还没有采购申请（报货批次）记录',
  detailTitle: '订单详情',
  back: '← 返回订单列表',
  open: '查看 / 操作 →',
  reload: '刷新',
};

/**
 * ⭐⭐ 2026-10-09（业务负责人 15:07 逐字）：「第三个 tab 是**订单列表**，分**两个子 tab**：
 *   1. **销售**… 2. **采购**…」
 * ⚠️ 这是**订单列表内部**的子 tab（选中态与切换在 `features/orders/index.js` 里自己实现），
 *    **不动**一级 tab 的结构与前两个 tab（一级 tab 的唯一来源仍是 `config/tabs.js`）。
 */
export const ORDERS_SUB_TABS = [
  { value: 'sales', label: '销售' },
  { value: 'purchase', label: '采购' },
];

/**
 * 销售子 tab 的分组（她逐字：「按照**是否钱货两清**分类。**没有钱货两清的就是有二次的**，
 * 比如**货物交付或者资金交付，或者两者都有**」）。
 *
 * 🔴 **判据只用既有字段与取值**（出处：`server/src/services/salesProgressService.js` 的
 *    `progressFromRecords`，服务端算好后由 `GET /api/workbench/sales/orders` 返回）：
 *      · 履约状态 `fulfillment_status` ∈ 未交付 / 部分交付 / 已交付
 *      · 收款状态 `payment_status`     ∈ 未收款 / 部分收款 / 待平台结算 / 已收款（或空）
 *    **本文件不新增任何状态 / 枚举** —— 下面两个常量就是上面那两个"已结清"取值本身。
 * ⚠️ `key` 只是**页面分组用的键**，不写回任何表。
 */
export const DELIVERED_FULFILLMENT = '已交付';
export const PAID_PAYMENT_STATUS = '已收款';

export const SALES_GROUPS = [
  { key: 'settled', label: '钱货两清', hint: '货已交付、钱已收清' },
  { key: 'undelivered', label: '有二次 · 货未交付', hint: '钱收清了，货还没交完' },
  { key: 'unpaid', label: '有二次 · 资金未收', hint: '货交付了，钱还没收清' },
  { key: 'both', label: '有二次 · 两者都有', hint: '货没交完，钱也没收清' },
];

/**
 * 采购子 tab 的「验收到货」入口。
 * ⚠️ 「实际金额」是**既有必填口径**（业务负责人 2026-10-08：「金额这个是必填的，
 *    必须让用户填」）⇒ 按钮点开的是一个小表单。
 * ⚠️ `defaultAcceptanceText` 会写进「报货批次 · 验收原话」，所以它必须**如实**：
 *    工作台这一下代表"按采购申请数全部到货"，**由她确认 / 可改**。
 */
export const ARRIVAL_CONFIRM = {
  defaultAcceptanceText: '工作台 · 验收到货：按采购申请数全部到货',
  amountPlaceholder: '例如 12800',
};

/** 接口路径（**唯一来源**：渲染层不写死 URL）。 */
export const ORDERS_API = {
  orders: '/api/workbench/sales/orders',
  payments: '/api/workbench/sales/payments',
  deliveries: '/api/workbench/sales/deliveries',
  afterSales: '/api/workbench/sales/after-sales',
  secondDelivery: '/api/workbench/sales/second-delivery',
  // 复用既有的**只读**货品选择器（「库存手工调整」页也在用同一个）
  products: '/api/workbench/inventory/products',
  // ⭐ 采购子 tab：读 + 验收（都复用既有路由，不新开鉴权）
  purchaseRequests: '/api/workbench/purchase/requests',
  arrivalConfirm: '/api/workbench/purchase/arrivals/confirm',
};

/**
 * ⭐ 补收款 / 二次交付的**默认收款方式** —— 业务负责人 2026-10-08 定：「微信」。
 * ⚠️ 默认值只是"预选、可改"；真正的候选清单来自后端返回的收款方式（见 `COLLECTION_METHODS`）。
 * 🔴 **只在这一页给默认**：群聊链路的口径是"用户会主动说，系统不猜"（AGENTS.md 第 16 条(1)）。
 */
export const DEFAULT_COLLECTION_METHOD = '微信';

/**
 * 收款方式下拉的**兜底候选**（后端一条收款方式都取不到时才用）。
 * ⚠️ 正常情况下页面用 `GET /api/workbench/sales/orders` 返回的 `methods`（= 「收款方式管理」里
 *    真实存在的收款方式）—— 不自己造选项。
 */
export const COLLECTION_METHODS = ['微信', '现金', '支付宝', '银行转账'];

/**
 * 售后退款 / 补差价的方式**必须她自己选**（业务负责人 2026-10-06：「钱退现金」记录里就要写现金，
 * 不沿用原单）——所以这个下拉的第一项是"请选择"，**不给默认值**。
 */
export const REFUND_METHOD_PLACEHOLDER = '请选择（退现金还是退微信？）';

/** 退回的鞋回哪儿（取值与既有 `config/afterSales.restockStates` 一字不差）。 */
export const RESTOCK_STATES = ['门盒', '样品'];

/**
 * 售后动作（退 / 换 / 赔）—— `value` 是既有 `config/afterSales` 的动作枚举，**不改**。
 * `needsNewLine` / `needsRestock` 是**既有动作语义的镜像**（`acceptsNewLines` /
 * `requiresRestockState`），页面据此显示 / 隐藏那两块表单；真正的判据仍在后端。
 */
export const AFTER_SALES_ACTIONS = [
  {
    value: 'return',
    label: '退货',
    hint: '那双退回来 + 原收款改成已退款 / 已留存',
    needsNewLine: false,
    needsRestock: true,
  },
  {
    value: 'exchange',
    label: '换货',
    hint: '原明细写「已换货」，换出去的新鞋写「已交付」',
    needsNewLine: true,
    needsRestock: true,
  },
  {
    value: 'compensation',
    label: '赔货',
    hint: '赔出去一双：新建明细、成交金额记 0、履约状态「已赔货」',
    needsNewLine: true,
    needsRestock: false,
  },
];

/** 「资金走向」候选 —— 取值只有既有配置里的两个（cash / prepaid）。 */
export const SETTLEMENTS = [
  { value: 'cash', label: '退给她 / 她补差价（现金或微信）', actions: ['return', 'exchange', 'compensation'] },
  { value: 'prepaid', label: '钱留在我们这里（已留存，仅退货）', actions: ['return'] },
];

/** 页面上的一切固定文案（渲染层不写死句子）。 */
export const ORDERS_TEXTS = {
  orderNo: '销售单号',
  details: '销售明细',
  payments: '收款情况',
  paid: '已收',
  pending: '还差',
  receivable: '应收',
  pendingDelivery: '待交付',
  collectTitle: '补收款',
  collectHint: '记一笔收款（收款方式默认微信，可以改）',
  collectAmount: '收款金额',
  collectSubmit: '提交收款',
  deliveryTitle: '交付',
  deliveryHint: '把货出库（勾上这次交付的明细）',
  deliveryEmpty: '这张单没有待交付的明细了',
  deliverySubmit: '提交交付',
  afterSalesTitle: '售后（退 / 换 / 赔）',
  afterSalesHint: '退回 / 换出 / 赔出的鞋都走既有售后处理层，原单不会被改',
  afterSalesDetails: '要处理的销售明细',
  afterSalesAction: '动作',
  restockState: '退回的鞋回哪儿',
  newLineMode: '换 / 赔出去的鞋',
  newLineSame: '同款换码（货号不变）',
  newLineOther: '另一双（选货号）',
  newProductKeyword: '找货品（货号 / 编号 / 颜色）',
  newProductSearch: '查找货品',
  newProductEmpty: '先按货号查找，再从结果里选一双',
  newLineSize: '新鞋尺码',
  newLineAmount: '这一双的成交金额（留空 = 按原成交金额 / 货品单价取）',
  diffAmount: '差价（正数 = 她补给我们；负数 = 我们退给她；0 / 留空 = 不动钱）',
  settlement: '资金走向（差价 ≠ 0 时必填）',
  refundMethod: '收款方式（资金走向 = 退给她 / 她补差价 时必填）',
  afterSalesSubmit: '提交售后',
  secondDeliveryTitle: '二次交付（收尾款 + 交付）',
  secondDeliveryHint: '把还没收的尾款记成已收，并把还没交的货交付（扣库存）；收款方式默认微信',
  secondDeliveryMethod: '收款方式',
  secondDeliverySubmit: '收尾款并交付',
  paymentMethod: '收款方式',
  select: '请选择',
  // ── ⭐ 2026-10-09 追加：子 tab + 采购验收 ──────────────────────────────────
  verifyArrival: '验收到货',
  arrivalVerifyTitle: '验收到货（按采购申请数全部到货，走既有入库链路）',
  arrivalVerifyHint: '实际金额必填（她 2026-10-08 定：「金额这个是必填的」）。到货说明会写进「报货批次」的「验收原话」',
  arrivalAmount: '实际金额',
  arrivalNote: '到货说明（写进验收原话）',
  arrivalSubmit: '确认到货并入库',
  groupEmpty: '这一类现在没有单',
};
