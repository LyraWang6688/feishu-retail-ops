const express = require('express');
const controller = require('../controllers/workbenchController');
// 准入闸门（未启用认证 503 / 未登录 401 / 白名单外 403）：**工作台与扫码页共用这一份**。
// 它留在本文件里（没有搬去 middleware/）—— 既有哨兵用例
// （`test/workbenchTwoTabsAndQueryEntries.test.js` 的 AC9/AC10）钉着这里必须看得见
// `require('./feishuWebAuth')`，而"扫码页也走同一道闸门"只要求**共用同一个函数**，
// 不需要搬家。扫码路由 `routes/scanPage.js` 从这里 require 它。
const { enabled: feishuAuthEnabled, getSessionUser, allowedOpenIds } = require('./feishuWebAuth');
const { SalesFollowupService } = require('../services/salesFollowupService');
const { createWorkbenchOrdersCache } = require('../services/workbenchOrdersCache');
const { readWorkbenchOrdersConfig } = require('../config/workbenchOrders');
const { V1BitableGateway } = require('../services/v1BitableGateway');
const { createPurchaseQueryRouter } = require('./purchaseQuery');
const { createInventoryAdjustmentRouter } = require('./workbenchInventoryAdjustment');
const { createWorkbenchOrderActionsRouter } = require('./workbenchOrderActions');
const { WorkbenchPurchaseArrivalService } = require('../services/workbenchPurchaseArrivalService');
const { createPurchaseQueryService } = require('../services/purchaseQueryService');
const { PurchaseWebhookService } = require('../services/purchaseWebhookService');
const { PurchaseArrivalConversationService } = require('../services/purchaseArrivalConversationService');
const { createLabelPrintService } = require('../services/labelPrintService');
const { SampleReplacementService } = require('../services/sampleReplacementService');
const { logError, logInfo, logWarn } = require('../utils/logger');
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
const accessoryTab = require('../config/workbenchAccessory');
const { sellableKindOf } = require('../config/sellableKinds');
const { createPaymentMethodsService } = require('../services/paymentMethodsService');
const { canScanNextWithFeishu } = require('../views/scanPageRenderer');
// ⭐⭐ 2026-10-14：「扫码打印」要的飞书 JSAPI 签名（服务在 `services/larkJsapiService.js`，
//    密钥只从 env 读；本文件只把它挂到**既有**工作台闸门之后 —— 不新开鉴权 ✗）。
const { createLarkJsapiService } = require('../services/larkJsapiService');

// ⚠️ 准入闸门只有这一份实现：语义与文案**逐字不变**（2026-10-08 的《工作台准入口径》沿用它）。
// 扫码页（`GET /s/:number`）require 的也是它 —— 不新开鉴权、也不抄第二份判断。
const requireWorkbenchAccess = (req, res, next) => {
  if (!feishuAuthEnabled()) return res.status(503).json({ success: false, error: '飞书身份认证尚未启用' });
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ success: false, error: '请先通过飞书身份登录工作台', auth_required: true });
  const allowed = allowedOpenIds();
  if (allowed.size && !allowed.has(user.open_id)) return res.status(403).json({ success: false, error: '当前飞书账号未被授权使用工作台' });
  req.workbenchUser = user;
  return next();
};

const createWorkbenchRouter = (options = {}) => {
  const router = express.Router();
  // ⭐⭐ 2026-10-12（她「一直说正在读取订单」）：订单列表的 TTL 缓存 ——
  //   ⚠️ **一个实例贯穿"读"（`followup.listOrders`）与"写"（下面四条 + 订单动作两条）**：
  //      写成功之后由本层 `invalidate()`，她下一次读一定是新数据（不许看到旧数据）。
  //   TTL 在 `config/workbenchOrders.js`（`WORKBENCH_ORDERS_CACHE_MS`，默认 30 秒；`0` = 关掉）。
  const ordersConfig = options.ordersConfig || readWorkbenchOrdersConfig();
  const ordersCache = options.ordersCache || createWorkbenchOrdersCache({ ttlMs: ordersConfig.ordersCacheMs });
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
  //   🔴 **不新写一套入库**：本路由只收 `{ batchNo, actualAmount, acceptanceText }`，
  //      原样交给 `WorkbenchPurchaseArrivalService` → 既有
  //      `PurchaseArrivalConversationService.confirmBatchArrival` →
  //      既有 `PurchaseWebhookService.confirmArrival`（逐条 `InventoryService.applyPurchase`）。
  //   ⚠️ 「实际金额」是**既有必填口径**（业务负责人 2026-10-08：「金额这个是必填的」），
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
        acceptanceText: req.body?.acceptanceText,
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
      // ③ 完成（🔴 **同一把** `submitKey`：来自既有 `submitKeyOf(session)` ✓ 幂等不许拆 ✗）
      const session = await arrivalService.get(openId);
      const result = await arrivalService.finish({
        openId,
        actualAmount: req.body?.[arrivalTab.fields.actualAmount],
        submitKey: arrivalService.submitKeyOf(session),
        operatorOpenId: openId,
      });
      if (!result?.ok) return res.status(400).json({ success: false, error: result?.message || arrivalTab.texts.acceptFailed });
      ordersCache.invalidate();
      return res.json({ success: true, reused: result.reused === true, notice: arrivalTab.texts.accepted, ...result });
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
      });
      // ⭐ 补收款成功 ⇒ 作废缓存（金额 / 状态都变了）。
      ordersCache.invalidate();
      return res.json({ success: true, ...result });
    } catch (error) {
      logError('workbench.sales.payment.failed', { request_id: req.requestId, error: error.message });
      return res.status(400).json({ success: false, error: error.message });
    }
  });
  /**
   * ⭐⭐ 2026-10-14（业务负责人：「把配品迁移到工作台销售里，新建一个子 tab」✓ 入口变了、逻辑没变 ✗）
   *   · `GET /sales/accessories`  —— **只读**：名称清单复用既有 `listAccessories()`（30 秒短缓存 ✓
   *     与扫码页**同一个**读取口 ✓ 不另造 ✗）
   *   · `POST /sales/accessory-sales` —— **一步成单**：数量默认 1 · 成交金额**必填** ✓ · 付款方式 **全付** ✓
   *     ⇒ 复用既有 `addSaleLine(kind:'accessory')` + `submitSale`（**同一把** `submitKey` ✓ 幂等 ✓）
   *     🔴 **零库存动作**（配品没有鞋 ✓）· 失败**如实 400 + 人话** ✗ 绝不返回"成功" ✗
   */
  const scanWrite = options.scanWrite || createScanWriteService({
    gateway: options.gateway || new V1BitableGateway(), config: SCAN_WRITE,
  });
  router.get(accessoryTab.api.methods, async (req, res) => {
    // ⭐⭐ 2026-10-14（她：「配品收款方式读『收款方式管理』表」）—— **只读**表 ✓ 有缓存 ✓
    //   🔴 读不到 ⇒ **如实**（503 + 人话）⇒ 前端**不进录入** ✗ 绝不拿配置默认列表兜底 ✗
    try {
      const service = options.paymentMethods
        || createPaymentMethodsService(options.gateway || new V1BitableGateway(), {});
      const listed = await service.list();
      if (!listed?.ok) {
        logError('workbench.sales.payment_methods.unreadable', { request_id: req.requestId, reason: listed?.reason || '' });
        return res.status(503).json({ success: false, error: accessoryTab.texts.methodsFailed });
      }
      return res.json({ success: true, methods: listed.items || [] });
    } catch (error) {
      logError('workbench.sales.payment_methods.failed', { request_id: req.requestId, error: error.message });
      return res.status(503).json({ success: false, error: accessoryTab.texts.methodsFailed });
    }
  });
  router.get(accessoryTab.api.list, async (req, res) => {
    try {
      const accessories = (await scanWrite.listAccessories()) || [];
      return res.json({ success: true, accessories });
    } catch (error) {
      logError('workbench.sales.accessories.failed', { request_id: req.requestId, error: error.message });
      return res.status(400).json({ success: false, error: accessoryTab.texts.listFailed });
    }
  });
  router.post(accessoryTab.api.submit, async (req, res) => {
    try {
      const openId = req.workbenchUser?.open_id;
      const requestId = req.body?.requestId || req.requestId;
      const amountText = String(req.body?.[accessoryTab.fields.amount] ?? '').trim();
      const amount = Number(amountText);
      // ⭐ 成交金额**必填**（她 2026-10-14）⇒ 空 / 非正数 ⇒ 当场 400 + 人话，**一行都不写** ✗
      if (!amountText || !Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ success: false, error: accessoryTab.texts.amountRequired });
      }
      const line = await scanWrite.addSaleLine({
        openId, requestId, kind: 'accessory',
        accessoryRecordId: req.body?.[accessoryTab.fields.accessoryId],
        amount: amountText,
        // ⭐ 2026-10-14 她：「并且配品都是默认的现货」⇒ 默认现货来自**可售品配置**（不散写 if ✗）
        inStock: sellableKindOf({ kind: 'accessory' }).defaultInStock === true,
      });
      if (!line?.ok) return res.status(400).json({ success: false, error: line?.message || accessoryTab.texts.submitFailed });
      const result = await scanWrite.submitSale({
        openId, requestId,
        // 🔴 **同一把 `submitKey`**（幂等不许拆 ✗）：连点两次 / 重试都走这一个键 ✓
        submitKey: req.body?.[accessoryTab.fields.submitKey],
        // ⭐ 2026-10-14 她：「配品收款方式读『收款方式管理』表」⇒ 那一行的收款方式 = **她选的那条** ✓
        //   （选项清单由 `paymentMethodsService`（PR #538）供；未合前若没传 ⇒ 沿用配置默认 ✓ 不猜 ✗）
        payments: [{
          method: String(req.body?.[accessoryTab.fields.method] || '').trim() || SCAN_WRITE.sale.defaultPaymentMethod,
          amount: amountText,
        }],
        paymentStatus: SCAN_WRITE.sale.paymentStatus.full,
        paidAmount: amountText,
      });
      if (!result?.ok) return res.status(400).json({ success: false, error: result?.message || accessoryTab.texts.submitFailed });
      ordersCache.invalidate();
      return res.json({ success: true, order_no: result.order_no || '', reused: result.reused === true });
    } catch (error) {
      logError('workbench.sales.accessory.failed', { request_id: req.requestId, error: error.message });
      return res.status(400).json({ success: false, error: error.message });
    }
  });
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
