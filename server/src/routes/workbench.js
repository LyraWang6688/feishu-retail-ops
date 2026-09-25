const express = require('express');
const controller = require('../controllers/workbenchController');
const { enabled: feishuAuthEnabled, getSessionUser, allowedOpenIds } = require('./feishuWebAuth');

const requireWorkbenchAccess = (req, res, next) => {
  if (!feishuAuthEnabled()) return res.status(503).json({ success: false, error: '飞书身份认证尚未启用' });
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ success: false, error: '请先通过飞书身份登录工作台', auth_required: true });
  const allowed = allowedOpenIds();
  if (allowed.size && !allowed.has(user.open_id)) return res.status(403).json({ success: false, error: '当前飞书账号未被授权使用工作台' });
  req.workbenchUser = user;
  return next();
};

const createWorkbenchRouter = () => {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
  });
  router.use(requireWorkbenchAccess);
  router.get('/sales/today', controller.queryTodaySales);
  router.get('/inventory', controller.queryInventory);
  return router;
};

module.exports = { createWorkbenchRouter };
