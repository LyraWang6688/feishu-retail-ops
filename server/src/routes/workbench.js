const express = require('express');
const controller = require('../controllers/workbenchController');
// 准入闸门（未启用认证 503 / 未登录 401 / 白名单外 403）：**工作台与扫码页共用这一份**。
// 它留在本文件里（没有搬去 middleware/）—— 既有哨兵用例
// （`test/workbenchTwoTabsAndQueryEntries.test.js` 的 AC9/AC10）钉着这里必须看得见
// `require('./feishuWebAuth')`，而"扫码页也走同一道闸门"只要求**共用同一个函数**，
// 不需要搬家。扫码路由 `routes/scanPage.js` 从这里 require 它。
const { enabled: feishuAuthEnabled, getSessionUser, allowedOpenIds } = require('./feishuWebAuth');
const { setTraceFields } = require('../utils/traceContext');
const { roleOf } = require('../config/trace');
const { SalesFollowupService } = require('../services/salesFollowupService');
// ⭐ 2026-10-15：**进程级共享实例**（配品成单那条新链路也要能作废同一份缓存 ⇒ 见该模块注释）
const { sharedWorkbenchOrdersCache } = require('../services/workbenchOrdersCache');
const { readWorkbenchOrdersConfig } = require('../config/workbenchOrders');
const { V1BitableGateway } = require('../services/v1BitableGateway');
const { createPurchaseQueryRouter } = require('./purchaseQuery');
const { createInventoryAdjustmentRouter } = require('./workbenchInventoryAdjustment');
const { createWorkbenchOrderActionsRouter } = require('./workbenchOrderActions');
const { WorkbenchPurchaseArrivalService } = require('../services/workbenchPurchaseArrivalService');
const { createPurchaseQueryService } = require('../services/purchaseQueryService');
const { PurchaseWebhookService } = require('../services/purchaseWebhookService');
// ⭐⭐ 2026-10-16（task-56）：异步之后**金额这道校验留在同步路径** —— 规则与文案**都取既有那一份**
//    （`parseActualAmount` 只有一处实现 ✓ `config/purchaseArrivalTexts` 的 `pageMessages` ✓）
//    ⇒ 本文件**不抄第二份规则、也不新写一句中文** ✗。
const { PurchaseArrivalConversationService, parseActualAmount } = require('../services/purchaseArrivalConversationService');
const { pageMessages } = require('../config/purchaseArrivalTexts');
const { createLabelPrintService } = require('../services/labelPrintService');
const { SampleReplacementService } = require('../services/sampleReplacementService');
const { logError, logInfo, logWarn } = require('../utils/logger');
const { tapIdFromRequest } = require('../utils/correlationFields');
// ⭐⭐ 2026-10-14 晚（埋点 P0 ⑤「**工作台接同一套上报**」）：端点处理与结果事件都来自
//   `utils/uiTapReport.js` —— 与**扫码页共用同一份实现**（事件名 / 字段 / ④ 判据 / ② 结果事件
//   全是同一套 ✓ 不抄第二份 ✗）；本文件只负责"挂在工作台这道闸门之后"。
const { UI_TAP } = require('../config/uiTap');
const { handleUiTap, uiTapResultMiddleware } = require('../utils/uiTapReport');
// ⭐⭐ 2026-10-13 Lead 更正：**工作台「扫一扫」照抄扫码页那套 AppLink**（AppLink **不需要签名** ✗）——
//    AppLink 目标与 UA 判据**都取既有唯一来源**（`config/scanPage.js` 的 `SCAN_NEXT` +
//    `views/scanPageRenderer.js` 导出的 `canScanNextWithFeishu`）⇒ **不抄第二份** ✓
const { SCAN_NEXT } = require('../config/scanPage');
// ⭐⭐ 2026-10-14：工作台「销售 → 配品」子 tab（业务负责人：「整体都迁移过去」✓）
const { createScanWriteService } = require('../services/scanWriteService');
const { SCAN_WRITE } = require('../config/scanWrite');
// 2026-10-14: the old acceptance flow moves into the workbench (reuse the existing arrival session service)
const arrivalTab = require('../config/workbenchArrival');
const { createScanArrivalService } = require('../services/scanArrivalService');
// ⭐⭐ 2026-10-16（task-56）：工作台【确认到货】也接异步 ⇒ 「后台那一跑」用**补货 / 退货同一件**
//   共用件（#664 ✓ 形状照销售那件）—— **不另造第二个后台件** ✗。
const { createPurchaseWriteBackgroundService } = require('../services/purchaseWriteBackgroundService');
const { canScanNextWithFeishu } = require('../views/scanPageRenderer');
// ⭐⭐ 2026-10-14：「扫码打印」要的飞书 JSAPI 签名（服务在 `services/larkJsapiService.js`，
//    密钥只从 env 读；本文件只把它挂到**既有**工作台闸门之后 —— 不新开鉴权 ✗）。
const { createLarkJsapiService } = require('../services/larkJsapiService');

// ⚠️ 准入闸门只有这一份实现：语义与文案**逐字不变**（2026-10-08 的《工作台准入口径》沿用它）。
// 扫码页（`GET /r/:recordId`）require 的也是它 —— 不新开鉴权、也不抄第二份判断。
const requireWorkbenchAccess = (req, res, next) => {
  if (!feishuAuthEnabled()) return res.status(503).json({ success: false, error: '飞书身份认证尚未启用' });
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ success: false, error: '请先通过飞书身份登录工作台', auth_required: true });
  const allowed = allowedOpenIds();
  if (allowed.size && !allowed.has(user.open_id)) return res.status(403).json({ success: false, error: '当前飞书账号未被授权使用工作台' });
  req.workbenchUser = user;
  // 埋点收尾刀：身份确定后补角色维度（只记 role 枚举，不记 open_id）
  setTraceFields({ role: roleOf(user.open_id) });
  return next();
};

const createWorkbenchRouter = (options = {}) => {
  const router = express.Router();
  // ⭐⭐ 2026-10-12（她「一直说正在读取订单」）：订单列表的 TTL 缓存 ——
  //   ⚠️ **一个实例贯穿"读"（`followup.listOrders`）与"写"（下面四条 + 订单动作两条）**：
  //      写成功之后由本层 `invalidate()`，她下一次读一定是新数据（不许看到旧数据）。
  //   TTL 在 `config/workbenchOrders.js`（`WORKBENCH_ORDERS_CACHE_MS`，默认 30 秒；`0` = 关掉）。
  const ordersConfig = options.ordersConfig || readWorkbenchOrdersConfig();
  const ordersCache = options.ordersCache || sharedWorkbenchOrdersCache({ ttlMs: ordersConfig.ordersCacheMs });
  const followup = options.followup || new SalesFollowupService({ ordersCache, ordersConfig });
  // ⭐ 工作台「扫一扫」这一屏要的两样：**AppLink 目标** + **本设备能不能调起飞书扫一扫**
  //    （服务端看 UA —— 与扫码页同一个判据 ✓ 电脑/手机自带浏览器 ⇒ canScan:false ⇒ 前端给人话+手输 ✗ 死按钮）
  router.get('/scan-entry', requireWorkbenchAccess, (req, res) => res.json({
    success: true,
    appLink: SCAN_NEXT.applink,
    canScan: canScanNextWithFeishu(req.get('user-agent')),
  }));

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
  });
  router.use(requireWorkbenchAccess);

  /**
   * ⭐⭐ 2026-10-14 晚（埋点 P0 ⑤）：**工作台接同一套上报**。
   *   · 端点：`POST /api/workbench/ui-tap`（挂在**既有** `requireWorkbenchAccess` 之后 ⇒
   *     未启用认证 503 / 未登录 401 / 白名单外 403 —— 与别的接口**同一个函数**，不新开鉴权 ✗）；
   *     ⚠️ 未登录时浏览器那一下 `sendBeacon` 就静默丢弃 ✓（埋点失败**从不**影响她操作 ✓）。
   *   · 处理体 = `handleUiTap`（扫码页用的**同一个**函数）⇒ 事件名 / 字段 / ④ 重复判据 /
   *     204-400 契约**逐字一致** ✓。
   */
  router.post(UI_TAP.paths.workbench, (req, res) => handleUiTap({ req, res, scope: 'workbench' }));

  /**
   * ⭐⭐ ② 结果事件：工作台的写接口很多，**一个 `router.use` 全覆盖** ——
   *   凡带了 `tap_id` 的请求（= 页面上点出来的那些）都在响应 `finish` 时记一条 `ui.tap.result`
   *   （状态 + 原因码 + 耗时）；GET / 别的调用方**不带 tap_id ⇒ 完全不进这条链**（零开销 ✓）。
   */
  router.use(uiTapResultMiddleware('workbench'));

  // ── ⭐⭐ 2026-10-14：飞书 **JSAPI 签名**（给「扫码打印」调起飞书扫一扫用）────────────
  /**
   * `GET /api/workbench/lark/jsapi-signature?url=<页面地址>`
   *
   * 依据（**都在文件里**）：业务负责人 2026-10-14 晚选了 ⓐ「扫完直接打印这一张」
   *   ⇒ `docs/scan-to-print-jsapi-2026-10-14.md` AC-SP1/SP2/SP3。
   *
   * 🔴 **不新开鉴权**：它就挂在本文件既有那道 `requireWorkbenchAccess` 之后
   *    （未启用认证 503 / 未登录 401 / 白名单外 403 —— 与其它工作台接口**同一个函数**）。
   * 🔴 **响应里不含任何密钥** ✗：只有 `h5sdk.config` 要的 `appId/timestamp/nonceStr/signature`
   *    （外加页面引入 JSSDK 用的公开地址 `jssdkUrl`）；**app secret / jsapi_ticket / token
   *    一个字符都不回** ✓（也不进日志 ✗）。
   * ⚠️ 单例复用：`createLarkJsapiService()` 内部缓存 `tenant_access_token` / `jsapi_ticket`
   *    ⇒ **必须复用同一个实例**，否则每次请求都去飞书换一次票（AC-SP3 就白做了）。
   * ⚠️ 用例可以注入 `options.larkJsapi`（假 fetch）来真红真绿。
   */
  let larkJsapi = options.larkJsapi || null;
  const resolveLarkJsapi = () => {
    if (!larkJsapi) larkJsapi = createLarkJsapiService();
    return larkJsapi;
  };
  router.get('/lark/jsapi-signature', async (req, res) => {
    const pageUrl = String(req.query?.url || '').trim();
    try {
      const result = await resolveLarkJsapi().signatureFor(pageUrl);
      if (!result.ok) {
        // 认得出错在哪 ⇒ 400（她/页面填错）；没配凭证 ⇒ 503（服务端缺配置）；其余 ⇒ 502（上游）。
        const status = result.reason === 'host_not_allowed' || result.reason === 'url_invalid'
          ? 400
          : (result.reason === 'not_configured' ? 503 : 502);
        logWarn('workbench.lark.jsapi_signature.failed', {
          request_id: req.requestId, reason: result.reason,
        });
        return res.status(status).json({ success: false, error: result.message, reason: result.reason });
      }
      logInfo('workbench.lark.jsapi_signature.ok', {
        request_id: req.requestId,
        // ⚠️ 只记域名（排障够用）；**签名 / 票 / 密钥一个字都不进日志** ✗。
        host: (() => { try { return new URL(result.url).host; } catch { return ''; } })(),
      });
      return res.json({
        success: true,
        appId: result.appId,
        timestamp: result.timestamp,
        nonceStr: result.nonceStr,
        signature: result.signature,
        url: result.url,
        // 页面要引入的 JSSDK（公开地址，来自 `config/larkJsapi.js` ⇒ 页面不抄第二份 ✓）。
        jssdkUrl: resolveLarkJsapi().config?.jssdkUrl || '',
        jsApiList: ['scanCode'],
      });
    } catch (error) {
      logError('workbench.lark.jsapi_signature.error', {
        request_id: req.requestId, error: error.message,
      });
      // 文案仍走配置（`config/larkJsapi.js` 的 `texts.upstreamFailed`）—— 路由里不写死中文。
      const texts = resolveLarkJsapi().config?.texts || {};
      return res.status(502).json({ success: false, error: texts.upstreamFailed });
    }
  });

  // ⭐ 2026-10-09（业务负责人当天 15:07：「**采购**，按照**采购订单**，有**验收到货**的按钮」）：
  //   订单列表 · **采购**子 tab 那一行上的「验收到货」。
  //   🔴 **不新开鉴权**：它就挂在这条 `requireWorkbenchAccess` 之后（与其它工作台接口同一道闸门）。
  //   🔴 **不新写一套入库**：本路由只收 `{ batchNo, actualAmount }`（她 2026-10-16：「到货说明必须得删」），
  //      原样交给 `WorkbenchPurchaseArrivalService` → 既有
  //      `PurchaseArrivalConversationService.confirmBatchArrival` →
  //      既有 `PurchaseWebhookService.confirmArrival`（逐条 `InventoryService.applyPurchase`）。
  //   ⚠️ 「发生金额」是**既有必填口径**（业务负责人 2026-10-08：「金额这个是必填的」），
  //      所以那个按钮点开的是一个小表单，不是一个"点了就入库"的裸按钮。
  //   ⚠️ 依赖**延迟构建**：只想注入一个桩的调用方（测试）不必先配好飞书凭证。
  let purchaseArrival = options.purchaseArrival || null;
  const resolvePurchaseArrival = () => {
    if (!purchaseArrival) {
      const arrivalGateway = options.gateway || new V1BitableGateway();
      const webhooks = new PurchaseWebhookService({ gateway: arrivalGateway });
      const arrivalConversation = new PurchaseArrivalConversationService({
        gateway: arrivalGateway,
        // ⚠️ 与采购链路**共用同一个任务存储**：`confirmArrival` 要读的草稿就在那里。
        store: webhooks.store,
        sizeReferences: webhooks.getSizeReferences,
        confirmArrival: (taskId, task, operatorOpenId) =>
          webhooks.confirmArrival(taskId, task, operatorOpenId),
        // 入库之后把批次行的「到货状态」改成已到货 —— 仍是**既有** `PurchaseOrderBatchService`。
        markBatchArrived: (batchNo, arriveOptions) =>
          webhooks.orderBatches.markArrived(batchNo, arriveOptions),
      });
      purchaseArrival = new WorkbenchPurchaseArrivalService({
        purchaseQuery: createPurchaseQueryService(arrivalGateway),
        arrivalConversation,
      });
    }
    return purchaseArrival;
  };
  router.post('/purchase/arrivals/confirm', async (req, res) => {
    const batchNo = String(req.body?.batchNo || '').trim();
    try {
      const result = await resolvePurchaseArrival().confirmArrival({
        batchNo,
        actualAmount: req.body?.actualAmount,
        operatorOpenId: req.workbenchUser?.open_id,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      logError('workbench.purchase.arrival_confirm.failed', {
        request_id: req.requestId, batch_no: batchNo, error: error.message,
      });
      // 失败口径与 `workbenchOrderActions` 同一套：她填错的 400 / 业务拒绝 502，
      // **两种都把原因原样回到页面**（页面上看得见原因，不许静默）。
      const status = error?.statusCode === 400 ? 400 : error?.statusCode === 503 ? 503 : 502;
      return res.status(status).json({ success: false, error: error.message });
    }
  });
  /**
   * ⭐⭐ 2026-10-14 晚（业务负责人：「把老验收整块搬进工作台」✓ 真源 `docs/acceptance-into-workbench-full-2026-10-14.md`）
   *   · `GET /purchase/arrivals/detail`  —— **只读**该批采购明细（既有 `listPurchaseRequests` ✓ 不新造读取口 ✗）
   *   · `POST /purchase/arrivals/accept` —— 走**既有** `scanArrivalService`（start → addScan… → finish ✓
   *     幂等键 = 它自己的 `submitKeyOf(session)` ✓ 同键两跑只写一次 ✗）· 加库存仍走 `InventoryService.applyPurchase` ✓
   *     🔴 失败**如实**（人话 + 不当成功 ✗）
   *     ⭐⭐ **2026-10-16（task-56）起这一条是异步的**：start / addScan（= 校验那一半）仍**同步**，
   *       `finish`（= 写库那一半）丢给下面那件共用后台件 ⇒ 她**先拿到统一成功页** ✓（见下方注释）。
   */
  const purchaseQueryForArrival = () => {
    if (options.purchaseQuery) return options.purchaseQuery;
    if (options.gateway) return createPurchaseQueryService({ gateway: options.gateway });
    return createPurchaseQueryService({ gateway: new V1BitableGateway() });
  };
  const arrivalService = options.arrival || createScanArrivalService({
    gateway: options.gateway || new V1BitableGateway(),
    config: (options.writeConfig || SCAN_WRITE).acceptance,
    store: options.arrivalStore,
  });
  /**
   * ⭐⭐ 2026-10-16（task-56 · 业务负责人**弹窗选定 B**：「**工作台那半也接异步**」；她当天逐字
   *   「**补货、退货还有验收，它都是异步的**……都是一句『**已提交成功，数据会更新**』」）：
   *   工作台【确认到货】= **先回成功页（200 ＋ 统一那一句）⇒ 「后台那一跑」再写库** ✓
   *
   * 🔴 三条硬要求都落在这一处（判据见 `test/acceptAsyncWrite.test.js`）：
   *   ① **校验仍当场同步拦** ✗ —— 批次号缺失 / 明细读不到 / 空单 / 货号认不出 /
   *      尺码数量非法 / 不在本批 全部在**排后台之前**（拦住 ＋ 人话 ＋ **零业务写入** ＋ **一次后台都不排** ✓）。
   *   ② **绝不假装成功** ✗ —— 后台那一跑没成就记一条 warn ＋ 把原因落回会话 `last_error`
   *      （共用件 `services/purchaseWriteBackgroundService.js` 的 `markFailed` ✓）⇒ 可查、可重试 ✓。
   *   ③ **同一把 `submitKey` 原样透传** ✗ —— 键仍由既有 `arrivalService.submitKeyOf(session)` 算
   *      （**不取表单** ✗、不拼、不加后缀 ✓）；幂等三层（会话键 ｜ 批次任务闸门 ｜ 库存三元组）**一层都不拆** ✓。
   *
   * ⚠️ **复用既有共用件**（`createPurchaseWriteBackgroundService` ✓ #664）—— 不另造后台件 ✗；
   *    事件名 / 看门狗阈值都取既有配置（`SCAN_WRITE.events.purchaseBackground*` /
   *    `SCAN_WRITE.purchaseAsync` ⇒ `config/scanWrite.js` **一个字不动** ✓）。
   */
  const acceptBackground = options.acceptBackground || createPurchaseWriteBackgroundService({
    // 🔴 `runRest` = **既有写入口**（`scanArrivalService.finish` ✓ 不新开写库路径 ✗）——
    //    实参形状与改前那一次 `await arrivalService.finish(...)` **逐字同形**（键名一个不改 ✗）。
    runRest: async ({ requestId, submitKey, restInput = {} }) => {
      const result = await arrivalService.finish({
        openId: restInput.openId,
        actualAmount: restInput.actualAmount,
        submitKey,
        operatorOpenId: restInput.operatorOpenId,
      });
      // 写完才作废订单列表缓存（她下一次读一定是新数据 ✓）——改前是"写成功后立刻作废"，语义不变 ✓
      if (result?.ok) ordersCache.invalidate();
      return result;
    },
    // 🔴 失败如实：共用件已经记了 warn；这里把**原因**落回会话（可查、可重试 ✓ 绝不吞成成功 ✗）。
    markFailed: async ({ requestId, context = {}, result, error }) => {
      const message = String(result?.message || error?.message || '').trim();
      if (!message) return;
      try {
        const session = await arrivalService.get(String(context.openId || ''));
        if (session?.session_id) {
          await arrivalService.store.update(session.session_id, { last_error: message });
        }
      } catch (markError) {
        logWarn(SCAN_WRITE.events.purchaseBackgroundMarkFailed, {
          request_id: requestId, chain: 'accept',
          error: String(markError?.message || markError).slice(0, 200),
        });
      }
    },
    purchaseAsync: (options.writeConfig && options.writeConfig.purchaseAsync) || SCAN_WRITE.purchaseAsync || {},
    config: {
      events: {
        restTiming: SCAN_WRITE.events.purchaseBackgroundTiming,
        restFailed: SCAN_WRITE.events.purchaseBackgroundFailed,
        markFailedError: SCAN_WRITE.events.purchaseBackgroundMarkFailed,
      },
    },
  });
  router.get(arrivalTab.api.detail, async (req, res) => {
    const batchNo = String(req.query?.[arrivalTab.fields.batchNo] || '').trim();
    if (!batchNo) return res.status(400).json({ success: false, error: arrivalTab.texts.batchMissing });
    try {
      const rows = (await purchaseQueryForArrival().listPurchaseRequests({
        batchNo, reportBehavior: 'purchase_request',
      })) || [];
      if (!rows.length) return res.json({ success: true, rows: [], notice: arrivalTab.texts.emptyDetail });
      // ⭐ **只读**：只回 货号 / 尺码 / 数量（前端渲染成不可输入的清单 ✓）
      return res.json({
        success: true,
        rows: rows.map((row) => ({
          item_no: row.item_no || row.product_item_no || '',
          size: row.size ?? '',
          quantity: row.quantity ?? 0,
          product_record_id: row.product_record_id || '',
        })),
      });
    } catch (error) {
      logError('workbench.purchase.arrival_detail.failed', { request_id: req.requestId, batch_no: batchNo, error: error.message });
      return res.status(400).json({ success: false, error: arrivalTab.texts.detailFailed });
    }
  });
  router.post(arrivalTab.api.accept, async (req, res) => {
    const openId = req.workbenchUser?.open_id;
    const batchNo = String(req.body?.[arrivalTab.fields.batchNo] || '').trim();
    const lines = Array.isArray(req.body?.[arrivalTab.fields.lines]) ? req.body[arrivalTab.fields.lines] : [];
    if (!batchNo) return res.status(400).json({ success: false, error: arrivalTab.texts.batchMissing });
    try {
      // ⭐⭐ 2026-10-17（业务负责人逐字）：「验收就是我报货、然后货到了，我需要验收；
      //   退货是发给别人的，也就不用验收」⇒ **硬闸门**：只有「发生行为 = 报货」的批次能验收；
      //   退货批次 ⇒ 400 ＋ 人话 ＋ **零写入**（`scanArrivalService` 自己不判行为，必须在这里挡）。
      const batchRows = (await purchaseQueryForArrival().listPurchaseRequests({ batchNo })) || [];
      if (batchRows.some((row) => row.report_behavior === 'purchase_return')) {
        return res.status(400).json({ success: false, error: arrivalTab.texts.notRequestBatch });
      }
      // ① 开会话（既有 `start` 读该批采购明细 ✓ 读不到 ⇒ 它自己的人话 `no_request_rows` ✓ 如实回 400 ✗）
      const started = await arrivalService.start({ openId, batchNo, operatorOpenId: openId });
      if (!started?.ok) {
        const status = started?.reason === 'not_wired' ? 503 : 400;
        return res.status(status).json({ success: false, error: started?.message || arrivalTab.texts.detailFailed });
      }
      // ② 逐行 `addScan`（**既有自定义路** ✓：认得出 productRecordId 才收；认不出**如实**回 400 ✗ 不静默丢）
      for (const line of lines) {
        const productRecordId = String(line?.[arrivalTab.fields.productRecordId] || '').trim();
        const size = Number(line?.[arrivalTab.fields.size]);
        const quantity = Number(line?.[arrivalTab.fields.quantity]);
        if (!productRecordId) {
          // 自定义货号：既有 `addScan` 只吃 `productRecordId` ⇒ 认不出就**如实说**（不许静默丢 ✗）
          return res.status(400).json({ success: false, error: arrivalTab.texts.itemNoUnresolved });
        }
        if (!Number.isSafeInteger(size) || !Number.isSafeInteger(quantity) || size <= 0 || quantity <= 0) {
          return res.status(400).json({ success: false, error: arrivalTab.texts.sizeInvalid });
        }
        // eslint-disable-next-line no-await-in-loop
        const added = await arrivalService.addScan({ openId, productRecordId, size, quantity });
        if (!added?.ok) return res.status(400).json({ success: false, error: added?.message || arrivalTab.texts.acceptFailed });
      }
      // ③ 同步闸门（🔴 **校验必须留在同步路径** ✗ —— 不许顺手挪进后台）：
      //    · `no_session` / `no_scan_lines`（空单）＝ **写层自己的判据与文案**（`scanArrivalService.finish`
      //      用的就是这两条 ✓ 本文件照它那两句回，不新写中文 ✗）；
      //    · 金额 = `PurchaseArrivalConversationService` 里**唯一那一份** `parseActualAmount`
      //      ＋ `config/purchaseArrivalTexts` 的 `pageMessages.m2/m3` ✓（不抄第二份规则 ✗）。
      //    ⚠️ 顺序与**改前那一版同步路径**逐字一致（会话 ⇒ 空单 ⇒ 金额）——两个都错时提示不换 ✗。
      //    命中 ⇒ **400 ＋ 人话 ＋ 零业务写入 ＋ 一次后台都不排** ✓。
      const session = await arrivalService.get(openId);
      if (!session) {
        return res.status(400).json({ success: false, error: SCAN_WRITE.texts.acceptNoSessionBody });
      }
      if (!(session.scans || []).length) {
        return res.status(400).json({ success: false, error: SCAN_WRITE.texts.acceptNoScansBody });
      }
      const amount = parseActualAmount(req.body?.[arrivalTab.fields.actualAmount]);
      if (!amount.ok) {
        return res.status(400).json({
          success: false,
          error: amount.reason === 'amount_missing' ? pageMessages.m2 : pageMessages.m3,
        });
      }
      // ④ 幂等键：**服务端算**（既有 `submitKeyOf(session)` ✓ 不取表单里的键 ✗）——
      //    ⚠️ 它**只在这里算一次**，原样交给后台那一跑（同一把键 ⇒ 幂等第一层仍在 ✓）。
      const submitKey = arrivalService.submitKeyOf(session);
      // ⑤ 排「后台那一跑」（🔴 **不 await** ⇒ 她**先拿到成功页** ✓；写库仍在既有 `finish` 里 ✗ 不新开路径）。
      //    ⚠️ 位置**必须在上面那几道校验之后**：先排后台再校验 = 把"她填错了"变成"看起来成功" ✗。
      acceptBackground.schedulePurchaseRest({
        chain: 'accept',
        requestId: req.requestId,
        submitKey,
        context: { openId, requestId: req.requestId, batchNo },
        restInput: {
          openId,
          // ⚠️ 金额**原样**透传（不改成 `amount.value`）—— 形状与改前那一次 `finish(...)` 逐字同形 ✓；
          //    金额规则在写层还会再走一遍同一份解析（幂等、无副作用 ✓）。
          actualAmount: req.body?.[arrivalTab.fields.actualAmount],
          operatorOpenId: openId,
        },
      });
      // ⑥ 成功页 = **统一那一句**（「已提交成功，数据会更新」· 真源在 `config/scanPage.js` 的
      //    `SCAN_PAGE.saleSuccess` ✓ 本文件不新造字面量 ✗）。
      //    ⚠️ **不许**回 "已确认到货"：这一刻后台还没写 ⇒ 那是假成功 ✗（真失败另有出口：
      //       后台件的 warn ＋ 会话 `last_error` ⇒ 可查、可重试 ✓）。
      return res.json({
        success: true,
        accepted: true,
        batchNo,
        message: arrivalTab.texts.submitted,
      });
    } catch (error) {
      logError('workbench.purchase.arrival_accept.failed', { request_id: req.requestId, batch_no: batchNo, error: error.message });
      const status = error?.statusCode === 400 ? 400 : error?.statusCode === 503 ? 503 : 502;
      return res.status(status).json({ success: false, error: error.message });
    }
  });
  router.use('/purchase', createPurchaseQueryRouter({ gateway: options.gateway || new V1BitableGateway() }));
  // 人工库存调整（盘点调整 / 换季调整）：真写「实时库存」+「库存流水」，
  // 所以放在身份闸门之后挂载（见 workbenchInventoryAdjustment.js 的说明）。
  router.use('/inventory/adjustments', createInventoryAdjustmentRouter(options.inventoryAdjustment || {}));
  // ⚠️ 2026-10-08：自建的「销售查询」接口已删（`GET /sales/query` 与老的 `GET /sales/today`）。
  //    业务负责人的口径（逐字）：「现有的**我们自己搭的**销售查询/库存查询页面与接口（`/api/workbench/*`），
  //    **顺手删掉**」—— 查询改走**飞书多维表格的网页外链**（前端「信息查询」两张卡，见
  //    `public/workbench/config/query.js`），所以这一维**不再自建接口**。
  // ⚠️ **`GET /inventory` 不是"库存查询"的孤儿**：下面这四条只读接口是
  //    【库存手工调整】（信息录入的入口，`features/inventory/adjustment.js`）在用的
  //    （换季调整要按品类列鞋、盘点要按尺码看三种状态的数量）⇒ **必须保留**。
  // ⚠️ 下面的 `/sales/orders` + `/sales/payments` + `/sales/deliveries` 是**写入类**
  //    （补记收款 / 交付并扣库存），不属于"查询"，本次**保留**（见 `docs/module-boundaries.md`）。
  // ⭐ 2026-10-09（业务负责人：「我们建一个**订单列表**吧……工作台要对移动端友好……
  //    如果它在移动端进行**补收款、售后，以及二次交付**，这些都是可以的」）：
  //    订单列表的另外两个动作挂在这里 —— 售后（退 / 换 / 赔）与二次交付（收尾款 + 交付）。
  //    ⚠️ 它们**复用既有的 `requireWorkbenchAccess`**（下面那条 `router.use`，不新开鉴权），
  //       并且**一次写库都不做**：全部交 `services/workbenchOrderActionService.js` →
  //       既有 `AfterSalesService.execute` / `SecondDeliveryService.confirm`。
  //    补收款 / 交付两条沿用既有路由（上面 `followup` 那个实例），一个字没改。
  router.use(createWorkbenchOrderActionsRouter({
    gateway: options.gateway || followup.gateway,
    service: options.orderActions,
    // ⭐ 同**一个**缓存实例：售后 / 二次交付写成功之后也作废它。
    ordersCache,
  }));
  // ⭐ 2026-10-28：售后扫一扫候选（只读）——扫货品二维码后查近 7 天销售单。
  //   鉴权沿用本文件上方既有的 requireWorkbenchAccess，不新开闸门。
  router.get('/sales/after-sales/candidates', async (req, res) => {
    try {
      const result = await followup.listAfterSalesCandidates({
        productRecordId: req.query.productRecordId || req.query.product_record_id,
        days: req.query.days,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      logError('workbench.sales.after_sales.candidates.failed', {
        request_id: req.requestId, error: error.message,
      });
      return res.status(error?.statusCode === 400 ? 400 : 502)
        .json({ success: false, error: error.message || 'after-sales candidates failed' });
    }
  });

  // 货品选择器 / 库存数量 / 品类清单 —— 都只读，供「库存手工调整」两个子页用。
  router.get('/inventory/products', controller.queryInventoryProducts);
  router.get('/inventory/stock', controller.queryInventoryStock);
  router.get('/inventory/categories', controller.queryInventoryCategories);
  router.get('/inventory', controller.queryInventory);
  // 鞋盒标签打印（业务负责人 2026-10-08 批准的第一个功能）—— **只读**：
  // 从「实时库存」（一双一条）取数，返回"每张标签要印什么"（含内联 SVG 二维码）+
  // 排版参数（50×30mm / A4 / 字号 / 字段开关，全部来自 `config/labelPrint.js`）。
  // ⚠️ 这里**不新开鉴权**：它挂在同一个 router 上，沿用上面那条 `requireWorkbenchAccess`
  //    （未启用认证 503 / 未登录 401 / 白名单外 403），与其它工作台接口一字不差。
  // ⚠️ 失败口径复用控制器那一份（400 / 503 / 500），不另写一套。
  const labelPrint = options.labelPrint || createLabelPrintService(options.gateway || new V1BitableGateway());
  router.get('/labels', async (req, res) => {
    try {
      const result = await labelPrint.listLabels({
        keyword: req.query.keyword,
        state: req.query.state,
        category: req.query.category,
        size: req.query.size,
        recentDays: req.query.recentDays,
        sort: req.query.sort,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      return controller.respondQueryFailure(res, error, {
        requestId: req.requestId, event: 'workbench.labels.failed', fallback: '标签数据读取失败',
      });
    }
  });
  /**
   * ⭐⭐ 2026-10-15：**批量打印要"一次给一批新货打码"** ⇒ 先要一份能挑的**编号清单**。
   *
   * 依据（**都在文件里**）：业务负责人 2026-10-15 逐字「编号对呀，我们的编号**只要它在货品信息里
   * 就行了**，不一定非要在库存里面有啊」＋ 批量打印的用途 =「一次给一批新货打码（新店开业 / 换季上架）」
   * ⇒ `docs/`（本任务的验收标准 AC-N5）。
   *
   * `GET /api/workbench/products/numbers?keyword=<str>&limit=<1..500，默认 200>`
   *   · 契约（**冻结**，前端并行按它写）：
   *     `{ success:true, total, truncated, numbers:[{ number, itemNo, color, category, hasStock, recordId }] }`
   *   · `keyword` 按 编号 / 货号 / 颜色 / 类别 模糊（大小写不敏感）；空 = 全部；
   *   · `hasStock` = 该编号在「实时库存」里**有没有行**（前端提示"还没入库"）；
   *   · 排序 = 按编号 `localeCompare('zh-CN')` 升序；`limit` 超出上限**如实**回 `truncated:true`。
   * 🔴 **只读诊断/查询**（**不写任何业务表、不改任何状态** ✗）：取数全在
   *    `services/labelPrintService.js#listProductNumbers`（两次 `listAll` + 日志）。
   * ⭐⭐ 2026-10-15（task-10）：那两次全表读**带短 TTL 缓存**（线上只读实测单次 ≈ 11.4 秒）——
   *    口径在 `config/labelPrint.js#PRODUCT_NUMBERS`（`cacheTtlMs` 默认 60000、**0 = 关掉**；
   *    `limitDefault/limitMax` 默认 200/500）；命中 / 未命中都有日志
   *    （`workbench.products.numbers.cache_hit` / `.cache_miss`），真机一眼看出"到底读没读表"。
   *    ⚠️ 这个缓存**只服务本端点**；`listLabels`（批量那一页）**这次不动**。
   * 🔴 **不新开鉴权**：它就挂在本文件既有那道 `requireWorkbenchAccess` 之后（未启用认证 503 /
   *    未登录 401 / 白名单外 403 —— 与其它工作台接口**同一个函数**）。
   * ⚠️ 失败口径**复用**控制器那一份（`respondQueryFailure`：她填错的 400 原样回显 /
   *    飞书数据没准备好的 503 / 其余 500 不回显内部细节），**不另写一套**。
   */
  router.get('/products/numbers', async (req, res) => {
    try {
      const result = await labelPrint.listProductNumbers({
        keyword: req.query.keyword,
        limit: req.query.limit,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      return controller.respondQueryFailure(res, error, {
        requestId: req.requestId, event: 'workbench.products.numbers.failed', fallback: '标签数据读取失败',
      });
    }
  });
  /**
   * ⭐⭐ 2026-10-15：**扫码打印的客户端诊断上报**（她真机反馈「扫码打印好像没调用成功」之后加的）。
   *   为什么需要：飞书 JSSDK 在手机里"装死"（`h5sdk.ready` 不回调）时**只有客户端知道原因** ——
   *   页面上只有一行小字、服务端**一条日志都没有** ✗ ⇒ 她一说"没成功"，我们只能猜。
   *   ⇒ 客户端把 `phase`（signature/config/scan/done）+ 原因码 + `errMsg` + 页面 URL 报上来，这里**记一条** ✓。
   *   🔴 **它不写任何业务表、不改任何状态**（只有一条 `logInfo` ✓）；
   *     挂在**既有** `requireWorkbenchAccess` 之后 ⇒ **不新开鉴权** ✓。
   */
  router.post('/labels/scan-report', (req, res) => {
    const body = req.body || {};
    logInfo('label_print.scan.report', {
      request_id: req.requestId,
      ok: body.ok === true,
      phase: String(body.phase || '').slice(0, 32),
      reason: String(body.reason || '').slice(0, 64),
      err_msg: String(body.err_msg || '').slice(0, 200),
      // ⭐⭐ 2026-10-15：**飞书回的原始内容**（它 `config` 失败时常常既不回 `errMsg` 也不回 `message`
      //   ⇒ 只报"失败"我们查不下去 ✗）—— 原样带上，一眼看出飞书自己怎么说 ✓
      raw: String(body.raw || '').slice(0, 300),
      url: String(body.url || '').slice(0, 300),
    });
    return res.json({ success: true });
  });
  router.get('/sales/orders', async (req, res) => {
    try { return res.json({ success: true, ...await followup.listOrders() }); }
    catch (error) {
      logError('workbench.sales.orders.failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: error.message });
    }
  });
  /**
   * ⭐⭐ 2026-10-11（业务负责人 20:30 确认）：**补样品**（工作台 → 销售 → 订单列表 →【待补充】）。
   *
   * 她卖掉的样品没指定门盒 ⇒ 订单列表里有一条待办 ⇒ 她在这里选一个码 ⇒
   * 那一双 **门盒 → 样品**（**1 双**，库存总数不变），待办消失。
   *
   * ⚠️ 本路由**一行业务判断都没有**：待办/门盒/幂等全在
   *    `services/samplePendingService.js` → `InventoryService.promoteToSample`
   *    （**与群卡片共用同一个 `operationId`** ⇒ 跨入口绝不重复挪）；
   *    鉴权走本文件既有的那道闸门（`requireWorkbenchAccess`），**不新开**。
   */
  router.post('/sales/sample-fill', async (req, res) => {
    try {
      const result = await followup.fillSample({
        detailRecordId: req.body?.detailRecordId,
        size: req.body?.size,
        requestId: req.body?.requestId,
        operatorOpenId: req.workbenchUser.open_id,
      });
      // ⭐ 写成功了才作废订单列表缓存（她下一次读一定是新数据）。
      ordersCache.invalidate();
      return res.json({ success: true, ...result });
    } catch (error) {
      // 她选错了 / 这一条不是待办 ⇒ 400（人话原样给她）；系统没做成 ⇒ 502。
      const status = error.statusCode === 400 ? 400 : 502;
      logError('workbench.sales.sample_fill.failed', {
        request_id: req.requestId, detail_record_id: req.body?.detailRecordId,
        size: req.body?.size, error: error.message,
      });
      return res.status(status).json({ success: false, error: error.message });
    }
  });

  router.post('/sales/payments', async (req, res) => {
    try {
      const result = await followup.addPayment({
        salesEntryRecordId: req.body?.salesEntryRecordId,
        method: req.body?.method, amount: req.body?.amount,
        requestId: req.body?.requestId, operatorOpenId: req.workbenchUser.open_id,
        // ⭐ 2026-10-15（task-48 b）：把这次点击的 `tap_id` 带下去 ⇒ 写库日志与 `ui.tap` 同一个 id ✓
        //    （取不到就是 `{}` ⇒ 字段压根不出现，**绝不编一个** ✗）
        correlation: tapIdFromRequest(req),
      });
      // ⭐ 补收款成功 ⇒ 作废缓存（金额 / 状态都变了）。
      ordersCache.invalidate();
      return res.json({ success: true, ...result });
    } catch (error) {
      logError('workbench.sales.payment.failed', { request_id: req.requestId, error: error.message });
      return res.status(400).json({ success: false, error: error.message });
    }
  });
  // ⭐ 2026-10-15 收尾（只改注释）：这里原来挂着一整段说明**工作台自建配品两条路由**的 JSDoc
  //   （`GET /sales/accessories` 只读清单 / `POST /sales/accessory-sales` 自建成单）。
  //   那两条路由**已随她那句「配品就是走表单了～工作台自建写服务可以删除了」整段删除**（见下面那块注释 ✓）
  //   ⇒ 这段"它还在这儿"的旧说明**留着就是误导** ✗ 换成这一句沿革即可。
  //   ⚠️ 那两条路由当年的**业务判据没有丢**：一步成单 / 收款明细形状 / 不动库存 / 幂等 / 失败如实
  //     ⇒ 已迁到新链路 `services/accessorySaleIntakeService.js` ＋ `test/accessorySaleIntake.test.js`
  //     的 **AC-MIG1…AC-MIG5**（迁移清单见 `test/workbenchAccessoryTab.test.js` 文件头 ✓）。
  const scanWrite = options.scanWrite || createScanWriteService({
    gateway: options.gateway || new V1BitableGateway(), config: SCAN_WRITE,
  });
  /**
   * ⭐⭐ 2026-10-15（⑰b-1 · 她逐字）：「失败落「**写入失败**」、工作台显示「**未完成，可点重试**」」
   *   ⇒ **工作台「续写 / 重试」入口**：那一单**能点、点了真能续上** ✓
   *
   * 口径（Lead 2026-10-15 批准）：
   *   · 🔴 **复用** `submitSale`（**不新开写库** ✗）：**同一把 `session.sale.key`**
   *     ＋ `session.sale.submitPending` 里那套资金入参 —— 与她点资金页那颗按钮**同一次调用** ✓
   *     （幂等一字没拆 ✗；同一把键 + 同一份入参 ⇒ 重试不会写第二遍 ✓）
   *   · ⭐ 主表已经建过（`master_record_id` 在会话里）⇒ `wasResume=true` ⇒ **不再往后丢**、
   *     这一次**同步跑完** ⇒ 她点下去能看到"好了 / 还没好" ✓
   *   · 🔴 **绝不直调 `_confirm`** ✓（走的是既有 `sales().confirm`）
   *   · 🔴 **不新开鉴权**：它挂在本文件上方那条既有 `router.use(requireWorkbenchAccess)` 之后 ✓
   *   · 🔴 **没有待续的单 / 单号对不上** ⇒ **如实 400 + 人话**（绝不假成功 ✗）
   */
  router.post('/sales/retry', async (req, res) => {
    const openId = req.workbenchUser?.open_id;
    const requestId = req.body?.requestId || req.requestId;
    const texts = SCAN_WRITE.texts || {};
    try {
      const session = await scanWrite.sessions?.get?.(openId).catch(() => null);
      const key = String(session?.sale?.key || '').trim();
      const masterRecordId = String(session?.sale?.master_record_id || '').trim();
      const orderNo = String(session?.sale?.order_no || '').trim();
      const pending = session?.sale?.submitPending || {};
      // 🔴 没有"已经建过主表、还没写完"的单 ⇒ 如实告诉她（不假成功 ✗）
      if (!key || !masterRecordId) {
        logWarn('workbench.sales.retry.no_pending', {
          request_id: requestId, open_id: String(openId || ''), has_key: Boolean(key),
        });
        return res.status(400).json({ success: false, code: 'no_pending_order', error: texts.saleRetryNoPendingBody });
      }
      // 🔴 点的是哪一单就重试哪一单：她给的单号与会话里那一单不一致 ⇒ 不动手 ✗
      const askedOrderNo = String(req.body?.order_no ?? '').trim();
      if (askedOrderNo && orderNo && askedOrderNo !== orderNo) {
        logWarn('workbench.sales.retry.order_mismatch', {
          request_id: requestId, asked_order_no: askedOrderNo, order_no: orderNo,
        });
        return res.status(400).json({ success: false, code: 'order_mismatch', error: texts.saleRetryMismatchBody });
      }
      const result = await scanWrite.submitSale({
        openId,
        requestId,
        // 🔴 **同一把 `submitKey`**（幂等不许拆 ✗）
        submitKey: key,
        payments: Array.isArray(pending.payments) ? pending.payments : [],
        lineAmounts: Array.isArray(pending.lineAmounts) ? pending.lineAmounts : [],
        paymentStatus: String(pending.paymentStatus || '').trim(),
        paidAmount: String(pending.paidAmount ?? ''),
        timing: {},
      });
      if (result?.ok) {
        // 写成了 ⇒ 让她下一次读到的是**真的新数据**（不看缓存 ✗）
        if (typeof ordersCache?.invalidate === 'function') ordersCache.invalidate();
        logInfo('workbench.sales.retry.done', {
          request_id: requestId, order_no: result.order_no || orderNo,
          detail_count: result.detail_count, payment_count: result.payment_count,
        });
        return res.json({
          success: true, order_no: result.order_no || orderNo,
          detail_count: result.detail_count || 0, payment_count: result.payment_count || 0,
          // ⭐ 她刷新/回看时看到的是**真实状态**：`reused:true` = "这一单刚才已经交过了"（不是又写了一遍 ✗）
          reused: result.reused === true,
          message: texts.saleRetryDoneBody,
        });
      }
      logWarn('workbench.sales.retry.failed', {
        request_id: requestId, order_no: orderNo,
        code: String(result?.code || ''), reason: String(result?.message || ''),
      });
      // 部成那类（主表已在、后面没写完）= 500（系统没写成）；她填错类 = 400 ✓
      const status = result?.code === 'sale_partial_failed' ? 500 : 400;
      return res.status(status).json({
        success: false, code: String(result?.code || ''),
        error: result?.message || texts.saleRetryFailedBody, order_no: orderNo,
      });
    } catch (error) {
      logError('workbench.sales.retry.error', {
        request_id: requestId, error: String(error?.message || error),
      });
      return res.status(500).json({ success: false, code: 'retry_failed', error: texts.saleRetryFailedBody });
    }
  });
  // ⭐⭐ 2026-10-15（业务负责人逐字）：「**配品就是走表单了～工作台自建写服务"可以删除了**」
  //   ⇒ 这一整块（`GET /sales/payment-methods` 收款方式清单 / `GET /sales/accessories` 配品清单 /
  //      `POST /sales/accessory-sales` 自建成单）**整段删除** —— 工作台点「配品」现在**直接跳她那张
  //      飞书表单**（`config/domains.js` 的直跳页 + `config/links.js` 的 `ACCESSORY_SALE_FORM_URL`）✓
  //   ⚠️ 这三条路由当年的**业务判据没有跟着消失**：一步成单 / 收款明细形状 / 不动库存 / 幂等（同一把键）/
  //      失败如实 ⇒ 已迁到**新链路**（`services/accessorySaleIntakeService.js` ＋
  //      `test/accessorySaleIntake.test.js` 的 **AC-MIG1/2/3/4**）—— 迁移清单见
  //      `test/workbenchAccessoryTab.test.js` 文件头 ✓
  //   ⚠️ `services/paymentMethodsService.js` **保留**（它有自己的用例 `test/paymentMethodsService.test.js`）——
  //      这一刀**只删工作台自建那套**，**不删业务模块** ✗
  /**
   * ⭐⭐ 2026-10-11（方案甲之后**唯一的补充入口**）：**逐件补「实收金额」**。
   * 业务负责人 2026-10-11：「待补充的时候，**一定要把每件的实收都留下来**」。
   * ⚠️ 本路由**一行业务判断都没有**：校验与两条红线全在
   *    `services/salesFollowupService.updateDetailAmounts`（同一个 service 管工作台这一页的写入，
   *    鉴权走本文件既有的那道闸门，不新开）。
   */
  router.post('/sales/detail-amounts', async (req, res) => {
    try {
      const result = await followup.updateDetailAmounts({
        salesEntryRecordId: req.body?.salesEntryRecordId,
        amounts: req.body?.amounts,
        requestId: req.body?.requestId,
        operatorOpenId: req.workbenchUser.open_id,
      });
      // ⭐ 补实收金额成功 ⇒ 作废缓存。
      ordersCache.invalidate();
      return res.json({ success: true, ...result });
    } catch (error) {
      logError('workbench.sales.detail_amount.failed', { request_id: req.requestId, error: error.message });
      return res.status(400).json({ success: false, error: error.message });
    }
  });
  router.post('/sales/deliveries', async (req, res) => {
    try {
      const result = await followup.delivery.deliver({
        salesEntryRecordId: req.body?.salesEntryRecordId,
        detailRecordIds: req.body?.detailRecordIds,
      }, {
        // ⭐ 2026-10-15（task-48 b）：同上 —— 交付（含扣库存）那一半也带同一个 `tap_id` ✓
        correlation: tapIdFromRequest(req),
      });
      // ⭐ 交付（含扣库存）成功 ⇒ 作废缓存。
      ordersCache.invalidate();
      if (result.sampleReplacements?.length) {
        const notifier = options.sampleNotifier || new SampleReplacementService({
          gateway: followup.gateway, inventory: followup.delivery.inventory,
        });
        await notifier.notifySampleReplacements(result, req.workbenchUser.open_id).catch((error) =>
          logWarn('workbench.sales.sample_notice.failed', { request_id: req.requestId, error: error.message }));
      }
      return res.json({ success: true, ...result });
    } catch (error) {
      logError('workbench.sales.delivery.failed', { request_id: req.requestId, error: error.message });
      return res.status(400).json({ success: false, error: error.message });
    }
  });
  return router;
};

// `requireWorkbenchAccess` 也导出：扫码路由（`routes/scanPage.js`）要用**同一个**闸门函数。
module.exports = { createWorkbenchRouter, requireWorkbenchAccess };
