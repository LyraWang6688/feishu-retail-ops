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
        // 行为编码精确筛选：PURCHASE_ORDER（报货）/ PURCHASE_RETURN（退货）。
        behaviorCode: req.query.behaviorCode ? String(req.query.behaviorCode) : undefined,
      });
      return res.json({ success: true, rows, total: rows.length });
    } catch (error) {
      logError('workbench.purchase.requests.failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: error.message });
    }
  });

  return router;
};

module.exports = { createPurchaseQueryRouter };
