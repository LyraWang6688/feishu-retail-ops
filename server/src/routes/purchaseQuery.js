const express = require('express');
const { createPurchaseQueryService } = require('../services/purchaseQueryService');
const { logError } = require('../utils/logger');

const createPurchaseQueryRouter = (options = {}) => {
  const router = express.Router();
  const service = options.service || createPurchaseQueryService(options.gateway);

  router.get('/requests', async (req, res) => {
    try {
      const rows = await service.listPurchaseRequests({
        batchNo: req.query.batchNo ? String(req.query.batchNo) : undefined,
        // 'purchase_request'（采购申请）/ 'purchase_return'（采购退货）—— 工作台
        // 「采购退货」子页用它把同一张「报货信息」表分成两栏。
        reportBehavior: req.query.reportBehavior ? String(req.query.reportBehavior) : undefined,
      });
      return res.json({ success: true, rows, total: rows.length });
    } catch (error) {
      logError('workbench.purchase.requests.failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: error.message });
    }
  });

  // ⭐ 2026-11-09（业务负责人）：验收页第一层固定展示「供应商管理」里的全部供应商。
  //   只读；走 `purchaseQueryService.listSuppliers` → 统一配置表缓存（supplier）。
  router.get('/suppliers', async (req, res) => {
    try {
      const rows = await service.listSuppliers();
      return res.json({ success: true, rows, total: rows.length });
    } catch (error) {
      logError('workbench.purchase.suppliers.failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: error.message });
    }
  });

  return router;
};

module.exports = { createPurchaseQueryRouter };
