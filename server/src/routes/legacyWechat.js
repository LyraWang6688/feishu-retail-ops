const express = require('express');

// Frozen legacy boundary. Feishu modules must never import this router.
// Disable ENABLE_LEGACY_WECHAT before eventually deleting this file and
// miniprogram/ as one isolated unit.
const createLegacyWechatRouter = () => {
  const router = express.Router();
  router.use('/recognition', require('./recognition'));
  router.use('/sync', require('./sync'));
  router.use('/query', require('./query'));
  router.use('/analytics', require('./analytics'));
  router.use('/sales/tasks', require('./salesTasks'));
  return router;
};

module.exports = { createLegacyWechatRouter };
