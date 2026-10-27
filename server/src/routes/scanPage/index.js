/**
 * 扫码页路由：**`GET /r/:recordId`**（`number` = 「编号」= `货号|颜色|类别`，URL 编码过的）
 * ＋ **`POST /r/:recordId`**（页面上那两个**写入口**：销售建单 / 补货报单）。
 *
 * 这一页就是标签二维码指向的那个地址 —— 二维码内容的唯一真源是
 * `config/tagQrCode.js` 的 `scanUrl.recordIdTemplate`（`https://hm.bamamei.online/s/{编号}`），
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
 *   ⚠️ 作用域是**整个扫码 router**（`/r/` 与 `/r/:recordId` 都算"扫码页"）：
 *   没登录的人先登录再看页面，页面本身（200/400/404/503）对已登录的人**逐字不变**。
 */
const express = require('express');
const { V1BitableGateway } = require('../../services/v1BitableGateway');
const { sizesForCategory, parseNumberSegments, createScanPageService } = require('../../services/scanPageService');
const { createScanWriteService } = require('../../services/scanWriteService');
const { createSalesAsyncRuntime } = require('../../services/salesAsyncRuntime');
// ⭐⭐ 2026-10-16（task-52 · ②-⑭ · 业务负责人**逐字**）：
//   「**补货、退货还有验收，它都是异步的**……都是一句『**已提交成功，数据会更新**』」
//   ⇒ 补货 / 退货改成 **先回成功页（200）⇒ 「后台那一跑」写库**。
//   后台件是**共用件**（`services/purchaseWriteBackgroundService.js`，已合在 main ✓）——
//   🔴 本文件**只接线**：`runRest` 接的就是**既有**写入口（**不新开写库路径** ✗）。
const { createPurchaseWriteBackgroundService } = require('../../services/purchaseWriteBackgroundService');
// ⭐⭐ 2026-10-16 A2a ③：**候选收款方式改读表**（她 2026-10-14 逐字：「**付款方式用交易方式管理，
//    可选择**」）—— 只读 + TTL 缓存的那份 service（`services/paymentMethodsService.js`）。
const { createPaymentMethodsService, orderWithPreferred } = require('../../services/paymentMethodsService');
const { createVoucherPaymentService } = require('../../services/voucherPaymentService');
const { SalesFollowupService } = require('../../services/salesFollowupService');
const { renderSalesHome, renderScanSkeleton, renderScanPage, renderScanMessagePage, renderMinimalPage, renderSaleSuccessPage, renderSalePaymentStepPage, buildPaymentRows } = require('../../views/scanPageRenderer');
// ⭐⭐ 2026-10-16（退货「出图发群」接线 · 本卡）：**采购退货**那条链要的「出图 / 发群 / 回填附件」
//   装配件 —— 它把真的那个出图 webhook 实例接到退货写入件的 `webhooks` 上
//   （与补货 / 验收**同一条路**：同一个类、同一个 `deliverSupplierImages` ✓ 不发明新写法 ✗）。
//   🔴 **为什么单独一个文件**：本文件（`routes/**`）有**两条既有哨兵**
//     （`test/multiItemOrderRoute.test.js` 的 RT5；草稿那条 `AC-D3i2` 已随草稿链退场删除）；
//     ⚠️ 还有 `test/scanPage.test.js` ④ **连注释一起扫**）——
//     路由里**不许出现**写链路那几个服务名（出图/报货那条、退货那条、以及那个类名）✗
//     ⇒ 真名只住在那个装配件里，本文件只 require 它 ✓（⚠️ 连注释里都别写它们 ✗）。
//   ⚠️ 接不接由**配置**决定（`config/scanWrite.js` 的 `PURCHASE_RETURN.imageDelivery.enabled` ✓
//     配置先行）；发到哪个群仍是既有 `PURCHASE_CHAT_ID` ✓（本文件一行都不读它 ✗）。
const { resolvePurchaseReturnImageOptions } = require('../../services/purchaseReturnImageWiring');
// ⚠️ 只借这两个**纯函数**：所选尺码在「样品 + 门盒」有没有货（= 页面上那两个分组的判据），
//    以及 `?from=` → 领域 id（认不出来回落缺省，不报错、不白屏）。
const { sellableSizeTexts, resolveRealm, DEFAULT_REALM, PURCHASE_RETURN_REALM } = require('../../views/scanPageRealm');
// ⭐ 写操作之后**立刻作废**「实时库存」内存快照（她：库存必须准确，不是等 30 秒）。
const { invalidateLiveInventorySnapshot } = require('../../services/liveInventorySnapshot');
// ⭐⭐ 2026-10-16 task-62（货/钱分离）：开关（**显式布尔 · 缺省 false** ✓ 调用时读 ⇒ 改了当场认 ✓）
const { requireWorkbenchAccess } = require('../workbench');
// ⚠️ 会话读取/解码与回跳校验**复用 feishuWebAuth 里那一份**（`getSessionUser` =
//    `requireWorkbenchAccess` 判 401 用的同一个函数），**不重写第二份**。
const {enabled: feishuAuthEnabled,
  getSessionUser,
  buildLoginStartUrl,
  resolveScanNext, COOKIE_NAME, encodeSession } = require('../feishuWebAuth');
const { SCAN_PAGE } = require('../../config/scanPage');
const { SCAN_WRITE, fillText: fillWriteText } = require('../../config/scanWrite');
// ⭐⭐ 2026-10-16（task-59「一单多货品」**路由半**）：设计见
//   `docs/multi-item-order-design-2026-10-15.md` · 锚点见 `docs/multi-item-route-anchors-2026-10-16.md`。
//   · **引擎**（`services/multiItemOrderService.js`）管草稿 / 校验 / 批量落库 / 幂等 / 轮换 ——
//     本文件**只做三件事**：解析载荷 → 把**首件**与本次表单的尺码/数量合并 → 交给引擎 ✓；
//   · **配置**（`config/multiItemOrder.js`）管开关 / 上限 / 字段名 / 文案 ✓（这里一行阈值都不许写死 ✗）；
//   · 🔴 **N=1 一个字节都不经过这条路** —— 只有"分组 > 1"才进（见下面两处 `groups.length > 1`）✓。
const { resolveMultiItemOrderConfig } = require('../../config/multiItemOrder');
const { createMultiItemOrderService } = require('../../services/multiItemOrderService');
// ⭐⭐ 2026-10-16（task-61 · ②「领域内扫一扫」）：口径与配置见 `config/realmScan.js` 的文件头。
//   · **不加第二套** ✗：仍然用既有 `services/larkJsapiService.js` 那一套飞书 JSAPI 签名
//     （与工作台「扫码打印」同一条链 ✓）；
//   · **落点只有一处区别**：扫完那件带 `?from=<当前领域>` ⇒ 落回**原领域** ✓
//     （读它的那一位是既有 `views/scanPageRealm.js` 的 `resolveRealm` ✓ 不新造规则 ✗）。
const { REALM_SCAN, realmEntryParams } = require('../../config/realmScan');
const { FUNNEL } = require('../../config/funnel');
// 别名：聚合测试会把 handler 实现文本也并进来 ⇒ 顶层同名会重复声明
const { handleReplenish: handleReplenishOf, handlePurchaseReturn: handlePurchaseReturnOf } = require('./handlers/purchase');
const { handlePaymentPay: handlePaymentPayOf } = require('./handlers/payment');
const { handleSubmitOrder: handleSubmitOrderOf } = require('./handlers/salesSubmit');
const { handlePrintLabel: handlePrintLabelOf, handleAddLine: handleAddLineOf, handleClearDraft: handleClearDraftOf } = require('./handlers/smallActions');
const { createMultiItemPending: createMultiItemPendingOf, createPurchaseScheduler: createPurchaseSchedulerOf } = require('./sessionFlow');
// ⭐⭐ 2026-10-18（task-2「扫码会话按页面/设备隔离」）：**per-page token**（cookie）与会话键合成。
//   · cookie 由中间件种/复用；POST 同源自动携带 ⇒ **一个表单字段都不用加**；
//   · 会话键 = openId + token，通过**既有** `sessionKey` 机制透传给写服务（不另造存储）；
//   · 没有 token（旧页面 / 浏览器拒收）⇒ 所有包装函数**原样返回** ⇒ 回落既有的 openId 共享路径。
//   为什么单独一个文件：`sessionFlow.js` 的导出列表被 `scanPageSessionFlow.test.js` 逐字钉着（不放宽）。
// ⭐⭐ 2026-10-18（task-2）：per-page token 与会话键（实现见 `./pageToken`；本文件只接线）
const {
  createPageTokenMiddleware, pageSessionKey, pageSessionKeyOfRequest,
  createLegacySessionProbe, createFirstVisitKeyAdopter, withPageSession, mountedPathOf,
} = require('./pageToken');
const {
  realmOfAction: realmOfActionOf,
  purchaseAmountRequiredFor: purchaseAmountRequiredForOf,
  purchaseAmountMissing: purchaseAmountMissingOf,
  purchaseAmountInvalid: purchaseAmountInvalidOf,
  markRealmUsed: markRealmUsedOf,
} = require('./actions');
const { setTraceFields } = require('../../utils/traceContext');
const { roleOf } = require('../../config/trace');
const { createLarkJsapiService } = require('../../services/larkJsapiService');
// ⭐⭐ 2026-10-16（口子收尾 · 业务负责人口径「**异步只针对"写库"**；校验必须当场同步拦」）：
//   **尺码 / 数量 / 空单**这三类校验的**唯一真源**（纯函数、不碰 IO、配置先行 ✓）——
//   判据与写层 `services/scanWriteService.js:1397-1426`（补货）/ `:1556-1585`（退货）**逐字同源**
//   （出处行号钉在配置里 ✓）。
//   🔴 本文件**只调它**（`purchaseEntryViolation`），**不手抄任何一条 if-else** ✗ ——
//     手抄一份就再也不会跟写层同步（那正是这一刀要避免的形状 ✗）。
const {
  ENTRY_RULE_TEXTS, purchaseEntryViolation,
} = require('../../config/scanPurchaseEntryRules');
// ⭐ 2026-10-11：「货品」领域的【打印这一款】把任务排进**打印队列**（店里那台电脑负责出纸）。
//   ⚠️ 队列是**进程内单例**（`services/labelPrintQueueRuntime.js`）—— 与电脑侧那条 SSE 路由
//      **共用同一个实例**，不然任务排进去了、小助手永远看不到。
//   ⚠️ 只在**真的要打印 / 渲染「货品」领域**时才构建它（`resolveLabelPrintQueue` 延迟创建）：
//      这一页是"扫码就能看"的入口，不能因为打印那条链路没配好就拖慢 / 打不开。
const { getLabelPrintQueue } = require('../../services/labelPrintQueueRuntime');
const { LABEL_PRINT_QUEUE } = require('../../config/labelPrintQueue');
const {SCAN_AUTH_REDIRECT, TICKET, redeemSessionTicket, pathWithoutTicket } = require('../../config/scanAuthRedirect');
const { logError, logInfo, logWarn } = require('../../utils/logger');
// ⭐⭐ 2026-10-16 拆分（阶段二·纯搬运）：下面这几件已搬到同目录各文件 ✓ 形状/语义一字未改 ✓
const { asList } = require('./shared');
const { parsePaymentRows } = require('./payment');
const { parseReplenishEntries, parseReturnEntries } = require('./posting');
const { parseMultiItemGroups, mergeFirstItemEntries } = require('./multiItem');
const { purchaseWriteDisabledError } = require('./multiItem');
// ⭐⭐ 2026-10-14 晚（埋点 P0 ②④⑤）：点击埋点的**同一份实现**（与工作台共用；
//   本文件只负责"挂在扫码路由上、写 POST 上带结果事件"）。
const {
  handleUiTap, uiTapResultMiddleware, markTapCode,
} = require('../../utils/uiTapReport');

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
  // 拆分第 2 刀：渲染日志/漏斗/回跳字段的实现搬到 `./renderContext.js`；这里只创建一次。
  const renderContext = require('./renderContext').createRenderContext({
    config,
    postActionFor: (...args) => postActionFor(...args),
  });
  const { logFunnelPage, logRendered, successReturnFields } = renderContext;
  const writeConfig = options.writeConfig === undefined ? SCAN_WRITE : options.writeConfig;
  const gateway = options.gateway || new V1BitableGateway();
  // ⚠️ 只读那一半的 service：`options.service` 供用例注入一个假的（既有用例就是这么做的，注入后不建内存快照）。
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
  // 深拆 P3b：响应/人话页面 helpers 搬进 ./responses.js（显式注入依赖；函数体逐字）
  const responses = require('./responses').createResponses({
    config, writeConfig, service, renderMessage, renderMinimalPage, sendHtml,
    logError, logWarn, isDataNotReady, DEFAULT_REALM, ENTRY_RULE_TEXTS, markTapCode,
    resolveRealm, scanTargetOf: (r) => scanTargetOf(r),
    backTargetFor: (r, f) => backTargetFor(r, f),
    postActionFor: (t, r) => postActionFor(t, r),
  });
  const { sendHuman, badNumberPage, notFoundPage, respondFailure, unknownActionFailure, purchaseAmountMissingPage, purchaseAmountInvalidPage, purchaseEntryInvalidPage, respondWriteFailure } = responses;
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
      // ⭐ 2026-10-18：表是唯一真源；配置默认方式只在表里存在时排第一（详见 orderWithPreferred）。
      return [...new Set(orderWithPreferred(listed.items, writeConfig.sale.defaultPaymentMethod))];
    }
    // ⭐ 2026-10-26：不再退回配置里的「微信/现金/支付宝/银行卡」——
    //   那份 fallback 与表里的真实值不一致（表里是「微信扫码 / 微信转账…」），
    //   页面能选、写库又按表校验 ⇒ 必然失败（线上 XSD-20261026-0007）。
    //   服务端只认表 / 最后一次成功快照；从未读成功过 ⇒ 宁可不给选项，也不给假选项。
    logWarn('scan.sale.payment_methods_unreadable', {
      request_id: req?.requestId,
      reason: String(listed?.reason || 'payment_methods_empty'),
      error: listed?.error ? String(listed.error) : undefined,
      message: '收款方式表读不到，且没有历史快照；不提供假选项',
      fallback,
    });
    return [];
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
    // ⭐ 2026-10-26：不再回落到配置里的旧方式（与表/写库校验不一致 ⇒ 会写出 400）。
    //   调用方拿不到候选 ⇒ 就是空清单；宁可不给选项，也不给假选项。
    paymentMethods: Array.isArray(opts.paymentMethods) ? opts.paymentMethods : [],
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
  /**
   * ⚠️ **成对迁移（改前逐字 → 改后逐字 → 依据）**：
   *   改前逐字：这段「被挡 ⇒ 渲染资金页（`status: 400`）＋ 把她刚填的钱原样带回」**只长在 `payment_pay` 那一支里** ✗
   *   改后逐字：抽成本地 `async` 函数 `respondSettlementBlock(res, req, ctx)` ⇒ ⭐ **两处共用** ✓
   *     （`payment_pay` 那一支 ＋ `submit_order` 里「货那一跑」之前的**预判** ✓ —— 预判下一轮接）
   *   依据 = 写服务契约逐字「拦住、**一个字都不写**」＋ 业务负责人 2026-10-16 23:5x「**那我肯定能看到这个单号呀**」✓
   *   🔴 **只搬不改**：文案 / 字段 / 中文 / `status: 400` 一个字不动 ✓
   *     （唯一新增：`toCents` 那 1 行同式搬进来 —— 它原本声明在 `payment_pay` 支内，抽出来会跑出作用域 ✓）
   */
  const respondSettlementBlock = async (res, req, ctx) => {
    const { settlement, effectiveLineAmounts, paidPayments, realm, body, fields, pendingLines,
      effectivePaymentStatus, pendingPaidAmount } = ctx;
    const toCents = (value) => Math.round(Number(value || 0) * 100);
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
  };

  const sendPaymentStep = (res, req, opts = {}) => {
    // ⭐ 她看到的这一页 = 这条日志记的（**在发页面之前**打 ⇒ 两件事不会分家 ✓）
    logRendered(req, {
      page: 'pay',
      trigger: String(opts.renderedTrigger || 'payment_step'),
      number: String(scanTargetOf(req)?.value || ''),
    });
    const target = backTargetFor(req, decodeURIComponent(String(req.params.recordId || '')));
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
      // ⭐ 2026-10-17 E：**总金额**（她逐字要的）——调用方给；拿不到就不渲染那一行（不编 ✓）
      totalAmountText: String(opts.totalAmountText || ''),
    }));
  };
  // ⚠️ 写服务**只为 POST 与"本单还有几双"服务**；`GET` 的库存表一个字都不依赖它。
  //    用例可以注入一个假的（`options.writeService`），`false` = 这一版不挂写入口。
  // ⭐⭐ 2026-10-16（退货「出图发群」接线 · 本卡）：把**采购退货的出图链路**装配上 ——
  //   原来这里是 `{ gateway, config }`，**没有人传** `purchaseReturnOptions`
  //   ⇒ 写链路的 `webhooks` 恒为空 ⇒ 退货**永远** `no_image_pipeline`（线上真缺陷，见
  //   `services/purchaseReturnImageWiring.js` 的文件头：改前逐字 → 改后逐字 → 依据）。
  //   ⚠️ **它惰性构造**（真正提交退货时才 `new`）⇒ 启动 / 建 router 这一层零副作用 ✓；
  //   ⚠️ 用例想注入假出图 / 假 IM ⇒ `options.purchaseReturnImage`（与 `options.writeService` /
  //     `options.multiItemWire` 同一种注入法 ✓）。
  const writeService = writeConfig && options.writeService !== false
    ? (options.writeService || createScanWriteService({
      gateway,
      config: writeConfig,
      purchaseReturnOptions: resolvePurchaseReturnImageOptions({
        gateway,
        config: writeConfig.purchaseReturn && writeConfig.purchaseReturn.imageDelivery,
        overrides: options.purchaseReturnImage || {},
      }),
    }))
    : null;
  const salesRuntime = createSalesAsyncRuntime({ gateway, writeService, config: writeConfig, options, logError }); const salesAsync = salesRuntime.worker;
  // ══════════════════════════════════════════════════════════════════════════
  // ⭐⭐ 「一单多货品」**路由半**（task-59）
  //     与渲染半那份（模块级 `MULTI_ITEM_ORDER`）**同一个 env 源**，两边不会漂 ✓。
  // ══════════════════════════════════════════════════════════════════════════
  const multiItemOrderConfig = resolveMultiItemOrderConfig();
  // 拆分第 3 刀：多货品暂存的读/写/清搬到 `./sessionFlow.js`（容器仍是引擎同一份会话）。
  const { multiItemPendingKey, readMultiItemPending, writeMultiItemPending, clearMultiItemPending } =
    createMultiItemPendingOf({ writeService, multiItemOrderConfig });
  // ⭐⭐ 2026-10-16（task-59 · **加/删货那一半**）：加货 / 删除那两颗 submit 的**字段名 / 动作名**。
  //   🔴 **缺省 = `null` ⇒ 渲染层照旧是今天那颗 `<a href="?add=1">`** ⇒ **一个字都不变** ✓
  //     （既有判据 `multiItemOrderRender.test.js:73` / `multiItemOrderReturnTrim.test.js:166` 原样绿 ✓）。
  //   ⚠️ 只有**本文件真的把那个 POST 接住之后**才把它交给渲染层 —— 否则她点一下按钮会把这一单
  //     直接提交走 ✗（比现在"点了没反应"**更糟**）⇒ 门是**显式**的，不是"渲染层自己猜" ✓。
  //   🔴 **默认关**（`config/multiItemOrder.js` 的 `addWireEnabled`，缺省 `false`）⇒ 页面上仍是
  //     今天那颗 `<a href="?add=1">` ⇒ 既有一切逐字不变 ✓（她真机验证过再把那个开关打开 ✓）。
  //   ⚠️ 用例可以注入一份假的（`options.multiItemWire`）—— 与 `options.writeService` 同一种注入法 ✓。
  const multiItemWire = options.multiItemWire !== undefined
    ? options.multiItemWire
    : (multiItemOrderConfig.addWireEnabled === true ? multiItemOrderConfig.wire : null);
  /** 会话暂存那一条链的名字（`replenish` / `return`；认不出的领域 ⇒ `''` 不猜 ✗）。 */
  const multiItemChainOf = (realm) => {
    const safe = resolveRealm(realm);
    if (safe === 'replenish' || safe === PURCHASE_RETURN_REALM) return safe;
    return '';
  };

  // ⭐⭐ 2026-10-16（task-61 · ②「领域内扫一扫」）
  //   · **开关缺省关**（`config/realmScan.js`）⇒ 关着时：不发脚本、不发配置块、
  //     签名端点也不回可用的签名 ⇒ **页面与今天逐字节一致** ✓（`AC-ML5`）；
  //   · 开着时：加货成功 303 回本页会带 `?scan=1` ⇒ 本页内联那一段（**复用既有那一段脚本** ✓
  //     不新增第二段 ✗）去调**飞书原生扫一扫** ⇒ 扫到的那件带 `?from=<本领域>` 落回来 ✓。
  //   ⚠️ 用例可以注入一份假配置 / 假签名服务（`options.realmScan` / `options.larkJsapi` ✓
  //     —— 与 `options.multiItemWire` 同一种注入法）。
  // ══════════════════════════════════════════════════════════════════════════
  const realmScanConfig = options.realmScan !== undefined ? options.realmScan : REALM_SCAN;
  let larkJsapi = options.larkJsapi || null;
  const resolveLarkJsapi = () => {
    if (!larkJsapi) larkJsapi = createLarkJsapiService();
    return larkJsapi;
  };
  /**
   * 这一页的领域**现在**该不该接着扫（`AC-ML3` / `AC-ML5` 的判据就在这一个函数里）。
   * 三条都要满足：① 开关开着 ② 这个领域配了链 ③ URL 上**明确**带了那个触发参数。
   * ③ 是刻意的：**页面一加载就弹相机**（她没点过、或刷新一下又弹）是最糟的那种"乱跳" ✗。
   */
  const realmScanActive = (realm) => realmScanConfig?.enabled === true
    && Boolean(realmScanConfig.realms && realmScanConfig.realms[realm]);
  const realmScanTriggered = (req, realm) => realmScanActive(realm)
    && String(req.query?.[realmScanConfig.triggerQueryKey] || '') === String(realmScanConfig.triggerQueryValue);
  /**
   * 这一页要给"扫完那件落回**本领域**"的那几样（**落点由客户端按扫到的那一串现算** ✓
   *   —— 「扫到的是哪一件」只有扫完那一刻才知道，服务端在这里**不可能**先算出来 ✗）。
   *
   * 🔴 只给**参数**、不给结果：`realmQueryKey`（`from` ✓ 与 `resolveRealm` 同一个键）、
   *   `recordBasePath`（扫到 id 时拼路径 ✓ 同一个真源）、`origin`（拼同源地址 ✓）＋ 文案与超时。
   */
  const realmScanPageConfig = (req, realm) => {
    if (!realmScanTriggered(req, realm)) return null;
    const origin = `${req.protocol}://${req.get('host') || ''}`;
    const signaturePath = mountedPathOf(req, realmScanConfig.signaturePath);
    return {
      realm,
      origin,
      // ⭐ 2026-10-17（假配置接线）：A 套真正读登记表的两个行为参数
      //   · returnsToRealm=false ⇒ 扫完不追加/回跳不带 `from=<领域>`
      //   · keepDraft=false     ⇒ 扫完回来先清旧草稿（"不带之前的数据"）
      returnsToRealm: realmEntryParams(realm, realmScanConfig).returnsToRealm !== false,
      keepDraft: realmEntryParams(realm, realmScanConfig).keepDraft !== false,
      appendRealm: realmEntryParams(realm, realmScanConfig).returnsToRealm !== false,
      realmQueryKey: realmScanConfig.realmQueryKey,
      recordBasePath: realmScanConfig.recordBasePath,
      maxScannedLength: realmScanConfig.maxScannedLength,
      scanNow: true,
      texts: realmScanConfig.texts,
      signaturePath,
      sdkTimeoutMs: realmScanConfig.sdkTimeoutMs,
      scanTimeoutMs: realmScanConfig.scanTimeoutMs,
      // 只读上报也挂在本 router 下（复用同一道身份闸门 ✓ 不新开一个入口 ✗）
      reportPath: signaturePath.replace(/[^/]+$/, 'scan-report'),
    };
  };
  /**
   * ⭐⭐ 2026-10-16 21:1x（本卡 ·「**销售也弹扫码框**」）：
   *   **加货成功之后**那一发 303 回跳要不要**带上触发参数**（`?scan=1` ✓）。
   *
   * 🔴 **只有这一处实现**（两个调用点共用同一份 ✓ 不写第二套 ✗）：
   *   · **补货 / 退货** —— 多货品那一支里那颗「＋ 再加一个货品」（`isMultiItemAdd` ⇒ 见下面 `addBackPathFor`）；
   *   · **销售** —— 同一张表单里那颗 `action=add_line`（草稿非空时它的文案就是「＋ 再加一个货品」✓）。
   *
   * 判据（与改动前**一字不差**）：① 开关开着 ② **这一页的领域**配了链 ③ 有触发键 ——
   *   缺任何一条 ⇒ **原样返回**（`page` 一个字不动）⇒ 开关关着 / 领域没配链时，回跳与今天**逐字节相同** ✓。
   *   🔴 ③ 是刻意的：回来的那一页**只有**看见这个参数才去调扫一扫
   *     ⇒ 「页面一加载就弹相机」那种坑从这里堵死 ✗（`AC-SR4` / `AC-ML5`）。
   *
   * ⚠️ **成对迁移（改前逐字 → 改后逐字 → 依据）**：
   *   改前逐字：这个函数**长在多货品那一支里面**、签名是 `addBackPath(realmId)`
   *     （它自己调 `backPathOf(realmId)` 现算页路径）⇒ **只有补货 / 退货够得着它** ✗；
   *   改后逐字：**提到工厂这一层**、签名改成 `addBackPath(page, realmId)`
   *     （页路径由调用方按**它自己那条链**的既有口径拼好再传进来 ⇒ 拼法与改前**逐字节相同** ✓）；
   *   依据 = 业务负责人 2026-10-16 21:1x 弹窗拍板「**要，销售也弹扫码框**」✓。
   *   ⚠️ **不是新行为、不是放宽**：两个调用点拼出来的 Location 与改前逐字节相同（`AC-SR6` 逐字钉着 ✓）。
   *
   * @param {string} page 已经拼好的回跳地址（含领域与既有查询串）
   * @param {string} realmId 这一页的领域 id（判据②要它）
   * @returns {string} 需要接着扫时 = `page` ＋ 触发参数；否则 = `page`（原样 ✓）
   */
  /** 去掉回跳地址里的领域键（`from=<realm>`）—— `returnsToRealm:false` 时用。 */
  const withoutRealmQuery = (page, key) => {
    const text = String(page || '');
    const wanted = String(key || '').trim();
    if (!text || !wanted) return text;
    const hashAt = text.indexOf('#');
    const head = hashAt >= 0 ? text.slice(0, hashAt) : text;
    const hash = hashAt >= 0 ? text.slice(hashAt) : '';
    const queryAt = head.indexOf('?');
    if (queryAt < 0) return text;
    const base = head.slice(0, queryAt);
    const pairs = head.slice(queryAt + 1).split('&')
      .filter((part) => part && part.split('=')[0] !== wanted);
    return pairs.length ? `${base}?${pairs.join('&')}${hash}` : `${base}${hash}`;
  };
  const addBackPath = (page, realmId) => {
    if (!realmScanActive(realmId)) return page;
    const key = String(realmScanConfig.triggerQueryKey || '');
    if (!key) return page;
    const entry = realmEntryParams(realmId, realmScanConfig);
    const target0 = entry.returnsToRealm === false
      ? withoutRealmQuery(page, realmScanConfig.realmQueryKey || 'from')
      : page;
    const target = /(?:[?&])added=/.test(target0) ? target0 : `${target0}${target0.includes('?') ? '&' : '?'}added=1`;
    return `${target}${target.includes('?') ? '&' : '?'}${encodeURIComponent(key)}=${encodeURIComponent(String(realmScanConfig.triggerQueryValue || ''))}`;
  };
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
   * ⭐⭐ 2026-10-16（task-59 · **加/删货那一半**）：草稿里"**已经加进来的那几个货品**"的读写。
   *
   * 为什么需要它（前一位执行者验证过的结论 ②③）：
   *   · 她点「＋ 再加一个货品」时必须走 **POST**（GET 链接带不走她刚填的尺码/数量 ✗）
   *     ⇒ 那个 POST 要**存下当前这一件**，再 **303 回本页**（PRG ⇒ 刷新不重复加 ✓）；
   *   · 回来渲染时，**已加的那几件**要回到页面上 ⇒ 只有**服务端**记得住（页面零 JS ⇒ 浏览器里没处放 ✗）。
   *
   * 落点：**引擎那同一份会话**（`config.session.ordersField` 下、按链分段的一个小块 ✓）——
   *   **不新建存储** ✗、也不碰业务表 ✗；⚠️ 它是"**还没开放提交的**这一单"的暂存，
   *   与引擎那份"已提交的草稿"**同一个容器、不同的键**（`:*:pending`）⇒ 两者不会互相覆盖 ✓。
   *
   * 🔴 **必须排除当前这一件**：`view.multi_items`（喂给渲染层、进 hidden 字段的那一份）
   *   只放**已加的** —— 当前这一件是表单里那个**首件** ✓。否则提交时 `addItem` 会拿草稿里
   *   那份旧 `entries` 覆盖她**刚填的** = **静默丢值** ✗（她最恨的那种假成功）。
   */
  /**
   * ⭐ 2026-10-17（假配置接线）：扫完回来若 `keepDraft=false` ⇒ **先清掉这一领域的旧草稿**
   *   （她定义的"不带之前的数据"）。默认 `true`（三处都带草稿）⇒ 线上行为与改前逐字节相同 ✓。
   *   🔴 失败**不影响页面渲染**（只记 warn）—— 清草稿是"体验修正"，不是业务写入。
   */

  /**
   * ⭐⭐ 「一单多货品」**提交**（**只有分组 > 1 才会进来**）—— 拒单 ⇒ 人话 + **零写入** ✓。
   *
   * 🔴 **成功页复用今天那条形状与文案**（`sendSuccess` + `successReturnFields` ✓）——
   *   本文件**不发明新文案** ✗，也**不承诺**这一刻还没有的东西（批次号 / 明细数由后台写出）✗。
   */

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
  // 首访那把旧键的采纳（补货 / 退货第一次带 token 提交时用；实现见 `./pageToken`）
  const adoptFirstVisitSubmitKey = createFirstVisitKeyAdopter({ getSessions: () => writeService?.sessions });

  const purchaseBackground = options.purchaseBackground || createPurchaseWriteBackgroundService({
    // 🔴 `runRest` = **既有写入口**（不新开写库路径 ✗）：补货 / 退货各自的写服务方法。
    //    ⚠️ **实参形状与改前那次 `await writeService.…(…)` 逐字同形**（键名一个不改 ✗）——
    //      判据 `test/multiItemOrderRoute.test.js` 的 **RT2-static** 逐字钉着这张参数清单
    //      （task-46「N=1 与老路径逐字等价」的护栏 ✓ 本刀**不放宽它** ✗）。
    runRest: async ({ chain, requestId, submitKey, restInput = {}, context = {} }) => {
      // ⭐⭐ 2026-10-18（task-2）：会话键从 `context` 来（旧页面没有这个键 ⇒ '' ⇒ 写服务回落 openId ✓）。
      const sessionKey = String(context.sessionKey || '').trim();
      await adoptFirstVisitSubmitKey({
        chain, openId: restInput.openId, sessionKey, submitKey,
      });
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
          // ⚠️ 只在有 token 时出现这个键：旧页面的入参形状**逐字不变**（RT2-static 也钉着这一点 ✓）
          ...(sessionKey ? { sessionKey } : {}),
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
          // ⚠️ 同上：旧页面不带这个键（入参形状逐字不变 ✓）
          ...(sessionKey ? { sessionKey } : {}),
        });
      }
      return { ok: false, code: 'unknown_chain', message: String(chain || '') };
    },
    markFailed: async ({ chain, context = {}, result, error }) => {
      // ⭐⭐ 2026-10-18（task-2）：有 per-page token 时失败要落到**这一页自己的**会话；
      //   旧页面（没有 sessionKey）⇒ 仍是 openId，逐字不变 ✓
      const openId = String(context.sessionKey || context.openId || '');
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
  // 拆分第 3 刀：排程也搬进 `./sessionFlow.js`（同一份 purchaseBackground 注入；幂等键原样透传）。
  const { schedulePurchaseWrite } = createPurchaseSchedulerOf({ purchaseBackground });
  /**
   * ⭐⭐ 2026-10-12：**未到货批次**（要列出来的那几条）—— **全仓只有这一处**读它。
   *
   * 两个调用方：① **有编号的领域页**（`?from=accept`，她扫开某款那一页）；
   *              ② **落地页** `GET /accept`（无 batch，她点【验收】进来的第一屏）。
   * ⚠️ **同一个 catch**：读表失败 ⇒ 只记一条 warn + 返回 `{ok:false, batches:[]}`
   *    ⇒ 页面照旧 **200**、走手输兜底（她的"别卡住她"）。
   */

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
      String(req.originalUrl || `${config.route.recordBasePath}${req.url || ''}`),
    );
    logInfo(SCAN_AUTH_REDIRECT.events.loginRedirect, {
      request_id: req.requestId,
      next: String(target).slice(0, 200),
    });
    return res.redirect(302, buildLoginStartUrl(target));
  });

  router.use(requireWorkbenchAccess);
  // ⭐⭐ 2026-10-18（task-2）：per-page token —— GET 首次访问 Set-Cookie；POST 自动携带；
  //   POST 没有 cookie（旧页面）⇒ `req.scanPageToken = ''` ⇒ 回落既有 openId 共享路径（不报错）。
  router.use(createPageTokenMiddleware({
    // ⭐ 过渡期保护：她手上那份"本单 N 双"还在 openId 会话里、而这一发 GET 还没 cookie
    //   ⇒ **先不换身份**（实现在 `./pageToken`；本文件只接线）。
    hasLegacySession: createLegacySessionProbe({
      getSessions: () => writeService?.sessions,
      openIdOf: (request) => String(
        request.workbenchUser?.open_id || getSessionUser(request)?.open_id || '',
      ),
    }),
  }));
  /**
   * ⭐⭐ **`GET /r/:recordId?from=<领域>`** —— 手机扫开的那一页。
   *
   * 2026-10-09 真机（飞书 webview 白屏）之后这一条重做过：
   *   · **服务端按 `from` 只渲染那一块**（不再靠 `<head>` 内联脚本 + CSS 显隐）；
   *   · 页面里**一行前端脚本都没有** ⇒ 飞书 webview 执不执行脚本都一个样；
   *   · 认不出的 `from` 回落缺省（销售），**永不报错、永不空白**。
   *   · 任何异常（取数 / 渲染）都落到 `respondFailure` → **人话页**（还有 `renderMinimalPage` 兜底）。
   */
  // ⭐⭐ 2026-10-12：**两条路共用这两个处理函数**（同一个 router 实例挂在 `/s` 与 `/r` 上）：
  //    · `/r/:recordId`   ⇒ `req.params.number`   = 编号
  //    · `/r/:recordId` ⇒ `req.params.recordId` = 记录 ID（**新二维码走这条**）
  //    ⚠️ 用**路径数组**把同一个 handler 挂到两个模式上 —— **不复制一份处理逻辑**；
  //      "这一页在取哪一样东西"由挂载点判定（`scanTargetOf`），其余一行都不分叉。

  // ⭐⭐ 2026-10-11（方案A）：**扫码验收**（工作台点【验收】→ 在这一页连续扫 → 完成验收）。
  //    ⚠️ 依赖**延迟构造**（在 `services/scanArrivalService.js` 里就地构造：
  //      `GET /r/{编号}` 那一步只用来读会话 —— **零飞书调用**，扫码页"一次扫码 0 次飞书调用"
  //      那条硬要求不能被这个功能破坏；真正要开批次 / 入库时它才构造采购查询与到货核对）。
  //    ⚠️ 本文件因此**只认识 `scanArrivalService` 一个名字**（不 require 任何写链路的 service）——
  //      既有的"路由层不出现写链路服务"哨兵照旧绿。
  //    ⚠️ 用例可以注入 `options.arrivalService`；`false` = 这一版不挂验收模式。
  let arrivalInstance = options.arrivalService || null;
  const arrival = () => {
    if (arrivalInstance === null && options.arrivalService !== false) {
      // eslint-disable-next-line global-require
      const { createScanArrivalService } = require('../../services/scanArrivalService');
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
  // 动作分派第 1 刀：实现搬到 `./actions.js`（纯函数可单测）；这里只保留**薄包装**，
  // 调用点一个字都没动。
  const realmOfAction = (action) => realmOfActionOf(action, writeConfig);
  const markRealmUsed = (openId, realm) => markRealmUsedOf({
    writeService, openId, realm, event: config.events.failed, logWarn,
  });

  // ⚠️ `req` 是**第 4 个可选参数**（task-58 加，只为那条 `scan.page.rendered` 日志 —— 成功页 =
  //    扫码这条链路的第三个落点 ✓）。不传照样能用（老调用点 / 用例不会炸 ✓），只是日志里
  //    `query_keys` 为空、`number` 为空 —— **判定与页面一个字都不受它影响** ✗。
  //    ⭐ task-60：**9 个调用点一个不落全传了 `req`**（含"一单多货品"那条成功页 ✓）——
  //      她点名要的"字段齐"（AC-LR4）就是这条：每一发 `page:'success'` 都说得出来"是哪一件" ✓。

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
   * ⭐⭐ 2026-10-15（③ 写入 · 她裁决 ⓐ「复用「发生金额」」）**改指向**：
   *   改前逐字：`🔴 本版**只判"填没填"**（她的原话就是「必填」）：数字格式不做额外校验、金额也**不落表**`
   *   改后逐字：**两件事都变了** —— ① 那个数现在**要落表**（退货批次行的「发生金额」）；
   *     ② ⇒ 多一道「**必须是数字**」的闸门（`purchaseAmountInvalidPage`，见下面）——
   *     放一个非数字过去 = "页面填了、表里没有" = **假成功** ✗（她最在意的一条）。
   *   依据：她 2026-10-14 晚「退货整单金额（必填），与补货同一套配置」＋ 2026-10-15 裁决 ⓐ
   *     ＋ 那一列是**数字列**（`v1BitableSchema` 的 `purchaseOrderBatch.actualAmount`）。
   */

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
  // 整单金额三道闸门同样搬到 `./actions.js`（补货/退货共用；按链路配置在那边读）。
  const purchaseAmountRequiredFor = (realm) => purchaseAmountRequiredForOf(realm, writeConfig);
  const purchaseAmountMissing = (body, realm) => purchaseAmountMissingOf(body, realm, writeConfig);
  const purchaseAmountInvalid = (body, realm) => purchaseAmountInvalidOf(body, realm, writeConfig);

  /** 「要填数字」那张人话页（与"还没填"同一形状：H1 + 怎么填 + 回上一页 + 埋点原因码）。 */

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


  /**
   * ⭐ 写成功之后**立刻作废**「实时库存」内存快照（她的硬要求：**库存准确**，
   * 不能等 30 秒那一拍）。
   *
   * 🔴 为什么调用点在**路由**（而不是写服务）：本任务的写作用域只覆盖到扫码这条链路的
   *    `routes/scanPage.js`；`services/scanWriteService.js` 刻意一行都没动。
   *    其余写入口（销售入账 / 到货 / 手工库存调整 / 交付扣减）**不在本任务作用域内**，
   *    它们各自在写成功后加一行同样的调用即可（跨模块、零注入，谁都不认识扫码页）：
   *    `require('../../services/liveInventorySnapshot').invalidateLiveInventorySnapshot('原因')`
   *    —— 详见 `services/liveInventorySnapshot.js` 的注释。
   */

  const openIdOf = (req) => {
    const openId = String(req.workbenchUser?.open_id || getSessionUser(req)?.open_id || '');
    if (openId) setTraceFields({ role: roleOf(openId) });
    return openId;
  };
  /** ⭐ 2026-10-18（task-2）：**这一页的会话键** = openId + per-page token（没有 ⇒ 原样 openId = 改前逐字）。 */
  const sessionIdOf = (req, openId = openIdOf(req)) => pageSessionKeyOfRequest(req, openId);

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
  //    · `/r/:recordId`   ⇒ `{ mode: 'number',   value: 编号 }`
  //    · `/r/:recordId` ⇒ `{ mode: 'recordId', value: 记录 ID }`
  //    🔴 **不许**在别处再拼一套路径（`postActionFor` 是唯一出口）—— 两边各写一份必然漂。
  const isRecordBase = () => true;
  const scanTargetOf = (req) => {
    const value = decodeURIComponent(String(req.params?.recordId ?? ''));
    return { mode: 'recordId', value };
  };
  /** 回跳沿用 URL 上的记录 ID。 */
  const backTargetFor = (req) => scanTargetOf(req);

  /** 这一页的"取商品"入参：只按记录 ID。 */
  const lookupInputOf = (req) => ({ recordId: scanTargetOf(req).value });

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
    const resolved = target && typeof target === 'object' ? target : { value: target };
    const basePath = String(config.route.recordBasePath || '');
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
   * ⭐⭐ **`GET /r/:recordId?from=<领域>`** —— 手机扫开的那一页。
   *
   * 2026-10-09 真机（飞书 webview 白屏）之后这一条重做过：
   *   · **服务端按 `from` 只渲染那一块**（不再靠 `<head>` 内联脚本 + CSS 显隐）；
   *   · 页面里**一行前端脚本都没有** ⇒ 飞书 webview 执不执行脚本都一个样；
   *   · 认不出的 `from` 回落缺省（销售），**永不报错、永不空白**。
   *   · 任何异常（取数 / 渲染）都落到 `respondFailure` → **人话页**（还有 `renderMinimalPage` 兜底）。
   */
  // ⭐⭐ 2026-10-12：**两条路共用这两个处理函数**（同一个 router 实例挂在 `/s` 与 `/r` 上）：
  //    · `/r/:recordId`   ⇒ `req.params.number`   = 编号
  //    · `/r/:recordId` ⇒ `req.params.recordId` = 记录 ID（**新二维码走这条**）
  //    ⚠️ 用**路径数组**把同一个 handler 挂到两个模式上 —— **不复制一份处理逻辑**；
  //      "这一页在取哪一样东西"由挂载点判定（`scanTargetOf`），其余一行都不分叉。
  const ROUTE_PATTERNS = [config.route.recordPath].filter(Boolean);
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

  // ── ⭐⭐ 2026-10-16（task-61 · ②「领域内扫一扫」）──────────────────────────────
  /**
   * `GET /<prefix>/lark/jsapi-signature?url=<地址>`
   *
   * 🔴 **不新开第二套** ✗：用的就是**既有** `services/larkJsapiService.js`（与工作台「扫码打印」
   *    同一个签名函数 ✓）；本路由**只转发**，不认识"扫一扫"这个词以外的任何业务 ✗。
   * 🔴 **不新开鉴权** ✗：它挂在本 router 下 ⇒ **与扫码页同一道**飞书身份闸门（未启用 503 / 未登录 302 /
   *    白名单外 403 —— 一字不变）✓。
   * 🔴 **响应里不含任何密钥** ✗：只有 `h5sdk.config` 要的四样（＋公开的 JSSDK 地址 ✓）。
   * ⚠️ 开关关着 ⇒ **当场 404**（连"有这么个端点"都不暴露 ✓ 页面也根本不会去调它 ✓）。
   * ⚠️ **必须排在上面那条 `GET /:number` 之前**（否则 `lark` 会被当成一个编号 ✗）。
   */
  const realmScanSignaturePath = String(realmScanConfig?.signaturePath || '/lark/jsapi-signature');
  router.get(realmScanSignaturePath, async (req, res) => {
    if (realmScanConfig?.enabled !== true) return res.status(404).json({ success: false, error: 'not_enabled' });
    const pageUrl = String(req.query?.url || '').trim();
    try {
      const result = await resolveLarkJsapi().signatureFor(pageUrl);
      if (!result.ok) {
        logWarn('scan.realm_scan.signature_failed', {
          request_id: req.requestId, reason: result.reason,
        });
        return res.status(400).json({ success: false, error: result.message, reason: result.reason });
      }
      logInfo('scan.realm_scan.signature_ok', {
        request_id: req.requestId,
        // ⚠️ 只记域名（排障够用）；签名 / 票 / 密钥一个字都不进日志 ✗
        host: (() => { try { return new URL(result.url).host; } catch { return ''; } })(),
      });
      return res.json({
        success: true,
        appId: result.appId,
        timestamp: result.timestamp,
        nonceStr: result.nonceStr,
        signature: result.signature,
        url: result.url,
        jssdkUrl: resolveLarkJsapi().config?.jssdkUrl || '',
        jsApiList: ['scanCode'],
      });
    } catch (error) {
      const texts = resolveLarkJsapi().config?.texts || {};
      return res.status(502).json({ success: false, error: texts.upstreamFailed });
    }
  });
  /**
   * `POST /<prefix>/lark/scan-report` —— 客户端那一段的**只读**上报（拿不到它就查不下去 ✗）。
   * 🔴 **零业务写入** ✓（只 `logInfo` 一条）；⚠️ 上报失败**绝不影响她**（客户端本来就 fire-and-forget ✓）。
   */
  router.post(realmScanSignaturePath.replace(/[^/]+$/, 'scan-report'), (req, res) => {
    if (realmScanConfig?.enabled !== true) return res.status(404).json({ success: false });
    const body = req.body || {};
    logInfo('scan.realm_scan.report', {
      request_id: req.requestId,
      ok: body.ok === true,
      realm: String(body.realm || '').slice(0, 32),
      reason: String(body.reason || '').slice(0, 64),
      err_msg: String(body.err_msg || '').slice(0, 200),
      // 「扫到了什么」只留**长度 + 前 80 字**（要能对上那一件，但不把一个长串整条塞进日志 ✗）
      scanned_length: String(body.scanned || '').length,
      scanned: String(body.scanned || '').slice(0, 80),
    });
    return res.json({ success: true });
  });


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
        number: String(lookupInputOf(req).recordId || ''),
      });
      return sendHtml(res, 200, renderScanSkeleton(lookupInputOf(req), config));
    }
    // ⭐⭐ 2026-10-14（业务负责人：**点「提交这一单」只到资金页**）：她**刷新**这一页时，
    //   如果会话里记着"已经走到资金这一步"（`paymentStep === 'pending'`）⇒ ⭐ **仍给资金页** ✓
    //   （否则刷新会掉回普通录入页 ⇒ 她会以为"白填了"✗）。其它情况**一个字都不改** ✓走老逻辑。
    //   ⚠️ 只认会话标记（**不认任何查询串** ✗）⇒ 别人/别的情况下拿不到这一页 ✓
    if (String(req.query?.data || '') !== '1'
      && (lookupInputOf(req).number || lookupInputOf(req).recordId)) {
      const pendingSession = await writeService?.sessions?.get?.(sessionIdOf(req)).catch(() => null);
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
            sessionIdOf(req), { paymentStep: undefined, submitPending: undefined },
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
              submitKey: writeService?.sessions?.submitKeyFor?.(sessionIdOf(req), pendingSession, 'sale') || '',
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
            sessionIdOf(req), { paymentStep: undefined, submitPending: undefined },
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
            number: String(view.number || lookupInputOf(req).recordId || ''),
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
      // ⭐⭐ 2026-10-18 修正（业务负责人：「全局和领域内的扫一扫逻辑不一样」）：
      //   五处扫一扫登记表（config/scanEntries.js）已经把两种入口分开：
      //     · 领域条【扫一扫】= standalone / AppLink，**不带历史数据**（keepDraft=false）
      //     · 领域内【再加一单】= JSAPI，扫完回跳 URL **显式带 `?from=<领域>&scan=1`**
      //   ⇒ 裸扫（无 `from=`）就是**全局入口**，必须固定落缺省领域（销售），
      //     不能再按 `last_realm` 记忆回补货 —— 那样全局入口会被上一笔补货"带偏"。
      //   ⚠️ 领域内回跳仍由 `?from=` 显式表达（不改）；`realmSource` 保持 default。
      // ⭐ 2026-10-17（假配置接线）：扫完回来的这一发、且这一处登记 keepDraft=false ⇒ 先清旧草稿
      if (realmScanTriggered(req, realm)) await clearDraftForScanIfNeeded(sessionIdOf(req), realm);
      const write = await buildWriteContext(req, view, realm);
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
      // ⭐⭐ 2026-10-16（task-59 · **加/删货那一半**）：把草稿里**已经加进来的那几个货品**
      //   喂给渲染层（`view.multi_items`）—— 渲染层据此渲「已加货品」列表 **＋** 把它并进
      //   那个 hidden 字段（`[首件, ...已加]`）⇒ 她**点一下"加"、前面加的不丢** ✓。
      //   🔴 **只在采购那两块**（补货 / 退货）读 —— 别的领域一次都不碰这段（她那句"一次扫码 0~1 次飞书"的同一条口径 ✓）。
      //   🔴 **取不到 / 没有 ⇒ 就是今天的空态**（`view.multi_items` 一个字都不加 ⇒ 页面逐字不变 ✓）。
      //   ⚠️ **绝不含当前这一件**：当前这件是表单里那个**首件** ✓（含了 ⇒ 提交时用它那份旧 `entries`
      //     覆盖她刚填的 = **静默丢值** ✗）。
      //   ⚠️ 位置在**渲染之前**（`readMultiItemPending` 是工厂里上面的 `const` ⇒ 这里已初始化 ✓）。
      const multiItemChain = realm === 'replenish' ? 'replenish'
        : (realm === PURCHASE_RETURN_REALM ? 'return' : '');
      if (multiItemChain && writeService?.sessions) {
        const pending = await readMultiItemPending(sessionIdOf(req), multiItemChain).catch(() => ({ items: [] }));
        if (pending.items.length) view.multi_items = pending.items;
      }
      // ⭐ 2026-10-11：把 UA 交给渲染层 —— 它只用来决定本单条上【继续扫下一个】
      //    是"飞书客户端内的扫一扫 AppLink"还是那句如实的人话（`canScanNextWithFeishu`）。
      // ⭐⭐ 2026-10-16（task-61 · ① 日志）：`renderLogs` 是渲染层**只读登记**用的（见下）。
      const renderLogs = [];
      const html = renderScan(view, config, writeForRender, realm, {
        userAgent: req.headers['user-agent'],
        // ⭐⭐ 2026-10-13：提交后回跳带过来的单号 ⇒ 顶部那条"上一单已提交"的指引（没有就不显示 ✓）
        justSubmittedOrderNo: String(req.query?.[config.successReturn?.noticeKey || 'done'] || '').slice(0, 40),
        // ⭐ 这一页挂在哪个前缀上（`/s` 或 `/r`）—— 自助块里的批次链接/手输表单必须**留在同一前缀**。
        basePath: req.baseUrl,
        print: printContext,
        // ⭐⭐ 2026-10-16（task-61 · 领域内扫一扫）：**只有"加货刚成功、303 回来这一发"才给**
        //   （`?scan=1` ✓）—— 其它任何时候都是 `null` ⇒ 页面上一个字都不多（`AC-ML5` ✓）。
        realmScan: realmScanPageConfig(req, realm),
        // ⭐⭐ 2026-10-16（task-61 · ① 日志）：渲染层把"**本单已加的货品**"那一笔**只读**登记在这里
        //   （渲染层是纯函数 ⇒ 它自己不打日志 ✗；**由本路由在渲染之后统一打** ✓ —— 与既有
        //   `logRendered` 同一处，且**失败也绝不会影响她的页面** ✗）。
        logs: renderLogs,
      });
      // ⭐⭐ 2026-10-16（task-61 · ① 第二条日志）：**渲染"本单已加的货品"列表**那一刻 ——
      //   与加货那条（`…add`）一比就能答她那句「**扫了 B 但没看到 A**」：
      //   `add` 说有（`added_count` ≥ 1）而 `render` 说没有（`item_nos` 里没有 A）⇒ 是**读出来那半边** ✗✓
      //   🔴 纯 additive：**没有那一笔就一条都不打**（今天她看不到这个列表时，日志与今天逐字一致 ✓）。
      for (const entry of renderLogs) {
        const log = entry.fields || {};
        logInfo(entry.event || 'scan.multi_item.render', {
          request_id: requestId,
          open_id: openIdOf(req),
          [log.chainKey || 'chain']: String(entry.chain || ''),
          [log.addedCountKey || 'added_count']: Number(entry.count) || 0,
          [log.itemNosKey || 'item_nos']: (Array.isArray(entry.itemNos) ? entry.itemNos : []).slice(0, 50),
          [log.modeKey || 'mode']: String(entry.chain || ''),
        });
      }
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
        number: String(lookupInputOf(req).recordId || ''),
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
    // ⭐⭐ 2026-10-16（task-59 · 加/删货那一半）：那两颗按钮**各自带自己的 name**（不是 `action` ✓）——
    //   所以下面那条"没 action 就猜成销售提交"的兜底**必须先把它们排除** ✗，
    //   否则她点「＋ 再加一个货品」会被当成**销售提交**（`submit_order`）✗✗。
    //   ⚠️ 字段名只从**工厂里那一份** `multiItemWire` 取（渲染与识别**同一个源** ⇒ 不会漂 ✓）。
    //   ⚠️ 只在**接线开着**时才认（缺省那两个字段名在页面上根本不存在 ⇒ 一个字都不影响既有逻辑 ✓）。
    const wireAddAction = String(multiItemWire?.addAction || '');
    const wireRemoveField = String(multiItemWire?.removeField || '');
    const isMultiItemAdd = Boolean(wireAddAction) && body[wireAddAction] !== undefined;
    const isMultiItemRemove = Boolean(wireRemoveField) && body[wireRemoveField] !== undefined;
    // ⭐⭐ 2026-10-12（她真机 400 / 1ms，`scan.write.unknown_action` 的 `action_kind=missing`、
    //   但 `body_keys` 里**该带的都带了**：submit_key / size / amount / gift / payment_* ✗）：
    //   ⇒ 那是"**没有提交者的提交**"（webview 里 JS/回车/隐式提交 ⇒ 浏览器**不送**按钮的 name/value ✗）。
    //   窄化兜底：**只有**在"没 action + 带幂等键 + 像销售提交"时，认作 `submitOrder`（并留痕 ✓）。
    //   ⚠️ 不碰标记（零哨兵风险 ✓）；只在这一页（编号页 POST）✓。
    if (!action && !isMultiItemAdd && !isMultiItemRemove
      && String(body[fields.submitKey] || '').trim()
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
    // ⭐ 2026-10-18（task-2）请求级包装（**不改 handler 源码**）：注入 sessionKey / context / 领域记忆。
    const pageToken = req?.scanPageTokenFromCookie === true ? String(req?.scanPageToken || '').trim() : '';
    const sessionId = pageSessionKey(openId, pageToken);
    const scopedWriteService = withPageSession(writeService, pageToken);
    const schedulePurchaseWriteForPage = (args) => (pageToken
      ? schedulePurchaseWrite({ ...args, context: { ...(args.context || {}), sessionKey: sessionId } })
      : schedulePurchaseWrite(args));
    const markRealmUsedForPage = (who, realmId) => markRealmUsed(pageSessionKey(who, pageToken), realmId);

    // ══════════════════════════════════════════════════════════════════════════
    // ⭐⭐ 2026-10-16（task-59 · **加/删货那一半**）
    //   · **加货** = 同一张表单里的第二颗 submit ⇒ 它**带着她刚填的尺码/数量**（`sizes` / `qty_*`
    //     或 `return_sizes` / `return_qty_*`）一起 POST 过来 ✓ —— 这正是"值不丢"的物理保证
    //     （改前那颗 `<a href="…?add=1">` 是 GET：**天生带不走**表单字段 ✗）。
    //   · 这里把它**存进草稿**（`readMultiItemPending` / `writeMultiItemPending`）再 **303 回本页**
    //     （PRG：刷新不重复加 ✓；回来那一页由 GET 把"已加的货品"渲出来 ✓）。
    //   · **删除** = 列表行里那颗 submit（`name=<删货字段> value=<该件 record_id>`）⇒ 从草稿里摘掉它 ✓。
    //   🔴 **只认草稿里的那一份**，**不查表、不写业务表**（这一半一个字节都不落业务表 ✓）。
    //   🔴 N=1 那条老路径**一个字都不变**：这里只吃「加货 / 删货」那两个动作，别的一个都不碰 ✓。
    //   ⚠️ `isMultiItemAdd` / `isMultiItemRemove` / 两个字段名**在上面那个兜底之前就取好了** ✓
    //     （不然她点"加"会被当成销售提交 ✗）。
    // ══════════════════════════════════════════════════════════════════════════
    if (isMultiItemAdd || isMultiItemRemove) {
      // ⚠️ 回跳口径与页面上的表单 `action` **同一处**（`:` 下面别的分支用的也是它 ✓ 不另拼一份 ✗）
      const backPathOf = (realmId) => postActionFor(
        backTargetFor(req, decodeURIComponent(String(req.params.recordId || ''))), realmId,
      );
      // ⭐⭐ 2026-10-16（task-61 · 领域内扫一扫）：**加货成功之后**，这一发回跳带上触发参数
      //   ⇒ 回来的那一页（**同一个领域** ✓）才去调飞书扫一扫 ⇒ 扫到的那件带 `?from=<领域>` 落回来 ✓。
      //   🔴 **只加在"加货"上，不加在"删除"上**（删完不该弹相机 ✗）；
      //   🔴 **只在这一页的领域配了链、且开关开着时加**（关着 ⇒ 回跳与今天逐字一致 ✓ `AC-ML5`）。
      //   ⭐⭐ 2026-10-16 21:1x（本卡）：实现**提到工厂那一层**（`addBackPath(page, realmId)` ✓）
      //     —— 因为**销售**那条 303 也要用**同一份**（不写第二套 ✗）。这里只负责按**既有口径**
      //     算出这一页的页路径（`backPathOf` ✓ 逐字没变 ✗），再交给它。
      const addBackPathFor = (realmId) => addBackPath(backPathOf(realmId), realmId);
      const backPath = () => backPathOf(realm);
      // 认不出是哪条链（不是补货 / 退货那两块）⇒ 与既有的"认不出的动作"同一条口径：给它一句人话 ✓
      const draftChain = realm === 'replenish' ? 'replenish'
        : (realm === PURCHASE_RETURN_REALM ? 'return' : '');
      if (!draftChain) {
        markTapCode(res, 'multi_item_chain_unknown');
        return respondWriteFailure(res, {
          code: 'multi_item_chain_unknown', message: writeConfig.texts.unknownActionBody,
        }, requestId);
      }
      if (!writeService) {
        markTapCode(res, 'write_disabled');
        return respondWriteFailure(res, {
          code: 'write_disabled', message: writeConfig.texts.writeDisabledBody,
        }, requestId);
      }
      const chainKind = draftChain === 'replenish' ? 'replenish' : 'purchase_return';
      // 「哪一件」的身份口径**与引擎的 `addItem` / `removeItem` 同一套**（`product_record_id` 优先，
      //   回落 `number` / `item_no` ✓）—— 两边不一致的话，删除会摘不掉那一件 ✗。
      const keyOfItem = (item) => String(
        (item && (item.product_record_id || item.productRecordId || item.number || item.item_no)) || '',
      ).trim();
      const pending = await readMultiItemPending(sessionId, draftChain);
      if (isMultiItemRemove) {
        const removed = String(body[wireRemoveField] || '').trim();
        const left = pending.items.filter((item) => keyOfItem(item) !== removed);
        await writeMultiItemPending(sessionId, draftChain, { orderKey: pending.orderKey, items: left });
        return res.redirect(303, backPath());
      }
      // ── 加货：本次表单的尺码/数量（**与提交那条路同一个解析器、同一份校验** ✓ 不手抄 if-else ✗）
      const entries = draftChain === 'replenish'
        ? parseReplenishEntries(body, fields, writeConfig)
        : parseReturnEntries(body, fields, writeConfig);
      const groups = mergeFirstItemEntries(parseMultiItemGroups(body, multiItemOrderConfig), entries);
      if (!groups.length) {
        // 表单里没有那个首件（手改表单 / 老页面）⇒ 不猜、不存空件 ⇒ 与人话页（400）✓
        markTapCode(res, 'multi_item_no_item');
        return respondWriteFailure(res, {
          code: 'multi_item_no_item', message: writeConfig.texts.unknownActionBody,
        }, requestId);
      }
      // 🔴 她填错了 ⇒ **当场同步拦**（400 + 写层那一句人话 + **零写入**）—— 与提交那条路同一条口径 ✓
      const violation = purchaseEntryViolation({ chain: chainKind, entries });
      if (violation) return purchaseEntryInvalidPage(req, res, requestId, realm, violation);
      // 把"已经加进来的"与"刚加的这件"接上（同一货品 ⇒ 覆盖那一件 ✓ 与引擎的 `addItem` 同口径）
      const added = groups[0];
      const at = pending.items.findIndex((item) => keyOfItem(item) === keyOfItem(added));
      const items = pending.items.slice();
      if (at >= 0) items[at] = added; else items.push(added);
      await writeMultiItemPending(sessionId, draftChain, { orderKey: pending.orderKey, items });
      // ⭐⭐ 2026-10-16（task-61 · ①「补充日志和埋点」）：**加货那一刻**的那一条
      //   —— 她当时问的是「扫了 B 但页面上没看到 A」：是**没存进去**、还是**存了没读出来** ✗✓
      //   ⇒ 这一条说"存进去了几件、存的是哪一件"；渲染那一条（`scan.multi_item.render`）说"读出来几件"。
      //   🔴 **纯 additive**：一个判定都不动（写完才打 ✓ 打日志失败也绝不影响她 ✗）；
      //   🔴 键名**全从配置取**（`multiItemOrderConfig.logFields` ✓ 逻辑里不写死 ✗）；
      //   🔴 关联键按既有口径带（`request_id` / `open_id` / `order_key` ✓ **拿不到就不传** ✗）。
      {
        const log = multiItemOrderConfig.logFields || {};
        logInfo(log.addEvent || 'scan.multi_item.add', {
          request_id: requestId,
          open_id: openId,
          [log.chainKey || 'chain']: draftChain,
          [log.addedCountKey || 'added_count']: items.length,
          [log.productKey || 'product']: keyOfItem(added) || '',
          [log.entriesKey || 'entries']: (Array.isArray(added?.entries) ? added.entries : [])
            .map((entry) => ({ size: String(entry?.size || ''), quantity: String(entry?.quantity || '') })),
          [log.orderKeyKey || 'order_key']: String(pending.orderKey || ''),
        });
      }
      return res.redirect(303, addBackPathFor(realm));
    }

    // ── ⭐⭐ 2026-10-11：扫码页「货品」领域 →【打印这一款】──────────────────────
    // 🔴 它**排在下面"扫码写入口关着 ⇒ 503"那道闸门之前**：打印这一款**不写任何业务表**
    //    （只把一条任务排进打印队列），所以与"销售/采购写入口开不开"是两件事。
    // ⚠️ 编号**只认 URL 里的那个**（表单里刻意不放编号字段）⇒ 手改表单也打不了别的款。
    // ⚠️ 页面上**零 JS**：这里就是一个原生表单的 POST，成功后 303 回本领域（PRG，
    //    刷新不会重复提交），状态由 GET 重新渲染。
      if (action === actions.printLabel) {
        return handlePrintLabelOf({
          req, res, requestId, body, fields, realm, action, openId, writeConfig, service, writeService: scopedWriteService, sendHuman, notFoundPage, isRecordBase, scanTargetOf, backTargetFor, lookupInputOf, postActionFor, resolveLabelPrintQueue, logInfo, logWarn, logError, LABEL_PRINT_QUEUE, sellableSizeTexts, DEFAULT_REALM,
        });
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
      // ── 加入本单 ────────────────────────────────────────────────────────────
      if (action === actions.addLine) {
        return handleAddLineOf({
          req, res, requestId, body, fields, realm, action, openId, writeConfig, service, writeService: scopedWriteService, addBackPath, notFoundPage, respondWriteFailure, scanTargetOf, backTargetFor, lookupInputOf, postActionFor, logInfo, logWarn, logError, LABEL_PRINT_QUEUE, sellableSizeTexts, DEFAULT_REALM,
        });
      }
      

      // ── 清空本单 ────────────────────────────────────────────────────────────
      if (action === actions.clearDraft) {
        return handleClearDraftOf({
          req, res, requestId, body, fields, realm, action, openId, writeService: scopedWriteService, backTargetFor, postActionFor, logInfo, logWarn, logError, LABEL_PRINT_QUEUE, sellableSizeTexts, DEFAULT_REALM,
        });
      }
      

      // ── 第 2 步【提交整单付款】⇒ **走既有那条诚实钱路**（不做第二套账 ✗）─────────────
      //    `followup.addPayment(...)` = 工作台「补记收款」用的同一条链路（`routes/workbench.js:215` ✓）
      //    🔴 三条红线：① 只有**写成功**才说"已收" ✓ ② 没填 ⇒ 待补充（不是失败）✓
      //                ③ 幂等沿既有 `requestId`（**不自造** ✓）
      if (action === (config.paymentStep?.payAction || 'payment_pay')) {
        return handlePaymentPayOf({
          SalesFollowupService, asList, backTargetFor, body, candidatePaymentMethods, config, fields, fillWriteText, invalidateInventorySnapshot, logError, logInfo, logWarn, markRealmUsed: markRealmUsedForPage, openId, openIdOf, parsePaymentRows, realm, realmOfAction, req, requestId, res, respondSettlementBlock, respondWriteFailure, sellableSizeTexts, sendHuman, sendPaymentStep, sendSuccess, service, voucherPayments, writeConfig, writeService: scopedWriteService, options, successReturnFields, lookupInputOf, salesAsync,
        });
      }

      // ── 提交销售单 ──────────────────────────────────────────────────────────
      if (action === actions.submitOrder) {
        return handleSubmitOrderOf({
          asList, backTargetFor, body, buildWriteContext, candidatePaymentMethods, config, fields, fillWriteText, invalidateInventorySnapshot, logError, logInfo, logWarn, lookupInputOf, markRealmUsed: markRealmUsedForPage, openId, openIdOf, parsePaymentRows, postActionFor, realm, realmOfAction, renderScan, req, requestId, res, respondWriteFailure, sellableSizeTexts, sendHuman, sendPaymentStep, sendSuccess, service, successReturnFields, writeConfig, writeService: scopedWriteService, nextOrderNo: () => salesRuntime.orderNoCache.next(),
        });
      }

      // ── 补货报单 ────────────────────────────────────────────────────────────
      if (action === actions.replenish) {
        return handleReplenishOf({
          action, backTargetFor, body, fields, invalidateInventorySnapshot, markRealmUsed: markRealmUsedForPage, mergeFirstItemEntries, multiItemOrderConfig, notFoundPage, openId, openIdOf, parseMultiItemGroups, parseReplenishEntries, purchaseAmountInvalid, purchaseAmountInvalidPage, purchaseAmountMissing, purchaseAmountMissingPage, purchaseEntryInvalidPage, purchaseEntryViolation, purchaseWriteDisabledError, realm, realmOfAction, req, requestId, res, respondWriteFailure, scanTargetOf, schedulePurchaseWrite: schedulePurchaseWriteForPage, sendSuccess, service, submitMultiItemOrder, writeConfig, lookupInputOf, sendHuman, badNumberPage, respondFailure, unknownActionFailure, successReturnFields,
        });
      }

      // ── ⭐ 采购退货（业务负责人 2026-10-11：「和"报货"逻辑一样，也走扫码」）────────
      //    与补货**同形**：同一个 POST 端点、同一套会话/幂等/失败口径；
      //    写库（批次行 + 退货明细 + 扣库存 + 出退货单图）全在既有构件里。
      if (action === actions.purchaseReturn) {
        return handlePurchaseReturnOf({
          action, backTargetFor, body, fields, invalidateInventorySnapshot, markRealmUsed: markRealmUsedForPage, mergeFirstItemEntries, multiItemOrderConfig, notFoundPage, openId, openIdOf, parseMultiItemGroups, purchaseAmountInvalid, purchaseAmountInvalidPage, purchaseAmountMissing, purchaseAmountMissingPage, purchaseEntryInvalidPage, purchaseEntryViolation, purchaseWriteDisabledError, realm, realmOfAction, req, requestId, res, respondWriteFailure, scanTargetOf, schedulePurchaseWrite: schedulePurchaseWriteForPage, sendSuccess, service, submitMultiItemOrder, writeConfig, lookupInputOf, sendHuman, badNumberPage, respondFailure, unknownActionFailure, successReturnFields, parseReturnEntries,
        });
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

  // 深拆 P3c：写上下文/多货品提交/打印上下文 helpers → ./flowHelpers.js（显式注入；函数体逐字）
  const {
    submitMultiItemOrder, buildWriteContext, loadPendingBatches, sendSuccess, invalidateInventorySnapshot, clearDraftForScanIfNeeded, buildPrintContext,
  } = require('./flowHelpers').createFlowHelpers({
    DEFAULT_REALM, LABEL_PRINT_QUEUE, arrival, backTargetFor, buildPaymentRows, candidatePaymentMethods, clearMultiItemPending, config, fillWriteText, invalidateLiveInventorySnapshot, logError, logInfo, logRendered, logWarn, markRealmUsed, multiItemOrder, multiItemOrderConfig, multiItemWire, openIdOf: sessionIdOf, postActionFor, purchaseBackground, realmEntryParams, realmOfAction, realmScanConfig, renderMinimalPage, renderSuccess, resolveLabelPrintQueue, respondWriteFailure, router, scanTargetOf, sendHtml, setDraftOrderAmount, successReturnFields, writeConfig, writeService,
  });

  return router;
};
module.exports = {
  createScanPageRouter, isDataNotReady, parseReplenishEntries, parseReturnEntries, parsePaymentRows,
  // ⭐ 2026-10-16（task-59 · 路由半）：多货品那两个**纯函数**照上面几个的既有风格一起导出 ✓
  //   （用例直调它们钉"坏输入 ⇒ `[]`"与"只合并一次 ⇒ 数量不翻倍"✓）
  parseMultiItemGroups, mergeFirstItemEntries,
};
