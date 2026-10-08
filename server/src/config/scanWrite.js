/**
 * 扫码页的**两个写入口**（销售建单 / 补货报单）的全部可配参数 —— **配置先行**。
 *
 * 背景（业务负责人 2026-10-08 定的口径，逐字要点）：
 *   ① **销售建单**：在扫码页上**连续扫码累积多双** → 一张销售单（**一单多明细**，每行一双）；
 *      **结束方式 = 页面上的【提交】按钮**（⚠️ **不做**超时自动结算）；
 *   ② **补货报单**：勾选缺的尺码 + 填数量 → **生成采购申请**（走**现有采购链路**；
 *      供应商取「货品信息.供应商」）；
 *   ③ 收款方式**默认选中「微信」**（可改）；
 *   ④ 赠品写**销售主表**的「赠品」列（主表那一列，不是明细 —— 明细的赠品列她已删）；
 *   ⑤ 钱可以先不填（"先货后钱"）：允许"只记货"，那张单在表里就是**既有的**「资金状态 = 未写入」；
 *   ⑥ 点【提交】才写（"不确认不写账"）；
 *   ⑦ 幂等：连点两次 / 重放 ⇒ **只写一次**。
 *
 * 🔴 入口隔离（`docs/entry-isolation-2026-10-08.md`）：
 *   扫码入口与群聊入口**只共享业务处理层**（销售入账 / 收款 / 采购 / 库存 / 幂等），
 *   **不共享**输入解析、会话/草稿状态、状态机、出口、失败与重试、文案。
 *   ⇒ 本文件的**每一句话**都只属于扫码入口；会话落在**自己的**目录（`data/scan_sessions`），
 *     绝不读写 `data/lark_mvp_tasks/`（群聊那条链路的任务记录）。
 *
 * 🔴 **与群聊入口的那一条区别（业务负责人点名要写进注释的）**：
 *   · 扫码入口：收款方式**默认选中「微信」**（可改）—— 她在手机页面上是"填表"，
 *     预设一个最常用的默认值能少点一次；
 *   · 群聊入口：**逐字不变** —— 那里仍然是「**用户说了才算、不预设**」
 *     （业务负责人 2026-10-06 的原话：「**不会，用户会说到交易方式的！**」，见 AGENTS.md 第 16 条）。
 *   ⚠️ 这条默认值**只在扫码页的表单上**，`larkMvpService` / `salesThreadProgressService`
 *     一个字都不许因此改动 —— 两边的口径本来就是**故意不同**的。
 *
 * ⚠️ 与 `config/scanPage.js` 刻意**不合并**：那一份是"扫码**看**库存"的展示与取数参数，
 *   这一份是"扫码**写**"的入口参数（能写什么、写去哪儿、失败怎么说、幂等键长什么样）。
 *   两份共享的只有**路由挂载点**（`SCAN_PAGE.route`，从那边 require 过来，不抄第二份）。
 */
const path = require('node:path');
const { readFlag, readInt, readList, readString } = require('./envValue');
const { SCAN_PAGE } = require('./scanPage');

/**
 * 路由：写入口挂在**同一个扫码 router**上（`app.js` 用 `SCAN_PAGE.route.basePath` 挂载）。
 * ⚠️ 不新开一段路径、也不挂到 `/api/*` 下：扫码的人是**手机浏览器直接打开**的，
 *    没有 `x-api-key`，挂到 `/api/*` 必被那条中间件挡掉（与第一版只读页同一条理由）。
 */
const ROUTE = Object.freeze({
  basePath: SCAN_PAGE.route.basePath, // '/s'
  path: SCAN_PAGE.route.path,         // '/:number'
});

/**
 * 表单动作（`POST` 的 `action` 字段取值）。
 * 一个 POST 端点 + 四个动作，而不是四个端点：路由表只有一处，加动作只改这里。
 */
const ACTIONS = Object.freeze({
  // 销售：把当前这一双加进"本单"（**只写本地会话**，一个字都不落业务表）
  addLine: readString(process.env, 'SCAN_WRITE_ACTION_ADD', 'add_line'),
  // 销售：提交整单（**这是唯一的写库时机** —— 她说"点【提交】才写"）
  submitOrder: readString(process.env, 'SCAN_WRITE_ACTION_SUBMIT', 'submit_order'),
  // 销售：清空本单（还没提交时撤掉加错的那些）
  clearDraft: readString(process.env, 'SCAN_WRITE_ACTION_CLEAR', 'clear_draft'),
  // 补货：按勾选的尺码 + 数量生成采购申请
  replenish: readString(process.env, 'SCAN_WRITE_ACTION_REPLENISH', 'replenish'),
});

/** 表单字段名（HTML 的 `name`）。改名只改这里，路由与渲染层两边都不许写死。 */
const FIELDS = Object.freeze({
  action: 'action',
  // 幂等键（**表单里带回来的那一串**）：连点两次 = 同一个键 = 只写一次。
  submitKey: 'submit_key',
  size: 'size',
  amount: 'amount',
  gift: 'gift',
  paymentMethod: 'payment_method',
  paymentAmount: 'payment_amount',
  // 补货：多选尺码的复选框名（同一批勾选的尺码）+ 每个尺码一个数量输入框（`qty_<尺码>`）。
  replenishSizes: 'sizes',
  replenishQuantityPrefix: 'qty_',
});

/**
 * 「本单」的会话（**扫码入口自己的**会话记录，绝不碰群聊的 `lark_mvp_tasks`）。
 *
 * 为什么必须落盘：她是**一部手机连续扫**的 —— 扫 A 打开一页、扫 B 又打开一页，
 * 每一页都是**独立的一次 HTTP 请求**。「累积多双」这件事必须有一个**跨页面的**落点；
 * 放在浏览器里（localStorage）会随"换手机 / 清缓存"丢，也测不到，所以放服务端。
 *
 * ⚠️ 幂等键的**前缀**也在这里（配置先行）：`<prefix>:<会话 id>:<轮次>`。
 *    同一轮里连点两次 = 同一把键 ⇒ 只写一次；提交成功后轮次 +1，
 *    下一次提交是**新的一单**（不是"重复"）。
 */
const SESSION = Object.freeze({
  dir: readString(process.env, 'SCAN_SESSION_DIR', path.join(__dirname, '../../data/scan_sessions')),
  idField: 'session_id',
  // 会话 id 的前缀（+ 录单人 open_id 的哈希）—— 只落本地，不进业务表。
  idPrefix: readString(process.env, 'SCAN_SESSION_ID_PREFIX', 'scan_session'),
  // 幂等键前缀：销售一单一把、补货一次一把（两把键不共用，出问题时一眼分得清是哪条链路）。
  saleKeyPrefix: readString(process.env, 'SCAN_SALE_KEY_PREFIX', 'scan_sale'),
  replenishKeyPrefix: readString(process.env, 'SCAN_REPLENISH_KEY_PREFIX', 'scan_replenish'),
  // 「本单」留存多久：她扫一单通常几分钟内完成；留 6 小时足够，过期就当新单。
  ttlMs: readInt(process.env, 'SCAN_SESSION_TTL_MS', 6 * 60 * 60 * 1000, { min: 60_000, max: 7 * 24 * 60 * 60 * 1000 }),
  // 一单最多累积多少双（防误操作 / 防脚本刷）。
  maxLines: readInt(process.env, 'SCAN_SALE_MAX_LINES', 50, { min: 1, max: 500 }),
  statuses: Object.freeze({ draft: 'draft', submitted: 'submitted' }),
});

/**
 * 销售建单（扫码入口）。
 *
 * ⚠️ 这里**只有入口参数**：怎么写库全部交给既有的业务层
 *   （`salesOrderService.confirm` —— 销售明细 / 收款 / 四个状态维度 / 进度）。
 *   本文件不写任何一个字段名，字段映射仍只有 `v1BitableSchema` 一个真源。
 */
const SALE = Object.freeze({
  enabled: readFlag(process.env, 'SCAN_SALE_WRITE_ENABLED', true),
  // ⭐ **扫码入口专属**：收款方式默认值（业务负责人 2026-10-08：「默认微信」）。
  // 🔴 群聊那条链路**没有**这个默认值 —— 那里是"用户说了才算、不预设"（见文件头）。
  defaultPaymentMethod: readString(process.env, 'SCAN_SALE_DEFAULT_PAYMENT_METHOD', '微信'),
  // 表单上给她的收款方式选项（配置先行；取值必须能在「收款方式管理」里找到，
  // 否则写收款明细时会大声报"收款方式管理中找不到：X"）。第一项 = 默认选中项。
  paymentMethods: readList(process.env, 'SCAN_SALE_PAYMENT_METHODS')
    || ['微信', '现金', '支付宝', '银行卡'],
  // 成交金额留空时的兜底：用「货品信息.单价」（她"钱可以先不填"）。
  // 取不到单价 → 明确让她填（**不猜、不写 0**）。
  amountFallback: readString(process.env, 'SCAN_SALE_AMOUNT_FALLBACK', 'product_price'),
  // 主表「原话」那一列：扫码来的单也留一句人话（谁、扫了什么、几双）。
  originalTextTemplate: readString(
    process.env, 'SCAN_SALE_ORIGINAL_TEXT', '扫码建单（{count} 双）：{products}',
  ),
  // ⚠️ 「解析状态」**刻意不在这里配**：扫码建单没有 AI 解析这一步，而主表记录由
  //    既有的 `LarkMvpService.createSalesEntryWithOrderNo`（全仓唯一创建销售主表的地方）
  //    创建，它把这一列写成「解析中」—— 这里不为了好看再补一次写库
  //    （那正是"扫码侧另写一套写库逻辑"）。取舍与建议写在本次任务的报告里。
  // 赠品文本上限（主表「赠品」是文本列，写太长没意义、也容易被截断）。
  giftMaxLength: readInt(process.env, 'SCAN_SALE_GIFT_MAX_LENGTH', 100, { min: 1, max: 500 }),
  // 金额文本框允许的小数位（两位 = 分）。
  amountDecimals: readInt(process.env, 'SCAN_SALE_AMOUNT_DECIMALS', 2, { min: 0, max: 2 }),
  // 「失败原因要不要原样给她看」的闸门：业务层抛出来的中文业务话（例：
  // 「本次收款超过本单成交金额」「尺码管理中找不到 41 码」）是**可以给她看**的 ——
  // 她照着改一下就能再提交。但**内部错误**（飞书错误码 / 表名字段名 / 配置缺失）
  // 一律不许出现在页面上（第一版只读页那条规矩照旧：内部细节不回显）。
  // ⇒ 命中下面任一标记的错误 → 页面只给配置好的通用人话，原文只进日志。
  unsafeErrorMarkers: readList(process.env, 'SCAN_WRITE_UNSAFE_ERROR_MARKERS') || [
    'Code:', 'code:', 'app_token', 'table_id', 'record_id', 'secret',
    '未配置', 'FieldNameNotFound', 'not found', 'undefined',
  ],
});

/**
 * 补货报单（扫码入口）。
 *
 * 走**现有采购链路**：`purchaseWebhookService.publishPurchaseRequest`（= 免确认那条，
 * 与「信息填写」表变更事件走的是**同一个函数**）。本配置只提供"这次要补什么"。
 */
const REPLENISH = Object.freeze({
  enabled: readFlag(process.env, 'SCAN_REPLENISH_WRITE_ENABLED', true),
  // 「采购行为」的**行为编码**：采购申请那条（「行为管理」表里已核实的编码）。
  // ⚠️ 与 `services/purchaseReportBehaviorPolicy.js` 的口径**同源**：
  //    那条策略写着「采购申请那条永远是 STOCK_PURCHASE_INCREASE，采购退货是 ..._DECREASE」。
  //    扫码补货只可能是**采购申请**，所以这里固定按这个编码解析行为记录；
  //    解析不到 ⇒ **停下来报人话**（绝不写一条没有"采购行为"的采购申请）。
  behaviorCode: readString(process.env, 'SCAN_REPLENISH_BEHAVIOR_CODE', 'STOCK_PURCHASE_INCREASE'),
  // 本地采购任务的 task id 前缀（幂等键就是从这个 task id 推出来的，
  // 见 purchaseWebhookService.ensurePostingPlan：`purchase_request:<taskId>:<序号>`）。
  taskIdPrefix: readString(process.env, 'SCAN_REPLENISH_TASK_PREFIX', 'scan_replenish'),
  // 扫码补货那一次的**本地采购任务**落在哪儿：与群聊入口的 `purchase_webhook_tasks`
  // **分开**（入口隔离：两条入口的会话/任务互不关联），但走的是**同一个** service 与同一套幂等。
  taskDir: readString(
    process.env, 'SCAN_REPLENISH_TASK_DIR', path.join(__dirname, '../../data/scan_replenish_tasks'),
  ),
  // 单次补货最多勾几个尺码 / 单个尺码最多几双（防手滑输入 9999）。
  maxSizes: readInt(process.env, 'SCAN_REPLENISH_MAX_SIZES', 30, { min: 1, max: 100 }),
  maxQuantity: readInt(process.env, 'SCAN_REPLENISH_MAX_QUANTITY', 99, { min: 1, max: 999 }),
  // 勾了尺码但没填数量 ⇒ 按 1 双算（与「信息填写」报单那条口径一致）。
  defaultQuantity: readInt(process.env, 'SCAN_REPLENISH_DEFAULT_QUANTITY', 1, { min: 1, max: 99 }),
});

/**
 * 用户可见文案。占位符用 `{...}`，由 `fillText` 替换（**不留空段**）。
 * ⚠️ 手机上看，尽量短；页面上**不出现任何代码标识符**（在表单里给她的提示也一样）。
 */
const TEXTS = Object.freeze({
  // ── 销售表单 ──────────────────────────────────────────────────────────────
  saleHeading: '销售（可以连着扫，最后一起提交）',
  draftHeading: '本单已加 {count} 双',
  draftItem: '{itemNo} · {size} 码',
  draftEmpty: '还没加入任何一双：选好尺码，点「加入本单」。',
  sizeLabel: '尺码',
  sizePlaceholder: '选尺码',
  amountLabel: '成交金额（可不填）',
  amountPlaceholder: '留空按货品单价',
  giftLabel: '赠品（可不填）',
  addButton: '加入本单',
  submitButton: '提交这一单',
  clearButton: '清空本单',
  paymentLabel: '收款方式',
  paymentAmountLabel: '这次收到多少钱（可不填）',
  paymentAmountPlaceholder: '不填 = 先货后钱',
  // 钱没记时页面上的说明（**不新造状态**：收款明细是空的 ⇒ 既有进度口径就是「未收款」，
  // 工作台那一列显示的正是它）。
  fundsPendingNote: '这一单先记了货、还没记钱：收款明细是空的，按既有口径就是「未收款」（待补资金）。',
  submittedTitle: '这一单提交好了',
  submittedBody: '销售单号 {orderNo}，共 {count} 双。',
  // 结果页上逐行列出来的事实（单号 / 双数 / 收款）。
  submittedOrderLine: '销售单号：{orderNo}',
  submittedDetailLine: '明细：{count} 双（每双一行）',
  submittedNextHint: '接着扫下一款就可以开新的一单。',
  submittedFundsBody: '收款也记上了，共 {paid} 元。',
  submittedAgainTitle: '这一单已经提交过了',
  submittedAgainBody: '销售单号 {orderNo}，没有重复写入。',
  // 「刚加入本单」那一句（加完回跳到这一页时显示）。
  lineAddedBanner: '已加入本单：现在共 {count} 双。',
  // ── 补货表单 ──────────────────────────────────────────────────────────────
  replenishHeading: '补货报单（勾选要补的尺码）',
  replenishHint: '打勾的尺码会生成采购申请；不填数量按 1 双算。',
  replenishQuantityLabel: '数量',
  replenishButton: '生成采购申请',
  replenishDoneTitle: '采购申请已生成',
  replenishDoneBody: '批次号 {batchNo}，共 {count} 条明细。',
  replenishBatchLine: '报货批次号：{batchNo}',
  replenishDetailLine: '采购申请：{count} 条',
  replenishAgainTitle: '这次补货已经提交过了',
  replenishAgainBody: '批次号 {batchNo}，没有重复写入。',
  // ── 失败（都要在**页面上**说清楚，不许只写日志）──────────────────────────
  failedTitle: '这一步没成功',
  failedRetryHint: '可以照上面那句话改一下再点一次；反复失败请把这一页截图发给运营。',
  // 业务层抛出来的中文业务话原样给她看（例：「本次收款超过本单成交金额」）。
  businessFailedBody: '没提交成功：{reason}',
  // 命中 `sale.unsafeErrorMarkers` 的内部错误：只给这一句，原文只进日志。
  internalFailedBody: '刚才是系统这边没处理成功，请再点一次；反复失败请把这一页截图发给运营。',
  tooManyLinesBody: '一张单最多加 {max} 双，请先提交这一单再继续扫。',
  writeDisabledTitle: '这个功能现在关着',
  writeDisabledBody: '扫码下单 / 补货报单暂时没有开启，请联系运营。',
  sessionEmptyBody: '本单还没有明细：先选尺码点「加入本单」，再点「提交这一单」。',
  sessionExpiredBody: '这一页放太久了，本单已经过期：请刷新这一页重新加入。',
  sizeMissingBody: '请先选一个尺码。',
  sizeUnknownBody: '这个尺码不在「尺码管理」里，请刷新这一页重新选。',
  amountInvalidBody: '成交金额要填数字（例：399 或 399.5）。',
  amountMissingBody: '「{itemNo}」在「货品信息」里没有单价，请填一下成交金额再提交。',
  paymentAmountInvalidBody: '这次收款金额要填数字（例：100 或 100.5）。',
  quantityInvalidBody: '数量要填 1 ~ {max} 之间的整数。',
  replenishNoneBody: '至少要勾一个要补的尺码。',
  replenishTooManyBody: '一次最多勾 {max} 个尺码，请分两次提交。',
  replenishAgainBody: '这一页已经提交过了：刷新这一页可以再补一次。',
  // 动作名不认识（老页面 / 手改表单）：也要给她一句人话，不静默。
  unknownActionBody: '这一页上的按钮我认不出来（可能放太久了）：请刷新这一页再操作。',
});

/**
 * 结构化日志事件名。
 * 扫码写入口的日志**只属于扫码**（前缀 `scan.`）：出问题时按这个前缀 grep 得到全貌，
 * 也不会与群聊那条链路（`lark.sales.*` / `sales.*`）混在一起。
 */
const EVENTS = Object.freeze({
  disabled: 'scan.write.disabled',
  lineAdded: 'scan.sale.line_added',
  draftCleared: 'scan.sale.draft_cleared',
  saleSubmitting: 'scan.sale.submitting',
  saleSubmitted: 'scan.sale.submitted',
  saleReused: 'scan.sale.reused',
  replenishSubmitting: 'scan.purchase.submitting',
  replenishSubmitted: 'scan.purchase.submitted',
  replenishReused: 'scan.purchase.reused',
  failed: 'scan.write.failed',
  sessionStarted: 'scan.session.started',
  sessionExpired: 'scan.session.expired',
});

const SCAN_WRITE = Object.freeze({
  route: ROUTE,
  actions: ACTIONS,
  fields: FIELDS,
  session: SESSION,
  sale: SALE,
  replenish: REPLENISH,
  texts: TEXTS,
  events: EVENTS,
});

/** `{name}` 占位符替换（与 `config/scanPage.js` 同一套规则：缺的值用 `—` 顶，不留空段）。 */
const fillText = (template, values = {}, missing = '—') => String(template ?? '')
  .replace(/\{(\w+)\}/g, (match, key) => {
    const value = values[key];
    return value === undefined || value === null || value === '' ? missing : String(value);
  });

module.exports = {
  SCAN_WRITE,
  ROUTE,
  ACTIONS,
  FIELDS,
  SESSION,
  SALE,
  REPLENISH,
  TEXTS,
  EVENTS,
  fillText,
};
