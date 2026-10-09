const express = require('express');
const controller = require('../controllers/workbenchController');
// 准入闸门（未启用认证 503 / 未登录 401 / 白名单外 403）：**工作台与扫码页共用这一份**。
// 它留在本文件里（没有搬去 middleware/）—— 既有哨兵用例
// （`test/workbenchTwoTabsAndQueryEntries.test.js` 的 AC9/AC10）钉着这里必须看得见
// `require('./feishuWebAuth')`，而"扫码页也走同一道闸门"只要求**共用同一个函数**，
// 不需要搬家。扫码路由 `routes/scanPage.js` 从这里 require 它。
const { enabled: feishuAuthEnabled, getSessionUser, allowedOpenIds } = require('./feishuWebAuth');
const { SalesFollowupService } = require('../services/salesFollowupService');
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
const { logError, logWarn } = require('../utils/logger');

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
  const followup = options.followup || new SalesFollowupService();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
  });
  router.use(requireWorkbenchAccess);
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
  router.post('/sales/payments', async (req, res) => {
    try {
      const result = await followup.addPayment({
        salesEntryRecordId: req.body?.salesEntryRecordId,
        method: req.body?.method, amount: req.body?.amount,
        requestId: req.body?.requestId, operatorOpenId: req.workbenchUser.open_id,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      logError('workbench.sales.payment.failed', { request_id: req.requestId, error: error.message });
      return res.status(400).json({ success: false, error: error.message });
    }
  });
  router.post('/sales/deliveries', async (req, res) => {
    try {
      const result = await followup.delivery.deliver({
        salesEntryRecordId: req.body?.salesEntryRecordId,
        detailRecordIds: req.body?.detailRecordIds,
      });
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
