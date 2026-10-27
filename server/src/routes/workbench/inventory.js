'use strict';

/**
 * 工作台「库存」只读 + 调整路由（从 routes/workbench.js 拆出，行为不变）。
 * 鉴权仍由 workbench.js 的父 router 统一加。
 */
const express = require('express');
const controller = require('../../controllers/workbenchController');
const { createInventoryAdjustmentRouter } = require('../workbenchInventoryAdjustment');

const createWorkbenchInventoryRoutes = (options = {}) => {
  const router = express.Router();
  router.use('/inventory/adjustments', createInventoryAdjustmentRouter(options.inventoryAdjustment || {}));
  router.get('/inventory/products', controller.queryInventoryProducts);
  router.get('/inventory/stock', controller.queryInventoryStock);
  router.get('/inventory/categories', controller.queryInventoryCategories);
  router.get('/inventory', controller.queryInventory);
  return router;
};

module.exports = { createWorkbenchInventoryRoutes };
