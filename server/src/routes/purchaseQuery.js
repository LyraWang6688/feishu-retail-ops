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
        // 'purchase_request'（采购申请）/ 'purchase_return'（采购退货）—— 工作台
        // 「采购退货」子页用它把同一张「单据信息」表分成两栏。
        reportBehavior: req.query.reportBehavior ? String(req.query.reportBehavior) : undefined,
      });
      return res.json({ success: true, rows, total: rows.length });
    } catch (error) {
      logError('workbench.purchase.requests.failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: error.message });
    }
  });

  router.get('/arrivals', async (req, res) => {
    try {
      // ⚠️ 原先还接受 recognitionStatus 过滤。识别状态字段已从生产表删除、
      // 识别链路整体退场，这个过滤条件永远命中不了任何东西，所以摘掉。
      const rows = await service.listPurchaseArrivals({
        batchNo: req.query.batchNo ? String(req.query.batchNo) : undefined,
        confirmStatus: req.query.confirmStatus ? String(req.query.confirmStatus) : undefined,
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
