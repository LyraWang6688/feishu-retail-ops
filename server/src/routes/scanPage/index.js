/**
 * 扫码页路由：**`GET /r/:recordId`**（`number` = 「编号」= `货号|颜色|类别`，URL 编码过的）
 * ＋ **`POST /r/:recordId`**（页面上那两个**写入口**：销售建单 / 补货报单）。
 *
 * 这一页就是标签二维码指向的那个地址 —— 二维码内容的唯一真源是
 * `config/tagQrCode.js` 的 `scanUrl.recordIdTemplate`（`https://hm.bamamei.online/s/{编号}`），
 * 本文件**不抄那份模板**，只用 `config/scanPage.js` 里的挂载点与路径段。
 *
 * 挂载与准入（**先读代码再动**的结果）：
 *   · `app.js` 把本 router 挂在 **`SCAN_PAGE.route.recordBasePath`（`/r`）** 上，
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
const { renderSalesHome, renderScanSkeleton, renderScanPage, renderScanMessagePage, renderMinimalPage, renderSalePaymentStepPage, buildPaymentRows } = require('../../views/scanPageRenderer');
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
const { renderFlowOf, handlePendingExchangeSubmit } = require('./exchangeFlow');
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
const { handleAddLine: handleAddLineOf, handleClearDraft: handleClearDraftOf } = require('./handlers/smallActions');
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
// 🔴 2026-11-09（业务负责人：「隐藏的旧「标签」领域块，可以删除」）：
//   扫码页「标签」领域（打印这一款 + 打印上下文）整块删除 ⇒ 本文件不再接打印队列。
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

const { createPageContext } = require('./pageContext');
const { installScanPageRoutes } = require('./routes');
const { createScanPageSetup } = require('./setup');
const { createScanPageHelpers } = require('./helpers');

const createScanPageRouter = (options = {}) => {
  const deps = { COOKIE_NAME, DEFAULT_REALM, ENTRY_RULE_TEXTS, FUNNEL, PURCHASE_RETURN_REALM, REALM_SCAN, SCAN_AUTH_REDIRECT, SCAN_PAGE, SCAN_WRITE, SalesFollowupService, TICKET, V1BitableGateway, asList, buildLoginStartUrl, buildPaymentRows, createFirstVisitKeyAdopter, createLarkJsapiService, createLegacySessionProbe, createMultiItemOrderService, createMultiItemPendingOf, createPageContext, createPageTokenMiddleware, createPaymentMethodsService, createPurchaseSchedulerOf, createPurchaseWriteBackgroundService, createSalesAsyncRuntime, createScanPageRouter, createScanPageService, createScanWriteService, createVoucherPaymentService, encodeSession, express, feishuAuthEnabled, fillWriteText, getSessionUser, handleAddLineOf, handleClearDraftOf, handlePaymentPayOf, handlePendingExchangeSubmit, handlePurchaseReturnOf, handleReplenishOf, handleSubmitOrderOf, handleUiTap, installScanPageRoutes, invalidateLiveInventorySnapshot, isDataNotReady, logError, logInfo, logWarn, markRealmUsedOf, markTapCode, mergeFirstItemEntries, mountedPathOf, orderWithPreferred, pageSessionKey, pageSessionKeyOfRequest, parseMultiItemGroups, parseNumberSegments, parsePaymentRows, parseReplenishEntries, parseReturnEntries, pathWithoutTicket, purchaseAmountInvalidOf, purchaseAmountMissingOf, purchaseAmountRequiredForOf, purchaseEntryViolation, purchaseWriteDisabledError, realmEntryParams, realmOfActionOf, redeemSessionTicket, renderFlowOf, renderMinimalPage, renderSalePaymentStepPage, renderSalesHome, renderScanMessagePage, renderScanPage, renderScanSkeleton, requireWorkbenchAccess, resolveMultiItemOrderConfig, resolvePurchaseReturnImageOptions, resolveRealm, resolveScanNext, roleOf, sellableSizeTexts, sendHtml, setTraceFields, sizesForCategory, uiTapResultMiddleware, withPageSession };
  const setupCtx = createScanPageSetup({ options, deps });
  const { salesAsync, SUBMIT_TOAST, addBackPath, adoptFirstVisitSubmitKey, badNumberPage, candidatePaymentMethods, clearMultiItemPending, config, configuredPaymentMethods, gateway, larkJsapi, logFunnelPage, logRendered, multiItemChainOf, multiItemOrder, multiItemOrderConfig, multiItemOrderEngine, multiItemPendingKey, multiItemWire, notFoundPage, paymentMethodsService, purchaseAmountInvalidPage, purchaseAmountMissingPage, purchaseBackground, purchaseEntryInvalidPage, readMultiItemPending, realmScanActive, realmScanConfig, realmScanPageConfig, realmScanTriggered, renderContext, renderMessage, renderScan, resolveLarkJsapi, respondFailure, respondSettlementBlock, respondWriteFailure, responses, salesRuntime, schedulePurchaseWrite, sendHuman, sendPaymentStep, service, setDraftOrderAmount, step2WriteOf, unknownActionFailure, voucherPayments, withoutRealmQuery, writeConfig, writeMultiItemPending, writeService } = setupCtx;

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
    // 「刚才那一页」= 原 path + 原 query（本 router 挂在 `SCAN_PAGE.route.recordBasePath` 上，
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

  const helperCtx = createScanPageHelpers({ options, ctx: setupCtx, deps, router });
  const { arrival, arrivalInstance, backTargetFor, isRecordBase, lookupInputOf, markRealmUsed, openIdOf, postActionFor, purchaseAmountInvalid, purchaseAmountMissing, purchaseAmountRequiredFor, realmOfAction, scanTargetOf, sessionIdOf } = helperCtx;

  const routeContext = { salesAsync, DEFAULT_REALM, PURCHASE_RETURN_REALM, SCAN_PAGE,
    SUBMIT_TOAST, SalesFollowupService, addBackPath, arrival, asList, backTargetFor, badNumberPage,
    buildPaymentRows, candidatePaymentMethods, clearMultiItemPending, config, fillWriteText, handleAddLineOf,
    handleClearDraftOf, handlePaymentPayOf, handlePendingExchangeSubmit,
    handlePurchaseReturnOf, handleReplenishOf, handleSubmitOrderOf, handleUiTap,
    invalidateLiveInventorySnapshot, isDataNotReady, logError, logInfo, logRendered, logWarn,
    lookupInputOf, markRealmUsed, markTapCode, mergeFirstItemEntries, multiItemOrder, multiItemOrderConfig,
    multiItemWire, notFoundPage, openIdOf, options, pageSessionKey, parseMultiItemGroups, parsePaymentRows,
    parseReplenishEntries, parseReturnEntries, postActionFor, purchaseAmountInvalid,
    purchaseAmountInvalidPage, purchaseAmountMissing, purchaseAmountMissingPage, purchaseBackground,
    purchaseEntryInvalidPage, purchaseEntryViolation, purchaseWriteDisabledError, readMultiItemPending,
    realmEntryParams, realmOfAction, realmScanConfig, realmScanPageConfig, realmScanTriggered, renderFlowOf,
    renderMinimalPage, renderSalesHome, renderScan, renderScanSkeleton,
    resolveLarkJsapi, resolveRealm, respondFailure, respondSettlementBlock, respondWriteFailure,
    salesRuntime, scanTargetOf, schedulePurchaseWrite, sellableSizeTexts, sendHtml, sendHuman,
    sendPaymentStep, service, sessionIdOf, setDraftOrderAmount, uiTapResultMiddleware, unknownActionFailure,
    voucherPayments, withPageSession, writeConfig, writeMultiItemPending, writeService,
  };
  installScanPageRoutes({ router, ctx: routeContext });

  return router;
};
module.exports = {
  createScanPageRouter, isDataNotReady, parseReplenishEntries, parseReturnEntries, parsePaymentRows,
  // ⭐ 2026-10-16（task-59 · 路由半）：多货品那两个**纯函数**照上面几个的既有风格一起导出 ✓
  //   （用例直调它们钉"坏输入 ⇒ `[]`"与"只合并一次 ⇒ 数量不翻倍"✓）
  parseMultiItemGroups, mergeFirstItemEntries,
};
