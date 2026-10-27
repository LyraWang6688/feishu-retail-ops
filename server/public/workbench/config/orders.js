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
  // ⭐ 2026-10-10（业务负责人真机反馈：「下面的这些文字解释就不用了」）：
  //    `title` / `subtitle` / `purchaseSubtitle` **整字段退场** —— 那是一级领域页里
  //    与子 tab 重复的大标题和它下面那行说明（订单列表在「销售」/「采购」两个领域里都是子 tab）。
  empty: '还没有已入账的销售单',
  purchaseEmpty: '还没有采购单记录',
  // ⭐ 2026-10-10：「验收到货」独立子页里，**已到货的批次折叠**在下面 —— 折叠头就写这一句
  //    （后面跟条数；不写"我为什么这么排"那种说明句）。
  purchaseArrivedSummary: '已到货',
  detailTitle: '订单详情',
  back: '← 返回订单列表',
  open: '查看 / 操作 →',
  reload: '刷新',
};

/**
 * ⭐ 2026-10-10：「报货批次」的**到货状态取值**（唯一来源 = `server/src/config/purchaseArrivalStatus.js`，
 *   那一边管"写"，这一边只管"读出来怎么摆"）。
 *   · 取值**原样来自既有字段**（`GET /api/workbench/purchase/requests` 的 `arrival_status`），
 *     这里一个状态都不新造；
 *   · 用途只有两处：卡片上那个小标签的兜底文案 + 「未到货排前面 / 已到货折叠在下面」的判据。
 */
export const ARRIVAL_STATUS_PENDING = '未到货';
export const ARRIVAL_STATUS_ARRIVED = '已到货';

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
/**
 * ⭐⭐ 2026-10-11（业务负责人 2026-10-09 定的新判据）：**三态判据用到的既有字段**，一处点名。
 *
 * 她原话：「**货品信息和资金信息是校验项，其余不是校验项**」
 *   · ① **货品信息** = 明细的 `product`（编号 / 货号）+ `color`（颜色）+ `size`（尺码）；
 *   · ② **资金信息** = 收款明细的 `method`（**收款方式**）+ **至少一笔收款记录**；
 *   · **钱货两清** = `fulfillment_status` = 「已交付」**且** `payment_status` = 「已收款」；
 *   · **配品行**（`requires_size === false`）**不参与货品信息 / 待交付**（它没有鞋）。
 *
 * ⚠️ **不新造任何状态 / 枚举**：上面每一个名字都是 `GET /api/workbench/sales/orders`
 *    已经在返回的字段（服务端算好的既有口径，见 `services/salesProgressService.js`）。
 * ⚠️ 判据本体只有一处实现：`features/orders/index.js` 的 `salesInfoOf` / `salesSectionOf`。
 *    这份常量是**给人和测试看的点名表**（她要求"报告里逐个点名用了哪些字段与取值"）。
 */
export const ORDER_STATE_FIELDS = Object.freeze({
  goods: Object.freeze(['product', 'color', 'size']),
  funds: Object.freeze(['method']),
  fulfillment: 'fulfillment_status',
  payment: 'payment_status',
  lineKind: 'requires_size',
});

/** 履约「已交付」= 货结清（取值来自既有 `fulfillment_status`）。 */
export const DELIVERED_FULFILLMENT = '已交付';
/** 收款「已收款」= 钱收齐（取值来自既有 `payment_status`）。 */
export const PAID_PAYMENT_STATUS = '已收款';

/**
 * 四类分组（空的那类也留着 —— 页面要显式告诉她这一类现在没有单）。
 * ⚠️ 2026-10-10：每组那句解释（`hint`，例「货已交付、钱已收清」）**已删** ——
 *    段头只留「名字 + 状态小标签 + N 单」（她：「下面的这些文字解释就不用了」）。
 */
export const SALES_GROUPS = [
  { key: 'settled', label: '钱货两清' },
  { key: 'undelivered', label: '有二次 · 货未交付' },
  { key: 'unpaid', label: '有二次 · 资金未收' },
  { key: 'both', label: '有二次 · 两者都有' },
];

/**
 * ⭐⭐ 2026-10-09（业务负责人定的结构）→ **2026-10-17 收窄成两段**：
 *   她 2026-10-17 逐字：「销售订单列表里**已经没有**所谓的"待补充信息"了，**只保留二次交割以及售后**」
 *   ⇒ **「补充信息单」整段退场**（`key: 'supplement'` 不许回来 ✗）；
 *     缺信息（缺货品信息 / 缺资金信息 / 待补样品）的单**并入「待交割单」**——
 *     `features/orders/index.js` 的 `salesSectionOf` 里那两处 `SALES_SECTIONS[0].key`
 *     **自动**落到 `pending` ✓（判定逻辑一行没改 ✓）。
 *
 * ⚠️ **判据（2026-10-17 起，只用既有字段与取值）**：
 *   · **待交割** —— 其余单子（含"缺货品 / 缺资金信息"＋"货没给完 / 钱没付完"）；
 *   · **售后列表** —— **钱货两清**（`fulfillment_status` = 已交付 且 `payment_status` = 已收款）。
 * ⚠️ 两段**互斥且覆盖全部单子**，不重不漏。
 * ⚠️ 这里**不新增任何状态枚举**：不含"已两清 / 未付清"这类自造词（有测试钉着）。
 * ⭐ 每段一个**彩色小标签**（`tag` + `tone`）：**待交割 / 已两清**。
 */
export const SALES_SECTIONS = [
  { key: 'pending', label: '交割单', tag: '待交割', tone: 'info', icon: '🧾', desc: '待交割订单与操作' },
  { key: 'afterSales', label: '售后单', tag: '待建设', tone: 'info', icon: '🛠️', desc: '售后处理' },
  { key: 'draft', label: '草稿单', tag: '待建设', tone: 'info', icon: '📝', desc: '未提交草稿' },
];

/**
 * 采购子 tab 的「验收到货」入口。
 * ⚠️ 「实际金额」是**既有必填口径**（业务负责人 2026-10-08：「金额这个是必填的，
 *    必须让用户填」）⇒ 按钮点开的是一个小表单。
 *    工作台这一下代表"按采购申请数全部到货"，**由她确认 / 可改**。
 */
export const ARRIVAL_CONFIRM = {
  // ⭐ 2026-10-16（她逐字：「数据表里已经没有到货文字说明（该列已从真表退场）了…你必须得删」）：
  //   原来是 `defaultAcceptanceText: '工作台 · 验收到货：…'`（写进「到货文字说明（该列已从真表退场）」的那个默认值）
  //   ⇒ **随那个输入框一起退场**（那一列在生产表里已经不存在 ⇒ 写了也没落点 ✗）
  amountPlaceholder: '例如 12800',
};

/**
 * ⭐⭐ 2026-10-11（业务负责人**选定方案A**）：「**扫码验收**」入口。
 *
 * 她的流程（逐字要点）：手机上打开工作台 → 采购 → 验收到货 → 选【未到货】的那个报货号 →
 * 点【验收】⇒ 进入"**验收模式**"（连续扫）⇒ 每扫一个码 ⇒ 选尺码 + 填数量 ⇒
 * 本单条（已验收 N / 应到 M）＋【继续扫下一个】＋【完成验收】⇒ 入库 + 批次改「已到货」。
 *
 * ⚠️ **它是加法**：下面那条 `ARRIVAL_CONFIRM`（"按采购申请数全额验收"）**一个字没改**
 *    —— 那条既是既有的工作台验收链路，也是群话题对话核对那条链路的入口。
 * ⚠️ 「验收模式」落在**扫码页**（`/s/accept`）：标签二维码内容就是 `/s/{编号}`，
 *    这是唯一**不用换标签**的做法（校验扫码也必须走那一页）。
 * ⚠️ URL 只在这里写一次（渲染层 import 它，不复制字面量）。
 */
// ⭐⭐ 2026-10-14 晚 cut B（改前逐字 → 改后逐字 → 依据）：
//   改前逐字：`export const ARRIVAL_SCAN = { pagePath: '/s/accept', buttonLabel: '扫码验收' };`
//   改后逐字：**`pagePath` 那一行删掉**（常量本身保留 ——
//     `test/scanAcceptance.test.js` 钉着「`ARRIVAL_SCAN` 常量保留 ✓」，且它确实**没有活引用**：
//     工作台入口早已改成工作台内的 confirm 表单，见
//     `test/workbenchAcceptanceInPlace.test.js` AC-AW1/AW4 ✓）
//   依据：业务负责人逐字「**`/s/accept` 这条路要彻底拆掉**」⇒ 这条指向它的 URL 是死的 ✗。
export const ARRIVAL_SCAN = {
  buttonLabel: '扫码验收',
};

/** 接口路径（**唯一来源**：渲染层不写死 URL）。 */
export const ORDERS_API = {
  orders: '/api/workbench/sales/orders',
  payments: '/api/workbench/sales/payments',
  // ⭐ 2026-10-11：逐件补「实收金额」（窄写入路径；服务端 = `SalesFollowupService.updateDetailAmounts`）
  detailAmounts: '/api/workbench/sales/detail-amounts',
  // ⭐⭐ 2026-10-11：**补样品**（卖了样品没指定门盒的那条待办；
  //    服务端 = `SalesFollowupService.fillSample` → `InventoryService.promoteToSample`，1 双）
  sampleFill: '/api/workbench/sales/sample-fill',
  deliveries: '/api/workbench/sales/deliveries',
  afterSales: '/api/workbench/sales/after-sales',
  secondDelivery: '/api/workbench/sales/second-delivery',
  // 复用既有的**只读**货品选择器（「库存手工调整」页也在用同一个）
  products: '/api/workbench/inventory/products',
  // ⭐ 采购子 tab：读 + 验收（都复用既有路由，不新开鉴权）
  purchaseRequests: '/api/workbench/purchase/requests',
  arrivalConfirm: '/api/workbench/purchase/arrivals/confirm',
  // ⭐⭐ 2026-10-15（⑨b-1 UI）：工作台「续写 / 重试」—— **复用既有服务端路由**
  //    （`routes/workbench.js` 的 `POST /sales/retry`，挂在既有 `requireWorkbenchAccess` 之后；
  //     同一把 `submitKey` 续写 ⇒ 幂等不拆 ✓ 绝不直调 `_confirm` ✓，**不新开写库** ✗）
  retry: '/api/workbench/sales/retry',
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

/**
 * 页面上的一切固定文案（渲染层不写死句子）。
 *
 * ⭐ 2026-10-10（业务负责人真机反馈：「下面的这些文字解释就不用了」）：
 *    ⚠️ 五个**使用说明句**已整字段退场（`collectHint` / `deliveryHint` / `afterSalesHint` /
 *       `secondDeliveryHint` / `arrivalVerifyHint`）—— 每个动作的标题（`<summary>`）与
 *       字段标签本身就说清了"能做什么"，再写一句解释就是说明书。
 *    ⭐ **保留下来的都是"填表要用到的"**：动作标题 · 字段标签 · 下拉占位 · 空状态人话 ·
 *       校验提示（校验句在 `features/orders/index.js` 里，原样保留）。
 */
export const ORDERS_TEXTS = {
  orderNo: '销售单号',
  details: '销售明细',
  payments: '收款情况',
  paid: '已收',
  pending: '还差',
  receivable: '应收',
  pendingDelivery: '待交付',
  collectTitle: '补收款',
  collectAmount: '收款金额',
  collectSubmit: '提交收款',
  // ⭐⭐ 2026-10-11（方案甲之后的**补充入口**）：逐件补「实收金额」。
  //    字段名与扫码页**逐字一致**（「实收金额」）—— 两个入口填的是同一份字段。
  detailAmountTitle: '实收金额',
  detailAmountLabel: '实收金额',
  detailAmountSubmit: '保存实收金额',
  // ⭐⭐ 2026-10-11：**补样品**（她卖掉的那双样品没有了 ⇒ 指定用哪个码的门盒挪一双变成样品）。
  //    ⚠️ 全是不带说明书的**功能名/事实**，不写"点这里可以先…"那种腔调。
  sampleFillTitle: '补样品',
  sampleFillLine: '{product} · {size} 码 的样品已卖掉，选一个码的门盒补上',
  sampleFillSizeLabel: '用哪个码的门盒',
  sampleFillOption: '{size} 码（门盒 {count} 双）',
  sampleFillSubmit: '补样品',
  sampleFillNoCandidate: '这一款现在没有可用的门盒，补不了样品',
  sampleFillDone: '已补样品：{size} 码 门盒 → 样品（库存总数不变）',
  deliveryTitle: '交付',
  deliveryEmpty: '这张单没有待交付的明细了',
  deliverySubmit: '提交交付',
  afterSalesTitle: '售后（退 / 换 / 赔）',
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
  secondDeliveryMethod: '收款方式',
  secondDeliverySubmit: '收尾款并交付',
  paymentMethod: '收款方式',
  select: '请选择',
  // ── ⭐ 2026-10-09 追加：采购验收 ──────────────────────────────────────────
  verifyArrival: '验收到货',
  // 验收表单的标题（`<details>` 的 summary）：与按钮同名，不再带"按采购申请数全部到货…"那串解释。
  arrivalVerifyTitle: '验收到货',
  arrivalAmount: '实际金额',
  // ⭐ 2026-10-16（她逐字：「**「到货说明」，到货说明必须得删**。因为目前我们的**数据表里面已经没有
  //   到货文字说明（该列已从真表退场）了**，这个是**之前我们的群聊链路**，跟这个**已经没有关系了**。**你必须得删**」）
  //   ⇒ **这个输入框整条退场**（含 `arrivalNote` 标签与它的默认值）——
  //     **不留孤儿配置** ✗（源码哨兵钉住：`arrivalNote` 再出现即红 ✓）
  arrivalSubmit: '确认到货并入库',
  groupEmpty: '这一类现在没有单',
  // ⭐⭐ 2026-10-16（⑨b-1 UI · 修一个真 bug）：这一套「未完成 ⇒ 可点重试」的文案
  //   原本写在 `ORDERS_PAGE` 里，**而代码是按 `T.*`（= 本对象）读的** ⇒
  //     `retrying` / `retryDone` / `retryAlreadyDone` 三个键**从来没生效过**：
  //     点击后那颗按钮显示的是通用句「正在提交，请不要重复点…」；
  //     服务端回 `reused:true`（"这一单已经写完了"）时页面**什么都不显示**（她最恨的"点了没反应"）。
  //   ⇒ 按**读取口**归位：视图/按钮标签走 `P.*`（`ORDERS_PAGE` 的 `incomplete` / `retry`），
  //     处理中文案与回执走本对象（与 `*Submit` / `sampleFillDone` 同族 ✓）。
  //   🔴 依据（业务负责人逐字）：「工作台显示「**未完成，可点重试**」」＋「**不许假成功**」——
  //     如实回执少一句都不行 ✗。⚠️ `未完成，可点重试` 是她逐字那一句，一个字别改。
  incomplete: '未完成，可点重试',
  retry: '重试',
  retrying: '正在续写…',
  // 成功 / 已写完两种回执（服务端也会回 `message`，这里只作兜底；都用既有口径的词，不新造状态 ✗）
  retryDone: '已续写完成。',
  retryAlreadyDone: '这一单已经写完了，没有要接着写的东西。',
};

// ⭐⭐ 2026-10-14 晚：「老验收整块搬进工作台」的前端真源（配置先行 ✓ 不散写中文 ✗）
//   真源文档：docs/acceptance-into-workbench-full-2026-10-14.md（AC-AW10…AW17）
//   ⚠️ 接口/字段名必须与服务端 src/config/workbenchArrival.js 逐字一致 ✓
export const ARRIVAL_FULL_API = {
  detail: '/api/workbench/purchase/arrivals/detail',
  accept: '/api/workbench/purchase/arrivals/accept',
  products: '/api/workbench/inventory/products',
};
export const ARRIVAL_FULL_FIELDS = {
  batchNo: 'batchNo', actualAmount: 'actualAmount', lines: 'lines',
  productRecordId: 'productRecordId', size: 'size', quantity: 'quantity',
};
export const ARRIVAL_FULL_TEXTS = {
  detailTitle: '这一批的采购明细',
  detailEmpty: '这一批没有可验收的采购明细',
  detailFailed: '这一批的采购明细没读到，请稍后再试',
  // ⭐⭐ 2026-10-15（task-27 · 她逐字：「点进去之后才是对应的采购明细情况，然后**可以自行补充**这个
  //   货号下的其余尺码和数量」＋「**实际到多少就是到多少**」）：
  //   · 第一屏只列批次，**点开**才看明细 ⇒ `detailOpenHint` 是那个"点开"的提示；
  //   · 每个明细行一个**实际到货数量**输入（默认 = 申请数量）⇒ `actualQuantityLabel` / `declaredQuantityLabel`；
  //   · **没填**（清空）与**填 0** 是两件事 ✗：填 0 = 这一码没到（**不提交那一行** ✓）；
  //     没填 = 我们不猜 ⇒ 拦住 + `actualQuantityRequired` 那句人话 ✓。
  detailOpenHint: '点开看这一批的采购明细（可以改实际到货数量）',
  actualQuantityLabel: '实际到货数量',
  declaredQuantityLabel: '申请',
  zeroMeansNotArrived: '没到的填 0',
  actualQuantityRequired: '每个尺码都要填「实际到货数量」（没到的填 0），再点确认到货并入库',
  // 与**服务端**那一份同口径（`src/config/workbenchArrival.js` 的 `texts.sizeInvalid` ✓）
  sizeInvalid: '尺码要填数字，数量要大于 0',
  noArrivalLines: '这一批没有可提交的实际到货数量，请先点开批次、把实际到货数量填上',
  customSizeLabel: '自定义尺码',
  customSizePlaceholder: '尺码',
  customQuantityPlaceholder: '数量',
  customItemNoLabel: '自定义货号',
  customItemNoPlaceholder: '货号',
  itemNoNotFound: '这个货号没找到，请核对后再填',
  submitting: '正在确认到货…',
  accepted: '已确认到货',
  // ⚠️ 2026-10-15（她追加口径）：明细**挂不上批次** ⇒ **不进这一屏**（见 `groupPurchaseOrders` ✓）——
  //    所以这里**不需要**"这批没有批次号、无法验收"那句文案了 ✗（我上一版加过，她口径一改就作废 ✓）。
};
