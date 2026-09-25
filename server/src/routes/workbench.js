const express = require('express');
const crypto = require('node:crypto');
const { logWarn } = require('../utils/logger');
const controller = require('../controllers/workbenchController');
const { enabled: feishuAuthEnabled, getSessionUser, allowedOpenIds } = require('./feishuWebAuth');

const sameSecret = (provided, expected) => {
  const left = Buffer.from(String(provided || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

const requireWorkbenchAccess = (req, res, next) => {
  if (feishuAuthEnabled()) {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ success: false, error: '请先通过飞书身份登录工作台', auth_required: true });
    const allowed = allowedOpenIds();
    if (allowed.size && !allowed.has(user.open_id)) return res.status(403).json({ success: false, error: '当前飞书账号未被授权使用工作台' });
    req.workbenchUser = user;
    return next();
  }
  const expected = process.env.WORKBENCH_ACCESS_TOKEN;
  if (!expected) {
    if (process.env.NODE_ENV === 'production') return res.status(500).json({ success: false, error: '工作台访问令牌未配置' });
    return next();
  }
  const provided = req.get('x-workbench-token');
  if (!provided || !sameSecret(provided, expected)) {
    logWarn('workbench.auth.rejected', { request_id: req.requestId, path: req.path });
    return res.status(401).json({ success: false, error: '工作台访问令牌无效' });
  }
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
