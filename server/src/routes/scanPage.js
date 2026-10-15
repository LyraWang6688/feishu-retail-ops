/**
 * 扫码页路由：**`GET /s/:number`**（`number` = 「编号」= `货号|颜色|类别`，URL 编码过的）
 * ＋ **`POST /s/:number`**（页面上那两个**写入口**：销售建单 / 补货报单）。
 *
 * 这一页就是标签二维码指向的那个地址 —— 二维码内容的唯一真源是
 * `config/tagQrCode.js` 的 `scanUrl.urlTemplate`（`https://hm.bamamei.online/s/{编号}`），
 * 本文件**不抄那份模板**，只用 `config/scanPage.js` 里的挂载点与路径段。
 *
 * 挂载与准入（**先读代码再动**的结果）：
 *   · `app.js` 把本 router 挂在 **`SCAN_PAGE.route.basePath`（`/s`）** 上，
 *     **不在 `/api/*` 之下** —— 那一段被 `API_KEY`（`x-api-key`）保护，
 *     而扫码的人是**手机浏览器直接打开**的页面，没有那个头，挂过去必被挡；
 *   · 准入用的是**工作台那一道**闸门（`routes/workbench.js` 里的 `requireWorkbenchAccess`，
 *     两处共用**同一个函数**）：认证没启用 503 / 未登录 302 去登录 / 白名单外 403，
 *     **没有新开一套鉴权**；
 *   · `GET` 是**只读**的（service 只 `listAll` / `listByFilter`）；
 *   · `POST` 是**写入口**（2026-10-08 加），但本文件里**没有一行写库代码**：
 *     全部交给 `services/scanWriteService.js`，而它只调**既有业务层**
 *     （销售入账 / 采购申请发布）。字段、动作名、文案、默认收款方式、幂等键前缀
 *     全在 `config/scanWrite.js`。
 *
 * 🔴 入口隔离（`docs/entry-isolation-2026-10-08.md`）：扫码入口与群聊入口**只共享业务层**。
 *   会话在 `data/scan_sessions/`（**自己的**），一个字都不碰 `data/lark_mvp_tasks/`；
 *   输入是页面表单（**不经过**任何 AI 解析）；出口是这一页的响应（**不回群、不 patch 卡片**）。
 *
 * 「扫码即用」（2026-10-08 下半场加）：
 *   ⚠️ 她是在**手机浏览器**上扫标签二维码的 —— 手机里没有 `hm.bamamei.online` 的登录
 *   cookie，原来那一版会把工作台那套 **401 JSON** 甩到她脸上。
 *   现在：**未登录 → 302 去 `/api/auth/feishu/start?next=<刚才那一页>`**，登录成功后
 *   自动回到刚才那个扫码页（逻辑与白名单在 `routes/feishuWebAuth.js` +
 *   `config/scanAuthRedirect.js`）。
 *   🔴 **共享闸门 `requireWorkbenchAccess` 的默认语义一个字都没改**
 *   （未启用 503 JSON / 未登录 401 JSON / 白名单外 403 JSON）—— 工作台的 fetch 接口
 *   与既有哨兵用例都钉着它。这里只在**扫码页这一个 router** 上把"未登录"那一种情况
 *   提前接住换成 302，另外两种原样交给下面那道共享闸门。
 *   ⚠️ 作用域是**整个扫码 router**（`/s/` 与 `/s/:number` 都算"扫码页"）：
 *   没登录的人先登录再看页面，页面本身（200/400/404/503）对已登录的人**逐字不变**。
 */
const express = require('express');
const { V1BitableGateway } = require('../services/v1BitableGateway');
const { sizesForCategory, parseNumberSegments, createScanPageService } = require('../services/scanPageService');
const { createScanWriteService } = require('../services/scanWriteService');
// ⭐⭐ 2026-10-16（task-52 · ②-⑭ · 业务负责人**逐字**）：
//   「**补货、退货还有验收，它都是异步的**……都是一句『**已提交成功，数据会更新**』」
//   ⇒ 补货 / 退货改成 **先回成功页（200）⇒ 「后台那一跑」写库**。
//   后台件是**共用件**（`services/purchaseWriteBackgroundService.js`，已合在 main ✓）——
//   🔴 本文件**只接线**：`runRest` 接的就是**既有**写入口（**不新开写库路径** ✗）。
const { createPurchaseWriteBackgroundService } = require('../services/purchaseWriteBackgroundService');
// ⭐⭐ 2026-10-16 A2a ③：**候选收款方式改读表**（她 2026-10-14 逐字：「**付款方式用交易方式管理，
//    可选择**」）—— 只读 + TTL 缓存的那份 service（`services/paymentMethodsService.js`）。
const { createPaymentMethodsService } = require('../services/paymentMethodsService');
const { createVoucherPaymentService } = require('../services/voucherPaymentService');
const { SalesFollowupService } = require('../services/salesFollowupService');
const { renderSalesHome, renderScanSkeleton, renderScanPage, renderScanMessagePage, renderMinimalPage, renderSaleSuccessPage, renderSalePaymentStepPage, buildPaymentRows } = require('../views/scanPageRenderer');
// ⚠️ 只借这两个**纯函数**：所选尺码在「样品 + 门盒」有没有货（= 页面上那两个分组的判据），
//    以及 `?from=` → 领域 id（认不出来回落缺省，不报错、不白屏）。
const { sellableSizeTexts, resolveRealm, DEFAULT_REALM, REPLENISH_REALM, PURCHASE_RETURN_REALM } = require('../views/scanPageRealm');
// ⭐ 写操作之后**立刻作废**「实时库存」内存快照（她：库存必须准确，不是等 30 秒）。
const { invalidateLiveInventorySnapshot } = require('../services/liveInventorySnapshot');
const { requireWorkbenchAccess } = require('./workbench');
// ⚠️ 会话读取/解码与回跳校验**复用 feishuWebAuth 里那一份**（`getSessionUser` =
//    `requireWorkbenchAccess` 判 401 用的同一个函数），**不重写第二份**。
const {enabled: feishuAuthEnabled,
  getSessionUser,
  buildLoginStartUrl,
  resolveScanNext, COOKIE_NAME, encodeSession } = require('./feishuWebAuth');
const { SCAN_PAGE } = require('../config/scanPage');
const { SCAN_WRITE, fillText: fillWriteText } = require('../config/scanWrite');
// ⭐⭐ 2026-10-16（task-59「一单多货品」**路由半**）：设计见
//   `docs/multi-item-order-design-2026-10-15.md` · 锚点见 `docs/multi-item-route-anchors-2026-10-16.md`。
//   · **引擎**（`services/multiItemOrderService.js`）管草稿 / 校验 / 批量落库 / 幂等 / 轮换 ——
//     本文件**只做三件事**：解析载荷 → 把**首件**与本次表单的尺码/数量合并 → 交给引擎 ✓；
//   · **配置**（`config/multiItemOrder.js`）管开关 / 上限 / 字段名 / 文案 ✓（这里一行阈值都不许写死 ✗）；
//   · 🔴 **N=1 一个字节都不经过这条路** —— 只有"分组 > 1"才进（见下面两处 `groups.length > 1`）✓。
const { resolveMultiItemOrderConfig, MULTI_ITEM_ORDER } = require('../config/multiItemOrder');
const { createMultiItemOrderService } = require('../services/multiItemOrderService');
// ⭐⭐ 2026-10-16（口子收尾 · 业务负责人口径「**异步只针对"写库"**；校验必须当场同步拦」）：
//   **尺码 / 数量 / 空单**这三类校验的**唯一真源**（纯函数、不碰 IO、配置先行 ✓）——
//   判据与写层 `services/scanWriteService.js:1397-1426`（补货）/ `:1556-1585`（退货）**逐字同源**
//   （出处行号钉在配置里 ✓）。
//   🔴 本文件**只调它**（`purchaseEntryViolation`），**不手抄任何一条 if-else** ✗ ——
//     手抄一份就再也不会跟写层同步（那正是这一刀要避免的形状 ✗）。
const {
  ENTRY_RULE_TEXTS, purchaseEntryViolation,
} = require('../config/scanPurchaseEntryRules');
// ⭐ 2026-10-11：「货品」领域的【打印这一款】把任务排进**打印队列**（店里那台电脑负责出纸）。
//   ⚠️ 队列是**进程内单例**（`services/labelPrintQueueRuntime.js`）—— 与电脑侧那条 SSE 路由
//      **共用同一个实例**，不然任务排进去了、小助手永远看不到。
//   ⚠️ 只在**真的要打印 / 渲染「货品」领域**时才构建它（`resolveLabelPrintQueue` 延迟创建）：
//      这一页是"扫码就能看"的入口，不能因为打印那条链路没配好就拖慢 / 打不开。
const { getLabelPrintQueue } = require('../services/labelPrintQueueRuntime');
const { LABEL_PRINT_QUEUE } = require('../config/labelPrintQueue');
const {SCAN_AUTH_REDIRECT, TICKET, redeemSessionTicket, pathWithoutTicket } = require('../config/scanAuthRedirect');
const { logError, logInfo, logWarn } = require('../utils/logger');
// ⭐⭐ 2026-10-14 晚（埋点 P0 ②④⑤）：点击埋点的**同一份实现**（与工作台共用；
//   本文件只负责"挂在扫码路由上、写 POST 上带结果事件"）。
const {
  handleUiTap, uiTapResultMiddleware, markTapCode,
} = require('../utils/uiTapReport');

// 飞书偶发「数据未准备好」(1254607)：回 503 + Retry-After，让她"过几秒刷新"，
// 这与工作台查询接口的口径一致（`controllers/workbenchController.js`）。
const isDataNotReady = (error) => /1254607|data not ready|数据未准备好/i.test(String(error?.message || error || ''));

// 业务数据（库存）不进任何缓存；顺带补 nosniff（HTML 由我们拼，但习惯性加上）。
const sendHtml = (res, status, html) => res.status(status)
  .type('html')
  .set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  .set('X-Content-Type-Options', 'nosniff')
  .send(html);

const createScanPageRouter = (options = {}) => {
  const config = options.config || SCAN_PAGE;
  const writeConfig = options.writeConfig === undefined ? SCAN_WRITE : options.writeConfig;
  const gateway = options.gateway || new V1BitableGateway();
  // ⚠️ 只读那一半的 service：`options.service` 供用例注入一个假的（既有用例就是这么做的，
  //    注入之后**连内存快照都不会建** —— 见 `services/scanPageService.js` 的注释）。
  const service = options.service || createScanPageService(gateway, {
    config,
    snapshot: options.snapshot,
    // ⭐ 生产接线（`app.js` 挂这个 router）默认**开着**后台快照；
    //    用例可以传 `startSnapshot: false`（不然会多出一次整表读 + 一个进程级定时器）。
    startSnapshot: options.startSnapshot !== false,
  });
  // 渲染器也留一个注入点：**只为验证"渲染抛错也必须回人话页"**（见用例 AC-W5）。
  const renderScan = options.render?.scan || renderScanPage;
  const renderMessage = options.render?.message || renderScanMessagePage;
  // ⭐ 2026-10-12：提交成功页（逐字「您的提交已成功」+「再录一单」回扫码页）——
  //    单独一个注入点，用例可以钉"成功页长什么样"而不用碰别的页。
  const renderSuccess = options.render?.success || renderSaleSuccessPage;
  /**
   * ⭐⭐ 2026-10-16 A2a ③：**候选收款方式 = 读「收款方式管理」那张表**（只读 + TTL 缓存那一份 service）。
   *
   *   她 2026-10-14 逐字：「**付款方式用交易方式管理，可选择**」⇒ 页面上的候选不再只吃
   *   `config/scanWrite.js` 里那几个名字，而是**表里真实的那几条**（她点名要过「抖音团购券」）。
   *   🔴 **读不到表**（或读出来是空的）⇒ **大声 `logWarn` + 退回配置里的方式**：
   *      · **不许静默**（静默 ⇒ 表坏了没人知道 ✗）；
   *      · **不许留白**（这一页是**展示** —— 候选为空 ⇒ 她"点不出来"，收款这一步就走不下去 ✗）。
   *   ⚠️ 与 `listAccessories`（`:181`）**口径不同**：配品读不到给**空清单**（少一个下拉项不挡卖鞋 ✓），
   *      收款方式读不到**必须退回配置**（挡的是"她能不能记账"✗）—— 这里刻意**不照抄**那一条。
   *   ⚠️ 默认方式照旧**排在第一位**（`defaultPaymentMethod`，她 2026-10-08：「默认微信」）——
   *      表里没有它时也保留：与改前那句 `[...new Set([default, ...config])]` 同口径 ✓。
   */
  const paymentMethodsService = options.paymentMethodsService
    || createPaymentMethodsService(gateway, options.paymentMethodsServiceOptions);
  /**
   * ⭐⭐ 2026-10-16（task-57 · 抖音团购券）：**券行**的解析器（只读 ✓ 与上面那份收款方式 service
   *   **共用同一趟读与同一份缓存** ⇒ 不为券多打一次飞书 ✓）。
   *   它只干一件事：把资金页那几行认成"券行"，并把一张券的**两个数各归各位**（面值→差额 / 结算款→明细）。
   */
  const voucherPayments = options.voucherPaymentService
    || createVoucherPaymentService({
      gateway,
      paymentMethods: paymentMethodsService,
      config: options.voucherPaymentConfig,
    });
  const configuredPaymentMethods = () => [...new Set([
    writeConfig.sale.defaultPaymentMethod, ...(writeConfig.sale.paymentMethods || []),
  ].filter(Boolean))];
  const candidatePaymentMethods = async (req) => {
    const fallback = configuredPaymentMethods();
    const listed = await paymentMethodsService.list().catch((error) => ({
      ok: false, items: [], reason: 'payment_methods_unreadable', error: error?.message || 'unknown',
    }));
    if (listed?.ok === true && Array.isArray(listed.items) && listed.items.length) {
      return [...new Set([writeConfig.sale.defaultPaymentMethod, ...listed.items].filter(Boolean))];
    }
    logWarn('scan.sale.payment_methods_unreadable', {
      request_id: req?.requestId,
      reason: String(listed?.reason || 'payment_methods_empty'),
      error: listed?.error ? String(listed.error) : undefined,
      message: '收款方式表读不到 / 退回配置里的方式',
      fallback,
    });
    return fallback;
  };
  /**
   * ⭐⭐ 2026-10-14（业务负责人口径：**点「提交这一单」只到资金页、点资金页按钮才建单**）：
   *   资金页的渲染**只留这一处**（GET 刷新认标记 / 点提交 / 点按钮 三处共用 ✓ 一份实现 ✗ 不复制）；
   *   原来它写在 `submitSale` 之后 ⇒ 只有"提交成功"用得到 ✗；且一度写在 POST 处理器里
   *   ⇒ ⭐ GET 看不到它（真机 `ReferenceError` ✗）⇒ 现在放在**工厂作用域** ✓
   *   ⚠️ **逐字**：`step2Write` 的字段与渲染入参一个都没改 ✗（不许顺手改口径 ✓）
   */
  const step2WriteOf = (opts = {}) => ({
    texts: writeConfig.texts, fields: writeConfig.fields, actions: writeConfig.actions,
    // ⭐⭐ 2026-10-16 A2a ③：候选清单**由调用方传进来**（= 上面读表那一份 ✓ 一份真源 ✗ 不在这儿再拼一份）——
    //   拿不到（用例直接调这一页 / 还没接线的老路径）⇒ 退回配置里的方式（与改前同一个退路 ✓）。
    paymentMethods: Array.isArray(opts.paymentMethods) && opts.paymentMethods.length
      ? opts.paymentMethods
      : writeConfig.sale.paymentMethods,
    defaultPaymentMethod: writeConfig.sale.defaultPaymentMethod,
    paymentRowCount: writeConfig.sale.paymentRowCount,
    // ⭐ 她刚填的那一档 / 实付多少 / 收款行 ⇒ **原样带回**（她不用重打 ✓ 她明确要过这条 ✓）
    paymentStatus: String(opts.paymentStatus || writeConfig.sale.paymentStatus.default),
    defaultPaymentStatus: writeConfig.sale.paymentStatus.default,
    paidAmount: String(opts.paidAmount || ''),
    ...(Array.isArray(opts.paymentRows) ? { paymentRows: opts.paymentRows } : {}),
    draft: { lines: [] },
  });
  /**
   * ⭐⭐ 2026-10-16（task-58 · 业务负责人真机 05:34，逐字）：
   *   「静态感觉很好，扫描了几个货品二维码，**但是有一个货品点击了之后出现的是这个资金页** ✗」
   *
   * 🔴 **为什么非要有这条**：她拉的线上日志里**每一次都打了 `scan.page.viewed`** —— 因为
   *   "资金页接管"那条路（本文件下面）**也**要先 `service.lookup()`，而 `viewed` 就在 lookup 里打
   *   （`services/scanPageService.js:1356` / 命中缓存 `:1070`）⇒ **日志长得一模一样**，
   *   分不出"渲染的是货品页还是资金页" ✗✗ ⇒ 真机再来一次还是只能猜。
   *
   * 这条只记**事实**（哪个落点 + 哪条条件命中 + 这次带了哪些查询字段 + 扫的是哪个编号）：
   *   · **不读表、不判定、不改任何返回** ✗ —— 判定那几行一个字都没动 ✓
   *   · `query_keys` **只字段名**（与 `app.js:80` 同一口径 ✗ 不记值）
   *   · `number` = 这次扫的编号 / 记录 ID（与 `scan.page.viewed` 同口径 ✓）
   *   · 事件名落 `config/scanPage.js` 的 `EVENTS.rendered`（配置先行 ✓）
   */
  const logRendered = (req, { page, trigger, number = '' } = {}) => {
    logInfo(config.events?.rendered || 'scan.page.rendered', {
      request_id: req?.requestId,
      page: String(page || ''),
      trigger: String(trigger || ''),
      query_keys: Object.keys(req?.query || {}).sort(),
      number: String(number || ''),
    });
  };
  const sendPaymentStep = (res, req, opts = {}) => {
    // ⭐ 她看到的这一页 = 这条日志记的（**在发页面之前**打 ⇒ 两件事不会分家 ✓）
    logRendered(req, {
      page: 'pay',
      trigger: String(opts.renderedTrigger || 'payment_step'),
      number: String(scanTargetOf(req)?.value || ''),
    });
    const target = backTargetFor(req, decodeURIComponent(String(req.params.number || '')));
    // ⚠️ 默认 200 ✓；⭐ 结算没过那一次要 **400**（"她能改"的那一类 ⇒ 与既有口径一致 ✓ 旧行为也是 400 ✓）
    const status = Number(opts.status) === 400 ? 400 : 200;
    return sendHtml(res, status, renderSalePaymentStepPage({
      write: step2WriteOf(opts),
      // ⚠️ **不编**：还没建单时它是空串 ✓（她在资金页阶段本来就没有单号 ✓）
      orderNo: String(opts.orderNo || ''),
      config,
      basePath: req.baseUrl,
      postAction: postActionFor(target, opts.realm || 'sales'),
      submitKey: String(opts.submitKey || ''),
      count: Number(opts.count) || 0,
      reused: Boolean(opts.reused),
      salesEntryRecordId: String(opts.salesEntryRecordId || ''),
      // ⭐ 结算没过时那一句人话（原地重渲染资金页 ✓）
      notice: String(opts.notice || ''),
    }));
  };
  // ⚠️ 写服务**只为 POST 与"本单还有几双"服务**；`GET` 的库存表一个字都不依赖它。
  //    用例可以注入一个假的（`options.writeService`），`false` = 这一版不挂写入口。
  const writeService = writeConfig && options.writeService !== false
    ? (options.writeService || createScanWriteService({ gateway, config: writeConfig }))
    : null;

  // ══════════════════════════════════════════════════════════════════════════
  // ⭐⭐ 「一单多货品」**路由半**（task-59）
  //   · 本文件**只做**：解析隐藏字段 → 首件合并 → 交给引擎（`openDraft/addItem/submitDraft`）；
  //   · **落库 / 校验 / 幂等 / `orderKey` 轮换全在引擎里** ✓（路由**不碰**写库、不认识表字段 ✗）；
  //   · 🔴 **N ≤ 1 一个字节都不走这里**（两处调用点都是 `groups.length > 1` 才进 ✓）。
  //   ⚠️ 配置**在 router 构建时读一次**（`resolveMultiItemOrderConfig()` 每次调用都重新读 env ✓）——
  //     与渲染半那份（模块级 `MULTI_ITEM_ORDER`）**同一个 env 源**，两边不会漂 ✓。
  // ══════════════════════════════════════════════════════════════════════════
  const multiItemOrderConfig = resolveMultiItemOrderConfig();
  /**
   * ⭐⭐ 2026-10-16（task-59 · 两半一刀）：**领域 → 链** 的映射（**只有补货 / 退货两条** ✓）。
   *
   * 🔴 为什么映射**故意只有这两条**：加 / 删货那颗 `submit` 是靠"这一页在哪个领域"认链的
   *   （表单 `action` 带着 `?from=` ✓ 见 `postActionFor`）。映射里**多一条** ⇒ 那个领域也会去开草稿 ✗
   *   ⇒ "别的领域行为不变"（**AC-MI-E**）就没了 ⇒ `test/multiItemOrderAddRemove.test.js` 反着钉住它 ✓。
   * ⚠️ 链名**从配置取**（`config/multiItemOrder.js` 的 `chains.<id>.id` ✓）—— 这里**不写死** ✗；
   *   领域 id 从**视图那份常量**取（`views/scanPageRealm.js`，**唯一真源** ✓ 不抄一份 ✗）。
   */
  const CHAIN_BY_REALM = Object.freeze({
    [REPLENISH_REALM]: String(multiItemOrderConfig.chains?.replenish?.id || ''),
    [PURCHASE_RETURN_REALM]: String(multiItemOrderConfig.chains?.return?.id || ''),
  });
  // 用例可以注入一个假引擎（`options.multiItemOrder`）—— 与 `options.writeService` 同一种注入法 ✓
  let multiItemOrderEngine = options.multiItemOrder || null;
  /**
   * 懒建引擎（**只有真的要提交多货品单时才建** ✗ N=1 那条路一次都不建 ✓）。
   * @returns {object|null} `null` = 这条路现在走不了 ⇒ 调用方**给人话 + 零写入**（绝不静默只写第一件 ✗）
   */
  const multiItemOrder = () => {
    if (multiItemOrderEngine) return multiItemOrderEngine;
    if (!writeService || typeof writeService.multiItemWriters !== 'function') return null;
    if (multiItemOrderConfig.enabled !== true) return null;
    // 🔴 写入件**只经** `writeService.multiItemWriters()`（同一批既有写入件的引用相等 ✓）——
    //   本文件里**不出现任何写链路服务名**（既有源码哨兵 `RT5` 钉着，不放宽 ✗）。
    multiItemOrderEngine = createMultiItemOrderService({
      sessions: writeService.sessions,
      config: multiItemOrderConfig,
      writers: writeService.multiItemWriters(),
    });
    return multiItemOrderEngine;
  };

  /**
   * ⭐⭐ 2026-10-16（task-59 · 两半一刀）：从**已经读到的那份会话**里挑出「这条链**正在写的那份草稿**」。
   *
   * 🔴 **只读**：`status === 'draft'` 才算（提交成功后引擎会把它置成 `submitted` ✓ 并轮换 `orders_seq` ✓）
   *   —— 她只是**看一眼**这一页，**不许**在会话里凭空多出一份草稿 ✗（所以这里**不调** `engine.openDraft`）。
   * 🔴 **不按 `orderKey` 去算**：那要在这里重抄一遍引擎的键规则（`orders_seq` + 前缀 + 会话 id）✗
   *   —— 判据只有两条：`chain` 对得上 ＋ `status === 'draft'`（`config/multiItemOrder.js` 的 `draftStatus` ✓）。
   * ⚠️ 正常只有一份；万一有多的（提交轮换失败那类残留）⇒ 取 `updated_at` **最新**的那一份 ✓（不猜 ✗）。
   *
   * @returns {{chain:string, items:Array, order_amount:string}|null}
   */
  const multiItemDraftOf = (session, realm) => {
    const chain = CHAIN_BY_REALM[String(realm || '')] || '';
    if (!chain || !session) return null;
    const orders = session[multiItemOrderConfig.session.ordersField] || {};
    const drafts = Object.values(orders).filter((draft) => draft
      && String(draft.chain || '') === chain
      && String(draft.status || '') === multiItemOrderConfig.session.draftStatus);
    if (!drafts.length) return null;
    const latest = drafts.reduce((best, one) => (
      String(one.updated_at || '') >= String(best.updated_at || '') ? one : best
    ));
    return {
      chain,
      items: Array.isArray(latest.items) ? latest.items : [],
      order_amount: String(latest.order_amount || ''),
    };
  };

  /**
   * ⭐⭐ 2026-10-16（task-59 · 两半一刀）：「＋ 再加一个货品」/「移除」那两颗 `submit` 的**接住点**。
   *
   * 🔴 **为什么必须由路由接住**：那两颗按钮就在**既有那张表单里** ⇒ 点它们时**整个表单**（含
   *   hidden `action=replenish|return_purchase`）一起发出来 ✗ ⇒ 不先拦，她这一点就会
   *   **把这一单直接提交走、页面也跳走**（比改前"点了没反应"**更糟** ✗✗）。
   *
   * 它**只做三件事**（写库 / 校验 / 幂等全在引擎里 ✓ 路由不认识表字段 ✗）：
   *   ① `engine.openDraft`（拿本单的 `orderKey`）；
   *   ② `engine.addItem`（**当前这一件**，`entries` = **本次表单**的尺码/数量 —— 既有
   *      `parseReplenishEntries` / `parseReturnEntries` ＋ `mergeFirstItemEntries` ✓ **不抄第二份** ✗）
   *      或 `engine.removeItem`（那一行的 `product_record_id` ✓）；
   *   ③ **303 PRG 回本页**（刷新不会重复加货 ✓；列表与表单由 GET 重新渲染 ✓）。
   *
   * ⚠️ 这里**刻意不跑**尺码 / 数量 / 空单那几道校验（`purchaseEntryViolation`）：
   *   她的这一次动作是"**先记下来**"，不是提交 ⇒ 校验失败若当场 400，她就**又丢一次刚填的值** ✗
   *   （那正是本刀要修的 bug）—— 真正的闸门在**提交那一步**（同步拦 ＋ 引擎的 `validateDraft` ✓）。
   */
  const handleMultiItemAction = async ({ req, res, requestId, realm, action }) => {
    const body = req.body || {};
    const engine = multiItemOrder();
    if (!engine) {
      // 引擎不可用（写服务没挂 / 多货品开关关）：**宁可给人话 + 零写入**，也绝不回落老路径 ✗
      return respondWriteFailure(
        res, { code: 'disabled', message: writeConfig.texts.writeDisabledBody }, requestId,
      );
    }
    const chain = CHAIN_BY_REALM[String(realm || '')] || '';
    if (!chain) {
      return respondWriteFailure(
        res, { code: 'chain_unknown', message: multiItemOrderConfig.texts.chainUnknown }, requestId,
      );
    }
    const openId = openIdOf(req);
    const opened = await engine.openDraft({ openId, chain, requestId });
    if (!opened.ok) return respondWriteFailure(res, opened, requestId);
    const orderKey = opened.orderKey;
    let item = null;
    // ⭐⭐ 整单金额（**只有"必填"的那条链看它** —— 判据来自配置 ✓ 路由里不写 `if (补货) …` ✗）：
    //   她在那张表单里敲的总额**也要原地留住** —— 不然点一下加货回来那一格就空了 ✗
    //   （与"尺码/数量丢了"是同一个 bug 类 ✓）。草稿里存着 ⇒ 渲染半会把它预填回输入框 ✓。
    //   ⚠️ 提交那一步仍会按**那次表单**的值覆盖它（`submitMultiItemOrder` 做 ✓）⇒ 不会串笔 ✓。
    if (multiItemOrderConfig.chains[chain]?.amountRequired === true) {
      await setDraftOrderAmount(openId, orderKey, String(body[writeConfig.fields.purchaseAmount] ?? ''));
    }
    if (action.kind === 'remove') {
      const removed = await engine.removeItem({
        openId, chain, orderKey, productRecordId: action.productRecordId, requestId,
      });
      if (!removed.ok) return respondWriteFailure(res, removed, requestId);
    } else {
      // ⚠️ **当前这一件的身份直接从 hidden `multi_items[0]` 取** —— 这一次请求**不再 lookup** ✗
      //    （lookup 是飞书那一次读表；她这一页刚刚才读过 ✓ 再读一次纯属浪费 ＋ 可能不一致 ✗）。
      const groups = parseMultiItemGroups(body, multiItemOrderConfig);
      if (!groups.length) {
        return respondWriteFailure(
          res, { code: 'product_missing', message: multiItemOrderConfig.texts.productMissing }, requestId,
        );
      }
      // ⚠️ 用**哪一份**解析器看的是"她在哪一块"（补货块 = `replenish_sizes` / 退货块 = `return_sizes`）
      //    ⇒ 判据是**领域**（`REPLENISH_REALM` / `PURCHASE_RETURN_REALM` ✓ 与渲染半同一处真源 ✓），
      //    不是"哪条链"（那是引擎的事 ✓）。既有那两个纯函数**原样复用** ✓ 不抄第二份 ✗。
      const entries = String(realm) === PURCHASE_RETURN_REALM
        ? parseReturnEntries(body, writeConfig.fields, writeConfig)
        : parseReplenishEntries(body, writeConfig.fields, writeConfig);
      // ⭐ 与提交那条**同一个**纯函数：首件（当前这件）的 `entries` = **本次表单**那一份 ✓
      //   （赋值语义 ⇒ 数量不翻倍 ✓ 既有判据 `AC-MIRW-3` 不放宽 ✗）
      [item] = mergeFirstItemEntries(groups, entries);
      const added = await engine.addItem({ openId, chain, orderKey, item, requestId });
      if (!added.ok) return respondWriteFailure(res, added, requestId);
    }
    // **不静默**：她点的那一下**真的被接住了** —— 按这条 grep 就能回答"加货到底有没有生效" ✓
    //   （改前那颗链接点了**一个字都不留** ✗：这正是"点了没反应"最难查的地方）
    logInfo(multiItemOrderConfig.events.draftItemChanged, {
      request_id: requestId,
      kind: action.kind,
      chain,
      order_key: orderKey,
      product_record_id: action.kind === 'remove' ? action.productRecordId : String(item?.product_record_id || ''),
      entries_count: Array.isArray(item?.entries) ? item.entries.length : 0,
    });
    markRealmUsed(openId, realm);
    // ⭐ PRG：303 回**本页 + 本领域**（`postActionFor` 会带上 `?from=`，与表单 action 同一处拼法 ✓）
    return res.redirect(303, postActionFor(
      backTargetFor(req, decodeURIComponent(String(req.params.number || ''))), realm,
    ));
  };

  /**
   * ⭐ 退货那条链的**整单金额**进草稿（形状 = 设计 §4.3 的 `order_amount`）。
   *
   * ⚠️ 为什么走 `sessions.store`：引擎的公开 API 里**没有"设金额"这一口**
   *   （只有 `openDraft` / `addItem` / `setEntries` / `removeItem` / `submitDraft`），
   *   而 `services/multiItemOrderService.js` **不在本刀写作用域** ⇒ 这里按**设计里那份草稿形状**、
   *   经**同一个会话 store** 写这一个字段（容器名取自 `config/multiItemOrder.js` ✓ **不写死** ✗）。
   *   `store.update` 是**同 id 串行**的读-改-写 ⇒ 不会把引擎刚写进去的 `items` 覆盖掉 ✓。
   */
  const setDraftOrderAmount = async (openId, orderKey, amount) => {
    if (!writeService || !writeService.sessions) return;
    const { store, idOf } = writeService.sessions;
    if (!store || typeof store.update !== 'function' || typeof idOf !== 'function') return;
    const ordersField = multiItemOrderConfig.session.ordersField;
    await store.update(idOf(openId), (session) => {
      const orders = { ...((session || {})[ordersField] || {}) };
      const draft = orders[orderKey];
      if (draft) orders[orderKey] = { ...draft, order_amount: String(amount || '').trim() };
      return { [ordersField]: orders };
    });
  };

  /**
   * ⭐⭐ 「一单多货品」**提交**（**只有分组 > 1 才会进来**）—— 拒单 ⇒ 人话 + **零写入** ✓。
   *
   * 🔴 **成功页复用今天那条形状与文案**（`sendSuccess` + `successReturnFields` ✓）——
   *   本文件**不发明新文案** ✗，也**不承诺**这一刻还没有的东西（批次号 / 明细数由后台写出）✗。
   */
  const submitMultiItemOrder = async ({
    req, res, requestId, chain, groups, action,
  }) => {
    const engine = multiItemOrder();
    if (!engine) {
      // 引擎不可用（写服务没挂 / 多货品开关关）：**宁可给人话 + 零写入**，
      // 也**绝不**回落老路径 —— 那会把"其余货品"静默丢掉 ✗（她最恨的那种假成功）。
      return respondWriteFailure(
        res, { code: 'disabled', message: writeConfig.texts.writeDisabledBody }, requestId,
      );
    }
    const openId = openIdOf(req);
    const opened = await engine.openDraft({ openId, chain, requestId });
    if (!opened.ok) return respondWriteFailure(res, opened, requestId);
    const orderKey = opened.orderKey;
    // 退货那条链：整单金额**先进草稿**（引擎的校验 `amountRequired` 与载荷 `order_amount` 都读它 ✓）。
    // ⚠️ 空 / 非数字**已经在上面同步拦过**（`purchaseAmount*Page` ⇒ 400 + 人话 + 零写入 ✓），
    //   这里原样透传、**不重算** ✗。
    // ⚠️ **判据来自配置**（`chains[chain].amountRequired` ✓）—— 路由里**不写 `if (补货) … else …`** ✗
    //   （与引擎同一条口径：两条链**只差配置** ✓）。
    if (multiItemOrderConfig.chains[chain]?.amountRequired === true) {
      await setDraftOrderAmount(openId, orderKey, String(req?.body?.[writeConfig.fields.purchaseAmount] ?? ''));
    }
    for (const group of groups) {
      const added = await engine.addItem({ openId, chain, orderKey, item: group, requestId });
      if (!added.ok) return respondWriteFailure(res, added, requestId);
    }
    // 🔴 幂等键 = **本单的 `orderKey`**（一单一把；提交成功后引擎**轮换**它 ✓）——
    //    **不传**表单里那把 key：页面上的 key 在提交后仍是旧值，重放旧页面会把**第 2 单**
    //    算成第 1 单的同一个 `taskId` ⇒ 被第 1 单吸收 ✗（设计 §4.2 的动机）。
    const result = await engine.submitDraft({
      openId, chain, orderKey, submitKey: orderKey, requestId,
    });
    if (!result.ok) return respondWriteFailure(res, result, requestId);
    // ⚠️ 理由串**只从配置取**（`config/multiItemOrder.js` 的 `invalidateReasons`；值与单货品那条路
    //   逐字同一串 ✓）—— **不在源码里再写一遍那两个既有字面量**：它们是既有邻近哨兵 `AC-SR4`
    //   的锚点，在前面多一处就把锚点挤开 ✗（本刀真踩到过 ✓）。
    invalidateInventorySnapshot(requestId, multiItemOrderConfig.invalidateReasons[chain]);
    markRealmUsed(openId, realmOfAction(action));
    // ⚠️ task-60：`req` 作**第 4 个实参**传进去 ⇒ 这条成功页的 `scan.page.rendered`
    //    也带得上 `number`（字段齐 ✓）；🔴 **页面本身一个字都不受影响** ✗（那个参数只喂日志）。
    return sendSuccess(res, 200, {
      ...successReturnFields(req, backTargetFor(req, decodeURIComponent(String(req.params.number || '')))),
      requestId,
    }, req);
  };

  /**
   * ⭐⭐ 2026-10-16（task-52 · ②-⑭ 接线 · 业务负责人**逐字**）：
   *   「**补货、退货还有验收，它都是异步的**……都是一句『**已提交成功，数据会更新**』」
   *   ⇒ 补货 / 退货：**先把成功页回给她**（200）⇒ 「**后台那一跑**」再写库 ✓
   *
   * 🔴 三条红线都在这一处落地（判据见 `test/purchaseAsyncAcceptance.test.js` 的 AC-ASY1..4）：
   *   ① **校验仍当场同步拦** ✗ —— **金额（空 / 非数字）** 与 **"这一款认不出"** 都在**排后台之前**
   *      （本文件上面的 `purchaseAmount*Page` / `notFoundPage` ✓ AC-ASY2 判的就是这两道）。
   *      ⚠️ **已知取舍**（如实写在这里，别当它不存在 ✗）：写层自己的**输入校验**
   *      （尺码 / 数量 / 空单 —— `services/scanWriteService.js` 里那几条）**跟着写库那一步进了后台**
   *      —— 因为本刀**一个字都不许改那个 service**（余量 0 硬红线 ✗），而校验与写库在它里面
   *      是同一个函数。⇒ 真发生"她填错了"时：她**已拿到成功页**，而失败会以
   *      `config/scanWrite.js` 的 `purchaseBackgroundFailed` 那条 warn ＋ 会话 `last_error`
   *      **如实留痕**（**不静默** ✗）。
   *      要把它挪回同步 ⇒ **必须**把那个函数拆成"先受理 / 后台续写"两半（= 动 `scanWriteService.js`）
   *      ⇒ **超出本刀授权**，留给 Lead 决策（见 PR 说明）。
   *   ② **后台失败绝不假装成功** ✗ —— 共用件记一条 warn ＋ 调 `markFailed`（落会话 `last_error`
   *      ⇒ **可查**；幂等键**不轮换** ⇒ 她再点一次 = 同一把键**重试** ✓）。
   *   ③ **`submitKey` 原样透传** ✗ —— 幂等责任在写层（本文件一个字不拼、不加后缀 ✓）。
   */
  const purchaseBackground = options.purchaseBackground || createPurchaseWriteBackgroundService({
    // 🔴 `runRest` = **既有写入口**（不新开写库路径 ✗）：补货 / 退货各自的写服务方法。
    //    ⚠️ **实参形状与改前那次 `await writeService.…(…)` 逐字同形**（键名一个不改 ✗）——
    //      判据 `test/multiItemOrderRoute.test.js` 的 **RT2-static** 逐字钉着这张参数清单
    //      （task-46「N=1 与老路径逐字等价」的护栏 ✓ 本刀**不放宽它** ✗）。
    runRest: async ({ chain, requestId, submitKey, restInput = {} }) => {
      if (!writeService) {
        return { ok: false, code: 'write_disabled', message: writeConfig.texts.writeDisabledBody };
      }
      if (chain === 'replenish') {
        return writeService.submitReplenish({
          openId: restInput.openId,
          requestId,
          submitKey,
          productRecordId: restInput.productRecordId,
          number: restInput.number,
          entries: restInput.entries,
        });
      }
      if (chain === 'purchase_return') {
        return writeService.submitPurchaseReturn({
          openId: restInput.openId,
          requestId,
          submitKey,
          productRecordId: restInput.productRecordId,
          number: restInput.number,
          orderAmount: restInput.orderAmount,
          entries: restInput.entries,
        });
      }
      return { ok: false, code: 'unknown_chain', message: String(chain || '') };
    },
    markFailed: async ({ chain, context = {}, result, error }) => {
      const openId = String(context.openId || '');
      const message = String(result?.message || error?.message || '').trim();
      try {
        const sessions = writeService && writeService.sessions;
        if (chain === 'replenish' && typeof sessions?.markReplenishFailed === 'function') {
          await sessions.markReplenishFailed(openId, message);
        } else if (chain === 'purchase_return' && typeof sessions?.markPurchaseReturnFailed === 'function') {
          await sessions.markPurchaseReturnFailed(openId, message);
        }
      } catch (markError) {
        logWarn(writeConfig.events.purchaseBackgroundMarkFailed, {
          request_id: context.requestId, chain,
          error: String(markError?.message || markError).slice(0, 200),
        });
      }
    },
    purchaseAsync: writeConfig.purchaseAsync || {},
    config: {
      events: {
        restTiming: writeConfig.events.purchaseBackgroundTiming,
        restFailed: writeConfig.events.purchaseBackgroundFailed,
        markFailedError: writeConfig.events.purchaseBackgroundMarkFailed,
      },
      // ⚠️ 这里**刻意不注入** `timing`：后台件的默认阶段名就是 `background`（与
      //   `SCAN_SALE_TIMING_PHASE_BACKGROUND` 的缺省一致 ✓）—— 而本文件有一条**既有哨兵**
      //   （`test/salesAsyncWrite.test.js` 的 AC-AS11b：「路由不许把后台句柄当数据读」，
      //   它按"点 + background"这种属性访问扫源码）⇒ **不放宽那条哨兵** ✗、也不写那种写法 ✓。
    },
  });
  /** 排一次「后台那一跑」（共用件登记在册 ✓ 用例可以 `waitForPendingPurchaseBackgrounds()` 等它）。 */
  const schedulePurchaseWrite = ({ chain, requestId, submitKey, context, restInput }) =>
    purchaseBackground.schedulePurchaseRest({ chain, requestId, submitKey, context, restInput });
  /**
   * ⭐⭐ 2026-10-12：**未到货批次**（要列出来的那几条）—— **全仓只有这一处**读它。
   *
   * 两个调用方：① **有编号的领域页**（`?from=accept`，她扫开某款那一页）；
   *              ② **落地页** `GET /accept`（无 batch，她点【验收】进来的第一屏）。
   * ⚠️ **同一个 catch**：读表失败 ⇒ 只记一条 warn + 返回 `{ok:false, batches:[]}`
   *    ⇒ 页面照旧 **200**、走手输兜底（她的"别卡住她"）。
   */
  const buildWriteContext = async (req, view, realm = DEFAULT_REALM, extra = {}) => {
    if (!writeService) return null;
    const openId = openIdOf(req);
    if (!openId) return null;
    const texts = writeConfig.texts;
    const fields = writeConfig.fields;
    // ⭐ 本单是**按人（登录会话）**存的（`scanSessionService.idOf(openId)`），
    //    **不是按编号** ⇒ 扫 A 加一双、再扫 B 加一双，读到的**是同一份本单**
    //    （"一单跨款累积"就是这么成立的；见 `services/scanSessionService.js` 的文件头）。
    const session = await writeService.sessions.get(openId).catch((error) => {
      // 读自己的会话失败**不影响看库存**：把表单退化成"还没加任何一双"，
      // 她照样能加单（加的时候会重建）。只记一条 warn，不给她报错。
      logWarn(writeConfig.events.failed, {
        request_id: req.requestId, reason: 'session_read_failed', error: error.message,
      });
      return null;
    });
    const sizes = (view.rows || [])
      .filter((row) => !row.unknown_size)
      .map((row) => ({ size_text: row.size_text, missing: Boolean(row.missing) }));
    const defaultPaymentMethod = writeConfig.sale.defaultPaymentMethod;
    // ⭐⭐ 2026-10-16 A2a ③（改前逐字 → 改后逐字 → 依据）：
    //   改前逐字：`const paymentMethods = [...new Set([defaultPaymentMethod, ...(writeConfig.sale.paymentMethods || [])].filter(Boolean))];`
    //     —— 候选**只从配置拼**（表里真实那几条看不到 ✗）
    //   改后逐字：`const paymentMethods = await candidatePaymentMethods(req);`
    //     —— **读「收款方式管理」表**（只读 + TTL 缓存 ✓）；读不到 ⇒ 大声 warn + **退回配置**（见上面那份注释）
    //   依据 = 她 2026-10-14 逐字「**付款方式用交易方式管理，可选择**」
    const paymentMethods = await candidatePaymentMethods(req);
    const lines = session?.sale?.lines || [];
    // ⭐ 2026-10-11（B）：配品下拉的候选（「其他配品」的名称）——**只在销售那一块要**
    //   （表单只在 `from=sales` 渲染），别的领域一次表都不读（她的"一次扫码 0~1 次飞书调用"）。
    //   ⚠️ 读不到配品表**不影响卖鞋**：`listAccessories` 自己吞掉错误并记 warn，给空清单。
    const accessories = realm === 'sales' && typeof writeService.listAccessories === 'function'
      ? await writeService.listAccessories().catch(() => [])
      : [];
    return {
      enabled: true,
      saleEnabled: writeConfig.sale.enabled !== false,
      replenishEnabled: writeConfig.replenish.enabled !== false,
      // ⭐ 2026-10-11：采购领域的第二个动作（退货）—— 关掉它，那一块就不渲染（与补货同一条口径）。
      returnEnabled: writeConfig.purchaseReturn?.enabled !== false,
      texts,
      fields,
      actions: writeConfig.actions,
      // ⭐⭐ `/r/{recordId}` 底下表单必须 POST 回 `/r/{recordId}`（否则提交会落到"按编号"那条路）。
      postAction: postActionFor(backTargetFor(req, view.number), realm),
      sizes,
      draft: { lines },
      // ⭐⭐ 2026-10-16（task-59 · 两半一刀）：「一单多货品」**正在进行的那份草稿**（补货 / 退货才有 ✓）。
      //   🔴 **只读**（`multiItemDraftOf` 只认 `status === 'draft'` ⇒ **不建草稿** ✗）；
      //   ⚠️ 复用**这一次已经读到的**那份会话（上面 `writeService.sessions.get` ✓）⇒ **零额外读盘** ✓；
      //   ⚠️ 别的领域（销售 / 库存 / 货品）拿到的**永远是 `null`**（`CHAIN_BY_REALM` 里没有它们 ✓）。
      multiItemDraft: multiItemDraftOf(session, realm),
      // ⭐ 配品行要的东西（没有配品时渲染层不画那个表单）。
      accessories: accessories.map((item) => ({ record_id: item.record_id, name: item.name })),
      saleKey: writeService.sessions.submitKeyFor(openId, session, 'sale'),
      replenishKey: writeService.sessions.submitKeyFor(openId, session, 'replenish'),
      // ⭐ 退货那把键（第三条链；与销售 / 补货**互不覆盖** —— 会话语义见 scanSessionService）
      returnKey: writeService.sessions.submitKeyFor(openId, session, 'purchase_return'),
      paymentMethods,
      defaultPaymentMethod,
      // ⭐⭐ 总单层的**「付款情况」**（整单三档）：默认档来自配置（**全付**）；
      //     校验失败原地重渲染时，用**她刚才选的那一档**（`extra.paymentStatus`）。
      paymentStatus: String(extra.paymentStatus || writeConfig.sale.paymentStatus?.default || ''),
      defaultPaymentStatus: writeConfig.sale.paymentStatus?.default || '',
      // ⭐ 「部分付」时资金区填的**实付多少**（另外两档服务端不看它）；同样原样回填。
      paidAmount: extra.paidAmount === undefined || extra.paidAmount === null
        ? '' : String(extra.paidAmount),
      // ⭐⭐ 总单层的多笔收款行：预置 N 行（第一行默认「微信」）；校验失败重渲染时
      //     用**她刚填的那几行**（值原样带回来，她改一改就能再提交）。
      paymentRows: buildPaymentRows({
        count: writeConfig.sale.paymentRowCount,
        defaultMethod: defaultPaymentMethod,
        rows: extra.paymentRows,
      }),
      // 校验失败时挂在表单上方的那句人话（差额）；成功路径上是空串。
      errorText: String(extra.errorText || ''),
      // 「刚加入本单」那一句（**文案来自配置**，只有数字来自会话 ⇒ 没有回显注入面）。
      notice: String(req.query?.added || '') === '1' && lines.length
        ? fillWriteText(texts.lineAddedBanner, { count: lines.length })
        : '',
    };
  };

  /**
   * ⭐⭐ 2026-10-13 **口径变更**（她的原话，逐字）：
   *   「"提交这一单"就说明**这一单已经结了**呀，如果我再操作的话，**应该就跟这一单没关系了**，
   *     除非我是选"**再加一双**"呀」
   *  ⇒ `/s`（**不带编号**）= **销售领域入口页**（= 她说的"销售首页" ✓）：
   *    · 提交成功后回跳这里（回跳 URL 带 `?done=<单号>` ⇒ 顶部"上一单已提交（单号）" ✓ 无状态）
   *    · 手输编号 ⇒ **302 到 `/s/<编号>`**（兜底 ✓）
   *  ⚠️ 改前这里是"缺编号 ⇒ 400 这个链接不对" ✗；**改后 `GET /s` 是有意义的入口** ✓
   *     （**认不出的编号**仍走原来的 400 人话页 ✓ 那条没动 ✗）
   */
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    next();
  });

  /**
   * 「扫码即用」：未登录 → **302** 去飞书登录（登录成功后自动回到刚才那一页）。
   *
   * 判定"未登录"用的是**共享闸门同一套能力**（`feishuWebAuth.enabled` + `getSessionUser`），
   * 不是新写一份：`getSessionUser` 就是 `requireWorkbenchAccess` 判 401 时读会话的那个函数
   * （读 `workbench_session` cookie → HMAC 验签 → 查过期）。
   *
   * 三种准入情况的分工（**共享闸门语义不变**）：
   *   · 认证**没启用** → 这里 `next()`，由共享闸门回 **503 JSON**（一字不变）；
   *   · **没登录**      → 这里回 **302**（本轮唯一的行为变化，只发生在扫码页）；
   *   · **已登录但白名单外** → 这里 `next()`，由共享闸门回 **403 JSON**（一字不变）。
   * ⚠️ 已登录且白名单内的人，下面的页面行为（200/400/404/503）**逐字不变**；
   *    `POST`（写入口）走的是**同一道**闸门，语义也一字不变。
   */
  router.use((req, res, next) => {
    if (!feishuAuthEnabled()) return next();
    // 2026-10-13: try the one-time URL ticket first (WebView keeps no cookie).
    //   ok -> set the session cookie here and 302 to the same path WITHOUT the ticket.
    //   expired/used/forged/other-path -> fall through to a fresh login (never half-logged-in).
    const ticketToken = TICKET.enabled ? req.query?.[TICKET.paramName] : '';
    if (ticketToken) {
      const targetPath = pathWithoutTicket(req.originalUrl || req.url || '');
      const redeemed = redeemSessionTicket(String(ticketToken), { targetPath });
      if (redeemed.ok) {
        const sessionCookie = encodeSession({ open_id: redeemed.openId, name: redeemed.name });
        res.setHeader('Set-Cookie', `${COOKIE_NAME}=${sessionCookie}; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=None`);
        return res.redirect(302, targetPath);
      }
      logWarn(SCAN_AUTH_REDIRECT.events.loginRedirect, {
        reason: `ticket_${redeemed.reason}`,
      });
    }
        if (getSessionUser(req)) return next();
    // 「刚才那一页」= 原 path + 原 query（本 router 挂在 `SCAN_PAGE.route.basePath` 上，
    // `req.originalUrl` 已经含挂载点）。再过一次回跳白名单：只放行扫码页自己，
    // 别的（`//host`、协议、绝对 URL、`/s/../api/...`）一律回落工作台首页。
    const target = resolveScanNext(
      String(req.originalUrl || `${config.route.basePath}${req.url || ''}`),
    );
    logInfo(SCAN_AUTH_REDIRECT.events.loginRedirect, {
      request_id: req.requestId,
      next: String(target).slice(0, 200),
    });
    return res.redirect(302, buildLoginStartUrl(target));
  });

  router.use(requireWorkbenchAccess);
  /**
   * ⭐⭐ **`GET /s/:number?from=<领域>`** —— 手机扫开的那一页。
   *
   * 2026-10-09 真机（飞书 webview 白屏）之后这一条重做过：
   *   · **服务端按 `from` 只渲染那一块**（不再靠 `<head>` 内联脚本 + CSS 显隐）；
   *   · 页面里**一行前端脚本都没有** ⇒ 飞书 webview 执不执行脚本都一个样；
   *   · 认不出的 `from` 回落缺省（销售），**永不报错、永不空白**。
   *   · 任何异常（取数 / 渲染）都落到 `respondFailure` → **人话页**（还有 `renderMinimalPage` 兜底）。
   */
  // ⭐⭐ 2026-10-12：**两条路共用这两个处理函数**（同一个 router 实例挂在 `/s` 与 `/r` 上）：
  //    · `/s/:number`   ⇒ `req.params.number`   = 编号
  //    · `/r/:recordId` ⇒ `req.params.recordId` = 记录 ID（**新二维码走这条**）
  //    ⚠️ 用**路径数组**把同一个 handler 挂到两个模式上 —— **不复制一份处理逻辑**；
  //      "这一页在取哪一样东西"由挂载点判定（`scanTargetOf`），其余一行都不分叉。
  const loadPendingBatches = async (requestId, timing = null) => {
    if (!arrival()) return null;
    return arrival().pendingBatches({ timing }).catch((error) => {
      logWarn(writeConfig.events.failed, {
        request_id: requestId, reason: 'accept_pending_batches_failed', error: error.message,
      });
      return { ok: false, batches: [] };
    });
  };

  // ⭐⭐ 2026-10-11（方案A）：**扫码验收**（工作台点【验收】→ 在这一页连续扫 → 完成验收）。
  //    ⚠️ 依赖**延迟构造**（在 `services/scanArrivalService.js` 里就地构造：
  //      `GET /s/{编号}` 那一步只用来读会话 —— **零飞书调用**，扫码页"一次扫码 0 次飞书调用"
  //      那条硬要求不能被这个功能破坏；真正要开批次 / 入库时它才构造采购查询与到货核对）。
  //    ⚠️ 本文件因此**只认识 `scanArrivalService` 一个名字**（不 require 任何写链路的 service）——
  //      既有的"路由层不出现写链路服务"哨兵照旧绿。
  //    ⚠️ 用例可以注入 `options.arrivalService`；`false` = 这一版不挂验收模式。
  let arrivalInstance = options.arrivalService || null;
  const arrival = () => {
    if (arrivalInstance === null && options.arrivalService !== false) {
      // eslint-disable-next-line global-require
      const { createScanArrivalService } = require('../services/scanArrivalService');
      arrivalInstance = createScanArrivalService({
        gateway,
        config: writeConfig.acceptance,
        store: options.arrivalSessionStore,
      });
    }
    return arrivalInstance;
  };


  /**
   * 🔴 **绝不空白**：所有"人话页"都从这里发出去 —— 连渲染本身抛错都还有最后一道兜底
   *（`renderMinimalPage` 不依赖任何配置，只有字符串拼接 + 转义，几乎不可能再抛）。
   *
   * 业务负责人 2026-10-09 真机反馈「手机扫码一片空白」之后定的口径：
   * **页面上无论如何都要有看得见的东西** —— 宁可给她一句"暂时打不开"，也不给一张白纸。
   */
  const sendHuman = (res, status, payload) => {
    try {
      return sendHtml(res, status, renderMessage(payload, config));
    } catch (error) {
      logError(config.events.failed, {
        request_id: payload?.requestId, reason: 'message_render_failed', error: error.message,
      });
      return sendHtml(res, status, renderMinimalPage({
        title: payload?.title || config.texts.errorTitle,
        body: payload?.body || config.texts.errorBody,
        requestId: payload?.requestId,
      }));
    }
  };

  const badNumberPage = (res, status, requestId, number = '') => sendHuman(res, status, {
    title: config.texts.badNumberTitle,
    body: config.texts.badNumberBody,
    number,
    requestId,
  });

  /**
   * ⭐⭐ **提交成功页**（`POST submit_order` 写成功之后直接渲染它，不回原页）。
   *
   * 业务负责人真机口径（逐字）：「点击提交之后直接提示"**您的提交已成功**"就行，
   * **页面跳转到提交成功页**。在这个页面上可以提示"**再录一单**"类似的信息，
   * 给一个链接让我能回到扫码页。」
   * ⇒ 与 `sendHuman` 同一套"**绝不空白**"兜底（成功页渲染抛错也还有最后一张人话页），
   *    只是渲染器换成成功页那一个。
   */
  /**
   * ⭐⭐ 2026-10-12（她拍板 · 方案 A，逐字）：「**提交完 ⇒ 自动回首页，而首页 = 销售页** ✓」
   *
   * 成功页要的三件事**只在这里算一次**（三路共用 ✓）：
   *   · `returnPath` = **服务端渲染出来的确定 URL**（她扫的那个编号 + **销售领域**）；
   *   · `autoReturnUrl` = **同一个 URL**（自动跳转与按钮**不可能不一致** ✓ 唯一来源 ✓）；
   *   · `returnDelaySeconds` = 先让她看到结果，再跳（配置里定 ✓）。
   * 配置：`SCAN_PAGE.successReturn`（`homeRealm` 改成别的领域即可回别处 ✓）。
   */
  /**
   * ⭐⭐ 2026-10-12：**写成功之后**记住"这个领域她刚用过"（她："继续扫 ⇒ 自动还是补货"）。
   * ⚠️ 只在**写成功**那几条路上调（看一眼 / 打开页面不算 ✗）；
   *    失败一律吞掉（记不住领域不该影响她这一单 ✓）。
   */
  /** 动作 → 领域（"她刚在哪个领域干过活"）——**一处映射**，别在各 handler 里各写一遍。 */
  const realmOfAction = (action) => {
    const a = String(action || '');
    if (a === writeConfig.actions.submitOrder) return 'sales';
    if (a === writeConfig.actions.submitReplenish) return 'replenish';
    if (a === writeConfig.actions.submitPurchaseReturn) return 'purchase_return';
    // ⭐⭐ 2026-10-14 晚 cut B（改前逐字 → 改后逐字 → 依据）：
    //   改前逐字：`if (a === writeConfig.actions.acceptFinish || a === writeConfig.actions.acceptFinishRows) return 'accept';`
    //   改后逐字：**这一行删掉**
    //   依据：扫码页「完成验收」那两个动作的 handler 已在 cut A 退场（`POST /s/accept` 那条路
    //     也拆了 ⇒ 它们**到不了这里**）；而 `accept` 又在 cut B 从 `REALMS` 退场 ⇒
    //     留着它就是「记下一个**已不存在的领域 id**」
    //     （`resolveRealm` 会把它回落成销售 ⇒ 语义上骗人 ✗）。
    return '';
  };

  const markRealmUsed = (openId, realm) => {
    if (!writeService || !openId) return;
    const sessions = writeService.sessions;
    if (!sessions || typeof sessions.setLastRealm !== 'function') return;
    Promise.resolve(sessions.setLastRealm(openId, realm)).catch((error) => {
      logWarn(config.events.failed, { reason: 'last_realm_write_failed', error: error.message });
    });
  };

  const successReturnFields = (req, target, noticeNo = '') => {
    const cfg = config.successReturn || {};
    if (cfg.enabled === false) return {};
    // ⭐⭐ 2026-10-13：回跳 URL 带**刚提交那一单的单号**（无状态 ✓）⇒ 编号页顶部据此给指引 ✓
    //   ⚠️ 只加键名与单号（单号不是敏感数据 ✓）；不带任何表单值 ✗
    // ⭐⭐ 2026-10-13（她的口径："提交这一单"⇒ 与这一单无关 ✓）：
    //   销售领域的"首页"= **不带编号的入口页**（`config.successReturn.homePath` ✓ 一处改 ✓）
    const homeRealm = cfg.homeRealm || DEFAULT_REALM;
    const landing = cfg.homePath && homeRealm === DEFAULT_REALM
      ? `${req.baseUrl}${cfg.homePath}`.replace(/\/+$/, '') + '/'
      : '';
    const base = landing || postActionFor(target, homeRealm);
    const noticeKey = cfg.noticeKey || 'done';
    const homePath = String(noticeNo || '').trim()
      ? `${base}${base.includes('?') ? '&' : '?'}${encodeURIComponent(noticeKey)}=${encodeURIComponent(String(noticeNo).trim())}`
      : base;
    return {
      returnPath: homePath,
      returnLabel: cfg.label || '',
      returnDelaySeconds: Number(cfg.delaySeconds) || 0,
      autoReturnUrl: homePath,
    };
  };

  // ⚠️ `req` 是**第 4 个可选参数**（task-58 加，只为那条 `scan.page.rendered` 日志 —— 成功页 =
  //    扫码这条链路的第三个落点 ✓）。不传照样能用（老调用点 / 用例不会炸 ✓），只是日志里
  //    `query_keys` 为空、`number` 为空 —— **判定与页面一个字都不受它影响** ✗。
  //    ⭐ task-60：**9 个调用点一个不落全传了 `req`**（含"一单多货品"那条成功页 ✓）——
  //      她点名要的"字段齐"（AC-LR4）就是这条：每一发 `page:'success'` 都说得出来"是哪一件" ✓。
  const sendSuccess = (res, status, payload, req = null) => {
    // ⭐ 成功页 = 她看到的落点之一（先记，再渲染 ⇒ "她看到的"与"日志记的"一致 ✓）
    //    `number` 与资金页那条**同一口径**（`scanTargetOf` ⇒ `/s` 用编号、`/r` 用记录 ID ✓）
    logRendered(req, {
      page: 'success',
      trigger: 'write_ok',
      number: String(scanTargetOf(req)?.value || ''),
    });
    try {
      return sendHtml(res, status, renderSuccess(payload, config));
    } catch (error) {
      logError(config.events.failed, {
        request_id: payload?.requestId, reason: 'success_render_failed', error: error.message,
      });
      return sendHtml(res, status, renderMinimalPage({
        title: payload?.title || config.texts.errorTitle,
        body: payload?.body || config.texts.errorBody,
        requestId: payload?.requestId,
      }));
    }
  };

  /**
   * ⭐⭐ 2026-10-12：**404「没找到这个编号」** 统一从这一处出 —— **人话 + 指得出下一步**。
   *
   * 她真机那次（二维码里编号缺「类别」⇒ 查不到 ⇒ 回 400 / 原始错误页）之后定的口径：
   * **不许再给原始错误页**。这里三种情况各一句人话：
   *   · 普通找不到（没试过兜底）⇒ 与改前**逐字相同**（`notFoundBody`，一个字都不多加）；
   *   · 编号缺段、按（货号 + 颜色）**也没找到** ⇒ 说清"缺了什么、该核对什么"；
   *   · 编号缺段、**匹配到多款** ⇒ 说清"没法确定是哪一双"（**不猜**）。
   * 后两种都给【再扫一次】的回跳（= 这一页的地址，重新扫标签即可）。
   */
  const notFoundPage = (res, requestId, { number = '', fallback = null, realm = DEFAULT_REALM, target = null } = {}) => sendHuman(res, 404, {
    title: config.texts.notFoundTitle,
    body: config.texts.notFoundBody,
    number,
    requestId,
    retryHint: fallback?.tried
      ? (fallback.ambiguous ? config.texts.notFoundAmbiguousHint : config.texts.notFoundFallbackMissHint)
      : '',
    // ⭐ 只有"确实按兜底找过、还是没找到"时才给【再扫一次】那条回跳；
    //   `/r` 底下回跳要带**记录 ID**（不是编号）。
    backPath: fallback?.tried ? postActionFor(target || { mode: 'number', value: number }, realm) : '',
    backLabel: fallback?.tried ? config.texts.notFoundBackLabel : '',
  });

  const respondFailure = (res, error, requestId, timing = null) => {
    // ⭐⭐ 2026-10-12：**第三条出口**也要留痕 —— 她真机那次 400"周围一条日志都没有" ✗，
    //   所以**任何**没预料到的失败都带一份"这次提交带了哪些字段名 / action 是什么形态"（**只字段名** ✗）。
    //   ⚠️ 与 `unknownActionFailure` 同一套字段（便于一起 grep）✓
    logWarn(writeConfig.events.unknownWriteAction, {
      request_id: requestId,
      where: 'respondFailure',
      error: String(error?.message || error || '').slice(0, 200),
      method: 'n/a',
    });
    // ⭐ 失败也要看得出卡在哪一步（她：「一查日志就知道卡在哪一步」）——
    //    在发页面之前把已经量到的那几段打出去（`total_ms` 由 service 写、`render_ms` 为 0）。
    service.logTiming?.(timing, { requestId, found: false });
    if (error?.scanLimitExceeded) {
      // service 已经记过 limitExceeded；这里只负责给她一张人话页面（**不显示半张库存表**）。
      return sendHuman(res, 503, {
        title: config.texts.limitTitle, body: config.texts.limitBody, requestId,
      });
    }
    if (isDataNotReady(error)) {
      res.set('Retry-After', '5');
      return sendHuman(res, 503, {
        title: config.texts.busyTitle, body: config.texts.busyBody, requestId,
      });
    }
    logError(config.events.failed, { request_id: requestId, error: error.message });
    return sendHuman(res, 500, {
      title: config.texts.errorTitle,
      body: config.texts.errorBody,
      requestId,
      retryHint: config.texts.retryHint,
    });
  };

  /**
   * 写入口失败 → **在页面上**说清楚（业务负责人：失败要人话，不许静默、不许只写日志）。
   * ⚠️ 内部错误（飞书错误码 / 表名字段名）**不回显**：`scanWriteService` 已经把它们
   *    换成了配置里的通用人话，原文只进日志。
   */
  /**
   * ⭐⭐ 2026-10-12（她真机 `POST /MK31-1|咖色|B` ⇒ **400 / 1ms**、周围**零日志** ✗）：
   * **"按钮认不出来"必须留痕**，而且三种原因**分开**（修法完全不同 ✓）：
   *   · `missing`      —— 表单里**根本没带** `action`（她点了某颗按钮 ⇒ 可能是**真 bug**）
   *   · `blank`        —— 带了但是空的（老页面 / 手改表单）
   *   · `unrecognized` —— 带了个我们认不出的值
   * ⚠️ 只打**字段名**（`body_keys`），**不打值** ✗；`action` 是**我们的动作名**（不是她的数据）⇒ 截断后打出 ✓。
   */
  const unknownActionFailure = (req, res, requestId, actionRaw) => {
    const body = req.body || {};
    const raw = body[writeConfig.fields.action];
    const kind = raw === undefined ? 'missing' : (String(raw).trim() === '' ? 'blank' : 'unrecognized');
    logWarn(writeConfig.events.unknownWriteAction, {
      request_id: requestId,
      path: String(req.originalUrl || req.path || '').split('?')[0],
      method: req.method,
      action_kind: kind,
      action_received: String(actionRaw ?? '').slice(0, 64),
      body_keys: Object.keys(body),
      content_type: String(req.headers['content-type'] || ''),
      realm: resolveRealm(req.query?.from),
      // ⭐ 2026-10-12：她点的是**哪一版页面**渲染出来的（缺失 ⇒ 旧页面 / 手改表单）
      page_build: String(body[config.pageBuildField || 'page_build'] || '').trim() || 'missing',
      page_build_stale: Boolean(String(body[config.pageBuildField || 'page_build'] || '').trim())
        && String(body[config.pageBuildField || 'page_build'] || '').trim() !== String(config.pageBuild || ''),
      target: String(scanTargetOf(req).value || '').slice(0, 120),
    });
    return respondWriteFailure(res, {
      code: 'unknown_action',
      message: kind === 'unrecognized'
        ? writeConfig.texts.unknownActionBody
        : writeConfig.texts.unknownActionMissingBody,
    }, requestId);
  };

  /**
   * ⭐⭐ 2026-10-14 晚（业务负责人**逐字**）：「**退货整单金额（必填），与补货同一套配置**」
   *   ＋同一晚另一句：「**只写一个整单金额**（一次填一个总额，**和补货一样**～）」。
   *
   * ⇒ **补货 / 退货共用这一个闸门**（一套配置 ✓ 不写两套 ✗）：整单金额**空** ⇒
   *   **400 + 人话 + 一个字都不写**（不建批次 / 不写明细 / 不动库存）——
   *   校验发生在**任何写之前** ⇒「零写入」是**结构性**的，不靠写服务配合 ✓；
   *   **非空 ⇒ 照旧提交** ✓。
   *
   * ⚠️ 与销售那条「每件实收必填」**同一形状**（判据只在**页面这条路由**上；服务层一行不动）——
   *    差别只有出口：销售那条回**资金页**（她还得在那一页点按钮），采购这两条回
   *    **一张人话页 + 一颗「回上一页」的链接**（那一页的表单还在，她补一个数字再提交 ✓）。
   * ⚠️ 这张页面**不写任何业务表**（`sendHuman` 只把 HTML 发出去 ✓）。
   * ⭐⭐ 2026-10-15（③ 写入 · 她裁决 ⓐ「复用「实际金额」」）**改指向**：
   *   改前逐字：`🔴 本版**只判"填没填"**（她的原话就是「必填」）：数字格式不做额外校验、金额也**不落表**`
   *   改后逐字：**两件事都变了** —— ① 那个数现在**要落表**（退货批次行的「实际金额」）；
   *     ② ⇒ 多一道「**必须是数字**」的闸门（`purchaseAmountInvalidPage`，见下面）——
   *     放一个非数字过去 = "页面填了、表里没有" = **假成功** ✗（她最在意的一条）。
   *   依据：她 2026-10-14 晚「退货整单金额（必填），与补货同一套配置」＋ 2026-10-15 裁决 ⓐ
   *     ＋ 那一列是**数字列**（`v1BitableSchema` 的 `purchaseOrderBatch.actualAmount`）。
   */
  const purchaseAmountMissingPage = (req, res, requestId, realm) => {
    logWarn(writeConfig.events.purchaseAmountRequired, {
      request_id: requestId,
      realm,
      reason: 'amount_empty',
      target: String(scanTargetOf(req).value || '').slice(0, 120),
    });
    // ⭐ 埋点 P0 ②：这次点击的结果原因码（`ui.tap.result` 用它 ⇒ 一眼看出"她填漏了"）
    markTapCode(res, 'purchase_amount_required');
    return sendHuman(res, 400, {
      title: writeConfig.texts.purchaseAmountMissingTitle,
      body: writeConfig.texts.purchaseAmountMissingBody,
      requestId,
      retryHint: writeConfig.texts.failedRetryHint,
      // 回"她刚才那一块"（编号 + 同一个领域）—— 不然她只能靠浏览器的返回键。
      backPath: postActionFor(
        backTargetFor(req, decodeURIComponent(String(req.params.number || ''))), realm,
      ),
      backLabel: writeConfig.texts.purchaseAmountBackLabel,
    });
  };

  /**
   * ⭐⭐ 2026-10-16（A2/A3 接线 · 业务负责人**逐字**）：**当前这条链路**要不要「整单金额」。
   *
   * 依据（她**逐字**）：
   *   · 2026-10-16：「**补货不问金额**」（＋「不用做那个为空去单价的功能了」）；
   *   · 2026-10-14 晚：「**退货整单金额（必填），与补货同一套配置**」
   * ⇒ **补货不问金额** ✓；**退货 / 验收不受影响** ✓（`requiredByRealm.return / .accept` 仍是显式 `true`）。
   *
   * ⭐ 实现 = **按链路分档**：取 `PURCHASE_AMOUNT.requiredByRealm[realm]`（一个链路一个**显式布尔** ✓）。
   *   · **改前逐字**（两个闸门各自一行）：`if (writeConfig.purchaseAmount?.required === false) return false;`
   *     —— 那是"**一个开关管两条链路**"：一关就把退货也放开 ✗（#667 查实的事实）。
   *   · **改后逐字**：`if (purchaseAmountRequiredFor(realm) === false) return false;`
   *   · 依据：她 2026-10-16「补货不问金额」＋ 2026-10-14「退货整单金额（必填），与补货同一套配置」。
   *
   * ⚠️ **只认显式布尔，不写 `||` 兜底** ✗ —— `requiredByRealm[realm] || 默认值` 那种形状会让
   *   "清空变量"回退成默认值 ⇒ **关不掉**（见 `AGENTS.md`《配置先行》那条）。
   * ⚠️ 老键 `required` **不改名、仍然先读**（兼容面：老 `.env` 里写 `false` / 空串 ⇒ **整套闸门关掉**，
   *   **一个字节的老行为都没变** ✓）。它只会把闸门**关小**（更严），**不会**把退货那道必填**放开** ✗
   *   ⇒ 所以「退货 / 验收不受影响」在**任何** `.env` 取值下都成立 ✓。
   * ⚠️ `realm` 认不出来（**不该发生**：两个调用点都传**字面量**，见下面两处）⇒ 按"**要金额**"判（宁严不宽 ✓）。
   * ⚠️ 调用点传的是**档位键**（`'replenish'` / `'return'`）——⚠️ 与页面的**领域 id**（`'purchase_return'`）
   *   **故意不同名**：档位键由 `config/scanWrite.js` 的三个 `readFlag` 决定（`replenish` / `return` / `accept`），
   *   所以退货那一处**逐字传 `'return'`** ✗ 不是 `'purchase_return'`（传错 = 拿错档位 ⇒ 判据会红 ✓）。
   */
  const purchaseAmountRequiredFor = (realm) => {
    if (writeConfig.purchaseAmount?.required === false) return false;
    const tiers = writeConfig.purchaseAmount?.requiredByRealm;
    if (tiers && tiers[realm] === false) return false;
    return true;
  };

  /**
   * 「整单金额**填了没有**」（补货 / 退货共用，只判空）——
   * 空 ⇒ `true`（调用方立刻回 400，**一步都不往下走**）；非空 ⇒ `false`（照旧提交 ✓）。
   * ⭐⭐ 2026-10-16：**加"当前链路"入参** ⇒ 由 `purchaseAmountRequiredFor(realm)` **按链路**决定要不要判
   *   （补货那一档 = `false` ⇒ 直接放行 ✓；退货那一档 = `true` ⇒ 照旧判 ✓）。
   * ⚠️ 关掉闸门 = 配置 `SCAN_PURCHASE_AMOUNT_REQUIRED`（**显式布尔**，`readFlag` ✓）
   *   ＋ **按链路** `SCAN_PURCHASE_AMOUNT_REQUIRED_{REPLENISH,RETURN,ACCEPT}`（各一个显式布尔 ✓）。
   */
  const purchaseAmountMissing = (body, realm) => {
    if (purchaseAmountRequiredFor(realm) === false) return false;
    return String(body?.[writeConfig.fields.purchaseAmount] ?? '').trim() === '';
  };

  /**
   * ⭐⭐ 2026-10-15（③ 写入）：整单金额**填了但不是数字** ⇒ 也当场拦住。
   *
   * 依据：她 2026-10-14 晚「退货整单金额（必填），与补货同一套配置」＋ **2026-10-15 裁决 ⓐ**
   *   （列名 = 复用「实际金额」）⇒ 那个数要落进**数字列** `purchaseOrderBatch.actualAmount`。
   *   ⇒ 放一个非数字过去就是「**页面填了、表里没有**」= 假成功 ✗（她最在意的一条）。
   *
   * ⚠️ 与"空"**分两道**（各有各的人话）：空 ⇒ `purchaseAmountMissingPage`（"还没填"）；
   *   非空但认不出数字 ⇒ 本函数 → `purchaseAmountInvalidPage`（"要填数字"）。
   * ⚠️ 判据是**收紧**，不是放宽 ✓；关掉整套闸门仍是 `SCAN_PURCHASE_AMOUNT_REQUIRED` ✓
   *   ＋ **按链路** `SCAN_PURCHASE_AMOUNT_REQUIRED_RETURN`（那一档 = `false` ⇒ 这条也一起放行 ✓）。
   * ⚠️ 服务层还有**同一条**数值判据（`purchaseOrderBatchService.writeOrderAmount` 的
   *   `numericOrNull`）⇒ 就算有人绕过这条路由直调写服务，也**不会**写进坏值/空值 ✓（只会如实报失败）。
   */
  const purchaseAmountInvalid = (body, realm) => {
    if (purchaseAmountRequiredFor(realm) === false) return false;
    const raw = String(body?.[writeConfig.fields.purchaseAmount] ?? '').trim();
    if (raw === '') return false; // 空的那条由上面那道闸门管（各有各的人话 ✓）
    return !Number.isFinite(Number(raw));
  };

  /** 「要填数字」那张人话页（与"还没填"同一形状：H1 + 怎么填 + 回上一页 + 埋点原因码）。 */
  const purchaseAmountInvalidPage = (req, res, requestId, realm) => {
    logWarn(writeConfig.events.purchaseAmountRequired, {
      request_id: requestId,
      realm,
      reason: 'amount_invalid',
      target: String(scanTargetOf(req).value || '').slice(0, 120),
    });
    markTapCode(res, 'purchase_amount_invalid');
    return sendHuman(res, 400, {
      title: writeConfig.texts.purchaseAmountInvalidTitle,
      body: writeConfig.texts.purchaseAmountInvalidBody,
      requestId,
      retryHint: writeConfig.texts.failedRetryHint,
      backPath: postActionFor(
        backTargetFor(req, decodeURIComponent(String(req.params.number || ''))), realm,
      ),
      backLabel: writeConfig.texts.purchaseAmountBackLabel,
    });
  };

  /**
   * ⭐⭐ 2026-10-16（口子收尾 · 业务负责人**逐字**口径）：
   *   「**异步只针对"写库"**；**校验必须当场同步拦**」——**尺码 / 数量 / 空单**这三类
   *   （判据与写层同源：`config/scanPurchaseEntryRules.js` ⇒
   *    `services/scanWriteService.js:1397-1426`（补货）/ `:1556-1585`（退货））。
   *
   * 🔴 命中 ⇒ **400 + 同一句人话 + 零写入 + 一次后台都不排** ✓
   *   （拦在 `schedulePurchaseWrite(…)` **之前** —— 顺序不能反 ✗）；
   *   通过 ⇒ 才排后台（异步那半**一个字不改** ✗）。
   *
   * ⚠️ 与"金额那两张页"**同形**（H1 + 人话 + 回上一页 + 埋点原因码 ✓）：
   *   · 正文**就是写层那一句**（`violation.message` —— 配置里的 `TEXTS.*Body` ✓ 不新造第二句 ✗）；
   *   · `code` 走 `markTapCode`（埋点能按它分辨是哪一类 ✓）；
   *   · 日志走 `writeConfig.events.entryInvalid`（**与写失败 `failed` 分开**：原因不同、修法不同 ✓）。
   * ⚠️ 这张页面**不写任何业务表**（`sendHuman` 只把 HTML 发出去 ✓）⇒「零写入」是**结构性**的 ✓。
   */
  const purchaseEntryInvalidPage = (req, res, requestId, realm, violation) => {
    logWarn(writeConfig.events.entryInvalid, {
      request_id: requestId,
      realm,
      reason: String(violation?.code || 'entry_invalid'),
      target: String(scanTargetOf(req).value || '').slice(0, 120),
    });
    markTapCode(res, String(violation?.code || 'entry_invalid'));
    return sendHuman(res, 400, {
      title: ENTRY_RULE_TEXTS.entryInvalidTitle,
      // 🔴 **写层那一句原样**（同一句人话 ✓）：`sizeUnknownBody` /
      //    `quantityInvalidBody{max}` / `replenishNoneBody` / `returnNoneBody`。
      body: String(violation?.message || writeConfig.texts.internalFailedBody),
      requestId,
      retryHint: writeConfig.texts.failedRetryHint,
      backPath: postActionFor(
        backTargetFor(req, decodeURIComponent(String(req.params.number || ''))), realm,
      ),
      backLabel: writeConfig.texts.purchaseAmountBackLabel,
    });
  };

  const respondWriteFailure = (res, result, requestId) => {
    // 2026-10-14 (real gap): a write failure used to log NOTHING. Only-add, existing event name.
    logError(writeConfig.events.failed, {
      request_id: requestId, reason: 'write_failed', code: String(result?.code || ''),
      where: 'respondWriteFailure',
    });
    // 500 = 系统那边没处理成（写库失败）；400 = 她填错了 / 数据不满足业务（一个字节都没写）。
    // ⭐ `sale_partial_failed` 也归 500：单子记上了、后面某步没写完 —— 不是她填错。
    const status = ['sale_write_failed', 'sale_partial_failed', 'replenish_write_failed', 'return_write_failed'].includes(result.code)
      ? 500 : 400;
    // ⭐ 2026-10-12：**钱算不对那几类**（差额 / 付款情况 / 实付多少 / 全付零元…）⇒
    //    把那句**人话差额**放到**最上面那一行（H1）**：她第一眼看到的就是"差在哪、差多少"，
    //    而不是一句泛泛的「没提交成功」。
    const moneyCodes = ['amount_mismatch', 'payment_amount_invalid', 'payment_status_invalid',
      'payment_amount_missing', 'partial_amount_missing', 'full_without_money'];
    const human = String(result.error?.scanUserMessage || result.message || '').trim();
    const moneyFailure = Boolean(human) && moneyCodes.includes(result.code);
    // ⭐ 埋点 P0 ②：把**业务原因码**留给结果事件（`ui.tap.result.code`）——
    //   与 ③ 那条「失败日志带人话原因码」同一个口径（`scan.write.settlement_blocked` 那类）。
    markTapCode(res, result.code || `http_${status}`);
    return sendHuman(res, status, {
      title: moneyFailure ? human : writeConfig.texts.failedTitle,
      body: moneyFailure ? writeConfig.texts.failedTitle
        : (result.message || writeConfig.texts.internalFailedBody),
      requestId,
      retryHint: writeConfig.texts.failedRetryHint,
    });
  };

  /**
   * ⭐ 写成功之后**立刻作废**「实时库存」内存快照（她的硬要求：**库存准确**，
   * 不能等 30 秒那一拍）。
   *
   * 🔴 为什么调用点在**路由**（而不是写服务）：本任务的写作用域只覆盖到扫码这条链路的
   *    `routes/scanPage.js`；`services/scanWriteService.js` 刻意一行都没动。
   *    其余写入口（销售入账 / 到货 / 手工库存调整 / 交付扣减）**不在本任务作用域内**，
   *    它们各自在写成功后加一行同样的调用即可（跨模块、零注入，谁都不认识扫码页）：
   *    `require('../services/liveInventorySnapshot').invalidateLiveInventorySnapshot('原因')`
   *    —— 详见 `services/liveInventorySnapshot.js` 的注释。
   */
  const invalidateInventorySnapshot = (requestId, reason) => {
    try {
      invalidateLiveInventorySnapshot(reason);
    } catch (error) {
      // 失效失败**不许**把已经写成功的业务打成 500（那才是最坏的）：记一条 warn 就够了。
      logWarn(config.events.failed, {
        request_id: requestId, reason: 'snapshot_invalidate_failed', error: error.message,
      });
    }
  };

  const openIdOf = (req) => String(
    req.workbenchUser?.open_id || getSessionUser(req)?.open_id || '',
  );

  /**
   * 表单的 POST 目标（= 处理完回跳到哪一页）。
   *
   * ⭐ **必须带上领域**：不然她在【销售】那一块点「加入本单」，303 回来会落在
   *   **缺省领域**、刚填的本单看不见了。
   *   ⚠️ 缺省领域（2026-10-11 起 = **销售**）不带 `?from=`（URL 干净，且既有断言一字不变）；
   *      另外三个领域一律带 `?from=<领域>` ⇒ **回跳停在本单所在的领域**。
   *   ⚠️ 这个函数**同时被 `buildWriteContext`（拼表单 action）与 POST 的 303 两处用** ——
   *      表单 action 带上了 `?from=`，POST 里 `resolveRealm(req.query?.from)` 才读得到领域。
   *      （2026-10-11 修的一处：表单 action 原来漏传 realm，导致回跳落到缺省领域。）
   */
  // ⭐⭐ 2026-10-12（治根）：**两条路共用同一个 router 实例**（`app.js` 把同一实例挂在 `/s` 与 `/r`）。
  //    ⇒ 「这一页在取哪一样东西」**只有一个判据**：挂载点（`req.baseUrl`）。
  //    · `/s/:number`   ⇒ `{ mode: 'number',   value: 编号 }`
  //    · `/r/:recordId` ⇒ `{ mode: 'recordId', value: 记录 ID }`
  //    🔴 **不许**在别处再拼一套路径（`postActionFor` 是唯一出口）—— 两边各写一份必然漂。
  const isRecordBase = (req) => String(req.baseUrl || '') === String(config.route.recordBasePath || '');
  const scanTargetOf = (req) => {
    const raw = req.params?.recordId !== undefined ? req.params.recordId : req.params?.number;
    const value = decodeURIComponent(String(raw ?? ''));
    return { mode: isRecordBase(req) ? 'recordId' : 'number', value };
  };
  /**
   * ⭐⭐ 回跳时用哪个值：`/r` 底下用**记录 ID**（URL 上那个），
   * `/s` 底下**沿用调用方原来那个值**（`view.number` / URL 里的编号）—— **逐字不变**。
   */
  const backTargetFor = (req, fallbackValue) => (isRecordBase(req)
    ? scanTargetOf(req)
    : { mode: 'number', value: fallbackValue });

  /** 这一页的"取商品"入参（`scanPageService.lookup` 的两条路共用同一份出参约定）。 */
  const lookupInputOf = (req) => {
    const target = scanTargetOf(req);
    if (target.mode === 'recordId') {
      // 「拿到 recordId 但那条货品读不到」时的**回退**：URL 上若还带着编号就按编号再试一次。
      const fallbackNumber = String(req.query?.[config.route.recordNumberQuery] ?? '').trim();
      return { recordId: target.value, number: fallbackNumber || undefined };
    }
    return { number: target.value };
  };

  /**
   * 表单的 POST 目标（= 处理完回跳到哪一页）。
   *
   * ⭐ **必须带上领域**：不然她在【销售】那一块点「加入本单」，303 回来会落在
   *   **缺省领域**、刚填的本单看不见了。
   *   ⚠️ 缺省领域（2026-10-11 起 = **销售**）不带 `?from=`（URL 干净，且既有断言一字不变）；
   *      另外三个领域一律带 `?from=<领域>` ⇒ **回跳停在本单所在的领域**。
   *   ⚠️ 这个函数**同时被 `buildWriteContext`（拼表单 action）与 POST 的 303 两处用** ——
   *      表单 action 带上了 `?from=`，POST 里 `resolveRealm(req.query?.from)` 才读得到领域。
   *      （2026-10-11 修的一处：表单 action 原来漏传 realm，导致回跳落到缺省领域。）
   *   ⭐⭐ 2026-10-12：第一个入参**同时接受**一个目标对象（`{mode,value}`，见 `scanTargetOf`）
   *      **或**一个字符串（= 按编号，既有调用点逐字不变）。挂载点决定拼 `/s` 还是 `/r`。
   */
  const postActionFor = (target, realm = DEFAULT_REALM) => {
    const resolved = target && typeof target === 'object'
      ? target
      : { mode: 'number', value: target };
    const basePath = resolved.mode === 'recordId'
      ? String(config.route.recordBasePath || '')
      : config.route.basePath;
    const path = `${basePath}/${encodeURIComponent(String(resolved.value || ''))}`;
    return realm && realm !== DEFAULT_REALM ? `${path}?from=${encodeURIComponent(realm)}` : path;
  };

  // ── ⭐⭐ 2026-10-11：扫码页「货品」领域 →【打印这一款】（送到店里那台电脑）────────
  /**
   * 打印队列（**延迟构建**，用例可注入 `options.labelPrintQueue`）。
   * ⚠️ 与电脑侧路由共用 `labelPrintQueueRuntime` 的单例 —— 那条长连接才收得到推送。
   */
  let labelPrintQueue = options.labelPrintQueue || null;
  const resolveLabelPrintQueue = () => {
    if (!labelPrintQueue) labelPrintQueue = getLabelPrintQueue();
    return labelPrintQueue;
  };

  /**
   * 渲染「货品」领域要的**打印上下文**（只放事实：在线与否 + 本次/最近一次任务 + 文案 + 回跳）。
   *
   * ⭐⭐ 2026-10-11 真机反馈（「点完没有反馈 ⇒ 她以为没点上、连点几次 ⇒ 多打了好几张」）之后：
   *    · `submitted`（`?printed=1&job=<id>`）⇒ 渲染层出**显眼横幅**：
   *      「✅ 已发送给打印电脑：本次 N 张」+ 在线/未连接 + 「已提交，不用重复点」；
   *      N 与状态**从那条任务上读**（`jobId`）—— 不是页面上猜的。
   *    · `duplicated`（`?dup=1&job=<id>`，= 去重窗口内又点了一次）⇒ 横幅改成
   *      「刚刚已经发过一次：本次 N 张（没有重复提交）」+ 一句"确实要再打一张"+
   *      **【再打一张】** 按钮（带 `again=1`，绕过窗口）。
   *
   * ⚠️ **绝不让这一页因为打印链路坏掉而空白**：队列不可用 ⇒ `enabled: false`，
   *    渲染层如实说一句"打印服务暂时不可用" + 保留原来那两条链接（人话，不是白屏）。
   */
  const buildPrintContext = async (number, realm, { requestId, submitted, duplicated, jobId, target = null } = {}) => {
    const texts = LABEL_PRINT_QUEUE.texts;
    // ⭐ 表单 action 落在哪条路上：`/r` 底下是**记录 ID**（`target` 由调用方给），
    //    缺省 `{mode:'number'}` = 与改前**逐字相同**。
    //    ⚠️ `number` 这个入参仍然是**编号**（打印队列按编号找"这一款最近一次"），不要混。
    const base = {
      enabled: true,
      submitted: Boolean(submitted),
      duplicated: Boolean(duplicated),
      postAction: postActionFor(target || { mode: 'number', value: number }, realm),
      actionField: writeConfig.fields.action,
      actionValue: writeConfig.actions.printLabel,
      submitKeyField: LABEL_PRINT_QUEUE.submitKeyField,
      againField: LABEL_PRINT_QUEUE.againField,
      texts,
    };
    try {
      const queue = resolveLabelPrintQueue();
      if (typeof queue.isEnabled === 'function' && !queue.isEnabled()) {
        return { ...base, enabled: false };
      }
      const [status, latest] = await Promise.all([
        queue.status(),
        queue.latestJobForNumber(number),
      ]);
      // 本次（刚提交的那一条）优先：横幅上的"N 张"要跟**她刚点的那一次**对得上。
      const justNow = jobId ? await queue.getJob(jobId).catch(() => null) : null;
      // ⚠️ 只认"这一条任务确实是这一款"的 —— URL 里的 job 参数是手改得了的，不许拿来显示别的款。
      const mine = justNow && Array.isArray(justNow.numbers) && justNow.numbers.includes(number) ? justNow : null;
      // ⭐⭐ 2026-10-12（她：「点完之后没有 Toast、按键置灰之类的提示，页面完全没有及时的交互反馈
      //    ⇒ 我不知道指令到底有没有到达，就会一直狂点」）⇒ 横幅上要回答"**排在第几位**"。
      //    ⚠️ 只读一次；**读不到就不显示这一句**（宁可不说，也不编一个数给她）。
      const queuePosition = mine && typeof queue.queuePositionOf === 'function'
        ? await queue.queuePositionOf(mine.job_id).catch(() => null)
        : null;
      return {
        ...base,
        online: Boolean(status.online),
        last_seen_at: status.last_seen_at || '',
        count_queued: status.counts?.queued || 0,
        // 横幅用"刚提交的那一条"（拿不到就退回最近一次 —— 至少不是空白）。
        banner_job: mine ? queue.summaryOf(mine) : null,
        queue_position: queuePosition,
        job: mine ? queue.summaryOf(mine) : latest,
      };
    } catch (error) {
      logError('scan.label_print.ready_failed', { request_id: requestId, error: error.message });
      return { ...base, enabled: false };
    }
  };

  // ── ⭐⭐ 2026-10-11（方案A）：扫码验收 ──────────────────────────────────────
  /** 验收表单的 POST 目标：落地页（没有编号那一刻）与逐码页（有编号）各一个。 */
  router.get('/', async (req, res) => {
    const requestId = req.requestId;
    const number = String(req.query?.number || '').trim();
    if (number) {
      logInfo(config.events.salesHomeOpened, { request_id: requestId, by: 'manual' });
      return res.redirect(302, `${req.baseUrl}/${encodeURIComponent(number)}`);
    }
    const noticeKey = config.successReturn?.noticeKey || 'done';
    const orderNo = String(req.query?.[noticeKey] || '').trim().slice(0, 40);
    return sendHtml(res, 200, renderSalesHome({ config, orderNo, basePath: req.baseUrl }));
  });

  /**
   * ⭐⭐ **`GET /s/:number?from=<领域>`** —— 手机扫开的那一页。
   *
   * 2026-10-09 真机（飞书 webview 白屏）之后这一条重做过：
   *   · **服务端按 `from` 只渲染那一块**（不再靠 `<head>` 内联脚本 + CSS 显隐）；
   *   · 页面里**一行前端脚本都没有** ⇒ 飞书 webview 执不执行脚本都一个样；
   *   · 认不出的 `from` 回落缺省（销售），**永不报错、永不空白**。
   *   · 任何异常（取数 / 渲染）都落到 `respondFailure` → **人话页**（还有 `renderMinimalPage` 兜底）。
   */
  // ⭐⭐ 2026-10-12：**两条路共用这两个处理函数**（同一个 router 实例挂在 `/s` 与 `/r` 上）：
  //    · `/s/:number`   ⇒ `req.params.number`   = 编号
  //    · `/r/:recordId` ⇒ `req.params.recordId` = 记录 ID（**新二维码走这条**）
  //    ⚠️ 用**路径数组**把同一个 handler 挂到两个模式上 —— **不复制一份处理逻辑**；
  //      "这一页在取哪一样东西"由挂载点判定（`scanTargetOf`），其余一行都不分叉。
  const ROUTE_PATTERNS = [config.route.path, config.route.recordPath].filter(Boolean);
  /**
   * ⭐⭐ 2026-10-13（她问"我点了几次"）：**前端点击埋点** `ui.tap`。
   * ⭐⭐ 2026-10-14 晚（埋点 P0 ②④⑤）：处理体**上移到 `utils/uiTapReport.js`** ——
   *   与**工作台**共用同一份实现（`handleUiTap`：事件名 / 字段 / ④ 判据 / 204-400 契约），
   *   本文件只保留"挂在哪个路径上"（路径的唯一真源仍是 `SCAN_PAGE.tapFeedback.reportPath`，
   *   渲染层写 URL 也读它 ✓）。
   *
   * · 通道：`navigator.sendBeacon('/<prefix>/ui-tap?target=…&tap_id=…&since_ms=…&page=…')`
   *   （**不阻塞跳转** ✓ 失败静默 ✓）
   * · 🔴 **只记 target（我们的标识）**：`realm:replenish` / `submit:submit_order`
   *   —— **不采集任何表单值 / 个人信息** ✗；用 query 传（零 body 解析 ✓）
   * · 挂在扫码路由下（`/s` `/r` 都有 ✓）⇒ **不动 `app.js`** ✓
   * · 同一个 target 在配置窗口内又被点 ⇒ **独立事件** `ui.tap.repeated`（④，服务端判 ✓）
   */
  router.post(config.tapFeedback?.reportPath || '/ui-tap', (req, res) => handleUiTap({
    req, res, scope: 'scan', realm: resolveRealm(req.query?.from),
  }));


  router.get(ROUTE_PATTERNS, async (req, res) => {
    const requestId = req.requestId;
    // ⚠️ 领域来自查询串（她给的参数名就是 `from`）；认不出来一律回落缺省，**不报错**。
    //    ⭐ 2026-10-11：六个领域（销售 · 补货 · 退货 · 验收 · 库存 · 货品）都是**真领域**，
    //      统一走 `resolveRealm` 就够；已退役的 `purchase` 认不出来 ⇒ 回落销售（既有口径）。
    //    ⚠️ `explicit` 区分"**裸扫**（一个 `from` 都没有，标签二维码就是这样）"与
    //      "她**点**了某个领域 tab（链接一定带 `?from=`）" —— 下面验收接管只对**裸扫**生效，
    //      这样"她点销售/库存…就能离开验收"才真的成立（`?from=sales` 不能被接管）。
    const askedRaw = String(req.query?.from ?? '').trim();
    const explicitRealm = askedRaw !== '';
    let realm = resolveRealm(askedRaw);
    // ⭐ task-58：**这一页的领域是怎么来的**（只为那条 `scan.page.rendered` 日志，不参与任何判定 ✗）：
    //   `explicit`   —— URL 上带了 `?from=`（她点的那个 tab）
    //   `remembered` —— 裸扫 + 她最近一次做过写操作的领域（下面那一支）
    //   `default`    —— 裸扫且从没记过 ⇒ 缺省（销售）
    let realmSource = explicitRealm ? 'explicit' : 'default';
    // ⭐ 分阶段耗时（出参）：失败 / 找不到时同样能看出卡在哪一步。
    // ⭐⭐ 2026-10-13（她：加载到中间一直白屏）：**骨架屏开关**（默认关 ⇒ 这一页与改动前逐字相同）。
    //   打开时：**先回骨架**（不读任何表）⇒ 她立刻有东西看；数据由骨架里那**同一段脚本**
    //   再 `fetch('?data=1')` 拿回来 —— ⚠️ `data=1` 一路落到下面**原有的整页渲染**（同一个
    //   `service.lookup` ✓ 不新增取数路径 ✓），所以两条路径的数据必然一致 ✓。
    //   ⚠️ 只覆盖**编号页/记录 ID 页**这一条；`GET /`（新首页）与所有写入口一个字不动 ✓
    // ⭐ 2026-10-14：骨架**只服务"首次进入"**（不带 `?from=`）——
    //   她「六格没问题、不要改动」+「中间态数据加载中」✗ ⇒ 点六格（带 `?from=`）**直接出整页** ✓
    //   判据在配置里（`config.skeleton.firstEntryOnly` ✓ 显式布尔 ✓ 不写 `||` 兜底 ✗）
    const skeletonFirstEntryOnly = config.skeleton?.firstEntryOnly === true;
    const hasRealmQuery = String(req.query?.from || '') !== '';
    if (config.skeleton?.enabled === true && String(req.query?.data || '') !== '1'
      && !(skeletonFirstEntryOnly && hasRealmQuery)
      && (lookupInputOf(req).number || lookupInputOf(req).recordId)) {
      logInfo(SCAN_PAGE.events?.skeletonServed || 'scan.page.skeleton', { request_id: requestId });
      // ⭐ task-58：骨架屏也是一个落点（她那一发 `?data=1` 才是真正的货品页）——
      //   两条都留痕，才分得出"这一发只是骨架"与"这一发已经出货品页" ✓
      logRendered(req, {
        page: 'skeleton',
        trigger: 'skeleton_first_entry',
        number: String(lookupInputOf(req).number || lookupInputOf(req).recordId || ''),
      });
      return sendHtml(res, 200, renderScanSkeleton(lookupInputOf(req), config));
    }
    // ⭐⭐ 2026-10-14（业务负责人：**点「提交这一单」只到资金页**）：她**刷新**这一页时，
    //   如果会话里记着"已经走到资金这一步"（`paymentStep === 'pending'`）⇒ ⭐ **仍给资金页** ✓
    //   （否则刷新会掉回普通录入页 ⇒ 她会以为"白填了"✗）。其它情况**一个字都不改** ✓走老逻辑。
    //   ⚠️ 只认会话标记（**不认任何查询串** ✗）⇒ 别人/别的情况下拿不到这一页 ✓
    if (String(req.query?.data || '') !== '1'
      && (lookupInputOf(req).number || lookupInputOf(req).recordId)) {
      const pendingSession = await writeService?.sessions?.get?.(openIdOf(req)).catch(() => null);
      // ⚠️ task-60：`const` → **`let`** —— 她选的 ② 要在下面把这条标记**清成"没有"**
      //    （`pendingMark = ''`）⇒ 那条既有接管**不再命中**（它的那一行**逐字未动** ✓）。
      let pendingMark = pendingSession?.sale?.paymentStep || pendingSession?.paymentStep;
      // 🔴 2026-10-14 晚（她真机：扫了码之后点「库存 / 补货 / 退货」**全都变成资金页**）：
      //   ⭐ 根因 = 上面这段"刷新仍给资金页"**没按领域限制** ✗ ⇒ 只要会话里还有 `pending`，
      //     她点**任何**领域都被资金页接管 ✗。
      //   ⇒ 修法（**只收紧、不改别的** ✓）：只在**销售**这一块才允许接管 ——
      //     · `from=sales`（她刷新销售页 ⇒ 仍给资金页 ✓ 不丢她刚填的 ✓）
      //     · 或**没带 `from`**（裸扫通常就是销售入口 ✓ 保持原有体验 ✓）
      //     · **其它领域**（库存/补货/退货/…）⇒ ⭐ **一律不接管**（照旧给那一块 ✓）
      const salesContext = String(req.query?.from || '') === '' || String(req.query?.from) === 'sales';
      /**
       * ⭐⭐ 2026-10-16（task-60 · 她真机 05:34「扫货品码却出现资金页」＋ **她当日亲口选的方案 ②**）：
       *   我给的选项（逐字）：「① 接管前先核对"是不是这个货品" 还是 ② 重扫同一个货品就从头开始
       *   （清掉那条未完成）？」⇒ 她答（逐字）：**「② 还是重扫同一个货品就从头开始（清掉那条未完成 ✓）」**。
       *
       * ⇒ **扫到货品、点「销售」那一发**（= 显式 `?from=sales`；realm tab 的链接就是它，
       *   `views/scanPageRenderer.js` 的 `href="?from=<领域>"` ✓）**先把那条"未完成"的标记清掉**
       *   ⇒ 这一发**从货品页开始** ✓（不再被"上一单的资金页"顶掉 ✗ —— 那正是她的截图）。
       *
       * 🔴 **清的范围（她逐字"清掉那条未完成"，别清过头 ✗）**：
       *   · 只清 **`paymentStep`** ＋ 与它同笔的 **`submitPending`**（那是她 2026-10-15 定下的
       *     "点按钮那一刻要写的那一双"pay 载荷 ⇒ `paymentStep` 一清它就没有读点，同笔清是纯卫生 ✓）；
       *   · **`lines` / `order_no` / `master_record_id` / `status` / `completed` / `seq` 一个字都不碰** ✗
       *     ⇒ 会话里那笔"已建单 / 已提交"的事实**原样留着**（她还能在工作台查到那一单 ✓）；
       *   · **只写她这条会话**（`openIdOf(req)` 来自**签名 cookie** ⇒ 别人的会话碰不到 ✗）；
       *   · **零业务表写入**：这一段只调 `sessions.saveDraftLines`（本地会话）—— 飞书一个字节都不写 ✓。
       *
       * ⚠️ **为什么只认显式 `?from=sales`、**裸扫不清** ✗**（这是本刀最容易做错的一处）：
       *   裸扫那条路挂着她 2026-10-14 定的**「资金页刷新不丢」**（"点提交 ⇒ 到资金页 ⇒ 刷新仍在资金页"）
       *   —— 判据是 `test/scanSalePayFront.test.js` 的 AC-PF4 ＋ `test/scanPaymentStepStale.test.js` 的
       *   AC-SM2/SM3/SM7/SM8（那几条**一条都没改** ✓）。在裸扫上清 ⇒ 把她**刚填完、正停在资金页**
       *   的那一单打回录入页 ✗ = **清过头**。
       *   ⭐ **线上（骨架屏开 + `firstEntryOnly`）裸扫先回骨架、`?data=1` 又绕过接管**
       *     ⇒ 能落到资金页的入口**只有她点「销售」这一发** ✓ ⇒ **就在这一发清** = 正好治她那一下 ✓
       *     （上一任的只读诊断 §2.3/§3.1 已证；骨架屏**关**时裸扫也会到资金页，那也照旧不动 ✓）。
       *   ⚠️ 与"**残标记自清理**"（下面那一段，**逐字未动** ✓）**各司其职**：
       *     那条治"有 pending 但**没东西要付**"（2026-10-15 的 #598/#601）；这条治"**她主动重扫**"。
       */
      const explicitSalesScan = String(req.query?.from || '') === 'sales';
      if (pendingMark === 'pending' && explicitSalesScan) {
        const hadSubmitPending = Boolean(pendingSession?.sale?.submitPending);
        let reset = false;
        try {
          // ⚠️ `undefined` = "这个键不在"（`services/scanSessionService.js` 默认 `sale` 的形状 ✓
          //    既有表示、**不新造状态值** ✗）—— 与下面那条残标记清理**同一种清法** ✓。
          await Promise.resolve(writeService.saveDraftLines?.(
            openIdOf(req), { paymentStep: undefined, submitPending: undefined },
          ));
          reset = true;
        } catch (error) {
          // 清失败**不许破她的页面**（这是 GET 渲染路径）⇒ 只 warn，照旧出整页 ✓
          logWarn(config.events?.paymentStepResetFailed || 'scan.payment_step.reset_failed', {
            request_id: requestId, error: error.message,
          });
        }
        // **不静默**：真机排查时这一条说明"那条未完成是**按她选的 ②** 清掉的"，并如实带旧状态 ✓
        logInfo(config.events?.paymentStepResetOnScan || 'scan.payment_step.reset_on_scan', {
          request_id: requestId,
          open_id: openIdOf(req),
          raw: String(pendingMark).slice(0, 32),
          lines: Array.isArray(pendingSession?.sale?.lines) ? pendingSession.sale.lines.length : 0,
          has_order: Boolean(String(pendingSession?.sale?.order_no || '').trim())
            || Boolean(String(pendingSession?.sale?.master_record_id || '').trim()),
          sale_status: String(pendingSession?.sale?.status || '').trim(),
          had_submit_pending: hadSubmitPending,
          reset,
        });
        // ⚠️ **这一句才是"别再接管"的开关**：把本地那份标记置空 ⇒ 下面那条
        //    "刷新仍给资金页"的接管（`pendingMark === 'pending' && salesContext`，**逐字未动** ✓）
        //    **不再命中** ⇒ 这一发继续走**正常整页渲染** ⇒ `page:'goods'` ✓（正是她选的 ②）。
        pendingMark = '';
      }
      if (pendingMark === 'pending' && salesContext) {
        const pendingView = await service.lookup({ ...lookupInputOf(req), requestId }).catch(() => null);
        if (pendingView?.found) {
          const pendingLines = Array.isArray(pendingSession?.sale?.lines) ? pendingSession.sale.lines : [];
          // ⭐⭐ 2026-10-15 晚（task-21 · 她真机 20:22：「我扫码一双鞋点击销售，出来的是**资金页面**」）：
          //   🔴 上面那半（10-14 晚）只把接管**限到销售上下文**，**没看"有没有东西要付"** ✗ ——
          //      她那次的会话是 `paymentStep:'pending'` + 草稿 **0 行** + 没有已建单号
          //      ＋ **`sale.status:'submitted'`**（**那一单早就交出去了**）⇒ 照样被顶到
          //      「整单付款（可填可不填）」，而且**之后每次扫码都这样** ✗✗。
          //   ⚠️ **光看"0 行"是不够的**（我第一版就是"0 行 + 没单号 ⇒ 残标记"，被全量挡下 ✓）：
          //      **刚点过「提交这一单」、正停在资金页**时，草稿**本来就是 0 行** —— 扫码那一双是走
          //      `submitPending`（提交那一步存下来的尺码/金额/收款）在**点按钮时**才落单的
          //      （见上面提交分支的 `lines: pendingDraftLines` ＋ 下面 pay 分支用 `pendingInfo`）✓
          //      ⇒ 拿"0 行"判残标记会把**正常**的资金页清掉 ⇒ 她点按钮就建不了单 ✗
          //        （`test/scanSalePayFront.test.js` 的 AC-PF1/PF2/PF4 正是这么挡住我的第一版 ✓）。
          //   ⇒ 判据收成她**真机那个状态**才有的特征：0 行 + 没单号 + **这一单已经 `submitted`**
          //      （`completeSale` 把 `status` 落成 submitted，它清的是 `lines`/`order_no`，
          //       **没清** `paymentStep` ⇒ 标记留成了残的 —— 正是她那次的形状 ✓）。
          const hasOrder = Boolean(String(pendingSession?.sale?.order_no || '').trim())
            || Boolean(String(pendingSession?.sale?.master_record_id || '').trim());
          const saleStatus = String(pendingSession?.sale?.status || '').trim();
          // ⚠️ 2026-10-15 晚（task-22 顺带修正）：改前逐字 `writeConfig?.statuses?.submitted || 'submitted'`
          //    —— `writeConfig.statuses` **不存在**（真路径是 `writeConfig.session.statuses`）⇒ 一直靠
          //    **字面量兜底**在跑（值恰好相同 ⇒ 行为没变 ✓，但那是"配置先行"没做到 ✗）。
          //    改后逐字：读**真路径**，兜底只在"配置竟然缺了"时保命（不改变任何现有行为 ✓）。
          const submittedStatus = String(writeConfig?.session?.statuses?.submitted || 'submitted');
          // 「有东西要付」= 草稿有行 ∨ **已经建过单**（order_no / master_record_id）∨
          //                **这一单还没交出去**（status 不是 submitted ⇒ 她刚点过提交、正停在资金页 ✓）
          if (pendingLines.length > 0 || hasOrder || saleStatus !== submittedStatus) {
            return sendPaymentStep(res, req, {
              // ⭐ 2026-10-16 A2a ③：候选收款方式 = 读表那一份（读不到 ⇒ 退回配置 + warn ✓ 见工厂里那份注释）
              paymentMethods: await candidatePaymentMethods(req),
              realm,
              submitKey: writeService?.sessions?.submitKeyFor?.(openIdOf(req), pendingSession, 'sale') || '',
              count: pendingLines.length,
              // ⭐⭐ task-58：**哪一条判据把她顶到了资金页** —— 就是上面那个三选一。
              //   （她真机再出现这个现象时，grep `scan.page.rendered` 一眼看出是哪种形状 ✓）
              renderedTrigger: pendingLines.length > 0
                ? 'pending_mark:lines'
                : (hasOrder ? 'pending_mark:order' : 'pending_mark:status_not_submitted'),
            });
          }
          // 🔴 **残标记**（0 行 + 没单号 + 已 `submitted`）⇒ **不给资金页**，并把标记清成"**没走到资金这一步**"
          //   的**既有表示** = 这个键**不在**（`services/scanSessionService.js` 的默认 `sale` 里就**没有**
          //   `paymentStep` ✓）⇒ 清成 `undefined`：`saveSaleProgress` 是 `{...当前 sale, ...patch}`、
          //   store 是 `JSON.stringify`（`jsonTaskStore`）⇒ 这个键就**没了** ✓。
          //   ⚠️ **不是** `'created'`（那是"**这一单已经建过**"的既有含义，写上去就是撒谎 ✗）；
          //   ⚠️ **不是**空串（那是**另造一个值**，注释里也点名过不许 ✗）；
          //   ⚠️ 清标记**失败不许破她的页面**（这是 GET 渲染路径）⇒ 只 warn，照旧出正常页 ✓。
          //   ⭐⭐ 2026-10-15 晚（task-22）：**`submitPending` 同一笔清掉**（纯卫生 ✓）——
          //      `paymentStep` 一清，它在代码里就**再没有读点**（pay / skip 两处都在
          //      `paymentStep === 'pending'` 的门内 ⇒ 这颗残留 payload 只会误导下次真机排查；
          //      Lead 手工清她会话时也把它一起清了 ✓）。
          //      🔴 **顺序不能反**：必须在"提交那一步把 `status` 落回 `draft`"（见提交分支）**之后**才敢这么清 ✗
          //         —— 否则第 2 单刚提交那一下也会命中这条残标记分支 ⇒ 把她**点按钮要写的那一双**抹掉 ⇒ 建不了单 ✗。
          const hadSubmitPending = Boolean(pendingSession?.sale?.submitPending);
          const clearing = writeService.saveDraftLines?.(
            openIdOf(req), { paymentStep: undefined, submitPending: undefined },
          );
          await Promise.resolve(clearing).catch((error) => {
            logWarn('scan.payment_step.stale_clear_failed', {
              request_id: requestId, error: error.message,
            });
          });
          // **不静默**：真机排查时这一条说明"那次残标记是被我们清掉的，不是她自己清掉的"。
          logWarn('scan.payment_step.stale_cleared', {
            request_id: requestId,
            open_id: openIdOf(req),
            raw: String(pendingMark).slice(0, 32),
            lines: pendingLines.length,
            has_order: hasOrder,
            sale_status: saleStatus,
            had_submit_pending: hadSubmitPending,
          });
        }
      }
    }
    const timing = {};
    // ⭐ 2026-10-13：`session_ms` = **从进这个处理函数到真正开始取数**这一段（认证 / 读会话 /
    //    路由开销）。实测它正是"total 减去各分段之后那 1.0~2.6 秒"的主要来源 ✗ ——
    //    现在把它也归到一段里，`stages_gap_ms` 才说明得了问题。
    const handlerStartedAt = Date.now();
    try {
      // ⚠️ Express 已经把路由参数解码过一次（`%7C` → `|`，未编码的中文也照收）；
      //    service 里再解一次是为了容忍双重编码，并且对孤立 `%` 的输入不抛。
      timing.session_ms = Math.max(0, Date.now() - handlerStartedAt);
      const view = await service.lookup({ ...lookupInputOf(req), requestId, timing });
      // ⭐⭐ 2026-10-14 她拍板：「把采购明细给删除了，把特殊码给去掉」⇒ 这里原来那次
      //   `purchaseSizeReader.listSizes()`（**1.7 秒**）**整块删除** ✓；尺码显示只按**实时库存**
      //   （`view.rows` = 内存快照 ✓）：库存里有 ⇒ 显示 ✓ 没有 ⇒ 不显示、不计缺码 ✓
      if (!view.found) {
        if (view.reason === 'empty') {
          logWarn(config.events.badNumber, { request_id: requestId, reason: 'empty_number' });
          service.logTiming?.(timing, { requestId, found: false });
          // ⭐ task-58：**没渲染出货品页**这件事也要留痕（否则"扫了但一条 rendered 都没有"）
          logRendered(req, {
            page: 'bad_number',
            trigger: 'lookup_bad_number',
            number: String(lookupInputOf(req).number || lookupInputOf(req).recordId || ''),
          });
          return badNumberPage(res, 400, requestId);
        }
        service.logTiming?.(timing, { requestId, found: false });
        // ⭐ `/r/{recordId}` 那条路读不到记录（记录被删 / 跨 Base）⇒ **同一条人话出口**，不是 500。
        logRendered(req, {
          page: 'not_found',
          trigger: 'lookup_not_found',
          number: String(view.number || lookupInputOf(req).recordId || ''),
        });
        return notFoundPage(res, requestId, {
          number: view.number, fallback: view.fallback, realm, target: scanTargetOf(req),
        });
      }
      // ⭐⭐ 2026-10-12（她拍板）：「扫 16 ⇒ 补货 ⇒ 提交 ⇒ 继续扫 ⇒ **自动还是补货**」——
      //   **裸扫**（标签码不带 `?from=`）时用**她最近用过**的那个领域；从来没记过 ⇒ 仍是缺省（销售 ✓）。
      //   ⚠️ 显式 `?from=` 永远优先 ✓；⚠️ 上面"正开着验收 ⇒ 裸扫进验收"的接管**优先于**这条 ✓。
      // ⚠️ 缺省领域用 `resolveRealm('')` 算（**不要**引一个新常量 —— 漏导入时这里会静默失效 ✗，
      //    我踩过：`DEFAULT_REALM` 没导入 ⇒ `undefined === 'sales'` 恒假 ⇒ 记忆永远不生效）。
      if (!explicitRealm && realm === resolveRealm('')) {
        const remembered = await writeService?.sessions?.get?.(openIdOf(req))
          .then((session) => String(session?.last_realm || '').trim())
          .catch(() => '');
        if (remembered) { realm = resolveRealm(remembered); realmSource = 'remembered'; }
      }
      const write = await buildWriteContext(req, view, realm);
      // ⭐⭐ 2026-10-16（task-59 · 两半一刀）：**一单多货品** —— 把**草稿里已加的货品**交给渲染半。
      //   · 渲染半据此：① 列出"本单已加的货品" ② 让 hidden `multi_items` **带上它们**
      //     ⇒ 她再点「提交」就是**一单多货品一起提交** ✓（#710 那条 `groups.length > 1` 的路 ✓）。
      //   · 🔴 **草稿里没有东西时一个字节都不盖** —— 既有渲染判据是往 `lookup` 的返回值里
      //     **注入** `multi_items` 的（`test/multiItemOrderReturnTrim.test.js` 的 AC-RT4 等 ✓）
      //     ⇒ 本刀**一个字都不动它们** ✓（"没有草稿" ≠ "清空她视图里的那份" ✗）。
      //   · ⚠️ 别的领域 `write.multiItemDraft` 恒为 `null` ⇒ 这里整段是**空转**（行为不变 ✓ AC-MI-E）。
      const pendingMultiItems = write?.multiItemDraft?.items || [];
      if (pendingMultiItems.length) view.multi_items = pendingMultiItems;
      // ⚠️ 验收模式那一块**只用到文案 / 字段名 / 动作名**（它们都在配置里）——
      //    所以即使扫码写入口整个关着（`write` 为 null），验收模式照旧可用：
      //    这里给它一个最小的上下文（不构造销售 / 补货那两条链的任何东西）。
      const writeForRender = write;  // ⭐ 2026-10-14 晚：验收模式的"最小上下文"随验收退场 ✓
      const renderStartedAt = Date.now();
      // ⭐ 2026-10-11「货品」领域：把**打印队列的真实状态**带进渲染层（在线 / 未连接 +
      //    这一款最近一次任务）。⚠️ 只在这个领域取 —— 别的领域一次都不碰打印那条链路。
      //    `printed=1` = 刚提交完（303 回来的），页面上给一句"已提交打印"。
      const printContext = realm === 'product'
        ? await buildPrintContext(view.number, realm, {
          requestId,
          submitted: String(req.query?.printed || '') === '1',
          duplicated: String(req.query?.dup || '') === '1',
          jobId: String(req.query?.job || '').trim(),
          // `/r` 底下表单要 POST 回 `/r/{recordId}`；`/s` 底下与改前逐字相同。
          target: backTargetFor(req, view.number),
        })
        : null;
      // ⭐ 2026-10-11：把 UA 交给渲染层 —— 它只用来决定本单条上【继续扫下一个】
      //    是"飞书客户端内的扫一扫 AppLink"还是那句如实的人话（`canScanNextWithFeishu`）。
      const html = renderScan(view, config, writeForRender, realm, {
        userAgent: req.headers['user-agent'],
        // ⭐⭐ 2026-10-13：提交后回跳带过来的单号 ⇒ 顶部那条"上一单已提交"的指引（没有就不显示 ✓）
        justSubmittedOrderNo: String(req.query?.[config.successReturn?.noticeKey || 'done'] || '').slice(0, 40),
        // ⭐ 这一页挂在哪个前缀上（`/s` 或 `/r`）—— 自助块里的批次链接/手输表单必须**留在同一前缀**。
        basePath: req.baseUrl,
        print: printContext,
      });
      timing.render_ms = Math.max(0, Date.now() - renderStartedAt);
      // ⭐⭐ task-58：**这就是"她最后看到货品页"那条正证据** —— 与资金页那条（`page:'pay'`）
      //   在日志里一眼分得开 ✓（改前两条都只打 `scan.page.viewed`，长得一模一样 ✗）
      logRendered(req, {
        page: 'goods',
        // `realm:<领域>:<explicit|remembered|default>` —— 说得出"这一页是哪个领域、怎么来的"
        trigger: `realm:${realm}:${realmSource}`,
        number: String(view.number || lookupInputOf(req).recordId || ''),
      });
      // `total_ms` = 取数 + 渲染（整条链路的墙钟）—— 她要的是"这一页到底花了多久"。
      timing.total_ms = (Number(timing.total_ms) || 0) + timing.render_ms;
      service.logTiming?.(timing, { requestId, found: true });
      return sendHtml(res, 200, html);
    } catch (error) {
      // ⭐ task-58：**没渲染出页面**也要留痕（不然"扫了、日志里一条 rendered 都没有"）
      logRendered(req, {
        page: 'failed',
        trigger: 'render_failed',
        number: String(lookupInputOf(req).number || lookupInputOf(req).recordId || ''),
      });
      return respondFailure(res, error, requestId, timing);
    }
  });

  /**
   * **写入口**：页面上那两个表单都 POST 到同一个地址，靠 `action` 字段分派。
   *
   * 四个动作：
   *   · `add_line`     —— 把这一双加进"本单"（**只写本地会话**，业务表一字不写）；
   *   · `submit_order` —— 提交整单（**唯一的销售写库时机**）；
   *   · `clear_draft`  —— 清空本单；
   *   · `replenish`    —— 按勾选的尺码 + 数量生成采购申请。
   *
   * ⚠️ **成功的"加一双 / 清空"走 303 回原页**（Post-Redirect-Get）：
   *    刷新不会重复提交，页面上也会带上"本单现在几双"。**提交订单**直接渲染结果页。
   * ⚠️ 失败一律**渲染一张人话页**（不静默、不只写日志）。
   */
  router.post(ROUTE_PATTERNS, uiTapResultMiddleware('scan'), async (req, res) => {
    const requestId = req.requestId;
    const body = req.body || {};
    const fields = writeConfig.fields;
    const actions = writeConfig.actions;
    let action = String(body[fields.action] || '');
    // ⭐⭐ 2026-10-12（她真机 400 / 1ms，`scan.write.unknown_action` 的 `action_kind=missing`、
    //   但 `body_keys` 里**该带的都带了**：submit_key / size / amount / gift / payment_* ✗）：
    //   ⇒ 那是"**没有提交者的提交**"（webview 里 JS/回车/隐式提交 ⇒ 浏览器**不送**按钮的 name/value ✗）。
    //   窄化兜底：**只有**在"没 action + 带幂等键 + 像销售提交"时，认作 `submitOrder`（并留痕 ✓）。
    //   ⚠️ 不碰标记（零哨兵风险 ✓）；只在这一页（编号页 POST）✓。
    if (!action && String(body[fields.submitKey] || '').trim()
      && (body[fields.size] !== undefined || body[fields.amount] !== undefined)) {
      action = actions.submitOrder;
      logWarn('scan.write.action_inferred', {
        request_id: requestId, reason: 'missing_action_default_submit',
        body_keys: Object.keys(body), path: String(req.originalUrl || '').split('?')[0],
      });
    }
    const openId = openIdOf(req);
    // 「回跳到哪一块」= 这一页的领域（认不出来一律回落缺省；两个入口同一条口径）。
    const realm = resolveRealm(req.query?.from);

    // ── ⭐⭐ 2026-10-11：扫码页「货品」领域 →【打印这一款】──────────────────────
    // 🔴 它**排在下面"扫码写入口关着 ⇒ 503"那道闸门之前**：打印这一款**不写任何业务表**
    //    （只把一条任务排进打印队列），所以与"销售/采购写入口开不开"是两件事。
    // ⚠️ 编号**只认 URL 里的那个**（表单里刻意不放编号字段）⇒ 手改表单也打不了别的款。
    // ⚠️ 页面上**零 JS**：这里就是一个原生表单的 POST，成功后 303 回本领域（PRG，
    //    刷新不会重复提交），状态由 GET 重新渲染。
    if (action === actions.printLabel) {
      let number = decodeURIComponent(String(req.params.number || '')).trim();
      // ⭐⭐ 2026-10-12：`/r/{recordId}` 底下 URL 里是**记录 ID**，而打印队列认的是**编号**
      //    ⇒ 先把它解出来（读不到就给"这一款现在打不了"的人话，不是 500）。
      if (isRecordBase(req)) {
        const printView = await service.lookup({ ...lookupInputOf(req), requestId }).catch(() => null);
        number = String(printView?.number || '').trim();
        if (!number) {
          logWarn('scan.label_print.number_unresolved', {
            request_id: requestId, product_record_id: scanTargetOf(req).value,
          });
          return notFoundPage(res, requestId, { target: scanTargetOf(req), realm });
        }
      }
      // ⭐ 连点去重 / 二次确认：
      //   · `submit_key`（表单里带回来的幂等键）—— 同一个 key 只会有一个任务；
      //   · `again=1`（横幅上那颗【再打一张】）—— **明确表达"我知道刚打过，还要再打"** ⇒ 绕过两道去重。
      const submitKey = String(body[LABEL_PRINT_QUEUE.submitKeyField] || '').trim();
      const again = String(body[LABEL_PRINT_QUEUE.againField] || '').trim() === '1';
      try {
        const queue = resolveLabelPrintQueue();
        const result = await queue.enqueueSingle({ number, actor: openId, source: 'scan', submitKey, again });
        logInfo('scan.label_print.enqueued', {
          request_id: requestId,
          number,
          job_id: result.job_id,
          total_labels: result.total_labels,
          again: again || undefined,
          // ⭐ 去重命中（她连点了 / 换了个页面又来点）—— 排障时一眼能看出来。
          reused: result.reused || undefined,
          reused_reason: result.reused_reason || undefined,
        });
        // Post-Redirect-Get：刷新不会重复提交；页面上那句**显眼横幅**由 GET 重新渲染。
        // `printed=1` = 这次真的新建了任务；`dup=1` = 命中去重（没有重复提交）。
        const flag = result.reused ? 'dup=1' : 'printed=1';
        // ⭐ `/r` 底下回跳要带**记录 ID**（不是编号）。
        return res.redirect(303, `${postActionFor(backTargetFor(req, number), realm)}&${flag}&job=${encodeURIComponent(result.job_id)}`);
      } catch (error) {
        // 她这一款没库存 / 条件是打不出来 ⇒ 400（**原因原样给她**，她要能看懂为什么）；
        // 系统这一侧坏了（产物画不出来 / 队列写不进盘）⇒ 502/503，**只给一句人话**，
        // 内部细节只进日志（与工作台其它接口同一条口径：5xx 不回显内部细节）。
        const status = error?.statusCode === 400 ? 400 : (error?.statusCode === 503 ? 503 : 502);
        logError('scan.label_print.failed', {
          request_id: requestId, number, status, error: error.message,
        });
        const texts = LABEL_PRINT_QUEUE.texts;
        return sendHuman(res, status, {
          title: status === 400 ? texts.enqueueFailedTitle : texts.unavailableTitle,
          body: status === 400 ? error.message : texts.unavailable,
          number,
          requestId,
        });
      }
    }

    if (!writeService) {
      // ⭐ 埋点 P0 ②：原因码（写入口关着 —— 与"她填错了"分开，修法完全不同）
      markTapCode(res, 'write_disabled');
      return sendHuman(res, 503, {
        title: writeConfig.texts.writeDisabledTitle,
        body: writeConfig.texts.writeDisabledBody,
        requestId,
      });
    }
    try {
      // ── ⭐⭐ 2026-10-16（task-59 · 两半一刀）：「＋ 再加一个货品 / 移除」那两颗 `submit` ──────
      //   🔴 **必须排在动作分派之前**（判据 `test/multiItemOrderAddRemove.test.js` 的 **AC-MI-D**）：
      //     那两颗按钮就在**既有那张表单里** ⇒ 点它们时 hidden `action=…` **也一起发出来** ✗
      //     ⇒ 不先拦，她这一点就会被"既有补货/退货提交"吃掉：**直接报单走人、页面跳走** ✗✗
      //       （比改前"点了没反应"更糟 —— 这正是 Lead 裁决"两半必须同一刀"的原因 ✓）。
      //   ⚠️ 判据是**配置里的字段名 + 取值**（`multiItemActionOf` ✓）—— 本文件不写死字符串 ✗；
      //     ⚠️ 尤其**不碰 `action`**（表单里已经有它 ⇒ 同名会被 `extended:true` 挤成数组 ✗）。
      const multiItemAction = multiItemActionOf(body, multiItemOrderConfig);
      if (multiItemAction.kind) {
        return handleMultiItemAction({ req, res, requestId, realm, action: multiItemAction });
      }

      // ── 加入本单 ────────────────────────────────────────────────────────────
      if (action === actions.addLine) {
        const view = await service.lookup({ ...lookupInputOf(req), requestId });
        if (!view.found) {
          return notFoundPage(res, requestId, {
            number: view.number, fallback: view.fallback, realm, target: scanTargetOf(req),
          });
        }
        const result = await writeService.addSaleLine({
          openId,
          requestId,
          productRecordId: view.product_record_id,
          number: view.number,
          itemNo: view.item_no,
          color: view.color,
          size: body[fields.size],
          amount: body[fields.amount],
          gift: body[fields.gift],
          // ⭐ 2026-10-09（**本文件唯一的一处新增**）：「选中的这一双是现货还是预订」——
          //    判据与页面上那两个分组**同一份**（所选尺码在「样品 + 门盒」有没有货，
          //    纯函数在 `views/scanPageRealm.js`）。交易类型**编码**不在这里写死：
          //    写服务按既有判据 `salesTradeTypeForStock` 推出来（现货 / 预订）。
          inStock: sellableSizeTexts(view).has(String(body[fields.size] ?? '').trim()),
        });
        if (!result.ok) return respondWriteFailure(res, result, requestId);
        logInfo(writeConfig.events.lineAdded, {
          request_id: requestId, number: view.number, count: result.count,
        });
        return res.redirect(303, `${postActionFor(backTargetFor(req, view.number), realm)}${realm === DEFAULT_REALM ? '?' : '&'}added=1`);
      }

      // ── ⭐ 2026-10-11（B）：把一件配品加进本单（与「加入本单」同一形状：只写本地会话）──
      if (action === actions.addAccessory) {
        const view = await service.lookup({ ...lookupInputOf(req), requestId });
        if (!view.found) {
          return notFoundPage(res, requestId, {
            number: view.number, fallback: view.fallback, realm, target: scanTargetOf(req),
          });
        }
        const result = await writeService.addSaleLine({
          openId,
          requestId,
          // ⚠️ `kind` **由路由按动作给**，不取表单里的值（手改表单也换不了可售品类型）。
          kind: 'accessory',
          accessoryRecordId: body[fields.accessory],
          amount: body[fields.amount],
          gift: body[fields.gift],
        });
        if (!result.ok) return respondWriteFailure(res, result, requestId);
        // 与「加入本单」同一条回跳（Post-Redirect-Get）：刷新不会重复提交、本单看得见。
        return res.redirect(303, `${postActionFor(backTargetFor(req, view.number), realm)}${realm === DEFAULT_REALM ? '?' : '&'}added=1`);
      }

      // ── 清空本单 ────────────────────────────────────────────────────────────
      if (action === actions.clearDraft) {
        await writeService.clearDraft({ openId, requestId });
        return res.redirect(303, postActionFor(
          backTargetFor(req, decodeURIComponent(String(req.params.number || ''))), realm,
        ));
      }

      // ── 第 2 步【提交整单付款】⇒ **走既有那条诚实钱路**（不做第二套账 ✗）─────────────
      //    `followup.addPayment(...)` = 工作台「补记收款」用的同一条链路（`routes/workbench.js:215` ✓）
      //    🔴 三条红线：① 只有**写成功**才说"已收" ✓ ② 没填 ⇒ 待补充（不是失败）✓
      //                ③ 幂等沿既有 `requestId`（**不自造** ✓）
      if (action === (config.paymentStep?.payAction || 'payment_pay')) {
        // ⭐⭐ 2026-10-14（业务负责人口径，逐字）：「**确认状态是资金那页点击了按钮之后，才算是用户确认了**」
        //   ⇒ **建单就发生在这一刻** ✓（点「提交这一单」时只到资金页、一个字都没写 ✓）
        //   · 会话里记着 `paymentStep:'pending'` ⇒ 说明她刚点过「提交这一单」、还没建单 ✓ ⇒ **现在建** ✓
        //   · ⚠️ 不是 pending ⇒ 走**既有**老流程（一字不改 ✗）
        //   · 🔴 金额/收款不齐 ⇒ `submitSale` 自己会拒（**它才是那份校验的真源** ✓ 路由不重算 ✗）
        //      ⇒ 拒了 ⇒ ⭐ **原地重渲染资金页 + 那句人话** ✓ **一个字都不写表** ✗（不会假成功 ✓）
        const paySession = await writeService?.sessions?.get?.(openIdOf(req)).catch(() => null);
        const payPending = (paySession?.sale?.paymentStep || paySession?.paymentStep) === 'pending';
        let createdResult = null;
        // ⭐ 这一步的墙钟起点（打点用 ✓ 见下面那条 `scan.sale.timing`）
        //   ＋ ⭐⭐ 2026-10-15（⑨b-2）：**打点载体**要**留一个名字** —— 写服务把各分段**写进传进去的
        //   这个对象**（`submitSale({ timing })` ✓），而它**不把 timing 放回返回值** ✗。
        //   改前逐字：`timing: {}` 传进去、打点时却读 `createdResult.timing?.master_ms`
        //     ⇒ 取到 `undefined` ⇒ **七个分段全是 0**（`payment_pay` 这条**她最常走**的路上
        //       "卡在哪一步"其实**一直打不出来** ✗ —— 与"每个关键节点都要有日志"冲突）。
        //   改后逐字：`timing: payStepTiming` 传进去、打点时读 `payStepTiming.*` ⇒ **真的数** ✓。
        //   🔴 **只改读取口**：事件名 / 字段名 / 形状一个都没变 ✗，也不影响任何写入判据 ✓。
        const payStepStartedAt = Date.now();
        const payStepTiming = {};
        if (payPending) {
          const pendingLines = Array.isArray(paySession?.sale?.lines) ? paySession.sale.lines : [];
          const pendingInfo = paySession?.sale?.submitPending || paySession?.submitPending || {};
          // ⚠️ 与提交那一下**同一套**解析（`parsePaymentRows` / `asList` ✓ 不新造 ✗）
          //   ⭐ 资金页那张表单**不带**"每件实收"（`line_amount`）⇒ ⭐ **优先用她提交时就填好的那份** ✓
          //     （实测 `AC-E2E-8`："她填的实收照旧落表" 就是靠这一条 ✓ 拿不到就退回表单 ✓ 不编 ✗）
          const pendingPayments = parsePaymentRows(body, fields).length
            ? parsePaymentRows(body, fields)
            : (Array.isArray(pendingInfo.payments) ? pendingInfo.payments : []);
          const pendingLineAmounts = asList(body[fields.lineAmount]).some((v) => String(v ?? '').trim())
            ? asList(body[fields.lineAmount])
            : (Array.isArray(pendingInfo.lineAmounts) ? pendingInfo.lineAmounts : []);
          const pendingPaymentStatus = String(body[fields.paymentStatus] || pendingInfo.paymentStatus || '').trim();
          const pendingPaidAmount = body[fields.paidAmount] ?? pendingInfo.paidAmount ?? '';
          const pendingSize = String(pendingInfo.size || '').trim();
          // ⭐⭐⭐ 2026-10-16（task-57 · 抖音团购券 · 业务负责人逐字）：
          //   「**差额的计算按照面值来**，但是**收款明细里的收款金额按照平台结算款**来」
          //   「是的，抖音团购券的是**待平台结算**」
          //   ⇒ 一张券 = **两个数各归各位**（口径与算式见 `services/voucherPaymentService.js`）：
          //      · 收款行交给写层的金额 = 【**平台结算款**】（收款明细那一笔的事实 ✓）
          //      · 差额按【**面值**】算 ⇒ 把 (面值 − 结算款) 从**货品那一侧**扣掉
          //        （差额的全仓唯一算法是 `累计 − 已收`，不扣就变成 `货品 − 结算款` ✗）
          //   🔴 **认不出那张券 / 券目录读不到** ⇒ **大声 warn + 拦住这一单**（400 + 人话 + 零写入）——
          //      **绝不静默把一条券当成普通收款记一笔** ✗（那会写一个错的金额进账，她事后对不上）
          //   ⚠️ 一行券都没有 ⇒ 原样返回、**券目录一次都不读** ⇒ 既有链路逐字不变 ✓（`voucherRows` 空）
          const voucher = voucherPayments.settings.enabled
            ? await voucherPayments.resolveRows(pendingPayments).catch((error) => ({
              ok: false, reason: 'voucher_resolve_failed', error: error?.message || 'unknown',
            }))
            : { ok: true, payments: pendingPayments, voucherRows: [], balanceDeltaCents: 0, faceValueCents: 0 };
          if (voucher.ok !== true) {
            logWarn('scan.write.voucher_blocked', {
              request_id: requestId,
              reason: String(voucher.reason || 'voucher_unresolved'),
              unresolved: Array.isArray(voucher.unresolved) ? voucher.unresolved.map((row) => row.method) : [],
            });
            // ⚠️ 与既有那条"能改的 ⇒ 400 + 原样带回她填的"**同一形状**（`sendPaymentStep` ✓ 一份实现 ✗ 不另起）
            //   ⚠️ 不传 `paymentStatus` / `paidAmount`：那一组控件（三档 + 实付多少）**已从资金页退场**
            //      ⇒ 传旧值只会误导下一屏（与 A2a 那条注释同一个理由 ✓）
            return sendPaymentStep(res, req, {
              paymentMethods: await candidatePaymentMethods(req),
              realm,
              submitKey: body[fields.submitKey],
              count: pendingLines.length,
              notice: voucherPayments.settings.unresolvedText,
              // ⭐ 她刚填的钱**原样带回**（她改一下就能再点 ✓）—— **不是**解析后的那一份（那会替她改数 ✗）
              paymentRows: pendingPayments,
              status: 400,
            });
          }
          // 交给写层的收款行（券行金额 = 平台结算款 ✓）＋ 货品那一侧（券的抽佣已扣 ✓）
          const paidPayments = voucher.payments;
          const effectiveLineAmounts = voucherPayments
            .adjustLineAmounts(pendingLineAmounts, voucher.balanceDeltaCents).amounts;
          if (voucher.voucherRows.length) {
            logInfo('scan.write.voucher_resolved', {
              request_id: requestId,
              voucher_count: voucher.voucherRows.length,
              voucher_methods: voucher.voucherRows.map((row) => row.method),
              face_value_cents: voucher.faceValueCents,
              balance_delta_cents: voucher.balanceDeltaCents,
              voucher_names: voucher.voucherRows.map((row) => row.name),
            });
          }
          // ⭐⭐ 2026-10-16 A2a（她：**页面去三档** ⇒ 档位**按金额自动定**）——
          //   改前逐字：档位 = `Object.keys(payStatusMap).find((key) => payStatusMap[key] === pendingPaymentStatus) || ''`
          //     （**从"请求体 / 已存档"反查** ✗）⇒ 页面去掉那三个单选框之后**必然查不到** ⇒ 被判 `unknown_mode` **拦住** ✓
          //   改后逐字：`autoModeOf({ itemsCents, paymentsCents })` —— **按金额推档**（纯函数 ＋ 配置表 ✓ 真源一份 ✓）
          //   依据 = 她 2026-10-16 逐字（"别让他带着这三个单选提交"）⇒ 本段是它的**前半刀**（页面 + 判据去档）✓
          //   🔴 **本段仍然接受** body 里的旧档位（**不拒绝** ✗ —— 拒绝留到 A3 ✓）；它只是**不再是判据**了 ✓
          //   ⭐ 券那一刀（2026-10-16）只换了**两个入参**（`effectiveLineAmounts` / `paidPayments`）——
          //      档位怎么算、后面怎么校验，**一个字没改** ✗
          const toCents = (value) => Math.round(Number(value || 0) * 100);
          const itemsCents = effectiveLineAmounts.reduce((sum, value) => sum + toCents(value), 0);
          const paymentsCents = paidPayments.reduce((sum, row) => sum + toCents(row.amount), 0);
          // eslint-disable-next-line global-require
          const { resolveSettlement, autoModeOf } = require('../config/saleSettlement');
          const auto = autoModeOf({ itemsCents, paymentsCents });
          // ⭐ 档位的真源仍在 `config/scanWrite.js` 的 `PAYMENT_STATUS`（语义键 ↔ 中文取值 ✓ 不另抄一份 ✗）——
          //   自动定档算出的是**语义键**；交给写服务时要换回**中文取值** ✓
          // eslint-disable-next-line global-require
          const { PAYMENT_STATUS } = require('../config/scanWrite');
          const payStatusMap = PAYMENT_STATUS || {};
          const pendingMode = auto.mode || '';
          // ⭐ 交给写服务的档位 = **自动定出来的那一档**（不是请求体里那个旧档位 ✗）——
          //   ⇒ "带着旧档位提交"也照新口径走 ⇒ 旧档位**不会**再把请求带进老分支 ✓（她 2026-10-16 口径 ✓）
          const effectivePaymentStatus = payStatusMap[pendingMode] || '';
          // ⭐⭐ 2026-10-16 A2a：交给写服务的「本次已收」（`paidAmount`）—— **就是收款行合计** ✓
          //   （与下面 `resolveSettlement` 的 `paidCents: paymentsCents` **同一个口径** ✗ 不两套算法）
          //   ⚠️ 一行收款都没有 ⇒ 用原来那个值（空串 ⇒ 不写；未付/全付两支**本来就不读它** ✓ 逐字同旧行为）
          const effectivePaidAmount = paymentsCents > 0 ? String(paymentsCents / 100) : pendingPaidAmount;
          // 收多了 ⇒ 纯函数已经给了 `block`（与既有 `amount_mismatch` **同一句话** ✓ 不新编中文 ✗）
          const settlement = auto.action === 'block' ? auto : resolveSettlement({
            mode: pendingMode,
            itemsCents,
            paymentsCents,
            // ⚠️ 这两处用**解析后**的那一份（券行已经有金额了 / 货品那一侧已扣掉券的抽佣）——
            //    判据形状一个字没变，只是喂给它的是**真正要落库的那两个数** ✓（不然"券金额可空"
            //    会把券行当成"没填钱"，与后面写进去的东西对不上 ✗）。
            hasPaymentRows: paidPayments.filter((row) => String(row.amount ?? '').trim()).length > 0,
            anyLineAmount: effectiveLineAmounts.some((value) => String(value ?? '').trim()),
            // ⭐ 新形状**页面上没有**「实付多少」这个框了（随三档一起去掉 ✓）⇒ "本次已收"**就是收款行合计** ✓
            //   ⚠️ 若传 `null` 会被判 `partial_amount_missing` —— 那是**旧形状**才有的失败 ✗ 不传 ✗
            paidCents: paymentsCents,
          });
          if (settlement.action === 'block') {
            // ⭐ 2026-10-14 晚（她批准埋点补充③：「失败日志带**人话原因码**」）——
            //   今天真机上她点了 6 次「提交整单付款」都只看到 400、日志里**没有任何原因** ✗ ⇒
            //   这里补一条：**只加打点** ✓ 状态码/人话/零写入**一个字都不改** ✗
            //   （她那天那次的原因就是 `amount_mismatch`：选了全付但「实付多少」空着 ✓）
            logWarn('scan.write.settlement_blocked', {
              request_id: requestId,
              code: String(settlement.code || ''),
              reason: String(settlement.reason || ''),
              mode: String(pendingMode || ''),
              items_cents: itemsCents,
              payments_cents: paymentsCents,
            });
            // ⚠️ 文案：**只用既有那几条模板**（`config/scanWrite.js` 的 texts ✓ **不编中文** ✗）
            //   ⭐「全付两边不等」那条要带上**差额金额**（她一眼看到"少多少/多多少"✓ 实测 AC-E2E-16 ✓）
            const blockText = (() => {
              const t = writeConfig.texts || {};
              const money = (cents) => `¥${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
              // ⚠️ 用**解析后**那两个数（与上面 `settlement` / 与真正要落库的金额**同一份** ✓ 不两套算法）
              const itemsCents = effectiveLineAmounts.reduce((sum, value) => sum + toCents(value), 0);
              const paymentsCents = paidPayments.reduce((sum, row) => sum + toCents(row.amount), 0);
              if (settlement.code === 'amount_mismatch' && t.amountMismatchBody) {
                const diff = Math.abs(paymentsCents - itemsCents);
                const side = itemsCents === 0
                  ? fillWriteText(t.amountMismatchNoItems, { diff: money(diff) })
                  : fillWriteText(
                    paymentsCents > itemsCents ? t.amountMismatchOver : t.amountMismatchShort,
                    { diff: money(diff) },
                  );
                return fillWriteText(t.amountMismatchBody, {
                  items: money(itemsCents), payments: money(paymentsCents), side,
                });
              }
              // 🔴🔴 2026-10-14 修（真 bug）：`settlement.code` 是 **snake_case**
              //    （`full_without_money` / `partial_amount_missing` / `partial_amount_mismatch`），
              //    而 `config/scanWrite.js` 的文案 key 是 **camelCase**（`fullWithoutMoneyBody` …）
              //    ⇒ 原来直接拼 `${settlement.code}Body` **永远查不到** ⇒ 那三条 block 的人话
              //    渲染成**空串**（页面只剩一个干巴巴的 400 + 满页表单）。
              //    ⚠️ 这就是她 2026-10-14 真机"点了 6 次「提交整单付款」都只看到 400"的现场之一：
              //      日志里当时**连原因都没有**（那条 `scan.write.settlement_blocked` 是后来才补的），
              //      页面上也没有一句话 —— 两处都静默。
              //    ⇒ 按 snake_case → camelCase 取真源文案（**不新编中文** ✓ 仍只用既有模板 ✓）。
              const codeCamel = String(settlement.code || '')
                .replace(/_([a-z])/g, (_, char) => char.toUpperCase());
              return t[`${codeCamel}Body`] || t[settlement.code] || '';
            })();
            return sendPaymentStep(res, req, {
              paymentMethods: await candidatePaymentMethods(req),
              realm,
              submitKey: body[fields.submitKey],
              count: pendingLines.length,
              notice: blockText,
              // ⭐ 她刚填的钱**原样带回**（她改一下就能再点 ✓ 这就是旧流程那条"值还在"的要求 ✓）
              // ⭐ 2026-10-16 A2a（接线）：档位改用**自动定出来的那一档**（`effectivePaymentStatus`）——
              //   旧档位（请求体那个）**不再是判据**，这里也不该再把它带回去（带回去只会误导下一屏）。
              paymentStatus: effectivePaymentStatus,
              paidAmount: pendingPaidAmount,
              // ⭐ 券那一刀：带回去的是**解析后**那一份（券行她本来就没填金额 ⇒ 只是把这一行的
              //    **真实金额（平台结算款）**显示出来 ✓ 既不是替她改数、也不是藏起来 ✗）。
              paymentRows: paidPayments,
              // ⭐ 400 = "她能改"的那一类（与既有口径一致 ✓ 旧流程这条也是 400 ✓ 不放宽 ✗）
              status: 400,
            });
          }
          const pendingView = pendingSize
            ? await service.lookup({ ...lookupInputOf(req), requestId }).catch(() => null) : null;
          // eslint-disable-next-line no-await-in-loop
          createdResult = await writeService.submitSale({
            openId: openIdOf(req),
            requestId,
            // 🔴 **同一把 `submitKey`**（幂等不许拆 ✗）：连点两次 / 重试都走这一个键 ✓
            submitKey: body[fields.submitKey],
            // ⭐⭐ 券那一刀（2026-10-16）：交给写层的是**解析后**那一份 ——
            //   · `paidPayments`：券行的金额 = 【平台结算款】（收款明细那一笔的事实 ✓）
            //   · `effectiveLineAmounts`：货品那一侧已扣掉券的 (面值 − 结算款) ⇒ 差额按【面值】算 ✓
            //   ⚠️ 没有券时这两个变量与 `pendingPayments` / `pendingLineAmounts` **同一个对象内容** ✓
            payments: paidPayments,
            lineAmounts: effectiveLineAmounts,
            // ⭐⭐ 2026-10-16 A2a **接线**（改前逐字 → 改后逐字 → 依据）：
            //   改前逐字：`paymentStatus: pendingPaymentStatus,` —— 传的是**请求体 / 会话暂存里那个旧档位** ✗
            //     ⇒ 页面去掉那三个单选框之后，她这一下**必然不带档位** ⇒ 旧档位恒为 `''` ⇒
            //       写服务按配置默认档（未付）落库 —— 与"按金额自动定档"**对不上**（`partial` 会被落成未付 ✗）
            //   改后逐字：`paymentStatus: effectivePaymentStatus,` —— 传**上面刚按金额自动定出来的那一档** ✓
            //   依据 = 她 2026-10-16 逐字（"别让他带着这三个单选提交"）⇒ 档位**只认金额**（一份真源 ✓）
            paymentStatus: effectivePaymentStatus,
            // ⭐⭐ 同一条接线（**不传就等于把"部分付"堵死**）：写服务「部分付」那一支要的
            //   `paidAmount`（= **本次已收**）在旧形状里来自那个**已退场的「实付多少」输入框**；
            //   改前逐字：`paidAmount: pendingPaidAmount,` ⇒ 新形状下恒为 `''` ⇒ `positiveAmount('')`
            //     ⇒ `partial_amount_missing` ⇒ **她已经确认的这一单被自己的旧形状拦住** ✗
            //   改后逐字：`paidAmount: effectivePaidAmount,` —— 有收款行 ⇒ **收款行合计（元）**；
            //     一行都没有 ⇒ 沿用原来那个值（空 ⇒ 不写；未付/全付两支本来就**不看它** ✓）
            //   依据 = 同一个口径：「本次已收」**就是收款行合计**（与上面 `resolveSettlement` 的 `paidCents` 一致 ✓）
            paidAmount: effectivePaidAmount,
            timing: payStepTiming,
            pendingLine: pendingView?.found ? {
              productRecordId: pendingView.product_record_id,
              number: pendingView.number,
              itemNo: pendingView.item_no,
              color: pendingView.color,
              size: pendingSize,
              amount: String(pendingInfo.amount || ''),
              gift: String(pendingInfo.gift || ''),
              inStock: sellableSizeTexts(pendingView).has(pendingSize),
            } : null,
          });
          if (!createdResult?.ok) {
            // ⭐ 校验类失败（金额/收款不齐那些 code ✓）⇒ **原地重渲染资金页**：人话挂上去、改一下再点 ✓
            if ((writeConfig.sale.formFailureCodes || []).includes(createdResult?.code)) {
              return sendPaymentStep(res, req, {
                paymentMethods: await candidatePaymentMethods(req),
                realm,
                submitKey: body[fields.submitKey],
                count: pendingLines.length,
                notice: createdResult.message,
              });
            }
            return respondWriteFailure(res, createdResult, requestId);
          }
          // ⭐ 建单成功 ⇒ 标记从「已到资金页」改成「**这一单已经建过**」✓
          //   🔴 **不能清成空串** ✗ —— 否则她**再点一次**时服务端就"忘了"，只会再渲染资金页 ✗，
          //      而她要的是「**这一单刚才已经交过了**」✓（幂等不许拆 ✓ 只写一次但要如实说 ✓）
          await writeService.saveDraftLines?.(openIdOf(req), { paymentStep: 'created' });
        }
        // ⭐⭐ 2026-10-14：**建单那一步的打点**要跟着挪到"点按钮"这里 ✓
        //   （旧流程在"点提交"那一段打 ✓ ⇒ 新流程里那一段不再建单 ✗ ⇒ 不打 ⇒ 她就看不到"卡在哪一段"✗
        //    实测 `AC-E2E-16/17/18/16b`：都要 `scan.sale.timing` ✓ 一条一条要 ✓ 事件名/形状**照旧** ✗）
        if (createdResult) {
          logInfo(writeConfig.events.saleTiming, {
            request_id: requestId,
            // ⭐⭐ 2026-10-15（⑨b-2）：**她那次请求**这一段（`request`）—— 与后台那一跑
            //   **同一事件名**、靠 `phase` 分得清（取值走配置 ✓ 不散写字符串 ✗）。
            phase: writeConfig.timing.phase.request,
            ok: createdResult.ok === true,
            code: createdResult.code || '',
            order_no: createdResult.order_no || '',
            reused: createdResult.reused === true,
            partial: createdResult.code === 'sale_partial_failed',
            lines: Number(createdResult.detail_count) || 0,
            // ⚠️ 这一步的墙钟（含排队等前面的写 —— 她连点 14 次时这一段会明显变大 ✓）
            submit_ms: Math.max(0, Date.now() - payStepStartedAt),
            queue_wait_ms: Number(payStepTiming.queue_wait_ms) || 0,
            lookup_ms: Number(payStepTiming.lookup_ms) || 0,
            prepare_ms: Number(payStepTiming.prepare_ms) || 0,
            master_ms: Number(payStepTiming.master_ms) || 0,
            status_ms: Number(payStepTiming.status_ms) || 0,
            detail_ms: Number(payStepTiming.detail_ms) || 0,
            stock_ms: Number(payStepTiming.stock_ms) || 0,
          });
        }
        // ⭐ 建单成功 ⇒ 记下"她刚在销售里干过活" ✓（下次**裸扫**默认还回销售 ✓）
        //   ⚠️ 旧流程在"点提交"那一段记 ✓ —— 新流程改成"**点按钮才建单**"⇒ 这一句也要跟着挪过来 ✗
        //      （实测 `AC-RF4`：写成功要记 `last_realm = sales` ✓ 不挪就丢了 ✓）
        if (createdResult) markRealmUsed(openIdOf(req), realmOfAction(writeConfig.actions.submitOrder));
        const payTarget = backTargetFor(req, decodeURIComponent(String(req.params.number || '')));
        // ⭐ 单号/双数：**优先用刚建单的返回值** ✓（没建单时退回表单里的那两个 ✓ 一律**不编** ✗）
        const paidOrderNo = String(createdResult?.order_no || body.order_no || '').trim().slice(0, 40);
        const paidCount = Number(String(createdResult?.detail_count ?? body.count ?? '').trim() || 0) || 0;
        const paidReused = String(body.reused || '') === '1';
        const paidDetails = [
          fillWriteText(writeConfig.texts.submittedOrderLine, { orderNo: paidOrderNo || '—' }),
          fillWriteText(writeConfig.texts.submittedDetailLine, { count: paidCount }),
        ];
        // ⭐⭐ 2026-10-15（⑨ B 异步）：成功页 payload **仍然只有一个来源**
        //   （成功页的自动回跳来源只在这一处调 `successReturnFields` —— `AC-SR4` 那条接线哨兵
        //     **一个字没动** ✓；⚠️ 注释里也**不写那个调用形状**，免得被源码计数哨兵当第 6 处 ✗）
        //   传了 `asyncSentence`（异步那一条）⇒ **只给她那一句**：
        //   她逐字「**统一文字改成：本单已创建成功（单号），其余文字不需要**，**销售和配品都这样**」
        //   ⇒ `title` = 那一句（含真单号 ✓）、`body` 空、`details` 空；其余照旧 ✓
        const paidPayload = (retryHint, asyncSentence = '') => ({
          ...successReturnFields(req, payTarget, paidOrderNo),
          title: asyncSentence || (paidReused
            ? writeConfig.texts.submittedAgainTitle : writeConfig.texts.submittedTitle),
          body: asyncSentence ? '' : (paidReused
            ? fillWriteText(writeConfig.texts.submittedAgainBody, { orderNo: paidOrderNo || '—' })
            : fillWriteText(writeConfig.texts.submittedBody, { orderNo: paidOrderNo || '—', count: paidCount })),
          order_no: paidOrderNo,
          details: asyncSentence ? [] : paidDetails,
          requestId,
          retryHint,
        });
        // 🔴 只认**填了金额**的行（PAY2 抓到的真 bug：空金额行也曾被当成「要记一笔」⇒ 会写出空账 ✗）
        const rowsToPay = parsePaymentRows(body, fields)
          .filter((row) => String(row.amount ?? '').trim());
        // ⭐⭐ 2026-10-14（她：**点资金页按钮 = 确认 ⇒ 才建单**）：
        //   · 刚建单那一次（`createdResult` 有值 ✓）⇒ **这一单的收款已经由 `submitSale` 按同一份入参写好了** ✓
        //     ⇒ 🔴 **不能再走下面那条 `addPayment`** ✗（否则就是**第二遍写收款**✗ ——
        //       写库时会被如实拦住"本次收款超过待收金额 ￥0"✓ 这正是它该有的样子 ✓）
        //   · 而"**补记收款**"（工作台那条既有用法 / 老流程的 order_no 路径）⇒ 照旧走 `addPayment` ✓ **一字不改** ✗
        if (createdResult) {
          invalidateInventorySnapshot(requestId, 'scan_sale_paid');
          // ⭐⭐ 2026-10-15（⑰ B 异步）：**单号一出就回** ——
          //   她逐字：「**统一文字改成：本单已创建成功（单号），其余文字不需要**，
          //   **销售和配品都这样**」⇒ 页面只给**那一句**（含真单号 ✓），
          //   **不给**"明细/收款/进度"那些行 ✗（文案走配置 ✓ 不写死 ✗）。
          //   ⚠️ "再录一单 / 回扫码页"那些**能点的东西照旧** ✓（她说的"其余文字"指的是那句话之外的**描述性文字** ✗）。
          if (createdResult.deferred) {
            const asyncSentence = fillWriteText(
              writeConfig.sale.asyncWrite?.doneBodyTemplate || '',
              { orderNo: paidOrderNo || '—' },
            );
            // ⚠️ 走**同一个** `paidPayload`（不另起一份 payload ✗）⇒ 成功页来源仍只有一处 ✓
            return sendSuccess(res, 200, paidPayload('', asyncSentence), req);
          }
          // ⭐ 成功页那句人话：与"提交成功"那条**逐字同形**（她 2026-10-12 定的那一句 ✓）
          //   ⚠️ `paidPayload(retryHint)` 的参数就是**那句提示** ✓ 不是 note 文本 ✗
          return sendSuccess(res, 200, paidPayload(writeConfig.texts.submittedNextHint), req);
        }
        // ⭐ 没填金额（或行数为 0）⇒ **待补充**：**一个字都不写**、成功页照给、**不报错** ✓
        if (!rowsToPay.length) {
          return sendSuccess(res, 200, paidPayload(config.paymentStep?.payPendingNote), req);
        }
        try {
          // eslint-disable-next-line no-await-in-loop
          const followup = options.followup
            || new SalesFollowupService(options.gateway ? { gateway: options.gateway } : {});
          for (const row of rowsToPay) {
            // eslint-disable-next-line no-await-in-loop
            const paid = await followup.addPayment({
              // ⭐ 主表 record_id：**优先用刚建单的返回值** ✓（资金页那份表单里它是空的 —— 那时还没建单 ✗
              //   用空串去写收款 ⇒ 会撞"销售订单尚未确认入账"✗ 这正是新流程多出来的一处 ✓）
              salesEntryRecordId: String(createdResult?.sales_entry_record_id || body.sales_entry_record_id || '').trim(),
              method: row.method,
              amount: row.amount,
              requestId,
              operatorOpenId: openId,
            });
            if (!paid || paid.ok !== true) throw new Error(paid?.message || 'addPayment 未成功');
          }
        } catch (error) {
          // 🔴 写失败 ⇒ **明说失败 + 人话**，**绝不显示"已收"** ✗（她口径：状态不许撒谎 ✓）
          logError(config.events.failed, {
            request_id: requestId, reason: 'payment_add_failed', error: error.message,
          });
          return sendHuman(res, 200, {
            // ⚠️ `writeConfig.texts.errorTitle` 可能是空串 ⇒ 退回页级标题（失败页**不许**没有标题 ✗）
            title: writeConfig.texts.errorTitle || config.texts.errorTitle,
            body: config.paymentStep?.payFailedNote,
            requestId,
            retryHint: writeConfig.texts.submittedNextHint,
          });
        }
        // ✅ 写成功 ⇒ 这**才**能说"已收" ✓
        return sendSuccess(res, 200, paidPayload(config.paymentStep?.paidNote), req);
      }

      // ── 第 2 步【跳过（稍后去工作台补）】⇒ 成功页 ──────────────────────────────
      //    ⭐ 走**既有 POST 动作分发**（不是我原先那条 GET 分支 —— 那条落错函数、已删 ✗）
      //    🔴 跳过**不是失败**：不写任何收款、不说"已收"、也不报错 ✓（她口径：「可写可不写」✓）
      if (action === (config.paymentStep?.skipAction || 'payment_skip')) {
        // ⭐⭐ 2026-10-14（她：**点资金页按钮 = 用户确认**）⇒ 【跳过】那颗按钮**同样要先把单建出来** ✓
        //   （跳过 = "钱稍后去工作台补" ✓ 但**货那一单必须先成立** ✓ 否则"跳过"就成了"什么都没发生"✗）
        //   🔴 与 `payment_pay` **同一把 `submitKey`**（幂等不许拆 ✗）· 校验仍由 `submitSale` 兜 ✓
        const skipSession = await writeService?.sessions?.get?.(openIdOf(req)).catch(() => null);
        const skipMark = skipSession?.sale?.paymentStep || skipSession?.paymentStep;
        // ⭐ `pending` = 还没建单 ⇒ 现在建 ✓；`created` = **这一单已经建过** ⇒ ⭐ 再点也要**如实**告诉她
        //   「这一单刚才已经交过了」✓（**同一把 `submitKey`** ⇒ `submitSale` 自己幂等 ⇒ **只写一次** ✓
        //    🔴 **幂等不许拆** ✗ 绝不直调 `_confirm` ✓）
        const skipPending = skipMark === 'pending' || skipMark === 'created';
        let skipCreated = null;
        // ⭐ 这一步的墙钟起点 + **打点载体**（服务端把各分段**写进这个对象** ✓ 与旧流程同一个形状 ✓）
        const skipStepStartedAt = Date.now();
        const skipStepTiming = {};
        if (skipPending) {
          const skipInfo = skipSession?.sale?.submitPending || skipSession?.submitPending || {};
          const skipSize = String(skipInfo.size || '').trim();
          const skipView = skipSize
            ? await service.lookup({ ...lookupInputOf(req), requestId }).catch(() => null) : null;
          // 🔴🔴 2026-10-16 P0 第二处（**"假成功"**）：她真机那条路上，「跳过付款」在**实收确实缺**时
          //   会走到下面这通 `submitSale` ⇒ 页面拿到**成功页**、`salesEntry` **0 条** ✗
          //   = 她最恨的「看着像好了」✗ ⇒ **实收缺就在这一步拦住**（绝不给成功页 ✓ 人话要给醒目的 ✓）
          //   ⚠️ 与提交那一步**同一套取值口径**（body → 会话暂存的那份 ✓ 一份真源 ✓ 不发明形状 ✗）
          const skipLineAmounts = asList(body[fields.lineAmount]).some((v) => String(v ?? '').trim())
            ? asList(body[fields.lineAmount])
            : (Array.isArray(skipInfo.lineAmounts) ? skipInfo.lineAmounts : []);
          const skipDraftSession = await writeService.sessions?.get?.(openIdOf(req)).catch(() => null);
          const skipDraftLines = Array.isArray(skipDraftSession?.sale?.lines) ? skipDraftSession.sale.lines
            : (Array.isArray(skipDraftSession?.lines) ? skipDraftSession.lines : []);
          const skipResolvedAmounts = skipLineAmounts.some((v) => String(v ?? '').trim())
            ? skipLineAmounts
            : skipDraftLines.map((line) => String(line?.amount ?? '').trim()).filter(Boolean);
          // ⚠️ 2026-10-16（裁决=甲）：**跳过 = 她明说"钱稍后去工作台补"** ⇒ **实收空在这一步是合法的** ✓
          //   （用"每一双都要填实收"去拦它 = 把"跳过"这个出口堵死 ✗）⇒ **这一步不放必填闸门** ✓
          //   ⭐ "假成功"改由**下面那道"写失败如实可见"**兜（不是靠必填挡 ✓）
          const skipItemsCents = skipResolvedAmounts
            .reduce((sum, value) => sum + Math.round(Number(value || 0) * 100), 0);
          // ⭐⭐ 2026-10-16 A2a **接线**（改前逐字 → 改后逐字 → 依据）：
          //   改前逐字：`paymentStatus: writeConfig.sale.paymentStatus.default,` —— **写死配置默认档** ✗
          //     （"档位由金额自动定"这条在这条出口上**没接线** ⇒ 与建单那条出口两套口径 ✗）
          //   改后逐字：`skipAutoPaymentStatus` = **同一个纯函数**按金额定出来的那一档
          //     （`payments: []` ⇒ 本次已收 = 0 ⇒ 自动档 = **未付** ✓ 与旧行为**同值**，但真源只剩一处 ✓）
          //   依据 = 她 2026-10-16 逐字（"别让他带着这三个单选提交"）⇒ 档位**只认金额**（不看页面/请求体 ✓）
          // eslint-disable-next-line global-require
          const { autoModeOf: autoModeOfSkip } = require('../config/saleSettlement');
          // eslint-disable-next-line global-require
          const { PAYMENT_STATUS: PAYMENT_STATUS_SKIP } = require('../config/scanWrite');
          const skipAutoPaymentStatus = (PAYMENT_STATUS_SKIP || {})[
            autoModeOfSkip({ itemsCents: skipItemsCents, paymentsCents: 0 }).mode
          ] || '';
          // ⭐ 跳过 = **不写收款** ✓（"钱稍后补"✓）⇒ 空的 payments + **自动定的档** + 实收按上面那份 ✓
          // eslint-disable-next-line no-await-in-loop
          skipCreated = await writeService.submitSale({
            openId: openIdOf(req),
            requestId,
            submitKey: body[fields.submitKey],
            payments: [],
            // ⭐ 同上：用**取值后的那一份**（body → 会话暂存 → 会话草稿行 ✓ 与上面同一口径）
            lineAmounts: skipResolvedAmounts,
            paymentStatus: skipAutoPaymentStatus,
            paidAmount: '',
            timing: skipStepTiming,
            pendingLine: skipView?.found ? {
              productRecordId: skipView.product_record_id,
              number: skipView.number,
              itemNo: skipView.item_no,
              color: skipView.color,
              size: skipSize,
              amount: String(skipInfo.amount || ''),
              gift: String(skipInfo.gift || ''),
              inStock: sellableSizeTexts(skipView).has(skipSize),
            } : null,
          });
          // ⭐⭐ 2026-10-16（裁决甲配套）：**"说 ok 但其实什么都没写"⇒ 不许给成功页** ✗
          //   （她真机那条「假成功」的形状：页面 200 + 成功页 + `salesEntry` 0 条）
          //   判据：既没有单号、也不是"把上一单结果还给她"（reused）⇒ 当成**没写成功**如实报 ✓
          const skipWroteNothing = Boolean(skipCreated?.ok)
            && !skipCreated?.order_no && skipCreated?.reused !== true;
          if (!skipCreated?.ok || skipWroteNothing) {
            // ⭐⭐ 2026-10-12（她口径）：**主表已建、明细那一步没写成功** ⇒ 给她**如实**的"半成"页
            //   （单子记上了 + 单号 + 怎么出去）🔴 **绝不许**说"提交已成功"✗、也**不许**说"一个字都没写"✗
            if (skipCreated?.code === 'sale_partial_failed') {
              return sendHuman(res, 500, {
                title: writeConfig.texts.partialFailedTitle,
                body: fillWriteText(writeConfig.texts.partialFailedBody, {
                  orderNo: skipCreated.order_no || '—',
                }),
                requestId,
                details: [fillWriteText(writeConfig.texts.submittedOrderLine, {
                  orderNo: skipCreated.order_no || '—',
                })],
                retryHint: writeConfig.texts.partialFailedRetryHint,
                backPath: postActionFor(
                  backTargetFor(req, decodeURIComponent(String(req.params.number || ''))), realm,
                ),
                backLabel: writeConfig.texts.submittedRecordAnother,
              });
            }
            return respondWriteFailure(
              res,
              skipWroteNothing && !skipCreated?.code
                ? { ...skipCreated, code: 'sale_write_failed' }
                : skipCreated,
              requestId,
            );
          }
          // ⭐ 建单成功 ⇒ 标记改成「**这一单已经建过**」✓（**不清成空串** ✗ —— 见 `payment_pay` 那段注释）
          await writeService.saveDraftLines?.(openIdOf(req), { paymentStep: 'created' });
        }
        // ⭐ 同上：跳过那颗按钮建单成功也要记"她刚在销售里干过活" ✓（否则裸扫默认领域会丢 ✓）
        if (skipCreated) markRealmUsed(openIdOf(req), realmOfAction(writeConfig.actions.submitOrder));
        // ⭐⭐ 同上：**建单那一步的打点**（事件名/形状照旧 ✓ 她"一查日志就知道卡在哪段"✓）
        if (skipCreated) {
          logInfo(writeConfig.events.saleTiming, {
            request_id: requestId,
            // ⭐⭐ 2026-10-15（⑨b-2）：同上（`request` 段；后台那一段由写服务自己打 ✓）。
            phase: writeConfig.timing.phase.request,
            ok: skipCreated.ok === true,
            code: skipCreated.code || '',
            order_no: skipCreated.order_no || '',
            reused: skipCreated.reused === true,
            partial: skipCreated.code === 'sale_partial_failed',
            lines: Number(skipCreated.detail_count) || 0,
            submit_ms: Math.max(0, Date.now() - skipStepStartedAt),
            queue_wait_ms: Number(skipStepTiming.queue_wait_ms) || 0,
            lookup_ms: Number(skipStepTiming.lookup_ms) || 0,
            prepare_ms: Number(skipStepTiming.prepare_ms) || 0,
            master_ms: Number(skipStepTiming.master_ms) || 0,
            status_ms: Number(skipStepTiming.status_ms) || 0,
            detail_ms: Number(skipStepTiming.detail_ms) || 0,
            stock_ms: Number(skipStepTiming.stock_ms) || 0,
          });
        }
        // ⭐ 单号/双数：**优先用刚建单的返回值** ✓（没建单时退回表单里的那两个 ✓ 一律**不编** ✗）
        const skippedOrderNo = String(skipCreated?.order_no || body.order_no || '').trim().slice(0, 40);
        const skippedCount = Number(String(skipCreated?.detail_count ?? body.count ?? '').trim() || 0) || 0;
        // ⭐ 她**再点一次**（同一把 `submitKey`）⇒ `submitSale` 返回 `reused` ✓ ⇒ 成功页要**如实**说
        //   「这一单刚才已经交过了」✓（不是失败 ✗ 也不是又写一遍 ✗）
        const skippedReused = String(body.reused || '') === '1' || skipCreated?.reused === true;
        const skipTarget = backTargetFor(req, decodeURIComponent(String(req.params.number || '')));
        // ⚠️ 成功页那两行（单号 / 双数）在**提交成功**那条路里是由 `details` 拼的 —— 跳过这条路
        //    也必须给她**同样的两行**（否则页面只剩标题 ⇒ 她看不到单号/双数 ✗）
        const skippedDetails = [
          fillWriteText(writeConfig.texts.submittedOrderLine, { orderNo: skippedOrderNo || '—' }),
          fillWriteText(writeConfig.texts.submittedDetailLine, { count: skippedCount }),
          // 🔴 2026-10-16（A2/A3）：这里原来还会追加**一句"下一步去哪"的提示**（文案键在 `config/scanWrite.js`）
          //   —— 业务负责人**逐字**：「（资金页那）三处提示【**全删**】……**全删就对了**」
          //   ⇒ 那句**连键带两处引用一起删** ✓（她不要成功页上再出现那个去处 ✗）。
          //   **塞回即红**：`test/saleSuccessHintRemoval.test.js` 的 AC-SNS1 / AC-SNS2 ✓。
        ];
        return sendSuccess(res, 200, {
          // ⭐ 与「提交成功」那条**逐字同形**：自动回销售首页那几个字段也必须有
          //    （否则成功页没有「回首页」的确定 URL ⇒ AC-SR/AC-H 那一族红 ✗）
          ...successReturnFields(req, skipTarget, skippedOrderNo || ''),
          title: skippedReused ? writeConfig.texts.submittedAgainTitle : writeConfig.texts.submittedTitle,
          body: skippedReused
            ? fillWriteText(writeConfig.texts.submittedAgainBody, { orderNo: skippedOrderNo || '—' })
            : fillWriteText(writeConfig.texts.submittedBody, { orderNo: skippedOrderNo || '—', count: skippedCount }),
          order_no: skippedOrderNo,
          details: skippedDetails,
          // ⭐ 与提交成功那条**逐字同形**：下一句人话（«接着扫下一款就可以开新的一单。» 那一句）
          retryHint: writeConfig.texts.submittedNextHint,
          requestId,
          backPath: postActionFor(
            backTargetFor(req, decodeURIComponent(String(req.params.number || ''))),
            String(body.from || realm),
          ),
          backLabel: writeConfig.texts.submittedRecordAnother,
          backHint: writeConfig.texts.submittedRecordAnotherHint,
        }, req);
      }

      /**
       * ⚠️ 2026-10-14：`step2WriteOf` / `sendPaymentStep` **已上移到工厂作用域** ✗ ——
       *   原来写在这里（POST 处理器内部）⇒ ⭐ GET 那条路（刷新认标记）**看不到它** ✗
       *   ⇒ 真机/测试都会炸 `ReferenceError: sendPaymentStep is not defined` ✓
       *   ⇒ 现在定义在工厂里（GET / POST 两个处理器都看得见 ✓ 一份实现 ✓ 不复制 ✗）
       */

      // ── 提交销售单 ──────────────────────────────────────────────────────────
      if (action === actions.submitOrder) {
        // ⭐⭐ 2026-10-11（**最终口径**）：总单层 = ①每件实收（同名重复 ⇒ 有序数组，下标 = 明细行）
        //    + ②**「付款情况」三档**（整单：全付（默认）/ 部分付 / 未付）
        //    + ③多笔收款（同名重复 ⇒ 两个数组按下标对齐）+ 「部分付」的实付多少。
        //    **原样交给写服务**，校验（含"全付必须相等"那条）在写服务里做 —— 路由不判业务。
        const payments = parsePaymentRows(body, fields);
        // 🔴🔴 2026-10-16 P0（她真机：「货品信息里填了 240 ⇒ 资金页显示 0 ⇒ 提交没反应」）：
        //   这一步原来看**裸 body** ✗ —— 而货品页每行的「每件实收」是先写进**会话草稿行**的
        //   （`:1201/:1230` → `services/scanWriteService.js:512/554` 的 `amount` ✓），
        //   资金页那张表单**完全不带** `line_amount`（`:1274` 的注释早就写明 ✓）
        //   ⇒ 空数组 ⇒ ① 必填闸门对空数组恒不报（`.some()` ✗ = 静默 0 的第二个口子）
        //            ② 结算读点拿到 0 ⇒ 26 次 `amount_mismatch items_cents=0`（她的 240 丢在这 ✗）
        //   ⇒ **照 `:1281`/`:1561` 那两处一模一样的回落写法**（一份真源 = 会话草稿行 ✓ 不发明形状 ✗）
        const submitSession = await writeService.sessions?.get?.(openId).catch(() => null);
        const pendingDraftLines = Array.isArray(submitSession?.sale?.lines) ? submitSession.sale.lines
          : (Array.isArray(submitSession?.lines) ? submitSession.lines : []);
        const bodyLineAmounts = asList(body[fields.lineAmount]);
        const draftLineAmounts = pendingDraftLines
          .map((line) => String(line?.amount ?? '').trim()).filter(Boolean);
        // 第三档：**一单一笔那条默认路径**（草稿 0 行 ⇒ 她那一下填的就在 `fields.amount` ✓）
        const singleRowAmount = String(body[fields.amount] ?? '').trim();
        const lineAmounts = bodyLineAmounts.some((value) => String(value ?? '').trim())
          ? bodyLineAmounts
          : (draftLineAmounts.length ? draftLineAmounts : (singleRowAmount ? [singleRowAmount] : []));
        // ⭐⭐ 2026-10-14（她裁决 ⓐ）：**每一双都要填「实收金额」**（现货/预订**同一处判** ✓）
        //   🔴 有空 ⇒ **400 + 人话 + 一个字都不写表** ✗（幂等键/会话都不动 ✓ 不许假成功 ✓）
        //   ⚠️ **整单收款仍可全空** ✓（「待补充」那条老路保留 ✓）
        // 🔴 2026-10-16（裁决=甲）：闸门判**取值后的那份**；且**空数组也算缺** ——
        //   只要"这一单确实有东西要付"（草稿有行 ‖ 这次带了尺码 ⇒ 一单一笔默认路径 ✓）。
        //   依据：她 2026-10-14「每一双都要填「实收金额」」+ 她 2026-10-16 00:01「金额是必填的吧」。
        // 🔴🔴 2026-10-16 P0（定论 · 顺序修正）：**状态标记必须先写** ——
        //   闸门原来在这段之前返回 ⇒ `paymentStep:'pending'` 永远没被写上
        //   ⇒ `routes/scanPage.js:1542` 的 `skipPending` 恒 false ⇒ 跳过那支整块被跳过
        //   ⇒ 拦住后她**再也走不动这一单**（页面 200、一条都不写）= 真机「点了提交没反应」✗
        //   ⇒ 标记照写（拦住时看到的仍是同一页 + 醒目人话 ✓）
await writeService.saveDraftLines?.(openId, {
          lines: pendingDraftLines,
          // ⭐ 她（或 GET）据此判断"已经走到资金这一步了" ⇒ 刷新仍停在资金页 ✓
          paymentStep: 'pending',
          // ⭐⭐ 2026-10-15 晚（task-22 · #598 引入的一处回退）：**这一单正在走 ⇒ status 落回 draft** ✓
          //   🔴 改前只写 `lines/paymentStep/submitPending`、**一个字都不写 `status`** ✗ ⇒ 上一单
          //      `completeSale` 落的 `status:'submitted'` 会**一直留着**（一单一笔的默认路径不点
          //      「加入本单」⇒ 不会重置）⇒ **第 2 单起，"刚提交、正停在资金页"的形状恰好长成
          //      #598 要清的那种残标记** ⇒ 她在资金页**刷新一下**就被打回录入页 ✗（更窄的一处回退）。
          //   ⇒ 补这一行：提交 = 这一单**正在走**，本来就是 draft 态 ✓ ⇒ 两个状态**彻底分开**：
          //      · 新一单刚提交 ⇒ `draft` ⇒ 刷新照旧给资金页 ✓
          //      · 她那次那种**没有新提交**的残标记（status 仍是上一单的 `submitted`）⇒ 照旧清 ✓
          //   ⚠️ 安全性：`status` 的另一批读点是"重启补跑"扫描（`scanSessionService` 的
          //      `findInterruptedSales` / `findUncertainInFlightSales`：**同时**要求 `draft` +
          //      `order_no` 非空 + `lines` 非空）⇒ 提交这一步**没有** `order_no`、`lines` 也可能为空
          //      ⇒ **两个条件都不满足 ⇒ 不会被当成待补跑** ✓（用例 `AC-SM10` 钉着）。
          // ⚠️ 配置路径是 `writeConfig.session.statuses`（= `config/scanWrite.js` 的 `SESSION.statuses`；
          //    `writeConfig.statuses` **不存在** ⇒ 写错了会当场 `Cannot read properties of undefined` ⇒ 500 ✗
          //    —— 我第一版就写错了，被全量/用例当场抓住 ✓ 现在按真路径取，并有用例钉着）。
          status: writeConfig.session.statuses.draft,
          // ⭐ 点按钮那一刻要写的那一双（尺码/金额/赠品）—— **从提交这一下原样存下来**（拿不到就不存 ✓ 不编 ✗）
          submitPending: {
            size: String(body[fields.size] ?? '').trim(),
            amount: String(body[fields.amount] ?? '').trim(),
            gift: String(body[fields.gift] ?? '').trim(),
            // ⭐⭐ 她在**销售页**填的"每件实收 / 收款行 / 付款情况 / 实付多少"也要一起存下来 ✓
            //   （资金页那张表单**不带**这些字段 ✗ ⇒ 不在这一步存 ⇒ 点按钮建单时它们就丢了 ✗
            //     实测：`AC-E2E-8` 的"她填的实收照旧落表"就是因为丢了这个 ✗）
            // ⭐⭐ 2026-10-16 P0（**写点一处收口**）：存**取值后的那一份**（不是裸 body ✗）——
            //   资金页两个读点（`:1281` pending / `:1561` skip）都回落到这里存的这份
            //   ⇒ 存空 ⇒ 它们也空 ⇒ `items_cents=0` ⇒ 拦住 ✗（= 她那个现场）
            lineAmounts,
            payments: parsePaymentRows(body, fields),
            paymentStatus: String(body[fields.paymentStatus] || '').trim(),
            paidAmount: String(body[fields.paidAmount] ?? ''),
          },
        });

        // ⚠️ 2026-10-16（裁决=甲 · **窄化**）：**提交步维持原状** —— 只判"她带着的那份"里的空项；
        //   "空数组也算缺"那条**只留在资金页（跳过）那一支** ✓
        //   （理由：拦下的**原因码/人话**是她真机看到的东西 ⇒ 不许在没问她之前换掉 ✗）
        if (writeConfig.lineAmountRequired !== false
          && lineAmounts.some((value) => String(value ?? '').trim() === '')) {
          logWarn('scan.write.line_amount_required', { request_id: requestId, lines: lineAmounts.length });

return sendPaymentStep(res, req, {
            paymentMethods: await candidatePaymentMethods(req),
            realm,
            status: 400,
            notice: String(writeConfig.texts.lineAmountRequiredNote || ''),
            totalAmountText: 0,
            submitKey: writeService?.sessions?.submitKeyFor?.(openId, false, 'sale') || '',
            count: lineAmounts.length,
          });
        }
        const paymentStatus = String(body[fields.paymentStatus] || '').trim();
        const paidAmount = body[fields.paidAmount] ?? '';
        // ⭐⭐ 2026-10-12：**提交这一步的分阶段耗时** —— 真机被卡住 / 收过 504 之后要的
        //    "一查日志就知道卡在哪一步"。`timing` 是写服务的**可选出参**（只读时间、不进业务入参）。
        const saleTiming = {};
        // ⭐ 2026-10-12：整页只有**一个表单** ⇒ 提交这一下**天然带着**她在尺码区选中的那一双。
        //    本单为空时 ⇒ 「选尺码 + 提交」两下就是一张单（一单一笔的默认路径）；
        //    本单已有几双 ⇒ 这一项**忽略**（多笔必须显式点【➕ 还要加一双】），
        //    判据在写服务里（`pendingLine` 只在本单为空时生效）。
        const submitLookupStartedAt = Date.now();
        const submitView = String(body[fields.size] ?? '').trim()
          ? await service.lookup({ ...lookupInputOf(req), requestId }).catch(() => null) : null;
        // `lookup_ms` = 提交前那一次"取商品"（缓存命中⇒很短；没命中⇒就是飞书那几读）。
        saleTiming.lookup_ms = Math.max(0, Date.now() - submitLookupStartedAt);
        // ⭐⭐⭐ 2026-10-16（task-53 · P0 **第二刀**）：「跳转资金页」的**前置判定** —— 缺尺码或金额 ⇒ 拦住。
        //
        // 业务负责人口径（逐字）：「算了，这样吧，**实收金额的输入框用户必须填写**，只有用户填了**尺码和金额**，
        //   才可以点击提交跳转到资金页，**不用做那个为空去单价的功能了**」
        //   ⇒ 判据 = **尺码已填 且 她填的实收金额已填**；缺任一 ⇒ **400 + 停在货品页 + 人话 + 零写入** ✓
        //
        // ⚠️ 落点三条理由（计划书 §1，都实测过）：
        //   ① **贴住那一个出口**（下面 `return sendPaymentStep(...)` 就是"点提交要跳资金页"的唯一出口）
        //      ⇒ 跳了就必须先过它，结构上不可能"跳了又拦" ✓；
        //   ② **不能往前挪**：`:1712` 起那几条更早的出口会连带罩住**幂等连点 / 重复提交 / 刷新 /
        //      资金页动作**（①刀那 6～13 条红就是挪早了 ✗）；
        //   ③ 仍在 `:1889` 那次 `service.lookup` **之后**（不挪动既有语句 ⇒ diff 最小 ✓）。
        //      ⚠️ 判定本体**不需要** `submitView` ⇒ **一次表都不读**（少一次飞书读 ✓）。
        //
        // ⚠️ 这是**独立的一块**：既有的那道闸门（`:1865` 的 `lineAmountRequired && lineAmounts.some(空)`）
        //    **一个字都没动**，新判定**没有**塞进那个 `if` 里 ✗（它是"她带着的那份里的空项"，
        //    与"缺尺码 / 缺金额 ⇒ 根本不许跳"是两件事）。
        //
        // ⚠️ 入口三条（缺一不进判定 ⇒ 不许拦）：
        //   ① `action === submitOrder`（资金页那两颗是 `payAction` / `skipAction` ⇒ 天然分开 ✓）；
        //   ② 这一发**不带收款字段**（带了 = 资金页那一跳 / 或本单流程还在往前走 ⇒ 不进 ✓）；
        //   ③ 会话标记 `paymentStep !== 'pending'`（她**再点一次** / 刷新与 ⑨ 同形 ⇒ 只能靠它
        //      区分"第一次点提交"与"已经放行过的重复提交" ✓）。
        const jumpGateHasPaymentField = asList(body[fields.paymentMethod]).length > 0
          || asList(body[fields.paymentAmount]).length > 0
          || asList(body[fields.lineAmount]).length > 0;
        const jumpGateIsFirstSubmit = String(submitSession?.sale?.paymentStep || '') !== 'pending';
        if (!jumpGateHasPaymentField && jumpGateIsFirstSubmit) {
          // 尺码 = 尺码区那一选（`body[fields.size]`）**或**本单草稿行里任一行有尺码
          //   （多行时这一发 body 不带 size ⇒ 必须看会话草稿行 ✓ 见 v2 计划 §3）。
          // ⚠️ 取舍（计划书 §6「配品行天生没有尺码」那一处）：本刀**按她字面**做 ——
          //   **尺码必须填**（不按 `requiresSize` 分叉）；"配品单"那条口子若要做，
          //   由她拍板后另开一刀（PR 里如实标注 ✓ 不擅自放宽 ✗）。
          const jumpGateHasSize = String(body[fields.size] ?? '').trim() !== ''
            || pendingDraftLines.some((line) => String(line?.size ?? '').trim() !== '');
          const jumpGateHasAmount = lineAmounts.some((value) => String(value ?? '').trim() !== '');
          if (!jumpGateHasSize || !jumpGateHasAmount) {
            // 日志：她（和我）"一查就知道卡在哪一段" ⇒ 与既有事件同一形状（不新造事件名 ✗）。
            logWarn('scan.write.jump_gate_blocked', {
              request_id: requestId, has_size: jumpGateHasSize, has_amount: jumpGateHasAmount,
            });
            return sendHuman(res, 400, {
              // 🔴 措辞从配置读（用户可见中文只许在 `src/config/**` ✗ 不许在本文件写死）：
              //   真源 = `config/scanPage.js` 的 `TEXTS.jumpGateNoticeTitle`（= 她这一刀的原话口径）。
              title: config.texts.jumpGateNoticeTitle,
              body: writeConfig.texts.lineAmountRequiredNote || '',
              requestId,
              // 「停在货品页」：回跳就是她自己扫的那一页（既有 `postActionFor` / `backTargetFor` ✓ 不新造 ✓）
              backPath: postActionFor(
                backTargetFor(req, decodeURIComponent(String(req.params.number || ''))), realm,
              ),
              backLabel: writeConfig.texts.submittedRecordAnother,
            });
          }
        }
        const submitStartedAt = Date.now();
        // ⭐⭐ 2026-10-14（业务负责人口径，逐字）：「**确认状态是资金那页点击了按钮之后，才算是用户确认了**」
        //   ⇒ 点「提交这一单」**只到资金页、一个字都不写表** ✗（不建单 / 不写明细 / 不动库存 ✓）
        //   ⇒ 把"这一单要写什么"**记进服务端会话** ✓（第二小步：点资金页按钮时才据此建单 ✓；刷新时 GET 也认它 ✓）
        //   ⚠️ 用**既有**会话机制（`saveSaleProgress` 的薄透传 `saveDraftLines` ✓ 不新造 ✓）
        // ⚠️ 2026-10-16 P0：`submitSession` / `pendingDraftLines` **已上移**到本分支开头
        //   （`lineAmounts` 的回落要用它 ✓）—— **这里不许再声明一次** ✗（重复声明 = SyntaxError）
                // ⚠️ 2026-10-16 P0：这一段 `saveDraftLines({ paymentStep:'pending', … })` **已上移到闸门之前** —— **这里不许再写第二份** ✗

        // ⭐ 资金页：还没建单 ⇒ `orderNo: ''`（**不编** ✗）· `count` 用草稿行数 ✓
        return sendPaymentStep(res, req, {
          paymentMethods: await candidatePaymentMethods(req),
          realm,
          submitKey: body[fields.submitKey],
          count: pendingDraftLines.length,
        });
        // eslint-disable-next-line no-unreachable
        const result = await writeService.submitSale({
          openId,
          requestId,
          submitKey: body[fields.submitKey],
          payments,
          lineAmounts,
          paymentStatus,
          paidAmount,
          timing: saleTiming,
          pendingLine: submitView?.found ? {
            productRecordId: submitView.product_record_id,
            number: submitView.number,
            itemNo: submitView.item_no,
            color: submitView.color,
            size: body[fields.size],
            amount: body[fields.amount],
            gift: body[fields.gift],
            // 「现货 / 预订」的判据与页面上那两个分组**同一份**（写服务按既有判据推编码）。
            inStock: sellableSizeTexts(submitView).has(String(body[fields.size] ?? '').trim()),
          } : null,
        });
        // ⭐⭐ **一条**汇总（与 `scan.lookup.timing` 同一形状）：她按 `scan.sale.timing` grep
        //    就能看出"这一次提交卡在哪一段"，不必再靠猜。
        logInfo(writeConfig.events.saleTiming, {
          request_id: requestId,
          // ⭐⭐ 2026-10-15（⑨b-2）：她那次请求这一段（后台那一跑另打一条，同事件名 + `phase`）。
          phase: writeConfig.timing.phase.request,
          ok: result.ok === true,
          code: result.code || '',
          order_no: result.order_no || '',
          reused: result.reused === true,
          partial: result.code === 'sale_partial_failed',
          lines: lineAmounts.length,
          // 提交这一步的墙钟（含排队等前面的那次提交 —— 她连点 14 次时这一段会明显变大）。
          submit_ms: Math.max(0, Date.now() - submitStartedAt),
          queue_wait_ms: Number(saleTiming.queue_wait_ms) || 0,
          lookup_ms: Number(saleTiming.lookup_ms) || 0,
          prepare_ms: Number(saleTiming.prepare_ms) || 0,
          master_ms: Number(saleTiming.master_ms) || 0,
          status_ms: Number(saleTiming.status_ms) || 0,
          detail_ms: Number(saleTiming.detail_ms) || 0,
          stock_ms: Number(saleTiming.stock_ms) || 0,
        });
        if (!result.ok) {
          // ⭐⭐ 2026-10-12：**建单成功、后面某一步（明细 / 收款 / 进度）抛错** ⇒ 如实说"半成"。
          //    🔴 判据用的是**既有**那一条：会话里已经落了主表 record_id（= 重试接着写的那条判据，
          //       见 `scanWriteService.submitSale` 里"建完立刻把 record_id 落进会话"那段）。
          //    🔴 **绝不许**显示"提交已成功"（她会以为钱货都落了）；也**不许**跟"一个字都没写"
          //       混为一谈（主表那条记录是真的落库了）⇒ 这一页给她**单号** + 怎么出去。
          if (result.code === 'sale_partial_failed') {
            const orderLine = fillWriteText(writeConfig.texts.submittedOrderLine, {
              orderNo: result.order_no || '—',
            });
            return sendHuman(res, 500, {
              title: writeConfig.texts.partialFailedTitle,
              body: fillWriteText(writeConfig.texts.partialFailedBody, {
                orderNo: result.order_no || '—',
              }),
              requestId,
              details: [orderLine],
              retryHint: writeConfig.texts.partialFailedRetryHint,
              // 怎么出去：回扫码页再点一次提交 —— 会接着**同一张单**写（幂等键 / 主表 id 都在会话里）。
              // ⭐ `/r` 底下「再录一单 / 回去再提交」要回**记录 ID** 那一页。
              backPath: postActionFor(
                backTargetFor(req, decodeURIComponent(String(req.params.number || ''))), realm,
              ),
              backLabel: writeConfig.texts.submittedRecordAnother,
            });
          }
          // ⭐⭐ 校验类失败（**核心那条：全付时每件实收合计 ≠ 收款合计**，以及付款情况 /
          //    收款行 / 每件实收本身的格式问题）⇒ **原地重渲染销售那一块**：
          //    差额人话挂在表单上方，她刚填的每件实收（在会话里）/ 付款情况 / 实付多少 /
          //    多笔收款（原样带回）都还在 —— 改一下再点提交即可。
          //    🔴 这一条**不写库**（写服务里那一段在校验之后才建主表），页面上也会把差额说清。
          if ((writeConfig.sale.formFailureCodes || []).includes(result.code)) {
            const view = await service.lookup({ ...lookupInputOf(req), requestId }).catch(() => null);
            if (view?.found) {
              const write = await buildWriteContext(req, view, 'sales', {
                paymentRows: payments, paymentStatus, paidAmount, errorText: result.message,
              });
              const html = renderScan(view, config, write, 'sales', { userAgent: req.headers['user-agent'] });
              return sendHtml(res, 400, html);
            }
          }
          return respondWriteFailure(res, result, requestId);
        }
        // ⭐ 销售单写成功 ⇒ **立刻作废**「实时库存」快照（她：库存必须准确，不是等 30 秒）。
        invalidateInventorySnapshot(requestId, 'scan_sale_submitted');
    // ⭐ 写成功 ⇒ 记住"她刚在销售里干过活"（下次**裸扫**默认还回这儿，除非她提交了 ⇒ 回销售 ✓）
    markRealmUsed(openIdOf(req), realmOfAction(writeConfig.actions.submitOrder));
        const texts = writeConfig.texts;
        const details = [
          fillWriteText(texts.submittedOrderLine, { orderNo: result.order_no || '—' }),
          fillWriteText(texts.submittedDetailLine, { count: result.detail_count || 0 }),
          // 🔴 2026-10-16（A2/A3）：原来这里还有**一句"下一步去哪"的提示**（她 2026-10-12 问过
          //   "那我接下来去哪补钱" ⇒ 当时加的）—— 她 2026-10-16 **逐字**：「（资金页那）三处提示
          //   【**全删**】……**全删就对了**」⇒ 那句**连键带两处引用一起删** ✓
          //   **塞回即红**：`test/saleSuccessHintRemoval.test.js` 的 AC-SNS1 / AC-SNS2
          //   ＋ 渲染面 = `test/scanSaleE2E.test.js` 的 AC-E2E-14 ✓。
        ];
        // ⑥ ⭐ 2026-10-11（A）：现货行"提交即交付 + 扣库存"**没扣成** ⇒ 给她一张**如实**的结果页
        //    （单子记上了 / 哪几双没扣成 / 怎么办），**不是**一句"没成功"把整件事说反。
        //    ⚠️ 这一单**没有**被记成"提交完成"（见 `scanWriteService.submitSale`）⇒
        //       照着重试那一句再点一次【提交这一单】，就会接着把没扣成的那几双扣掉。
        if (Number(result.stock?.failed || 0) > 0) {
          return sendHuman(res, 200, {
            title: texts.stockFailedTitle,
            body: fillWriteText(texts.stockFailedBody, {
              failed: result.stock.failed,
              reason: (result.stock.reasons || []).join('；'),
            }),
            requestId,
            details,
            retryHint: texts.stockFailedRetryHint,
          });
        }
        // ⚠️ 2026-10-10：原来钱没记时会补一句「这一单先记了货、还没记钱…」（`fundsPendingNote`）——
        //    那是**解释既有口径**的说明句，按业务负责人的口径删掉；写完的事实（单号 / 双数）照旧。
        // ⭐ 2026-10-11 晚：她**显式选了「全付」却一笔收款都没填** ⇒ 单子照**按未付**落
        //    （不拦她 —— 她真机就是被"资金不齐"卡住的），但结果页给她一句**指向能做的事**的人话。
        const submitHint = result.full_without_payments
          ? texts.fullWithoutPaymentsNote : texts.submittedNextHint;
        // ⭐⭐ 2026-10-12（业务负责人真机口径，逐字）：「点击提交之后**直接提示"您的提交已成功"**就行，
        //    **页面跳转到提交成功页**……给一个**链接**让我能回到扫码页。」
        //    ⇒ 从这里出去的是**成功页**（H1 逐字「您的提交已成功」+ 一颗【再录一单】回扫码页），
        //      **不再**渲染回原页、也不 303。⚠️ 连点的那一次（`reused`）同样给这一页 ——
        //      她**看到了成功**，才不会再狂点（真实事故：她点了 14 次）。
        const submitTarget = backTargetFor(req, decodeURIComponent(String(req.params.number || '')));
        // ⭐⭐ 2026-10-13「金额两步走」第 2 步（业务负责人：**可写可不写** ✓）：
        //    提交成功 ⇒ **先落「整单付款」页**（三档横向 + 收款多行 + 赠品，可填可不填）
        //    ⇒ 她点【跳过（稍后去工作台补）】⇒ 走 `payment_skip` 动作 ⇒ 成功页 ✓
        //    🔴 跳过 = 记成「待补充的信息单」：**不写收款 / 不说已收 / 也不报失败** ✓
        //    ⚠️ 2026-10-14：渲染搬去 `sendPaymentStep`（逐字搬迁 ✓ 提交与按钮两处共用 ✓）
        try {
          return sendPaymentStep(res, req, {
            paymentMethods: await candidatePaymentMethods(req),
            realm,
            submitKey: body[fields.submitKey],
            orderNo: result.order_no || '',
            count: result.detail_count || 0,
            reused: result.reused,
            // ⭐ 第 2 步的付款要写「收款明细」⇒ 用**这次提交就有**的主表 record_id（不反查 ✓）
            salesEntryRecordId: result.sales_entry_record_id || '',
          });
        } catch (error) {
          logError(config.events.failed, {
            request_id: requestId, reason: 'payment_step_render_failed', error: error.message,
          });
        }
        return sendSuccess(res, 200, {
          // ⭐ 提交成功 ⇒ 自动回【销售】首页（+ 一颗【返回扫码】兜底，同一个 URL ✓）；「再录一单」照旧保留 ✓
          // ⭐ 提交这一单 ⇒ 回跳带它的单号（ⓑ 顶部指引的数据来源 ✓）
          ...successReturnFields(req, submitTarget, result.order_no || ''),
          title: result.reused ? texts.submittedAgainTitle : texts.submittedTitle,
          body: result.reused
            ? fillWriteText(texts.submittedAgainBody, { orderNo: result.order_no || '—' })
            : fillWriteText(texts.submittedBody, {
              orderNo: result.order_no || '—', count: result.detail_count || 0,
            }),
          requestId,
          details,
          retryHint: submitHint,
          // 「再录一单」= 回到**这一款**的扫码页（编号取自 URL；非缺省领域带上 `?from=`）。
          // ⭐ `/r` 底下「再录一单」回到**记录 ID** 那一页（不是 `/s/<记录id>`）。
          backPath: postActionFor(
            backTargetFor(req, decodeURIComponent(String(req.params.number || ''))), realm,
          ),
          backLabel: texts.submittedRecordAnother,
          backHint: texts.submittedRecordAnotherHint,
        }, req);
      }

      // ── 补货报单 ────────────────────────────────────────────────────────────
      if (action === actions.replenish) {
        const view = await service.lookup({ ...lookupInputOf(req), requestId });
        if (!view.found) {
          return notFoundPage(res, requestId, {
            number: view.number, fallback: view.fallback, realm, target: scanTargetOf(req),
          });
        }
        const entries = parseReplenishEntries(body, fields, writeConfig);
        // ⭐⭐ 2026-10-14 晚：**整单金额必填**（补货 / 退货**同一个**闸门 —— 见
        //   `purchaseAmountMissingPage`）。空 ⇒ 400 + 人话 + **一个字都不写** ✓；
        //   非空 ⇒ 照旧往下走 ✓。
        // ⭐⭐ 2026-10-15（③ 写入）：**不是数字**也当场拦（见 `purchaseAmountInvalidPage`）——
        //   那个数要落**数字列**，放过去就是"页面填了、表里没有" = 假成功 ✗。
        // ⭐⭐ 2026-10-15 **她当次裁决（已不再"待裁"）**：**补货这一条不写金额** ——
        //   她原话：「退货批次的整单金额 ⇒ 写进「实际金额」，**补货不会写金额**，
        //           **只有到货的时候才会写金额**，也是写进实际金额里」
        //   ⇒ 这一列（「实际金额」）在本条链路上的**写入者只有"到货核对"那一个** ——
        //     她 2026-10-08 的口径也印证：「实际金额 = **这一次供应商的金额**」✓
        //     ⇒ **补货（报货）不许插一脚** ✗（否则同一格两个写入者会互相静默覆盖）。
        //   为什么（2026-10-15 只读核出来的事实，留在这里，下一个接棒的人不必再核一遍）：
        //   · 补货（报货）的批次行由**报货那条链路**的 `confirmPurchaseRequest`（建「报货批次」行那一处；
        //     那里的注释逐字：「她走的两条入口（供应商报单 webhook / 扫码页补货）都汇到这一处建行点」）
        //     （`origin/main` 的 `:1603`）建，**显式写 `arrivalStatus = 未到货`** ⇒ 这条批次**会**进到货验收清单
        //     （`purchasePendingBatchService` 按 `到货状态 = 未到货` 过滤）；
        //   · ⇒ 她之后**到货核对**填的「实际金额」会经 `purchaseOrderBatchService.writeAcceptance`
        //     （那里的 `:331` 起）**写同一行的同一列**，而且**没有"已有值不覆盖"的保护**；
        //   · ⇒ 所以**补货这一侧一个字都不写** ✓（她的裁决 + 上面这条技术事实**指向同一个结论**）。
        //   ⚠️ **退货那条不打架、已经写了**（退货批次建行时不写「到货状态」⇒ 不进到货清单 ⇒ 独占该列）：
        //     见下面的退货分支 + `purchaseReturnService` 的 `writeOrderAmount` 调用点。
        //   ⚠️ 这段注释**刻意不写**那个 service 的名字 —— `routes/*` 有一条既有哨兵
        //     （`test/scanPage.test.js` ④「路由里不许出现写链路的服务」）会扫源码；按它的判据走，
        //     **不放宽它** ✓（只改我这句注释的措辞）。
        // ⭐⭐ 2026-10-16（A2/A3 接线）：**把"当前是哪条链路"传进闸门** ⇒ 按 `requiredByRealm.replenish`
        //   取档 —— 她 2026-10-16 逐字「**补货不问金额**」⇒ 那一档是 `false` ⇒ **补货这条不再要求金额** ✓
        //   （**改前逐字**：`if (purchaseAmountMissing(body)) …` ＝ 与退货共用"一个开关" ⇒ 补货也被拦 ✗）。
        //   ⚠️ 这里**逐字传档位键 `'replenish'`**（＝ `PURCHASE_AMOUNT.requiredByRealm` 的键名 ✓），
        //     **不是**页面领域 id（那个恰好同名，但**别指望**它是同一个概念 —— 见下面退货那处）。
        if (purchaseAmountMissing(body, 'replenish')) return purchaseAmountMissingPage(req, res, requestId, realm);
        if (purchaseAmountInvalid(body, 'replenish')) return purchaseAmountInvalidPage(req, res, requestId, realm);
        // ⭐⭐ 2026-10-16（口子收尾 · 她**逐字**：「**异步只针对"写库"**；校验必须**当场同步拦**」）：
        //   **尺码 / 数量 / 空单**这三类**也留在同步路径**（与上面两道金额闸门**同形** ✓）——
        //   命中 ⇒ **400 + 写层那一句人话 + 零写入 + 一次后台都不排** ✓（见 `purchaseEntryInvalidPage`）。
        //   🔴 判据**只有一份真源**：`config/scanPurchaseEntryRules.js`（== 写层
        //     `services/scanWriteService.js:1397-1426` 那一段，**逐字同源**）⇒ 本文件**不手抄 if-else** ✗。
        //   🔴 位置**必须在 `schedulePurchaseWrite(…)` 之前**：先排后台再校验 = 把"她填错了"
        //     变成"看起来成功" ✗（她最恨的那条；也是 AC-ASY2 的精神 ✓）。
        const replenishViolation = purchaseEntryViolation({ chain: 'replenish', entries });
        if (replenishViolation) {
          return purchaseEntryInvalidPage(req, res, requestId, realm, replenishViolation);
        }
        // ⭐⭐ 2026-10-16（task-52 · ②-⑭ 接线 · 她 2026-10-16 逐字）：
        //   「**补货、退货还有验收，它都是异步的**……都是一句『**已提交成功，数据会更新**』」
        //   ⇒ **金额 / 单号认不出**仍留在**同步路径**（上面两道闸门 + 上面的 `notFoundPage`），
        //     **写库那一步**丢给后台那一跑 ⇒ 她**先拿到成功页** ✓
        //   🔴 顺序不能反：先排后台再校验 = 把"她填错了"变成"看起来成功" ✗（她最恨的那条）。
        const disabledError = purchaseWriteDisabledError(writeConfig.replenish, writeConfig.texts);
        if (disabledError) return respondWriteFailure(res, disabledError, requestId);
        // ⭐⭐ 2026-10-16（task-59 · 路由半）：**一单多货品**（补货）。
        //   · 隐藏字段 `multi_items` 渲的是【**首件**（= 当前这一款）+ `entries: []`】——
        //     渲染半逐字注明「`entries` 由路由在提交时合并」⇒ 这里把**本次表单**的尺码/数量
        //     **合并进首件**（`mergeFirstItemEntries`：**赋值**语义 ⇒ 只生效一次，数量**不会翻倍** ✓）；
        //   · 🔴 **`≤1` 组 ⇒ 一个字都不变**：不碰引擎、不碰参数，照旧走下面那条老路径 ✓
        //     （「N=1 与旧路径逐字等价」靠**代码路径同一条**成立，不是在引擎里凑形状 ✗）。
        const groups = mergeFirstItemEntries(parseMultiItemGroups(body, multiItemOrderConfig), entries);
        if (groups.length > 1) {
          return submitMultiItemOrder({
            req, res, requestId, chain: 'replenish', groups,
            action: writeConfig.actions.submitReplenish,
          });
        }
        // 🔴 **同一把 `submitKey` 原样透传**（幂等责任在写层：本文件不拼、不加后缀 ✗）
        const replenishSubmitKey = body[fields.submitKey];
        schedulePurchaseWrite({
          chain: 'replenish',
          requestId,
          submitKey: replenishSubmitKey,
          context: { openId, requestId, number: view.number },
          // ⚠️ 只给**写层要的那几个实参**（`requestId` / `submitKey` 由 `runRest` 原样带上 ✓）
          restInput: {
            openId,
            productRecordId: view.product_record_id,
            number: view.number,
            entries,
          },
        });
        // ⭐ 补货报单**已经收下**（后台接着写）⇒ 同样失效快照（她点名了「补货」也要；这一步不动库存，
        //    但"写完就失效"永远比"猜它动没动库存"安全）。
        invalidateInventorySnapshot(requestId, 'scan_replenish_submitted');
        markRealmUsed(openIdOf(req), realmOfAction(writeConfig.actions.submitReplenish));
        // ⭐⭐ 2026-10-16（她逐字：「用户提交之后**都是一个成功页**，说『**已提交成功，数据会更新**』」）
        //   ⇒ 成功页 = **统一那一句**（文案的家在 `config/scanPage.js` 的 `saleSuccess` ✓ 本文件不新造 ✗）。
        //   ⚠️ **批次号 / 明细数这一刻还没有**（后台那一跑才取号）⇒ 成功页**不许**承诺它们 ✗
        //     （真失败仍有出口：后台件的 warn ＋ 会话 `last_error` ⇒ 可查、可重试 ✓）。
        return sendSuccess(res, 200, {
          // ⭐ 补货成功 ⇒ **同样自动回首页**（销售 ✓ 方案 A 三路一致）
          ...successReturnFields(req, backTargetFor(req, decodeURIComponent(String(req.params.number || '')))),
          requestId,
        }, req);
      }

      // ── ⭐ 采购退货（业务负责人 2026-10-11：「和"报货"逻辑一样，也走扫码」）────────
      //    与补货**同形**：同一个 POST 端点、同一套会话/幂等/失败口径；
      //    写库（批次行 + 退货明细 + 扣库存 + 出退货单图）全在既有构件里。
      if (action === actions.purchaseReturn) {
        const view = await service.lookup({ ...lookupInputOf(req), requestId });
        if (!view.found) {
          return notFoundPage(res, requestId, {
            number: view.number, fallback: view.fallback, realm, target: scanTargetOf(req),
          });
        }
        const entries = parseReturnEntries(body, fields, writeConfig);
        // ⭐⭐ 2026-10-14 晚（她逐字）：「**退货整单金额（必填），与补货同一套配置**」
        //   ⇒ 与补货**同一个**闸门（一套配置 ✓ 不写两套 ✗）：空 ⇒ 400 + 人话 + **零写入** ✓；
        //     ⭐ 2026-10-15：**不是数字**也拦（要落数字列 ⇒ 不许假成功 ✗）。
        // ⭐⭐ 2026-10-16（A2/A3 接线）：**传链路** ⇒ 按 `requiredByRealm.return` 取档 —— 她 2026-10-14
        //   「退货整单金额（必填）」＋ 2026-10-16「补货不问金额」⇒ **退货这一档仍是 `true`** ⇒
        //   空 / 非数字**照旧 400 + 人话 + 零写入** ✓（**她的口径：退货不受影响** ✓ 判据一个字没放宽 ✗）。
        //   ⚠️ **逐字传档位键 `'return'`** —— ⚠️ **不是** `'purchase_return'`（那是页面的领域 id，
        //     `views/scanPageRealm.js` 的 `PURCHASE_RETURN_REALM`）★ 两者**故意不同名**：
        //     档位键由 `config/scanWrite.js` 的三个 `readFlag`（`…_REPLENISH` / `…_RETURN` / `…_ACCEPT`）决定。
        //     传错 = 拿错档位（`requiredByRealm['purchase_return']` 是 `undefined` ⇒ 会退化成"要金额"）
        //     ⇒ 判据 `test/purchaseAmountRealmWiring.test.js` 的 AC-PAWIRE2 **逐字**钉住这两处 ✓。
        if (purchaseAmountMissing(body, 'return')) return purchaseAmountMissingPage(req, res, requestId, realm);
        if (purchaseAmountInvalid(body, 'return')) return purchaseAmountInvalidPage(req, res, requestId, realm);
        // ⭐⭐ 2026-10-16（口子收尾）：与补货那条**同形** —— **尺码 / 数量 / 空单**也在这里当场拦
        //   （判据同一份真源 `config/scanPurchaseEntryRules.js` == 写层
        //    `services/scanWriteService.js:1556-1585`，逐字同源 ✓）。
        //   🔴 同样**必须在 `schedulePurchaseWrite(…)` 之前**：命中 ⇒ 400 + 写层那一句人话
        //     ＋ **零写入** ＋ **一次后台都不排** ✓。
        const returnViolation = purchaseEntryViolation({ chain: 'purchase_return', entries });
        if (returnViolation) {
          return purchaseEntryInvalidPage(req, res, requestId, realm, returnViolation);
        }
        // ⭐⭐ 2026-10-15 **③ 写入已落地**（她裁决 ⓐ「复用「实际金额」」）——
        //   改前逐字：`// TODO(purchase-amount): 金额**还没落表** —— 落哪一列**待她裁决**（同上，
        //             采购明细没有金额列、「实际金额」已被"到货核对"占用）⇒ 不自己挑列写 ✗。`
        //   改后逐字：**TODO 删掉**，改成下面这一句 + 把金额透传给既有写服务：
        //     `orderAmount: String(body[fields.purchaseAmount] ?? '').trim(),`
        //   依据：她 2026-10-14 晚「退货整单金额（必填），与补货同一套配置」＋ 2026-10-15 裁决 ⓐ
        //     （落点 = `purchaseOrderBatch.actualAmount`）；⚠️ **退货这条独占该列**（只读核过：
        //     退货批次建行时不写「到货状态」⇒ 不进到货清单 ⇒ 不会被到货核对覆盖）✓
        //   ⚠️ 写库仍在**既有**构件里：`scanWriteService.submitPurchaseReturn` → `purchaseReturnService`
        //     → `purchaseOrderBatchService.writeOrderAmount`（**不新开写库路径** ✗）；
        //     同一把 `submitKey` 幂等（批次行只建一条、金额是同一个值 ⇒ 不累加）✓
        // ⭐⭐ 2026-10-16（task-52 · ②-⑭ 接线）：与补货那条**同形** —— **金额 / 单号认出与否**
        //   留在这里（同步 ✗）、**写库丢给后台那一跑**（她先拿到统一成功页 ✓）。
        const disabledError = purchaseWriteDisabledError(writeConfig.purchaseReturn, writeConfig.texts);
        if (disabledError) return respondWriteFailure(res, disabledError, requestId);
        // ⭐⭐ 2026-10-16（task-59 · 路由半）：**一单多货品**（退货）—— 与补货那条**同形** ✓
        //   · 首件 = 当前这一款，`entries` 由这里合并进去（**只合并一次** ✓ 见 `mergeFirstItemEntries`）；
        //   · 🔴 **整单金额**（退货必填）由 `submitMultiItemOrder` 写进草稿 `order_amount`
        //     —— 空 / 非数字**上面已经同步拦过**（400 + 人话 + 零写入 ✓），这里不重复判 ✗；
        //   · 🔴 **超库存**：本刀**不传**引擎的 `stockView` ⇒ 逐行"退能退的"仍由**既有写入件**
        //     落地（与今天 N=1 同一条通路 ✓）；差额照旧只在写入件返回值 / 日志里（**已知取舍**，
        //     与今天 N=1 那条路一致 —— 见下面那句"差额这一刻还没有"✓），**本刀不把它搬到页面上**
        //     （那要新文案 ⇒ 越界 ✗）。
        //   · 🔴 **`≤1` 组一个字都不变** ⇒ 照旧走下面那条老路径 ✓。
        const groups = mergeFirstItemEntries(parseMultiItemGroups(body, multiItemOrderConfig), entries);
        if (groups.length > 1) {
          return submitMultiItemOrder({
            req, res, requestId, chain: 'return', groups,
            action: writeConfig.actions.submitPurchaseReturn,
          });
        }
        // 🔴 **同一把 `submitKey` 原样透传**（幂等责任在写层：本文件不拼、不加后缀 ✗）
        const returnSubmitKey = body[fields.submitKey];
        //   ⚠️ 金额入参**逐字不带**：金额闸门在**上面**已经判过（空 / 非数字当场 400 + 零写入 ✓），
        //      这里仍按改前的形状把金额透传给写层（它要落「实际金额」✓）。
        const returnOrderAmount = String(body[fields.purchaseAmount] ?? '').trim();
        schedulePurchaseWrite({
          chain: 'purchase_return',
          requestId,
          submitKey: returnSubmitKey,
          context: { openId, requestId, number: view.number },
          // ⚠️ 只给**写层要的那几个实参**（`requestId` / `submitKey` 由 `runRest` 原样带上 ✓）
          restInput: {
            openId,
            productRecordId: view.product_record_id,
            number: view.number,
            orderAmount: returnOrderAmount,
            entries,
          },
        });
        // ⭐ 退货**真的动了库存** ⇒ 立刻作废「实时库存」内存快照（她：库存必须准确）。
        invalidateInventorySnapshot(requestId, 'scan_purchase_return_submitted');
        markRealmUsed(openIdOf(req), realmOfAction(writeConfig.actions.submitPurchaseReturn));
        // ⭐⭐ 2026-10-16（她逐字：「都是一个成功页，说『已提交成功，数据会更新』」）：
        //   成功页 = **统一那一句**（文案的家在 `config/scanPage.js` ✓）。
        //   ⚠️ 批次号 / 明细数 / **超库存差额**这一刻都还没有（后台那一跑才知道）⇒ 页面**不许**承诺 ✗
        //     —— 差额那件事仍在后台日志与会话 `last_error` 里（**已知取舍，见 PR 说明** ✓）。
        return sendSuccess(res, 200, {
          // ⭐ 退货成功 ⇒ **同样自动回首页**（销售 ✓ 方案 A 三路一致）
          ...successReturnFields(req, backTargetFor(req, decodeURIComponent(String(req.params.number || '')))),
          requestId,
        }, req);
      }

      // ⭐⭐ 2026-10-14：**所有动作分支都不匹配 ⇒ 照旧给人话**（`unknownActionFailure`）——
      //   ⚠️ 拆验收那几刀时，这个**通用兜底调用点**被连带摘掉过 ✗ ⇒ 症状：未知动作的 POST
      //      **永远没人应答** ⇒ 客户端 `fetch` 挂住 ≈301 秒 ✗（`test/scanPageWrite.test.js` 的 ⑨ 抓到 ✓）
      //   ⇒ 这里按 HEAD 的原样补回（**产品行为修复** ✓ 不是改测试绕开 ✗）
      return unknownActionFailure(req, res, requestId, action);
    } catch (error) {
      // 走到这里说明是**没预料到**的异常（写服务内部已把业务失败都收敛成人话结果）。
      if (isDataNotReady(error)) {
        res.set('Retry-After', '5');
        return sendHuman(res, 503, {
          title: config.texts.busyTitle, body: config.texts.busyBody, requestId,
        });
      }
      return respondFailure(res, error, requestId);
    }
  });

  // `POST /s`（没有编号）：没有编号就不知道是哪一款，回"这个链接不对"。
  router.post('/', (req, res) => {
    logWarn(config.events.badNumber, { request_id: req.requestId, reason: 'missing_number' });
    return badNumberPage(res, 400, req.requestId);
  });

  /**
   * 路由参数解码失败（例：`/s/50%OFF`、`/s/%zz`）会在**进入上面那个 handler 之前**
   * 由 Express 抛出来（`Failed to decode param`，status 400）。router 级错误中间件能接住它
   * —— 接住是为了**给她一张人话页面**，而不是 Express 默认那行 "Bad Request"。
   * ⚠️ 只挂在 `/s` 这一个 router 上，别的路由的错误不受影响。
   */
  // eslint-disable-next-line no-unused-vars
  router.use((error, req, res, next) => {
    logWarn(config.events.badNumber, {
      request_id: req.requestId,
      reason: 'decode_failed',
      path: String(req.originalUrl || '').slice(0, 200),
    });
    return badNumberPage(res, error?.status === 400 ? 400 : 500, req.requestId);
  });

  return router;
};

/**
 * 补货表单 → `[{ size, quantity }]`。
 * 表单里：勾了哪个尺码（`sizes` 多选）就在 `qty_<尺码>` 里填数量；
 * 勾了不填 ⇒ 交给写服务按配置的默认值（1 双）算 —— 这里**不替她决定**。
 * ⚠️ 本函数**只做形状转换**（不判合法性 ✗）；三类校验走
 *   `config/scanPurchaseEntryRules.js` 的 `purchaseEntryViolation`（与写层
 *   `services/scanWriteService.js:1397-1426` 逐字同源 ✓）—— 判据**不许**在这里再抄一份 ✗。
 */
const parseReplenishEntries = (body, fields, writeConfig) => {
  const rawSizes = body[fields.replenishSizes];
  const sizes = Array.isArray(rawSizes) ? rawSizes : (rawSizes === undefined || rawSizes === '' ? [] : [rawSizes]);
  return sizes.map((size) => ({
    size,
    quantity: body[`${fields.replenishQuantityPrefix}${size}`] ?? writeConfig.replenish.defaultQuantity,
  }));
};

/**
 * ⭐ 2026-10-11：**退货**表单 → `[{ size, quantity }]`（与补货那条**同一个形状**，
 * 只是字段名换成配置里的 `return_sizes` / `return_qty_<尺码>`）。
 * 勾了不填数量 ⇒ 交给写服务按配置的默认值算 —— 这里**不替她决定**。
 * ⚠️ 与补货那条同一条口径：**只做形状转换**；三类校验走
 *   `purchaseEntryViolation`（与写层 `services/scanWriteService.js:1556-1585` 逐字同源 ✓）。
 */
const parseReturnEntries = (body, fields, writeConfig) => {
  const rawSizes = body[fields.returnSizes];
  const sizes = Array.isArray(rawSizes) ? rawSizes : (rawSizes === undefined || rawSizes === '' ? [] : [rawSizes]);
  return sizes.map((size) => ({
    size,
    quantity: body[`${fields.returnQuantityPrefix}${size}`] ?? writeConfig.purchaseReturn.defaultQuantity,
  }));
};

/**
 * ⭐⭐ 2026-10-16（task-59 · 路由半）：隐藏字段 `multi_items` → **分组数组**（纯函数 ✓ 用例直调 ✓）。
 *
 * 形状 = 设计 §4.3（渲染半的 `multiItemPayloadJson` 逐字同源）：
 *   `[{ product_record_id, number, item_no, color, supplier_record_id, entries: [{ size, quantity }] }]`
 *
 * 🔴 **坏输入一律 `[]`**（回落老路径 ⇒ 引擎 **0 次** ✓）：没这个字段 / 空串 / **JSON 坏** /
 *    **不是数组** —— 解析器**不抛、不编、不猜** ✗（RT6）。
 * ⚠️ 同名字段出现多次时（`extended:true` ⇒ 数组）**取最后一个**（= 浏览器最后提交的那一份）。
 * ⚠️ 字段名**只从配置取**（`config/multiItemOrder.js` 的 `field` ✓）—— 这里**不写死** ✗。
 */
const parseMultiItemGroups = (body, multiConfig) => {
  const field = String((multiConfig && multiConfig.field) || '');
  if (!field || !body) return [];
  const raw = body[field];
  const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  if (typeof value !== 'string' || !value.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    return [];
  }
  return Array.isArray(parsed) ? parsed : [];
};

/**
 * ⭐⭐ 2026-10-16（task-59 · 两半一刀）：这一发 POST 是不是「＋ 再加一个货品 / 移除」那两颗 `submit`？
 *
 * 🔴 **必须在动作分派之前问这一句**：那两颗按钮就在**既有那张表单里** ⇒ 点它们时
 *   `hidden action=replenish|return_purchase` **也一起发出来** —— 不先拦，她这一点就会被
 *   "既有补货/退货提交"吃掉（**直接报单走人、页面跳走** ✗✗，比改前"点了没反应"更糟）。
 *
 * ⚠️ **字段名 / 取值都从配置取**（`config/multiItemOrder.js` ✓）—— 这里**一个字符串都不写死** ✗；
 *   尤其**不许拿 `action` 当字段名**（表单里已经有它 ⇒ `extended:true` 下会被挤成**数组** ✗）。
 * ⚠️ 同名字段出现多次（她连点 / 手工构造）⇒ 取**最后一个**（与 `parseMultiItemGroups` 同一条口径 ✓）。
 * ⚠️ **坏输入 ⇒ `{ kind: '' }`**（回落"这不是加/删货"⇒ 照旧走既有分派 ✓ 不抛、不猜 ✗）。
 *
 * @returns {{kind:'add'|'remove'|'', productRecordId?:string}}
 */
const multiItemActionOf = (body, config = MULTI_ITEM_ORDER) => {
  if (!body || typeof body !== 'object') return { kind: '' };
  const addField = String((config && config.addField) || '');
  const addValue = String((config && config.addValue) || '');
  const removeField = String((config && config.removeField) || '');
  const last = (value) => (Array.isArray(value) ? value[value.length - 1] : value);
  // 删货优先判：它的 `value` 是**每一行各不相同**的货品 id（不是那个固定取值 ✓）
  if (removeField && body[removeField] !== undefined) {
    return { kind: 'remove', productRecordId: String(last(body[removeField]) ?? '').trim() };
  }
  if (addField && String(last(body[addField]) ?? '').trim() === addValue && addValue !== '') {
    return { kind: 'add' };
  }
  return { kind: '' };
};

/**
 * ⭐⭐ **首件 + 本次表单的尺码/数量**（渲染半逐字注明「`entries` 由路由在提交时合并」✓）。
 *
 * 🔴 **只合并一次**：这里是**赋值**（不是 `concat` / `push`）⇒ 就算这一段被走两遍，
 *    数量也**不会翻倍** ✓（翻倍 = 那一单凭空多补/多退 ✗）。
 * ⚠️ 真的"同货号 + 同尺码出现两次"（她勾了两遍）由引擎的 `duplicate_line` **拒单**兜住 ✓
 *    —— **不是**静默翻倍 ✗。
 * ⚠️ 只动**首件**（= 隐藏字段里那件，也就是她当前扫的这一款）；
 *    其余分组**原样透传**（它们的 `entries` 由渲染那一侧决定，本函数**不碰** ✗）。
 */
const mergeFirstItemEntries = (groups, entries) => {
  const list = Array.isArray(groups) ? groups : [];
  if (!list.length) return [];
  const lines = (Array.isArray(entries) ? entries : []).map((entry) => ({
    size: entry?.size, quantity: entry?.quantity,
  }));
  return [{ ...list[0], entries: lines }, ...list.slice(1)];
};

/**
 * 表单里**同名重复**的字段（`line_amount` / `payment_method` / `payment_amount`）
 * 在 `express.urlencoded({extended:true})` 下是**数组**；只出现一次时是**字符串**。
 * 这个纯函数把两种形状统一成有序数组（顺序 = 页面上的行顺序）。
 */
/**
 * ⭐ 2026-10-12：表单里传来的**尺码**（正整数；认不出就丢）——
 * 与 `asList` 并排，只给"未报货候选"那几个可点元素用。
 */
const positiveSize = (value) => {
  const text = String(value ?? '').trim();
  return /^[1-9]\d*$/.test(text) ? Number(text) : null;
};

/**
 * ⭐⭐ 2026-10-16（task-52 · ②-⑭ 接线）：**写入口关着 ⇒ 不许收单** ——
 *   这条闸门必须在**同步那一半**（排后台之前）：否则开关关着时她也会看到成功页，
 *   而**一个字都没写** ✗（val-cp 盘点的 X-6：「关着还收单 = 骗她」）。
 *
 * ⚠️ 它是**运维开关**（`SCAN_REPLENISH_WRITE_ENABLED` / `SCAN_RETURN_WRITE_ENABLED`，显式布尔 ✓），
 *    不是她的输入 ⇒ 与「她填错了」那类校验**分开**：
 *   · **金额 / 单号认不出** ⇒ 仍在**同步路径**（`purchaseAmount*Page` / `notFoundPage` ✓）；
 *   · **尺码 / 数量 / 空单** ⇒ 也**已经**在**同步路径**（`purchaseEntryViolation` ⇒
 *     `purchaseEntryInvalidPage`，**排后台之前** ⇒ 400 + 人话 + 零写入 + 不调度 ✓）。
 *     ⚠️ **改前逐字**（2026-10-16 上半场 · #695 的已知取舍）：
 *       `· **尺码 / 数量 / 空单** ⇒ 在**写层**（\`services/scanWriteService.js\`，本刀**一个字不改** ✗）——
 *        它们跟着"写库那一步"进后台（**已知取舍**：写层失败 ⇒ 后台 warn ＋ 会话 \`last_error\`，
 *        不会静默；🔴 见 PR 说明，别当它不存在 ✗）。`
 *     ⚠️ **改后逐字**：本刀把这三类**搬到同步路径**（**移出后台** ✓）——
 *       判据只有一份真源（`config/scanPurchaseEntryRules.js`，与写层
 *       `services/scanWriteService.js:1397-1426` / `:1556-1585` 逐字同源 ✓），
 *       **`scanWriteService.js` 一个字都不改** ✗（余量 0 硬红线）。
 *       依据：业务负责人口径「**异步只针对"写库"**；**校验必须当场同步拦**」。
 *
 * @returns {null|{code:string, message:string}} `null` = 放行；否则调用方照旧
 *   `respondWriteFailure` ⇒ **400 + 人话 + 零写入**（与改前那张页逐字同形 ✓）。
 */
const purchaseWriteDisabledError = (chainConfig, texts) => (chainConfig?.enabled === false
  ? { code: 'disabled', message: texts.writeDisabledBody }
  : null);

const asList = (value) => {
  if (Array.isArray(value)) return value.map((item) => (item === undefined || item === null ? '' : item));
  if (value === undefined || value === null) return [];
  return [value];
};

/**
 * 表单 → **多笔收款**（`[{ method, amount }]`，按下标对齐）。
 * ⚠️ 这里**不判业务**（哪一行算一笔、方式必不必填 ⇒ 写服务说了算）；
 *    只负责把两个同名数组拼成行 —— 少一个字段的行也照拼（缺的那位是空串）。
 */
const parsePaymentRows = (body, fields) => {
  const methods = asList(body[fields.paymentMethod]);
  const amounts = asList(body[fields.paymentAmount]);
  const total = Math.max(methods.length, amounts.length);
  return Array.from({ length: total }, (_, index) => ({
    method: methods[index] ?? '', amount: amounts[index] ?? '',
  }));
};

module.exports = {
  createScanPageRouter, isDataNotReady, parseReplenishEntries, parseReturnEntries, parsePaymentRows,
  // ⭐ 2026-10-16（task-59 · 路由半）：多货品那两个**纯函数**照上面几个的既有风格一起导出 ✓
  //   （用例直调它们钉"坏输入 ⇒ `[]`"与"只合并一次 ⇒ 数量不翻倍"✓）
  parseMultiItemGroups, mergeFirstItemEntries,
  // ⭐⭐ 2026-10-16（task-59 · 两半一刀）：**加 / 删货**那一发的判据（同样导出，用例直调 ✓）
  multiItemActionOf,
};
