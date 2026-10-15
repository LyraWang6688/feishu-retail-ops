/**
 * 扫码页的**三个写入口**（销售建单 / 补货报单 / **采购退货**）的全部可配参数 —— **配置先行**。
 *
 * ⭐ 2026-10-11：第三个入口是【**退货**】（业务负责人：「和"报货"逻辑一样，也走扫码」）——
 *   它与补货**同形**（同一页面 / 同一 POST 端点 / 同一套会话与幂等风格），
 *   配置块见下面的 `PURCHASE_RETURN`。
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
 *     （业务负责人 2026-10-06 的原话：「**不会，用户会说到收款方式的！**」，见 AGENTS.md 第 16 条）。
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
 * 一个 POST 端点 + 若干个动作，而不是多个端点：路由表只有一处，加动作只改这里。
 */
const ACTIONS = Object.freeze({
  // 销售：把当前这一双加进"本单"（**只写本地会话**，一个字都不落业务表）
  addLine: readString(process.env, 'SCAN_WRITE_ACTION_ADD', 'add_line'),
  // ⭐ 2026-10-11（B）：把**一件配品**加进"本单"（同样只写本地会话）。
  //    与「加入本单」分成两个动作（表单不同：配品没有尺码、金额单列），
  //    但落进本单之后是**同一种东西** —— 一行销售明细（`kind` 不同而已）。
  addAccessory: readString(process.env, 'SCAN_WRITE_ACTION_ADD_ACCESSORY', 'add_accessory'),
  // 销售：提交整单（**这是唯一的写库时机** —— 她说"点【提交】才写"）
  submitOrder: readString(process.env, 'SCAN_WRITE_ACTION_SUBMIT', 'submit_order'),
  // 销售：清空本单（还没提交时撤掉加错的那些）
  clearDraft: readString(process.env, 'SCAN_WRITE_ACTION_CLEAR', 'clear_draft'),
  // 补货：按勾选的尺码 + 数量生成采购申请
  replenish: readString(process.env, 'SCAN_WRITE_ACTION_REPLENISH', 'replenish'),
  // ⭐⭐ 2026-10-11（业务负责人定）：采购领域的第二个动作 —— **退货**
  //    「和"报货"逻辑一样，也走扫码」⇒ 与 `replenish` **同形**（同一 POST 端点、
  //    同一套会话/幂等风格、勾尺码 + 填数量），只是落成**采购退货**。
  purchaseReturn: readString(process.env, 'SCAN_WRITE_ACTION_RETURN', 'return_purchase'),
  // ⭐⭐ 2026-10-11（方案A）：「**扫码验收**」两个动作 —— 扫一码加进本次验收 / 完成验收并入库。
  //    它们挂在**扫码页**上（她的口径：「不管是扫码页还是工作台，都是在移动端完成的」；
  //    **旧贴纸**（2026-10-12 之前的 `/s/{编号}`）扫开是编号版；**新贴纸**扫开是 `/r/{记录ID}`
  acceptAdd: readString(process.env, 'SCAN_WRITE_ACTION_ACCEPT_ADD', 'accept_add'),
  acceptFinish: readString(process.env, 'SCAN_WRITE_ACTION_ACCEPT_FINISH', 'accept_finish'),
  // ⭐⭐ 2026-10-12：**带清单的完成**（她改完数量 + 自定义行 + 实际金额，一次提交 = 一次写库）。
  //    ⚠️ 与 `acceptFinish`（只带金额的老路）**并存**：老页面 / 既有用例一个字都没动。
  acceptFinishRows: readString(process.env, 'SCAN_WRITE_ACTION_ACCEPT_FINISH_ROWS', 'accept_finish_rows'),
  // ⭐⭐ 2026-10-12（她选的方案 A）：「系统把 40、41 列出来（标注"未报货"）⇒ 你**点一下就加到货**」
  //    点一下 = 一个 POST（带当前清单）⇒ 服务端记账 ⇒ 302 回清单；再点一下 = 取消。
  acceptToggleSize: readString(process.env, 'SCAN_WRITE_ACTION_ACCEPT_TOGGLE_SIZE', 'accept_toggle_size'),
  // ⭐⭐ 2026-10-11（业务负责人：「**扫码页应该是有货品的吧？你不是有六个领域吗？**」）：
  //    「货品」领域那颗【**打印这一款**】—— **不写任何业务表**（只是把一条打印任务排进队列），
  //    所以它**不受"扫码写入口关着"影响**（见 `routes/scanPage.js`：那一支排在
  //    `if (!writeService) return 503` 那道闸门**之前**）。
  //    ⚠️ 页面上仍然**零 JS**：一个原生 `<form method="post">`，提交后 303 回本领域，
  //      由服务端重新渲染状态（在线 / 未连接（任务已排队）/ 已打印 / 失败 + 原因）。
  printLabel: readString(process.env, 'SCAN_WRITE_ACTION_PRINT_LABEL', 'print_label'),
});

/**
 * ⭐⭐ 2026-10-11（业务负责人**最终口径**，唯一权威）：「**付款情况**」= **整单**的收款情况，
 * 三档（表单上默认选中第一档「全付」）——
 *
 *   · **全付**：按**收款方式**写收款明细（1 条或多条），
 *     🔴 **收款合计必须 == 每件实收合计**；不等 ⇒ **拦住、一个字都不写** + 人话说明差额；
 *   · **部分付**：资金区填**实付多少** ⇒ 按方式写已收的那几条（状态 = 既有「已收款」）
 *     ＋ ⭐ **差额写一条【未收款】**（金额 = 每件实收合计 − 已收合计）；
 *   · **未付**：不用填 ⇒ ⭐ **写一条【未收款】**（金额 = 每件实收合计）。
 *
 * ⚠️ 三档都**只跟"这个单子所有的实收金额加起来"比**，
 *    **绝不引入"应收 / 单价"当判据**（她逐字：「只跟"这个单子所有的实收金额加起来"比，
 *    不跟应收/单价相比」）。
 * 🔴 取值 / 错误码 / 文案**全部可配**（配置先行）：加一档、改一句话都不必动逻辑。
 * ⚠️ 「未收款」那一条的**字段形状**由既有业务层决定（`PaymentService.record`：
 *    状态 = 表里既有的「未收款」、**方式留空**、金额 = 差额、关联 = 既有「关联销售单」，
 *    **不写**「交易方向」—— 见 `paymentService` 的 `MONEY_DIRECTION_INCOME` 注释）。
 */
const PAYMENT_STATUS = Object.freeze({
  // 全付（默认）：两边必须相等。
  full: readString(process.env, 'SCAN_SALE_PAYMENT_STATUS_FULL', '全付'),
  // 部分付：填"实付多少"，差额补一条【未收款】。
  partial: readString(process.env, 'SCAN_SALE_PAYMENT_STATUS_PARTIAL', '部分付'),
  // 未付（**默认档**，2026-10-11 晚起）：一个字都不用填 —— **只记货**；
  // ⚠️ **不再**自动补那条【未收款】（她真机被"资金不齐"卡住之后改的；口径 = "她说欠才算欠"）。
  unpaid: readString(process.env, 'SCAN_SALE_PAYMENT_STATUS_UNPAID', '未付'),
});

/**
 * ⭐⭐ 2026-10-14 晚（业务负责人**逐字**）：「**退货整单金额（必填），与补货同一套配置**」
 *   ＋同一晚另一句：「**只写一个整单金额**（一次填一个总额，**和补货一样**～）」
 *   ⇒ **补货 / 退货共用这一套**（一个字段名 + 一个必填开关 ✓ **不写两套** ✗）：
 *     · 两个表单各加**一个「整单金额」输入**（**一次一个总额** ✓ **不按行分填** ✗）；
 *     · 提交时：**空 ⇒ 400 + 人话 + 一个字都不写** ✓；**非空 ⇒ 照旧提交** ✓。
 *   ⚠️ 本套只管"**填没填**"（判据就是她说的「必填」）——**数字格式不做额外校验** ✗
 *     （与销售那条「每件实收必填」同一个形状：非空照旧能提交 ✓）。
 *   🔴 **本版不落表**：金额落**哪一列**待她裁决 —— 采购明细 `purchaseRequest` 没有任何金额列；
 *     采购主表 `purchaseOrderBatch` 唯一的金额列「实际金额」**已被"到货核对"占用**（见
 *     `v1BitableSchema.js:487-493`）⇒ 见 `routes/scanPage.js` 的 `TODO(purchase-amount)`。
 *     **绝不自己挑一列写** ✗（挑错会污染到货那条链路的钱）。
 *   ⚠️ 开关是**显式布尔**（`readFlag`）：**不用** `process.env.X || fallback`（那种"清空关不掉"✗）。
 *   ⚠️ 字段名见 `FIELDS.purchaseAmount`、人话见 `TEXTS.purchaseAmount*`（三处互相引用 ✓）。
 */
const PURCHASE_AMOUNT = Object.freeze({
  // **一个开关同时管**退货与补货（她：「与补货同一套配置」）。
  // ⚠️ **兼容键，不改名**（老 `.env` / 老用例仍读它 ✓）；新逻辑按下面 `requiredByRealm` 分链路判 ✓。
  required: readFlag(process.env, 'SCAN_PURCHASE_AMOUNT_REQUIRED', true),
  /**
   * ⭐⭐ 2026-10-16（⑫ · 她逐字：「**不用做那个为空去单价的功能了**」＋「补货与退货共用同一道闸门」）：
   *   #667 查实：补货与退货**共用同一个 `required`** ⇒ **不能靠一个开关分链路** ✗
   *   （一关就把退货也放开 ✗）⇒ 改成**按链路分档**：一个链路一个**显式布尔**，
   *   路由按"当前是哪条链路"取对应那一档 ⇒ **不改逻辑、只换配置** ✓。
   *   · `replenish` —— 补货那条链路；
   *   · `return`    —— 退货那条链路（**行为一个字不变** = true ✓）；
   *   · `accept`    —— 验收那条链路（今天没有金额闸门 ⇒ 先钉 true，将来接上直接用 ✓）。
   * ⚠️ 三个都走 `readFlag`（**显式布尔**：清空/写 0/false 就真关掉 ✓ **不用 `||` 兜底** ✗）。
   * ⚠️ 默认值 = `required` 那一档 **不是**这里写死 `true`：**旧键说什么就是什么** ⇒
   *    今天 `required=true` 时，**退货/验收**仍 `true`（行为不变 ✓）；**补货改为 `false`** —— 按她
   *    「**补货不问金额**」的口径，这是目标的终态 ✓（路由尚未读这一档 ⇒ 生产行为暂时仍不变 ✓）。
   */
  requiredByRealm: Object.freeze({
    // ⭐ 2026-10-16 修（Lead）：她的口径是「**补货不问金额**」⇒ 补货这一档默认必须是 **false** ✓
    //   （改前逐字：`…_REPLENISH', true)` ⇒ 与 task-55 的判据 `replenish === false` 冲突 ⇒ main 自己红 ✗）
    //   ⚠️ 路由还没读这一档（接线未落）⇒ **本次改动对生产行为零影响** ✓ 只是把配置的默认值改对 ✓
    //   依据 = 她 2026-10-16 逐字：「不用做那个为空去单价的功能了」＋「补货不问金额」（她 2026-10-16 口径）
    replenish: readFlag(process.env, 'SCAN_PURCHASE_AMOUNT_REQUIRED_REPLENISH', false),
    return: readFlag(process.env, 'SCAN_PURCHASE_AMOUNT_REQUIRED_RETURN', true),
    accept: readFlag(process.env, 'SCAN_PURCHASE_AMOUNT_REQUIRED_ACCEPT', true),
  }),
  // 表单字段名（HTML 的 `name`）—— 两个表单**用同一个**（一套配置管两边 ✓）。
  field: readString(process.env, 'SCAN_PURCHASE_AMOUNT_FIELD', 'purchase_amount'),
});

/** 表单字段名（HTML 的 `name`）。改名只改这里，路由与渲染层两边都不许写死。 */
const FIELDS = Object.freeze({
  action: 'action',
  // 幂等键（**表单里带回来的那一串**）：连点两次 = 同一个键 = 只写一次。
  submitKey: 'submit_key',
  size: 'size',
  // ⚠️ 2026-10-11 起：`amount` = **「实收金额」**（加单那一步填的那一个数 = 这一件实际收到多少）。
  //    🔴 它**没有第二个金额概念**：页面上、表里都只有这一个数
  //      （物理列名 = 「实收金额」，见 `v1BitableSchema.salesDetail.actualAmount`）。
  //    留空 ⇒ **那一列就留空**（2026-10-11 方案甲：**不再读「单价」兜底**，表里不出现假数字）；
  //    填了 ⇒ 必须 > 0（0 / 非数字照旧拦住，见 `line_amount_invalid` / `accessory_amount_invalid`）。
  amount: 'amount',
  gift: 'gift',
  // ⭐ 配品那一行的「其他配品」记录 id（下拉里选中的名称对应的记录）。
  //    ⚠️ 与 `size` 二选一：配品行没有尺码、鞋行没有配品（见 `config/sellableKinds`）。
  accessory: 'accessory_record_id',
  // ⭐⭐ 2026-10-11：**总单层**的两个字段。
  //    ① 每件实收（提交表单里按本单顺序**逐行一个输入框**，同名重复 ⇒ body 里是有序数组，
  //       下标与本单的明细行**一一对应**）；
  lineAmount: 'line_amount',
  //    ② 收款：**多笔、多方式**（同名重复 ⇒ 两个数组按行下标对齐）；
  //       每一行 = 收款方式（「收款方式管理」里的选项）+ 金额。
  paymentMethod: 'payment_method',
  paymentAmount: 'payment_amount',
  // ⭐⭐ 2026-10-11（最终口径）：**「付款情况」（整单）** —— 三档单选（`全付` / `部分付` / `未付`，
  //    取值来自 `PAYMENT_STATUS`，默认第一档「全付」）。
  paymentStatus: 'payment_status',
  //    ③ 「部分付」时资金区填的**实付多少**（单一数字输入框；「全付」/「未付」两档忽略它）。
  paidAmount: 'paid_amount',
  // 补货：多选尺码的复选框名（同一批勾选的尺码）+ 每个尺码一个数量输入框（`qty_<尺码>`）。
  replenishSizes: 'sizes',
  replenishQuantityPrefix: 'qty_',
  // 退货：与补货**同形**，但字段名**各用各的** —— 两张表单在同一个页面（采购领域）上，
  //   `name` 分开之后，将来谁想加"两个表单同时提交"或做断言都不会互相串。
  returnSizes: 'return_sizes',
  returnQuantityPrefix: 'return_qty_',
  // ⭐⭐ 2026-10-14 晚：**整单金额**（她：「**只写一个整单金额**（一次填一个总额，和补货一样～）」）
  //   —— 补货 / 退货**共用同一个 `name`**（唯一来源 = `PURCHASE_AMOUNT.field` ✓ 不抄两份 ✗）。
  purchaseAmount: PURCHASE_AMOUNT.field,
  // 扫码验收：单选一个尺码 + 一个数量 + 最后一步的「实际金额」。
  acceptSize: 'accept_size',
  acceptQuantity: 'accept_quantity',
  acceptAmount: 'accept_amount',
  // ⭐⭐ 2026-10-12（她的口述版）：**预填清单**用的三个字段（同名重复 ⇒ 按行序解析）。
  //    `acceptRowQty` 一"报货行"一个（顺序 = 采购明细顺序）；后两个是自定义行（尺码 + 数量）。
  acceptRowQty: 'accept_row_qty',
  // 清单表单把"哪一批"也带上（URL 上也有；这条是**手改 URL 也换不了批次**的保险）。
  acceptBatch: 'accept_batch',
  acceptCustomSize: 'accept_custom_size',
  acceptCustomQuantity: 'accept_custom_quantity',
  // ⭐⭐ 2026-10-12（方案 A）："未报货尺码"那几个可点元素带的是**哪个尺码**（可重复 ⇒ 按行序解析）。
  acceptToggleSize: 'accept_toggle_size',
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
  // 幂等键前缀：销售一单一把、补货一次一把、退货一次一把（三把键不共用，出问题时一眼分得清是哪条链路）。
  saleKeyPrefix: readString(process.env, 'SCAN_SALE_KEY_PREFIX', 'scan_sale'),
  replenishKeyPrefix: readString(process.env, 'SCAN_REPLENISH_KEY_PREFIX', 'scan_replenish'),
  returnKeyPrefix: readString(process.env, 'SCAN_RETURN_KEY_PREFIX', 'scan_return'),
  // 「扫码验收」的会话（**第四条链**，自己的目录，与销售 / 补货 / 退货互不覆盖）。
  acceptKeyPrefix: readString(process.env, 'SCAN_ACCEPT_KEY_PREFIX', 'scan_accept'),
  // 「本单」留存多久（**配置先行**：`SCAN_SESSION_TTL_MS`，显式数值，没有 `||` 兜底那种关不掉的写法）。
  // 🔴 2026-10-12 真机改：**默认 12 小时**（改前 6 小时）—— 她实测「会挂 8 小时」，
  //    6 小时就过期了；而当时过期后**每一次提交都 400**（见 `scanWriteService` 的 `revive` 那条注释）。
  // ⚠️ 过期**不再是死路**：提交时会**续上**这一份会话（草稿 / 已落盘的主表 id 都保留），
  //    只有「加入本单 / 清空本单」这类"要开一笔新操作"才按 TTL 语义新开一单。
  ttlMs: readInt(process.env, 'SCAN_SESSION_TTL_MS', 12 * 60 * 60 * 1000, { min: 60_000, max: 7 * 24 * 60 * 60 * 1000 }),
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
  // ⚠️ 2026-10-11 起它只落在**第一笔**收款行上（第二行起默认"不记这笔"）——
  //    否则每一行都预选微信 ⇒ 每一行都像"已经被用了"。
  defaultPaymentMethod: readString(process.env, 'SCAN_SALE_DEFAULT_PAYMENT_METHOD', '微信'),
  // 表单上给她的收款方式选项（配置先行；取值必须能在「收款方式管理」里找到，
  // 否则写收款明细时会大声报"收款方式管理中找不到：X"）。
  // ⚠️ 默认选中项 = `defaultPaymentMethod`（只落在**第一行**收款上）。
  paymentMethods: readList(process.env, 'SCAN_SALE_PAYMENT_METHODS')
    || ['微信', '现金', '支付宝', '银行卡'],
  // ⭐⭐ 2026-10-11：**总单层可以记几笔收款**（页面预置几行；没填金额的行 = 不用）。
  //    ⚠️ 这一页是**零 JS** 的原生表单（2026-10-09 白屏事故之后定的、有用例钉着），
  //      所以"可增删行"落地成"预置 N 行、填几行算几行"。
  //      业务上最常见的形状是"微信 + 现金"两笔（她 2026-10-11 的例子：500 = 200 + 300）。
  //    ⚠️ **2026-10-11 最终口径**：预置 **1** 行（她："收款行预置 1 行；填了金额才算一笔"）——
  //      第一行选中默认收款方式；要记第二笔就在第二行填金额 + 选方式（"填了才算一笔"）。
  paymentRowCount: readInt(process.env, 'SCAN_SALE_PAYMENT_ROWS', 1, { min: 1, max: 10 }),
  // 金额文本的显示前缀（人话里报差额时用；页面上的「单价」另有 `config/scanPage` 的 `PRICE`）。
  moneyPrefix: readString(process.env, 'SCAN_SALE_MONEY_PREFIX', '¥'),
  // ⛔ **2026-10-11（方案甲）：「留空 ⇒ 读「单价」兜底」这条已整条退场** ——
  //    她没填实收 ⇒ **那一列就留空**（不写进表），表里因此不会出现"按单价顶上去的假数字"。
  //    ⇒ 那个旋钮（原来的 `amountFallback` / `SCAN_SALE_AMOUNT_FALLBACK`）**已删除**：
  //      留着一个"没有读取点、且与新口径相反"的开关，比删掉更容易把人带偏。
  //    ⚠️ 「单价」现在只在**货品那一页显示**（`config/scanPage` 的 `PRICE`），
  //       **不再参与建单**；三档收款的比对**永远只跟"每件实收金额加起来"比**。
  //    ⚠️ **填了就必须 > 0**（0 / 负数照旧拦住）—— 放宽只针对"缺省"。
  // ⭐⭐ **「付款情况」三档**（整单口径）—— 取值定义在上面的 `PAYMENT_STATUS`。
  //    · `default` = 表单上默认选中的那一档；
  //    · `values` = 合法的三档取值（手改表单塞第四种 ⇒ 人话拦住，不静默）；
  //    · `mode`   = **语义键 → 取值**（逻辑里只认 `mode.full` / `mode.partial` / `mode.unpaid`，
  //      **不许拿 `values` 的下标或字面量去比**：改一句话不该改逻辑）。
  //
  // 🔴🔴 **2026-10-11 晚（她真机被卡住之后改的，唯一权威）**：默认档 = **「未付」**。
  //    现场：线上日志 `scan.sale.amount_mismatch payment_status="全付" items_cents=9900
  //    payments_cents=0`，她的原话「**只有一笔单子，一直提交不了**」—— 根因就是
  //    **默认档是「全付」**：她只填了实收、没填收款 ⇒ 撞上"全付必须相等"⇒ 被拦住。
  //    而扫码建单的**真实场景**是"钱通常还没收" ⇒ 默认档必须是 **未付**：
  //    她不动那个单选框 ⇒ 只记货、钱进**待补充**（与「建单只要货品信息全了就放行」一致）。
  paymentStatus: Object.freeze({
    values: Object.freeze([PAYMENT_STATUS.full, PAYMENT_STATUS.partial, PAYMENT_STATUS.unpaid]),
    default: PAYMENT_STATUS.unpaid,
    mode: Object.freeze({
      full: PAYMENT_STATUS.full,
      partial: PAYMENT_STATUS.partial,
      unpaid: PAYMENT_STATUS.unpaid,
    }),
  }),
  // ⭐⭐ 2026-10-11：**校验失败 → 原地把差额说给她听**（不是丢一张干巴巴的失败页）。
  //    命中这些 code 的失败：路由**重新渲染销售那一块**（她刚填的每件实收 / 收款行 /
  //    付款情况 / 实付多少都在），页面顶部一条人话横幅说明差多少、哪边多了少了。
  //    ⚠️ 服务端仍然是**权威**：这些 code 一个字节都不写库（见 `services/scanWriteService.js`）。
  formFailureCodes: readList(process.env, 'SCAN_SALE_FORM_FAILURE_CODES') || [
    // 核心校验：全付时 每件实收合计 ≠ 收款合计（**只有全付时必须相等**）
    'amount_mismatch',
    // 部分付：填的收款行合计 ≠ 她填的"实付多少" / 实付超过每件实收合计 / 没填实付多少
    'partial_amount_mismatch', 'partial_amount_missing',
    // 付款情况：取值不认识（手改表单）
    'payment_status_invalid',
    // 收款行：填了金额没选方式 / 金额不是数字
    'payment_row_incomplete', 'payment_amount_invalid',
    // 每件实收：不是数字（**空不再是失败** —— 2026-10-11 方案甲：没填 ⇒ 那一列留空）
    'line_amount_invalid',
    'accessory_amount_invalid',
  ],
  // 主表「原话」那一列：扫码来的单也留一句人话（谁、扫了什么、几双）。
  originalTextTemplate: readString(
    process.env, 'SCAN_SALE_ORIGINAL_TEXT', '扫码建单（{count} 双）：{products}',
  ),
  // ⚠️ 「解析状态」**刻意不在这里配**：扫码建单没有 AI 解析这一步，而主表记录由
  //    共享处理层的 `services/salesEntryService.createSalesEntryWithOrderNo`
  //    （全仓唯一创建销售主表的地方，2026-10-11 从 larkMvpService 剥出）创建，
  //    它把这一列写成「解析中」—— 这里不为了好看再补一次写库
  //    （那正是"扫码侧另写一套写库逻辑"）。取舍与建议写在本次任务的报告里。
  // 赠品文本上限（主表「赠品」是文本列，写太长没意义、也容易被截断）。
  giftMaxLength: readInt(process.env, 'SCAN_SALE_GIFT_MAX_LENGTH', 100, { min: 1, max: 500 }),
  // ⭐ 2026-10-11（B）：「其他配品」清单的**进程内缓存**（毫秒；0 = 每次都读）。
  //    为什么要有它：她**连着扫码**，每一页都要画那个配品下拉 —— 一次扫码不该多打一次飞书。
  //    30 秒足够短：她在飞书里新加一件配品，最迟半分钟后刷新这一页就能选到。
  accessoryCacheTtlMs: readInt(process.env, 'SCAN_SALE_ACCESSORY_CACHE_TTL_MS', 30_000,
    { min: 0, max: 10 * 60 * 1000 }),
  // 金额文本框允许的小数位（两位 = 分）。
  amountDecimals: readInt(process.env, 'SCAN_SALE_AMOUNT_DECIMALS', 2, { min: 0, max: 2 }),
  // ⭐⭐ 2026-10-15（⑰ B 异步 · 她逐字）：
  //   「**单号一出立刻回**…**明细/库存/交付转后台**；失败落「**写入失败**」、
  //    工作台显示「**未完成，可点重试**」；重试**只走 `submitSale` 同一把 `submitKey`**」
  //   ＋她晚间那句：「**统一文字改成：本单已创建成功（单号），其余文字不需要**，
  //    **销售和配品都这样**」
  //   ⇒ 配置先行：开关 / 那句话 / 后台看门狗超时 **全部可配** ✓（不散写 if-else ✗）。
  //   ⚠️ 那句话**销售与配品共用**（一处配置 ✓）；`{orderNo}` 占位用**真单号**填 ✓（拿不到就不编 ✗）。
  asyncWrite: Object.freeze({
    // ⭐⭐ **2026-10-15（⑨b-2）：默认翻成 `true`** —— 她这才**真正看到异步**（单号先出立刻回）。
    //   为什么现在才翻（历史顺序，别再翻回去 ✗）：
    //     · ⑨a 默认刻意 `false`：那时后台写失败会让她看到「**未完成，可点重试**」，
    //       而**重试入口还没做** ⇒ 她会卡在"点不了的重试"，比同步报错**更坏** ✗；
    //     · ⑨b-1（#568/#569/#570）**重试入口已就位**（工作台 `POST /api/workbench/sales/retry`
    //       + UI「未完成，可点重试」）⇒ 翻开关的前置条件成立 ✓。
    //   ⚠️ 仍是**显式布尔**（`readFlag`）：显式 `SCAN_SALE_ASYNC_WRITE_ENABLED=false` / 空串 ⇒ **关** ✓；
    //      **不许**写 `||` 兜底（那样"清空变量"关不掉 ✗ —— 本仓被这条坑过）。
    enabled: readFlag(process.env, 'SCAN_SALE_ASYNC_WRITE_ENABLED', true),
    doneBodyTemplate: readString(
      process.env, 'SCAN_SALE_ASYNC_DONE_BODY', '本单已创建成功（{orderNo}）',
    ),
    // 后台那一跑的看门狗阈值（毫秒）—— **只用于记一条 warn**（不取消写入）✗
    backgroundTimeoutMs: readInt(process.env, 'SCAN_SALE_ASYNC_TIMEOUT_MS', 180000, { min: 1000, max: 1800000 }),
  }),
  // 「失败原因要不要原样给她看」的闸门：业务层抛出来的中文业务话（例：
  // 「本次收款超过本单实收金额」「尺码管理中找不到 41 码」）是**可以给她看**的 ——
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
 * 走**现有采购链路**：`purchaseWebhookService.publishPurchaseRequest`（= 免确认那条；
 * 它原先也是「信息填写」表变更事件走的那条路，那条入口 2026-10-09 已退场，函数没变）。
 * 本配置只提供"这次要补什么"。
 */
const REPLENISH = Object.freeze({
  enabled: readFlag(process.env, 'SCAN_REPLENISH_WRITE_ENABLED', true),
  // 「采购行为」的**行为编码**：采购申请那条（「行为管理」表里已核实的编码）。
  // 🔴🔴 2026-10-12 真机 bug（业务负责人的原话：「**为什么你选成了采购增加了呢？**」）：
  //    这里原来写的是 `STOCK_PURCHASE_INCREASE`（名字「采购增加」）—— 那是**库存环节**的行为 ✗
  //    （真表事实：「采购增加」`所属环节=库存`、`库存方向=增加`；而「**报货**」`所属环节=采购`、`库存方向=不影响`）。
  //    「采购单.采购行为」与「库存流水.库存行为」是**两张表两列、两件事** ✗：
  //      · 采购单的「采购行为」⇒ 走本配置（**采购环节**的行为编码：报货 / 退货）；
  //      · 库存流水的「库存行为」⇒ 永远是 `inventoryService` 的 `STOCK_PURCHASE_INCREASE/_DECREASE`（**库存环节**）✓
  //    ⚠️ **只能按「行为编码」解析**：行为管理里「退货」有**同名两条**
  //      （采购 `PURCHASE_RETURN` / 销售 `SALE_RETURN`）⇒ 按名字会解析错 ✗
  //      解析不到 ⇒ **停下来报人话**（绝不写一条没有"采购行为"的采购申请）。
  behaviorCode: readString(process.env, 'SCAN_REPLENISH_BEHAVIOR_CODE', 'PURCHASE_ORDER'),
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
  // 勾了尺码但没填数量 ⇒ 按 1 双算（"每条明细至少一双"）。
  defaultQuantity: readInt(process.env, 'SCAN_REPLENISH_DEFAULT_QUANTITY', 1, { min: 1, max: 99 }),
});

/**
 * ⭐⭐ 采购**退货**（扫码入口，业务负责人 2026-10-11 定：「和"报货"逻辑一样，也走扫码」）。
 *
 * 与 `REPLENISH` **同形**（同一页面、同一 POST 端点、勾尺码 + 填数量、同一套会话与幂等风格），
 * 差别只有"落成什么"：
 *   · 明细写「报货信息」，**采购行为 = 退货行为**（按下面的编码去「行为管理」解析）；
 *   · 「报货批次」建一行，**只写 批次号 + 幂等键**（🔴 **不写「到货状态」** —— 她的口径：
 *     留空 ⇒ 9 点「未到货」推送与工作台待验收列表都看不见退货批次）；
 *   · **扣库存**（走「库存行为」= 退货那条既有编码；consumes 由库存注册表声明 = 门盒+样品+仓库）；
 *   · 出「采购退货单」PNG（与采购申请单**共用**同一条出图/发群/回填附件链路，只换标题）。
 *
 * ⚠️ **超库存**的既有业务口径（她认的）：**退能退的 + 把差额如实回报** ——
 *    绝不退成负数、也绝不静默少退（`shortfall` 会一路回到页面）。
 * ⚠️ 「采购退货」这条链路 2026-10-09 曾随「信息填写」整表删除一起退场（代码里已无入口）
 *    ⇒ 本次是**用既有构件重新组合**（批次服务 / createOnceByKey / 库存引擎 / 出图链路），
 *    不是新写一套写库逻辑。
 */
const PURCHASE_RETURN = Object.freeze({
  enabled: readFlag(process.env, 'SCAN_RETURN_WRITE_ENABLED', true),
  // 🔴🔴 2026-10-12 同上：原来写 `STOCK_PURCHASE_DECREASE`（「采购减少」）也是**库存环节**的行为 ✗
  //    ⇒ 采购退货的「采购行为」应该是真表里**采购环节**的「**退货**」= 编码 `PURCHASE_RETURN` ✓
  //    ⚠️ 库存流水那一边**仍然是** `STOCK_PURCHASE_DECREASE`（`inventoryService` 的口径，一行没动 ✓）
  //    解析不到 ⇒ 停下来报人话（绝不写一条没有"采购行为"的退货明细）。
  behaviorCode: readString(process.env, 'SCAN_RETURN_BEHAVIOR_CODE', 'PURCHASE_RETURN'),
  // 本地退货任务的 task id 前缀（幂等键由它 + 这一次提交的键推出）。
  taskIdPrefix: readString(process.env, 'SCAN_RETURN_TASK_PREFIX', 'scan_return'),
  // 本地退货任务落在哪儿：与补货那条**分开**（两条链路的进度/计划互不干扰）。
  taskDir: readString(
    process.env, 'SCAN_RETURN_TASK_DIR', path.join(__dirname, '../../data/scan_return_tasks'),
  ),
  // 单次最多勾几个尺码 / 单个尺码最多几双。
  maxSizes: readInt(process.env, 'SCAN_RETURN_MAX_SIZES', 30, { min: 1, max: 100 }),
  maxQuantity: readInt(process.env, 'SCAN_RETURN_MAX_QUANTITY', 99, { min: 1, max: 999 }),
  // 勾了尺码但没填数量 ⇒ 按 1 双算。
  defaultQuantity: readInt(process.env, 'SCAN_RETURN_DEFAULT_QUANTITY', 1, { min: 1, max: 99 }),
  // 退货单出图：与采购申请单共用渲染器，只换标题与文件名后缀（既有出图链路支持这两个参数）。
  imageTitle: readString(process.env, 'SCAN_RETURN_IMAGE_TITLE', '邯美皮鞋采购退货单'),
  fileNameSuffix: readString(process.env, 'SCAN_RETURN_FILE_SUFFIX', '采购退货单'),
});

/**
 * ⭐⭐ 2026-10-11（方案A，业务负责人选定）：「**扫码验收**」。
 *
 * 流程（她的原话要点）：
 *   工作台 → 采购 → 验收到货 → 选【未到货】的报货号 → 点【验收】⇒ **进入验收模式**（连续扫）
 *   → 每扫一个码（二维码里只有编号）⇒ 列该编号各尺码 ⇒ 选尺码 + 填数量（默认 1，可改）
 *   → **本单条式**（已验收 N 双 / 应到 M 双 ＋【继续扫下一个】＋【完成验收】）
 *   → 【完成验收】⇒ **入库 + 该批次改「已到货」**（实际到货数量 = **已扫合计**）。
 *
 * 口径（她自己补的）：
 *   · 扫到**不属于本批**的货 ⇒ 提示"这一双不在本批"、**不记**；**重复扫** ⇒ **只记一次**；
 *   · **不写差异说明**：「我们已经通过扫码解决了具体到货情况，所以就**不用到货说明了**」；
 *     ⇒ 【完成验收】**只收「实际金额」（必填）**。⚠️ 「到货说明」那一步只留给**工作台既有那条
 *     「全额验收」链路**（它的表单与载荷一个字不改）—— 这里是**加法**，不是替换。
 *   · 本地草稿里的 `acceptance_text`（那张表上**没有**这一列，写了也不会落库）由**扫码事实**
 *     拼出来（`acceptanceTextTemplate`）—— 是"她扫了什么"的复述，不是替她编的一句话。
 *
 * ⚠️ 会话**独立落盘**（`sessionDir`，与 `data/scan_sessions` 分开）：一处"验收模式"就是
 *    这一批的连续扫，与销售本单 / 补货 / 退货那三条链互不覆盖（有用例钉住）。
 * ⚠️ 验收**不写任何业务表**：完成的写库全部走既有
 *    `PurchaseArrivalConversationService.confirmBatchArrival` → `confirmLocked` →
 *    `PurchaseWebhookService.confirmArrival`（逐条 `InventoryService.applyPurchase`）。
 */
const ACCEPTANCE = Object.freeze({
  enabled: readFlag(process.env, 'SCAN_ACCEPT_WRITE_ENABLED', true),
  sessionDir: readString(
    process.env, 'SCAN_ACCEPT_SESSION_DIR', path.join(__dirname, '../../data/scan_arrival_sessions'),
  ),
  sessionIdPrefix: readString(process.env, 'SCAN_ACCEPT_SESSION_PREFIX', 'scan_accept'),
  // 「验收模式」留多久：她扫一批通常几分钟；留 30 分钟足够，过期就当没在验收（回工作台重来）。
  ttlMs: readInt(process.env, 'SCAN_ACCEPT_TTL_MS', 30 * 60 * 1000, { min: 60_000, max: 12 * 60 * 60 * 1000 }),
  // 一次验收最多记多少条扫码明细（防脚本刷）。
  maxScans: readInt(process.env, 'SCAN_ACCEPT_MAX_SCANS', 200, { min: 1, max: 2000 }),
  // 单条扫码明细的数量上限 / 默认值（页面默认 1，可改）。
  maxQuantity: readInt(process.env, 'SCAN_ACCEPT_MAX_QUANTITY', 99, { min: 1, max: 999 }),
  defaultQuantity: readInt(process.env, 'SCAN_ACCEPT_DEFAULT_QUANTITY', 1, { min: 1, max: 99 }),
  // 「实际金额」必填（既有业务口径，业务负责人 2026-10-08：「金额这个是必填的」）
  amountRequired: readFlag(process.env, 'SCAN_ACCEPT_AMOUNT_REQUIRED', true),
  // ⭐⭐ 2026-10-12（业务负责人口述版）：「用户点验收的时候，**先默认带出我们采购申请里的尺码和数量**。
  //    用户可以在给定的区域里直接修改，同时也可以自定义；自定义的时候同样支持扫码。」
  //    ⇒ 进验收就渲染那张**可编辑清单**（默认值 = 报货数量）。
  prefillEnabled: readFlag(process.env, 'SCAN_ACCEPT_PREFILL_ENABLED', true),
  // ⚠️ **还没拍板的那条**（她没回）：采购明细一条都没有的批次，要不要也能开工？
  //    业务语义没定（**款从哪来**不知道 ⇒ 加库存那一列没法填）⇒ **默认关**（= 现状：如实报"读不到明细"）；
  //    打开时也只是"页面能开 + 手输/扫码入口在"，真加行仍需**扫码带款**（不猜 ✗）。
  allowEmptyRows: readFlag(process.env, 'SCAN_ACCEPT_ALLOW_EMPTY_ROWS', false),
});

/**
 * 用户可见文案。占位符用 `{...}`，由 `fillText` 替换（**不留空段**）。
 * ⚠️ 手机上看，尽量短；页面上**不出现任何代码标识符**（在表单里给她的提示也一样）。
 *
 * ⭐⭐ **2026-10-10（业务负责人）：「只留能点、能做的事，删掉解释我怎么用的句子」** ——
 *   这里退场的是**说明句 / 用法标题**（逐条）：
 *     · `saleHeading`（「销售（可以连着扫，最后一起提交）」）—— 子 tab 上已经写着「销售」；
 *     · `replenishHeading`（「补货报单（勾选要补的尺码）」）—— 同上；
 *     · `fundsPendingNote`（「这一单先记了货、还没记钱…」）—— 解释既有口径，不是能点的事；
 *     · `replenishHint`（「打勾的尺码会生成报货订单；不填数量按 1 双算。」）—— 用法说明。
 *   ⚠️ **保留**的都是功能性的：字段标签 / 按钮 / 成功失败页的事实与**失败原因** /
 *     空本单与过期那两句（不填就会懵）—— 见下面每一条。
 */
const TEXTS = Object.freeze({
  // ── 销售表单 ──────────────────────────────────────────────────────────────
  draftHeading: '本单已加 {count} 双',
  draftItem: '{itemNo} · {size} 码',
  // 配品行在本单里的那一行（没有尺码、没有货号 —— 只有名称）。
  draftAccessoryItem: '配品 · {name}',
  sizeLabel: '尺码',
  sizePlaceholder: '选尺码',
  amountLabel: '实收金额',
  // ⚠️ 2026-10-16（⑫ · 她逐字：「**实收金额的输入框用户必须填写**……**不用做那个为空去单价的功能了**」）：
  //   改前逐字 `'实收金额（可不填）'` ＋ placeholder `'留空按货品单价'` —— 那两句**与真实校验不一致**
  //   ⇒ ①标签去掉「（可不填）」（**必填** ✓）；②placeholder **删掉"留空按货品单价"那个承诺** ✗
  //     （那条兜底**不做了** ⇒ 不给一个不会发生的提示 ✓）。依据 = 她 2026-10-16 逐字 ✓
  amountPlaceholder: '',
  // ⚠️ 2026-10-16：跳资金页前置判定**按她授权拆到第二刀（task-53）** ⇒ 当时加的两句文案
  //   一并**摘掉**（不许留孤儿 ✗；也不许再把旧列名字面量带回 config ✗ 见 `scanSaleTwoLayerMoney.test.js` 的 AC-11）
  // ⭐⭐ 2026-10-12（业务负责人拍板，逐字）：「② 「备注」还是「赠品」（表列名 / 页面标签）⇒ **赠品**」
  //    ⇒ **页面标签与表列名统一叫「赠品」**（改前页面写"备注"、表里写"赠品"，一列两个叫法）。
  //    ⚠️ 改的**只有这一个显示串**：语义键仍是 `gift`、落点仍是**销售主表·「赠品」**那一列
  //       （映射见 `v1BitableSchema.tables.salesEntry.fields.gift`）——读写行为一个字不动。
  //    ⚠️ 它**不是**"备注"：这一列从 2026-10-08 起就是**赠品**（`config/salesGift.js` 的合并规则）。
  giftLabel: '赠品（可不填）',
  addButton: '加入本单',
  // ⭐⭐ 2026-10-14（业务负责人裁决 ⓐ）：「**商定好的价格**」⇒ **每一双都要填「实收金额」**
  //   （现货、预订**同一处判** ⇒ 两边天然都必填 ✓）· ⚠️ **整单收款仍可全空** ✓
  //   ⇒ 「先记成待补充的信息单、之后去工作台补收款」这条老路**保留** ✓（她 2026-10-14 早先的话）
  lineAmountRequiredNote: '每一双都要填「实收金额」（那是和客户商定好的价格），填好再提交。',
  // ⭐⭐ 2026-10-14（业务负责人裁决 **ⓐ**，逐字）：「**只要本次付的金额小于累计的，那么差额
  //   都是未收款，包括本次付款为 0**」⇒ 差额 = `累计 − 本次已收` **> 0 就补一条**【未收款】，
  //   **不看档位**（未付 / 部分付都一样 ✓ 0 收款也补 ✓）。
  //   ⚠️ 改前逐字（本条注释当时写的是"ⓒ：填过至少一笔收款才补；一笔都没填 ⇒ 不补"）——
  //      **与代码不符**：`scanWriteService` 里那段是 `if (itemsCents - paidCents > 0)`，
  //      也就是 ⓐ（差额>0 一律补）。她 2026-10-14 覆盖了 2026-10-11 那句老口径，以本条为准。
  //   ⚠️ 那条【未收款】的形状**不由扫码侧拼**（走既有业务层 `SalesOrderManager.confirm({ owed })`）；
  //      这里只放**方式名**（不写死在逻辑里 ✓ 配置先行 ✓）。
  unpaidMethodLabel: '未收款',
  // ── ⭐ 2026-10-11（B）：配品（单独一行销售明细；不是校验项）────────────────
  //    「配品」选的是「其他配品」表里的**名称**；选中后它是**独立的一行销售明细**：
  //    `配品` 有值、`编号`/`尺码` 留空、**实收金额单列**。
  accessoryLabel: '配品',
  // 不选配品时下拉里的那一项（空 value = 不加这一行）。
  accessoryPlaceholder: '不加配品',
  // ⭐ 配品行与鞋**同一条规则**（她 2026-10-11 未单独定 → 本轮按"与鞋同规则"实现，
  //    取舍已写在交付报告里）：它也有「实收金额」，留空同样兜底读「其他配品.单价」。
  accessoryAmountLabel: '配品实收金额（可不填）',
  accessoryAmountPlaceholder: '留空按配品单价',
  accessoryAddedBanner: '已加入本单（{count} 项）',
  submitButton: '提交这一单',
  // ⭐ 2026-10-12（她的意见：一单一笔居多）——按钮上直接写**几双**，一眼就知道这一单里有几双。
  //    ⚠️ 主按钮那颗就是"选好尺码直接提交"（一单一笔 = 选尺码 + 提交，**两下**）；
  //       多笔要显式点【➕ 还要加一双】。
  submitButtonCount: '✅ 提交这一单（{count} 双）',
  addAnotherButton: '➕ 还要加一双',
  // 每件实收**可以留空**（她："不然太费劲"）—— 就写一句事实，不写说明书。
  clearButton: '清空本单',
  // ── ⭐⭐ 总单层：每件实收（逐行）+ 多笔收款 ────────────────────────────────
  // ⚠️ 提交表单里那个「每件实收」输入框是**每行一个**的（同名 `line_amount` 重复出现），
  //    下面这两个是它的 aria-label / placeholder（手机读屏与占位，不是说明书）。
  lineAmountLabel: '这一双实收',
  accessoryLineAmountLabel: '这一件实收',
  lineAmountPlaceholder: '实收',
  // ⭐⭐ 2026-10-11（最终口径）：**「付款情况」（整单）** 三档控件 —— 组名 + 三个选项 + 实付输入。
  paymentStatusLabel: '付款情况',
  // ⚠️ 这三个字面量 = `PAYMENT_STATUS` 的取值本身（唯一真源），不另抄一份。
  paymentStatusOptions: Object.freeze([
    Object.freeze({ value: PAYMENT_STATUS.full, label: PAYMENT_STATUS.full }),
    Object.freeze({ value: PAYMENT_STATUS.partial, label: PAYMENT_STATUS.partial }),
    Object.freeze({ value: PAYMENT_STATUS.unpaid, label: PAYMENT_STATUS.unpaid }),
  ]),
  paidAmountLabel: '实付多少',
  paidAmountPlaceholder: '实付金额',
  paymentLabel: '收款方式',
  paymentAmountLabel: '收款金额',
  paymentAmountPlaceholder: '金额',
  // 预置行里那个"空"选项（不填金额 = 这一行不用）。
  paymentNoneOption: '不记这笔',
  // ⭐ **核心校验的人话**（她 2026-10-11：「必须相等，所以系统需要校验！」）：
  //    说清①两边各是多少 ②哪边多了/少了、差多少 —— 她照着改一下就能再提交。
  //    🔴 这条**只在「全付」那一档出现**（"只有全付时必须相等"）。
  amountMismatchBody: '每件实收合计 {items}，收款合计 {payments}；{side}，请核对后再提交。',
  amountMismatchShort: '收款比每件实收少 {diff}',
  amountMismatchOver: '收款比每件实收多 {diff}',
  amountMismatchNoItems: '每件实收还没填（差 {diff}）',
  // ⭐ 部分付那一档的两句人话（同样说清数额，指得出该改哪儿）。
  partialAmountMismatchBody: '实付填的是 {paid}，收款行加起来是 {payments}：两边要一样，请核对后再提交。',
  partialAmountMissingBody: '「部分付」要填一下实付多少（收款行合计 {payments}）。',
  paymentStatusInvalidBody: '「付款情况」没认出来（可能放太久了）：请刷新这一页再操作。',
  paymentRowIncompleteBody: '有一笔收款填了金额、还没选收款方式，请补一下。',
  // ⭐⭐ 2026-10-12（业务负责人真机口径，逐字）：「我希望**点击提交之后直接提示"您的提交已成功"**
  //    就行，**页面跳转到提交成功页**。在这个页面上可以提示"**再录一单**"类似的信息，
  //    给一个链接让我能回到扫码页。」
  //    ⇒ 这一句就是**成功页的 H1**（逐字，一个字都不许改）；
  //      「再录一单」那颗链接的文案/回跳目标在下面 `submittedRecordAnother*`（链接地址由路由给）。
  //    🔴 **只在真的写成功时出现**：建单失败 ⇒ 照旧报错页；建单成功但后面某步没写完 ⇒
  //      走 `partialFailed*`（**不许显示成功**）。
  submittedTitle: '您的提交已成功',
  submittedBody: '销售单号 {orderNo}，共 {count} 双。',
  // ⭐ 成功页上那颗「回扫码页」的链接（业务负责人点名要的出口）。
  submittedRecordAnother: '再录一单',
  submittedRecordAnotherHint: '再扫一次标签，就能接着录下一单。',
  // 结果页上逐行列出来的事实（单号 / 双数 / 收款）。
  submittedOrderLine: '销售单号：{orderNo}',
  submittedDetailLine: '明细：{count} 双（每双一行）',
  submittedNextHint: '接着扫下一款就可以开新的一单。',
  // ⭐ 2026-10-12：结果页给她"下一步能做什么"（她自己问过"那我接下来去哪补钱"）。
  submittedNextSteps: '要补实收 / 收款：去工作台「销售」那一页。',
  // ⭐⭐ 2026-10-11 晚：她**显式选了「全付」但一笔收款都没填**时给的一句人话。
  //    ⚠️ **只提示、不拦整单**（按「未付」落库：只记货、钱进待补充）—— 她真机就是被
  //       "全付必须相等"卡住的；"填了钱才算账"这条不能反过来变成"没填钱就不许记账"。
  //    ⚠️ 这句话**必须指得出能做的事**（选未付 / 补收款），不是"校验失败"四个字。
  fullWithoutPaymentsNote: '选「全付」要填收款金额；钱还没收就选「未付」。',
  // 🔴🔴 2026-10-12（真机丢钱之后加的兜底）：她**显式选了「全付」**，却一笔收款都没填、
  //    每件实收也全空 ⇒ 这一单**哪儿都没钱**，与"全付"直接矛盾 ⇒ 拦住 + 人话。
  fullWithoutMoneyBody: '选「全付」要填收款方式 + 金额；还没收钱就选「未付」，或者把每件的「实收金额」填上。',
  submittedFundsBody: '收款也记上了，共 {paid} 元。',
  // ⭐ 2026-10-12（她自己被这句话吓到过）：**不许**出现"没有重复写入"这种会被读成
  //    "没写进去"的话；重复提交就是**同一件事的第二次点击**，语气要平：
  submittedAgainTitle: '✅ 这一单刚才已经交过了',
  submittedAgainBody: '销售单号 {orderNo}。就是这一单，不用再点。',
  // ⭐ 2026-10-11（A）：现货行"提交即交付 + 扣库存"**没扣成**时的如实结果页。
  //    她要知道的是三件事：单子已经记上了、哪几双没扣成、怎么办 —— 一句说明书都不写。
  stockFailedTitle: '这一单记上了，库存没扣成',
  stockFailedBody: '{failed} 双没扣成：{reason}',
  stockFailedRetryHint: '照上面的原因处理一下，再点一次【提交这一单】就能接着扣（不会重复记账）。',
  // ⭐⭐ 2026-10-12：**建单成功、后面某一步（明细 / 收款 / 进度）没写完** ⇒ 如实说"半成"。
  //    🔴 这一页**绝不许显示"提交已成功"**（她会以为钱货都落了）；
  //    🔴 也**不许**跟"一个字都没写"混为一谈（主表那条记录是真的落库了）。
  //    判据用的是**既有**那一条：会话里已经落了主表 record_id（= 重试接着写的那条判据）。
  //    怎么出去：回扫码页（链接）再点一次提交 —— 会接着**同一张单**写，不会重复记账。
  partialFailedTitle: '单子记上了，后面还有一步没写完',
  partialFailedBody: '销售单号 {orderNo}：明细 / 收款这一步没写成功，请回扫码页再点一次【提交这一单】——会接着同一张单写，不会重复记账。',
  partialFailedRetryHint: '如果反复不成功，请把这一页截图发给运营（单号在上面的明细里）。',
  // 「刚加入本单」那一句：**极简**（她 2026-10-11 要的"一句极简反馈"）。它渲染在
  // **每个领域页顶部的本单条**里（见 `views/scanPageRenderer.js` 的 `draftBarHtml`），
  // 加完一双无论停在哪个领域都看得见。
  lineAddedBanner: '已加入本单（{count} 双）',
  // ── 补货表单 ──────────────────────────────────────────────────────────────
  replenishQuantityLabel: '数量',
  // ⭐ 2026-10-14 晚（她逐字）：「**生成采购申请的文字变为生成报货订单**」⇒ **只改文案** ✓
  //   🔴 行为/接口/幂等/落表**一字不动** ✗
  replenishButton: '生成报货订单',
  replenishDoneTitle: '采购申请已生成',
  replenishDoneBody: '批次号 {batchNo}，共 {count} 条明细。',
  replenishBatchLine: '报货批次号：{batchNo}',
  replenishDetailLine: '采购申请：{count} 条',
  replenishAgainTitle: '这次补货已经提交过了',
  replenishAgainBody: '批次号 {batchNo}，没有重复写入。',
  // ── 退货表单（与补货同形；只留能点、能做的事）──────────────────────────────
  returnButton: '生成采购退货',
  returnDoneTitle: '采购退货已生成',
  returnDoneBody: '批次号 {batchNo}，共 {count} 条明细。',
  returnBatchLine: '报货批次号：{batchNo}',
  returnDetailLine: '采购退货：{count} 条',
  returnAgainTitle: '这次退货已经提交过了',
  returnAgainBody: '批次号 {batchNo}，没有重复写入。',
  // ⭐ 超库存的**如实回报**（她说退 5 双、库存只有 3 双 ⇒ 退 3 双 + 把差额说清）。
  //    这是"事实 + 为什么"，不是用法说明 ⇒ 属于保留的那一类文案。
  returnShortfallLine: '{shortfall} 双没退成：{sizes} 现在库存不够。',
  returnStockEmptyBody: '这些尺码现在库存里一双都没有，退不了（要退 {declared} 双）。',
  // ⚠️ 内部错误（库存引擎抛的原文里带 record_id）**不许回显** ⇒ 命中它时给这一句。
  returnStockChangedBody: '退的时候库存刚好被改动，这次没退成：请再点一次【生成采购退货】。',
  returnNoneBody: '至少要勾一个要退的尺码。',
  returnTooManyBody: '一次最多勾 {max} 个尺码，请分两次提交。',
  // ── ⭐⭐ 2026-10-14 晚：**整单金额**（补货 / 退货**共用这一份**）─────────────────
  //   她的原话（逐字）：「**退货整单金额（必填），与补货同一套配置**」
  //   ＋「**只写一个整单金额**（一次填一个总额，**和补货一样**～）」。
  //   ⇒ 一个标签 / 一个占位 / 一句人话**管两边**（改文案只改这里 ✓ 不写两套 ✗）。
  //   ⚠️ 标签里直接写「（必填）」—— 与验收那条「实际金额（必填）」同一条规矩：
  //      必填要在页面上**看得出来**（她第一次被拒就是因为看不出来）。
  purchaseAmountLabel: '整单金额（必填）',
  purchaseAmountPlaceholder: '这一单的总额',
  // 空 ⇒ **400** 时那张页面的 H1：先让她一眼看到**差什么**（不是一句泛泛的"没提交成功"）。
  purchaseAmountMissingTitle: '整单金额还没填',
  // 一行说清"填什么 / 怎么填"（一次一个总额，不按行分填）——**指得出能做的事**。
  purchaseAmountMissingBody: '这一单要填「整单金额」——填一个总额就行，不用按行分填；填好再提交。',
  // 那张页面上的"回上一页"链接（不然她只能靠浏览器的返回键）。
  purchaseAmountBackLabel: '回上一页填整单金额',
  // ⭐⭐ 2026-10-15（③ 写入 · 她裁决 ⓐ「复用「实际金额」」）：**不是数字** ⇒ 400 + 这一句。
  //   为什么这一刀才有：那个数现在要**落进数字列** `purchaseOrderBatch.actualAmount`
  //   （`config/v1BitableSchema.js` 的 `actualAmount: '实际金额'`）⇒ **放它过去就是"页面填了、
  //   表里没有" = 假成功** ✗（她最在意的一条）⇒ 当场拦住，人话指得出怎么改 ✓。
  //   ⚠️ 判据是**收紧**（原来只判"填没填"），**不是放宽** ✓。
  purchaseAmountInvalidTitle: '整单金额要填数字',
  purchaseAmountInvalidBody: '「整单金额」请填一个数字（例：399），不用带单位；填好再提交。',
  // ⭐⭐ 2026-10-15：退货那一批的**整单金额没写进表**时的如实人话（**不许假成功** ✗）。
  //   走到它 = 批次行已经建了、金额没落 ⇒ 这一次**不算成功**；她再点一次会**接着这一批写**
  //   （同一把 `submitKey` ⇒ 不重复退、不重复扣库存 ✓）。
  // ⭐⭐ 2026-10-15（⑰b-1 · 她逐字「工作台显示「**未完成，可点重试**」」）：
  //   **工作台「续写 / 重试」入口**的四句人话（全部可配 ✓ 不编中文在路由里 ✗）。
  //   🔴 一律**如实**：没有待续的单 / 单号对不上 / 还是没写成 ⇒ 各自的人话（**绝不假成功** ✗）。
  saleRetryNoPendingBody: '这一单没有要接着写的东西（可能已经写完了）：刷新一下看看最新状态。',
  saleRetryMismatchBody: '要重试的那一单和刚才提交的不是同一单：刷新一下再点。',
  saleRetryDoneBody: '已经接着写完了。',
  saleRetryFailedBody: '还是没写成功：请稍后再点一次重试。',
  purchaseReturnAmountWriteFailedBody: '这一批的「整单金额」没写进表里，这次没算成功：请再点一次【生成采购退货】——会接着这一批写，不会重复退。',
  // ── ⭐⭐ 扫码验收（方案A；只留能点、能做的事 + 事实）─────────────────────────
  // ⭐⭐ 2026-10-12（业务负责人真机，逐字）：「提交这一单我点了好多次，因为点完之后页面
  //    **一直没有任何反应**，我还以为没接收到……而且我现在还收到了 504 网关超时的提示」
  //    ⇒ 提交按钮点下去**立刻置灰**并换成下面这句；服务端慢的时候还要显示"已 N 秒"（纯前端计时）。
  submitSubmitting: '正在提交，请不要重复点…',
  submitSubmittingElapsed: '正在提交，请不要重复点…（已 {seconds} 秒）',
  acceptModeTitle: '扫码验收',
  // 本单条：**已验收 N 双 / 应到 M 双**（她点名要的那一行）。
  acceptSummary: '已验收 {scanned} 双 / 应到 {expected} 双',
  acceptBatchLine: '报货批次号：{batchNo}',
  acceptAddButton: '加入本次验收',
  acceptAddedBanner: '已加入本次验收（{scanned} 双）',
  acceptDuplicateBanner: '这一双已经记过了',
  acceptNotInBatchBody: '这一双不在本批，没有记。',
  acceptFinish: '完成验收',
  // ⭐⭐ 2026-10-12 21:20：金额**必填**要在页面上看得出来（她第一次提交被拒就是因为看不出来）。
  acceptFinishAmountLabel: '实际金额（必填）',
  acceptFinishSubmit: '确认完成验收',
  acceptNoScansBody: '还没扫到任何一双：先扫一双，再点【完成验收】。',
  // ⭐⭐ 2026-10-12（她的口述版）：「先默认带出我们采购申请里的尺码和数量」——
  //    那一块就是这张清单：每个报货尺码一行、数量**默认 = 报货数量**、可改。
  acceptRowsTitle: '这次要核对的尺码和数量',
  // ⭐⭐ 2026-10-12 21:11：有批次号、但这一批**一条明细都没有** ⇒ **明确说清**（不许留一张空白页）。
  acceptEmptyDetailBody: '这一批没有明细：可以直接在下面手输尺码/数量，也可以扫标签加一款。',
  acceptRowsHint: '数量填实际到货的；没到的改成 0 就行。',
  acceptRowSizeLabel: '{size} 码',
  acceptCustomTitle: '自定义加一行（没报但到了的）',
  acceptCustomSizePlaceholder: '尺码',
  acceptCustomQuantityPlaceholder: '数量',
  acceptCustomAddLabel: '加上这一行',
  // 扫标签那条路（码里带着是哪一款）——本批有多个款 / 一条明细都没有时，**不猜款**，让她扫码。
  acceptCustomScanLabel: '也可以扫标签加一款',
  acceptCustomProductNeededBody: '这一批里有多个款（或一条明细都没有）：自定义请用**扫标签**加（标签里带着是哪一款）。',
  // ⭐⭐ 2026-10-12（方案 A）：「系统把 40、41 列出来（标注"未报货"）⇒ 你**点一下就加到货**」
  acceptUnreportedTitle: '没报货的尺码',
  acceptUnreportedBadge: '未报货',
  acceptUnreportedAddLabel: '加到货',
  acceptUnreportedRemoveLabel: '取消',
  // 没有"款"可归时不列（列了也没用）——给她一句"先扫这一款的标签"。
  acceptUnreportedNoProductBody: '先扫这一款的标签，就能看到它没报货的尺码。',
  acceptDoneTitle: '这批已验收入库',
  acceptDoneBody: '批次号 {batchNo}，实际到货 {scanned} 双。',
  // ⭐⭐ 2026-10-12 21:20：成功后**明确成功页**（不许沉默 —— 她"一直点"就是因为点完没交代）。
  // 她拍的成功页那句（2026-10-12）；`acceptDoneTitle` 留给别的口径用，不动。
  acceptDoneHeading: '验收已完成',
  acceptDoneQuantityLabel: '实际数量',
  acceptDoneAmountLabel: '实际金额',
  acceptDoneBackLabel: '回到未到货批次',
  acceptAgainBody: '批次号 {batchNo}，已经验收入库过了，没有重复入库。',
  acceptNoSessionBody: '这次验收已经结束了：回上面【验收】领域重新选一个批次（或填批次号）就能继续。',
  // ⭐⭐ 2026-10-12（她真机："报单之后点验收 ⇒ 就提示这个，我不知道啥意思"）：
  //    改前这句是「…**回【验收】领域**选一个批次（或填批次号）再进来。」—— 而她**就是**从
  //    【验收】领域进来的；落地页上又**没有输入框**（"或填批次号"做不到）⇒ **自相矛盾** ✗。
  //    现在：`GET /accept`（无 batch）**直接给自助块**（列未到货批次 + 手输兜底），
  //    这句只剩"内部兜底"用（真走到这里说明连 form 都没渲染出来）⇒ 改成**指得出眼前能做的事**。
  acceptBatchMissingBody: '这一页没带报货批次号：请在下面选一个未到货的批次，或直接输入批次号。',
  acceptRowsUnreadableBody: '这一批的采购明细读不到，暂时不能验收：稍后再进【验收】重试。',
  acceptDuplicateRowsBody: '这一批里同一款同一码有两行申请，先在采购群核对一下再验收。',
  acceptTooManyScansBody: '这一次记的扫码明细太多了，请先完成验收。',
  acceptQuantityInvalidBody: '数量要填 1 ~ {max} 之间的整数。',
  // 本地草稿里那句"到货说明"= **扫码事实的复述**（她不用写；表里也没有这一列）。
  acceptanceTextTemplate: '扫码验收：{detail}（共 {scanned} 双）',
  // ── 失败（都要在**页面上**说清楚，不许只写日志）──────────────────────────
  failedTitle: '这一步没成功',
  failedRetryHint: '可以照上面那句话改一下再点一次；反复失败请把这一页截图发给运营。',
  // 业务层抛出来的中文业务话原样给她看（例：「本次收款超过本单实收金额」）。
  businessFailedBody: '没提交成功：{reason}',
  // 命中 `sale.unsafeErrorMarkers` 的内部错误：只给这一句，原文只进日志。
  internalFailedBody: '刚才是系统这边没处理成功，请再点一次；反复失败请把这一页截图发给运营。',
  tooManyLinesBody: '一张单最多加 {max} 双，请先提交这一单再继续扫。',
  writeDisabledTitle: '这个功能现在关着',
  writeDisabledBody: '扫码下单 / 补货报单暂时没有开启，请联系运营。',
  sessionEmptyBody: '本单还没有明细：先选尺码点「加入本单」，再点「提交这一单」。',
  sessionExpiredBody: '这一页放太久了：请点【清空本单】重新开始这一单。',
  sizeMissingBody: '请先选一个尺码。',
  sizeUnknownBody: '这个尺码不在「尺码管理」里，请刷新这一页重新选。',
  amountInvalidBody: '实收金额要填数字（例：399 或 399.5）。',
  // ⛔ 2026-10-11（方案甲）两句"没有单价 ⇒ 请填"已随"读单价兜底"一起退场：
  //    没填实收**不再是失败**（那一列留空，她事后再补）⇒ 留着它们就是**说反了**。
  // ── 配品（B）：三条人话 ────────────────────────────────────────────────────
  // ⚠️ 配品**不是校验项**（不选不报错）；下面两句只在"选了配品但缺东西"时才出现。
  accessoryMissingBody: '请先选一件配品。',
  accessoryUnknownBody: '这件配品不在「其他配品」里，请刷新这一页重新选。',
  accessoryAmountInvalidBody: '配品实收金额要填数字（例：39 或 39.9）。',
  // ⭐⭐ 总单层：多笔收款的人话。
  //    ⚠️ 「每件实收」不是数字时复用上面的 `amountInvalidBody` / `accessoryAmountInvalidBody`
  //      （同一个字段、同一个说法；不为第二个入口再抄一句）。
  paymentAmountInvalidBody: '这次收款金额要填数字（例：100 或 100.5）。',
  quantityInvalidBody: '数量要填 1 ~ {max} 之间的整数。',
  replenishNoneBody: '至少要勾一个要补的尺码。',
  replenishTooManyBody: '一次最多勾 {max} 个尺码，请分两次提交。',
  replenishAgainBody: '这一页已经提交过了：刷新这一页可以再补一次。',
  // 动作名不认识（老页面 / 手改表单）：也要给她一句人话，不静默。
  unknownActionBody: '这一页上的按钮我认不出来：请刷新这一页再操作。',
  // ⭐ 那句「可能放太久了」在她真机上**误导**（页面只渲染了 41 秒 ✗）⇒ 缺/空 action 单独一句更准的。
  unknownActionMissingBody: '这一页没带上要做什么：请刷新这一页再操作。',
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
  // 2026-10-13 interrupted (account written, draft not cleared): detect + clear each logs one line
  interruptedDetected: 'scan.sale.interrupted_detected',
  interruptedCleared: 'scan.sale.interrupted_cleared',
  saleSubmitting: 'scan.sale.submitting',
  saleSubmitted: 'scan.sale.submitted',
  // ⭐⭐ 2026-10-12：**一条**分阶段的提交耗时汇总（她真机被卡住 / 收过 504 网关超时）。
  //    与扫码取数那条 `scan.lookup.timing` 同一个形状：一查日志就知道**卡在哪一步**。
  saleTiming: 'scan.sale.timing',
  // ⭐⭐ 2026-10-15（⑰ 异步）：后台那一跑的**正面/负面证据**（她问"写完了吗"时按它 grep ✓）
  // 排队那一下（"单号已经出了、余下转后台"）
  saleBackgroundQueued: 'scan.sale.background_queued',
  saleBackgroundDone: 'scan.sale.background_done',
  saleBackgroundFailed: 'scan.sale.background_failed',
  // ⭐⭐ 2026-10-13（验收提速）：**一条**验收的分阶段耗时汇总（与销售那条同形状）。
  //    为什么要有它：真账量出「每批 5 码 = 143.9 秒，其中逐码"库存+流水" = 119.5 秒（83%）」——
  //    没有分段就打不出"卡在哪一步"，也就证不了批量写到底省了多少。
  //    分段：`session_ms`（读会话）/ `inbound_total_ms`（confirmArrival 整段）/
  //          `inventory_ms`（其中"加库存"那一段）/ `batches_ms`（② 待验收列表那次读）。
  //    ⚠️ 由**服务层**自造 timing 并透传（见 `scanArrivalService.finish`）；本层只放事件名。
  acceptTiming: 'scan.accept.timing',
  // ⭐⭐ 2026-10-12：**建单成功、后面某一步没写完**（明细 / 收款 / 进度抛错）。
  //    warn 级、**不静默**：页面上同时给她一张"半成"的如实结果页（见 texts.partialFailed*）。
  partialFailed: 'scan.sale.partial_failed',
  saleReused: 'scan.sale.reused',
  // ⭐⭐ 2026-10-11：**每件实收合计 ≠ 收款合计**（她：「必须相等，所以系统需要校验！」）——
  //    这条日志带两边的合计与差额，她说"我明明填对了"时按它一眼对得出来。
  //    ⚠️ 命中它 = **一个字都没写库**（阻拦发生在建主表之前）。
  amountMismatch: 'scan.sale.amount_mismatch',
  // ⭐ 2026-10-11（A）：现货行"提交即交付 + 扣库存"**没扣成**的如实记录
  //    （页面上同时会告诉她一句人话；这条日志是排查口）。
  stockFailed: 'scan.sale.stock_failed',
  replenishSubmitting: 'scan.purchase.submitting',
  replenishSubmitted: 'scan.purchase.submitted',
  // ⭐ 2026-10-12：她换了货号后用旧键提交 ⇒ **不当重放**（日志要能看出这次是新提交）
  replenishRegenerated: 'scan.purchase.regenerated',
  replenishReused: 'scan.purchase.reused',
  // ⭐ 退货（与补货同形的三条 + 差额与库存侧两条正向证据）
  returnSubmitting: 'scan.purchase_return.submitting',
  returnSubmitted: 'scan.purchase_return.submitted',
  returnReused: 'scan.purchase_return.reused',
  returnShortfall: 'scan.purchase_return.shortfall',
  returnStockApplied: 'scan.purchase_return.stock_applied',
  // 退货链路的另外三条正向证据（计划冻结 / 批次行 / 出图失败——出图失败不阻塞主流程）
  returnPlanFrozen: 'scan.purchase_return.plan_frozen',
  returnBatchCreated: 'scan.purchase_return.batch_created',
  returnImageFailed: 'scan.purchase_return.image_failed',
  // ⭐⭐ 2026-10-14 晚：**整单金额没填**（补货 / 退货**共用这一条**）—— 命中它 =
  //   **她填漏了**（不是系统写失败 ✗）且**一个字都没写**（不建批次 / 不写明细 / 不动库存 ✓）。
  //   ⚠️ 与 `failed`（写失败）**分开**：原因不同、修法也不同（她补一个数字 vs 我们去查库），
  //      一 grep 就分得清 —— 与 `unknownWriteAction` 那条同一个理由。
  purchaseAmountRequired: 'scan.write.purchase_amount_required',
  // ⭐ 扫码验收（方案A）的正向证据
  acceptStarted: 'scan.accept.started',
  acceptLineAdded: 'scan.accept.line_added',
  acceptNotInBatch: 'scan.accept.not_in_batch',
  acceptDuplicate: 'scan.accept.duplicate',
  // ⭐⭐ 2026-10-12：清单被整表覆盖（她改完数量 / 加了自定义行）——"实际到货几双"的可 grep 证据。
  acceptRowsSet: 'scan.accept.rows_set',
  acceptFinishing: 'scan.accept.finishing',
  acceptFinished: 'scan.accept.finished',
  acceptReused: 'scan.accept.reused',
  acceptFailed: 'scan.accept.failed',
  failed: 'scan.write.failed',
  // ⭐⭐ 2026-10-12（她真机：`POST /MK31-1|咖色|B` ⇒ **400 / 1ms**、周围**一条日志都没有** ✗）：
  //   "写操作按钮的 action 认不出来 / 没带上" —— **唯一**能定位这类 400 的日志（按它 grep ✓）。
  unknownWriteAction: 'scan.write.unknown_action',
  sessionStarted: 'scan.session.started',
  sessionExpired: 'scan.session.expired',
});

/**
 * ⭐⭐ 2026-10-15（⑨b-2）：`scan.sale.timing` 的**阶段标记**（`phase`）—— **配置先行** ✓ 不散写字符串 ✗。
 *
 * 为什么要有它：异步之后**同一次提交被劈成两段** ——
 *   · `request` 段：她点按钮那一次（会话/校验 + 建主表 + 单号 + 确认状态）⇒ **单号一出立刻回**；
 *   · `background` 段：**后台那一跑**（同一把 `submitKey` 的续写：明细 / 收款 / 库存）。
 * 🔴 硬口径（业务负责人 + 本仓《长期工程原则》）：「**每个关键流程节点都要有日志和可排查路径**」
 *    ⇒ **转后台不等于看不见** —— 后台那一段**照旧**打一条**同一事件名** `scan.sale.timing`
 *      （`detail_ms` / `stock_ms` 那些每段耗时照旧在 ✓），只是多一个 `phase` 把两段分开。
 *    ⚠️ **事件名不新开**（她按 `scan.sale.timing` grep 一次就能把两段都收齐 ✓）。
 * ⚠️ 取值可配（`SCAN_SALE_TIMING_PHASE_*`）：换一个叫法**不必改代码** ✓。
 */
const TIMING = Object.freeze({
  phase: Object.freeze({
    request: readString(process.env, 'SCAN_SALE_TIMING_PHASE_REQUEST', 'request'),
    background: readString(process.env, 'SCAN_SALE_TIMING_PHASE_BACKGROUND', 'background'),
  }),
});

/**
 * ⭐⭐ 2026-10-12：**只读引用数据的进程内短缓存**（提交链路提速 —— 她真机收过 504 网关超时）。
 *
 * 起因（线上量级实测）：一趟"提交这一单"会打 **47 次飞书调用**，其中相当一部分是
 * **同一张只读引用表读了 5 遍 / 2 遍**（`尺码管理` ×5、`货品信息` ×2、`行为管理` ×2 …）——
 * 而它们在**同一次提交里**、彼此**逐字相同**。
 *
 * 🔴 **白名单只放"只读引用表"**（改一次要很久才生效、且与"这一次写"无关的东西）。
 *    名单**不许**出现任何**写入判据**的表：
 *      · 销售主表（`salesEntry`，单号分配 / 撞号复查）—— 不缓存 ✗
 *      · 销售明细 / 收款记录（`salesDetail` / `paymentRecord`，**幂等回查**）—— 不缓存 ✗
 *      · 实时库存 / 库存流水（`liveInventory` / `inventoryLedger`，**扣减判据**）—— 不缓存 ✗
 *    ⇒ 缓存**不可能**影响幂等、金额、库存判据或四个状态目标的取值。
 * ⚠️ 写方法（create / update / delete）**一律不经过缓存**（原样透传）。
 * ⚠️ 实现见 `services/scanWriteService.js` 的 `createReadOnlyReferenceCache`。
 */
const READ_CACHE = Object.freeze({
  enabled: true,
  // 短 TTL：宁可不命中，也不让"她刚改的配置"在页面上迟迟不生效。
  ttlMs: 30000,
  tables: Object.freeze(['sizeManagement', 'product', 'behavior', 'paymentMethod']),
});

const SCAN_WRITE = Object.freeze({
  route: ROUTE,
  actions: ACTIONS,
  fields: FIELDS,
  session: SESSION,
  sale: SALE,
  // ⭐⭐ 2026-10-14 晚：**整单金额**（补货 / 退货**共用一套**：一个字段名 + 一个必填开关）。
  purchaseAmount: PURCHASE_AMOUNT,
  replenish: REPLENISH,
  purchaseReturn: PURCHASE_RETURN,
  // ⭐⭐ 只读引用缓存（白名单 + TTL；写与写入判据一律不经过它）
  readCache: READ_CACHE,
  // ⭐ 扫码验收（方案A）：会话 + 数量上限 + 「实际金额」必填
  acceptance: ACCEPTANCE,
  texts: TEXTS,
  events: EVENTS,
  // ⭐⭐ 2026-10-15（⑨b-2）：`scan.sale.timing` 的两段标记（`request` / `background`）—— 配置先行。
  timing: TIMING,
});

/** `{name}` 占位符替换（与 `config/scanPage.js` 同一套规则：缺的值用 `—` 顶，不留空段）。 */
const fillText = (template, values = {}, missing = '—') => String(template ?? '')
  .replace(/\{(\w+)\}/g, (match, key) => {
    const value = values[key];
    return value === undefined || value === null || value === '' ? missing : String(value);
  });

module.exports = {
  SCAN_WRITE,
  READ_CACHE,
  ROUTE,
  ACTIONS,
  FIELDS,
  SESSION,
  SALE,
  PAYMENT_STATUS,
  PURCHASE_AMOUNT,
  REPLENISH,
  PURCHASE_RETURN,
  ACCEPTANCE,
  TIMING,
  TEXTS,
  EVENTS,
  fillText,
};
