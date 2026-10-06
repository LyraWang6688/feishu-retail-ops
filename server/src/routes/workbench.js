const express = require('express');
const controller = require('../controllers/workbenchController');
const { enabled: feishuAuthEnabled, getSessionUser, allowedOpenIds } = require('./feishuWebAuth');
const { SalesFollowupService } = require('../services/salesFollowupService');
const { V1BitableGateway } = require('../services/v1BitableGateway');
const { createPurchaseQueryRouter } = require('./purchaseQuery');
const { createInventoryAdjustmentRouter } = require('./workbenchInventoryAdjustment');
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
  router.get('/sales/today', controller.queryTodaySales);
  // 「销售查询」：支持 date（按某日）与 from/to（按区间）；/sales/today 保持不变。
  router.get('/sales/query', controller.querySales);
  // 货品选择器 / 库存数量 / 品类清单 —— 都只读，供「库存手工调整」两个子页用。
  router.get('/inventory/products', controller.queryInventoryProducts);
  router.get('/inventory/stock', controller.queryInventoryStock);
  router.get('/inventory/categories', controller.queryInventoryCategories);
  router.get('/inventory', controller.queryInventory);
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
