const express = require('express');
const controller = require('../controllers/workbenchController');
const { enabled: feishuAuthEnabled, getSessionUser, allowedOpenIds } = require('./feishuWebAuth');
const { SalesFollowupService } = require('../services/salesFollowupService');
const { logError } = require('../utils/logger');

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
  router.get('/sales/today', controller.queryTodaySales);
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
        state: req.body?.state,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      logError('workbench.sales.delivery.failed', { request_id: req.requestId, error: error.message });
      return res.status(400).json({ success: false, error: error.message });
    }
  });
  return router;
};

module.exports = { createWorkbenchRouter };
