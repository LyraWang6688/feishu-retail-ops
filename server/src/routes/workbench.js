const express = require('express');
const controller = require('../controllers/workbenchController');
const { enabled: feishuAuthEnabled, getSessionUser, allowedOpenIds } = require('./feishuWebAuth');
const { SalesFollowupService } = require('../services/salesFollowupService');
const { V1BitableGateway } = require('../services/v1BitableGateway');
const { createPurchaseQueryRouter } = require('./purchaseQuery');
const { createInventoryAdjustmentRouter } = require('./workbenchInventoryAdjustment');
const { createLabelPrintService } = require('../services/labelPrintService');
const { SampleReplacementService } = require('../services/sampleReplacementService');
const { logError, logWarn } = require('../utils/logger');

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

module.exports = { createWorkbenchRouter };
