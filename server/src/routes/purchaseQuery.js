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
        arrivalStatus: req.query.arrivalStatus ? String(req.query.arrivalStatus) : undefined,
      });
      return res.json({ success: true, rows, total: rows.length });
    } catch (error) {
      logError('workbench.purchase.requests.failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: error.message });
    }
  });

  router.get('/arrivals', async (req, res) => {
    try {
      const rows = await service.listPurchaseArrivals({
        batchNo: req.query.batchNo ? String(req.query.batchNo) : undefined,
        confirmStatus: req.query.confirmStatus ? String(req.query.confirmStatus) : undefined,
        recognitionStatus: req.query.recognitionStatus ? String(req.query.recognitionStatus) : undefined,
      });
      return res.json({ success: true, rows, total: rows.length });
    } catch (error) {
      logError('workbench.purchase.arrivals.failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: error.message });
    }
  });

  return router;
};

module.exports = { createPurchaseQueryRouter };
