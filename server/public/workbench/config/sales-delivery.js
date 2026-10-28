/**
 * 「销售 → 订单列表 → 交割单」页的唯一配置来源（配置先行）。
 *
 * 2026-10-28 业务负责人最新口径：
 *   · 页面按**三个子 tab** 展示：货未清 / 钱未清 / 钱货都未清（**只在第三个 tab 出现，不重复**）；
 *   · 每个 tab 带数量；默认打开「货未清」（业务最常用）；
 *   · 已接**真实只读接口**（销售明细 + 收款明细；不写库）；
 *   · 卡片内容、排序、交付/付款按钮保留；按钮 / 表单只做 UI。
 *
 * 🔴 本文件必须覆盖：tab（key/label/顺序/空态）、文案、按钮、表头、排序、状态取值、字段映射。
 *   `features/sales-delivery/*` 里**不写死**中文文案、状态字符串、tab 顺序、字段名。
 */

/** 页面 / 数据来源 / 排序。 */
export const SALES_DELIVERY_CONFIG = Object.freeze({
  pageTitle: '交割单',
  /** 页面固定按销售日「远→近」（旧→新）排序；不提供排序控件。 */
  sortDirection: 'asc',
  /** 真实只读接口（销售明细 + 收款明细；销售主表只用于销售单号）。 */
  // 批注预览时页面由 DSH 宿主代理，`<base>` 指向本地预览服务 ⇒ 用 baseURI 计算 API 绝对地址；
  // 生产/正常打开时 baseURI 与页面同源，结果仍是同一 origin 的 `/api/...`。
  api: Object.freeze({
    delivery: `${typeof document === 'undefined' ? '' : new URL('/', document.baseURI).origin}/api/workbench/sales/delivery`,
  }),
  /** 只在打开 / 刷新页面时拉一次；不做定时刷新。 */
  dataSource: 'api',
});

/**
 * 三个子 tab（顺序 = 页面从左到右；默认 tab = `defaultTab`）。
 * `match` 是**归类判据**（由 `filter.js` 的纯函数消费）：
 *   · `goodsOnly` = 货没清 && 钱没清为 false
 *   · `moneyOnly` = 钱没清 && 货没清为 false
 *   · `both`      = 两者都为 true（**只在这个 tab 出现**）
 * `empty` 是这一类没有单时的人话。
 */
export const SALES_DELIVERY_TABS = Object.freeze([
  Object.freeze({
    key: 'goods', label: '货未清', match: 'goodsOnly', empty: '现在没有「只有货未清」的单',
  }),
  Object.freeze({
    key: 'money', label: '钱未清', match: 'moneyOnly', empty: '现在没有「只有钱未清」的单',
  }),
  Object.freeze({
    key: 'both', label: '钱货都未清', match: 'both', empty: '现在没有「钱货都未清」的单',
  }),
]);
export const SALES_DELIVERY_DEFAULT_TAB = 'goods';

/** 状态取值（与既有表 / 既有读模型逐字一致；**不新造状态**）。 */
export const SALES_DELIVERY_STATUSES = Object.freeze({
  delivered: '已交付',
  /** 货没交清只认「未交付」；已换货/已退货/已赔货按售后已结清算（业务负责人 2026-10-29 定）。 */
  undelivered: '未交付',
  unpaid: '未收款',
  paid: '已收款',
  platformPending: '待平台结算',
  unpaidStatuses: Object.freeze(['未收款']),
});

/** 读模型字段映射（归一化用；原型阶段输入是样例数据，字段名与只读接口同形）。 */
export const SALES_DELIVERY_FIELDS = Object.freeze({
  orderNo: 'order_no',
  recordId: 'record_id',
  recordedAt: 'recorded_at',
  payableAmount: 'payable_amount',
  pendingAmount: 'pending_amount',
  pendingDeliveryQuantity: 'pending_delivery_quantity',
  details: 'details',
  payments: 'payments',
  methods: 'methods',
  detail: Object.freeze({
    recordId: 'record_id',
    product: 'product',
    accessory: 'accessory',
    color: 'color',
    size: 'size',
    fulfillmentStatus: 'fulfillment_status',
    actualAmount: 'actual_amount',
  }),
  payment: Object.freeze({
    recordId: 'record_id',
    method: 'method',
    amount: 'amount',
    status: 'status',
  }),
});

/** 页面文案（渲染层不写死句子）。 */
export const SALES_DELIVERY_TEXTS = Object.freeze({
  tabsLabel: '交割单分类',
  soldAtMissing: '销售日未填',
  productFilterLabel: '货号',
  allProducts: '全部货号',
  filterEmpty: '没有该货号的记录',
  loading: '正在读取交割单…',
  empty: '没有还没结清的交割单',
  loadFailed: '交割单读取失败',
  retry: '重新读取',
  tags: Object.freeze({ goodsNotClear: '货未清', moneyNotClear: '钱未清', platformPending: '待平台结算' }),
  tabCount: '{count} 双',
  detailsTitle: '销售明细',
  paymentsTitle: '收款情况',
  noDetails: '这一单没有销售明细',
  noPayments: '还没有收款记录',
  headers: Object.freeze({ payable: '应付', pending: '待付', pendingDelivery: '待交付' }),
  noMethod: '未选收款方式',
  buttons: Object.freeze({ delivery: '交付', payment: '付款' }),
  deliveryToast: '该产品已交付',
  forms: Object.freeze({
    paymentTitle: '付款（v1 预览）',
    paymentAmount: '付款金额',
    paymentMethod: '付款方式',
    paymentMethodEmpty: '暂无收款方式（先到「收款方式管理」维护）',
    previewOnly: 'v1 预览：这里只填表单，暂不提交写库',
    previewSubmit: '预览（不提交）',
    previewFilled: '表单已填好：v1 预览不提交写库（等业务负责人改稿定稿后再接动作）',
    placeholderDash: '—',
  }),
  amountsLine: '{payableLabel}{payableAmount} · {pendingLabel}{pendingAmount}',
});
