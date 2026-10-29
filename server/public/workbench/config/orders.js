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

/** 面板文案（**只剩采购验收在用**；销售侧的旧列表/详情文案 2026-10-29 随旧前端一起删除）。 */
export const ORDERS_PAGE = {
  purchaseEmpty: '还没有采购单记录',
  // 「验收到货」独立子页里，**已到货的批次折叠**在下面 —— 折叠头就写这一句（后面跟条数）。
  purchaseArrivedSummary: '已到货',
};

/**
 * ⭐⭐ 2026-10-29：销售订单列表**只剩三条路径**（业务负责人定稿）——
 *   交割单（跳独立页）/ 售后单（飞书扫一扫→售后落地页）/ 草稿箱（占位）。
 * ⚠️ 三张卡只显示 `label + icon`；`tag/tone` 是为将来需要时保留的字段（当前不渲染）。
 */
export const SALES_SECTIONS = [
  { key: 'pending', label: '交割单', tag: '待交割', tone: 'info', icon: '🧾' },
  { key: 'afterSales', label: '售后单', tag: '待建设', tone: 'info', icon: '🛠️' },
  { key: 'draft', label: '草稿单', tag: '待建设', tone: 'info', icon: '📝' },
];

export const ARRIVAL_STATUS_PENDING = '未到货';
export const ARRIVAL_STATUS_ARRIVED = '已到货';

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

/**
 * ⭐ 2026-10-28：「交割单」卡片的落点 —— 独立预览页（业务负责人直接改稿用）。
 * ⚠️ URL 只在这里写一次；`features/orders/index.js` 读取它，不复制字面量。
 */
export const SALES_DELIVERY_PAGE = '/workbench/sales-delivery.html';

/**
 * 接口路径（**唯一来源**：渲染层不写死 URL）。
 *
 * ⚠️ 2026-10-29（旧订单列表前端退场）：本对象里原来那些动作接口（补收款 / 交付 / 补实收 / 补样品 /
 *    二次交付 / 续写重试 / 货品选择）**已删**——它们的旧 UI 和"无调用方"的后端路由一起退场；
 *    **业务服务层保留**（`SalesFollowupService` / `SecondDeliveryService` 等，独立页以后从服务层接）。
 */
export const ORDERS_API = {
  // 三卡入口的**首屏缓存**仍在读它（业务负责人点名保留"首屏缓存"）。
  orders: '/api/workbench/sales/orders',
  // 售后独立页的写入口（这次只做页面前半段，写库下一步接）。
  afterSales: '/api/workbench/sales/after-sales',
  // 采购验收：读采购申请 + 按批次确认到货（既有路由）。
  purchaseRequests: '/api/workbench/purchase/requests',
  arrivalConfirm: '/api/workbench/purchase/arrivals/confirm',
};

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
  // ── 采购验收（工作台「验收」页在用）──────────────────────────────────────
  verifyArrival: '验收到货',
  arrivalVerifyTitle: '验收到货',
  arrivalAmount: '实际金额',
  arrivalSubmit: '确认到货并入库',
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
