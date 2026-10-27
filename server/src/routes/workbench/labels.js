'use strict';

/**
 * 工作台「货品 / 标签打印」路由（从 routes/workbench.js 拆出，行为不变）。
 * 鉴权、no-store、ui-tap 仍由 workbench.js 的父 router 统一加；本 router 只挂业务端点。
 */
const express = require('express');
const controller = require('../../controllers/workbenchController');
const { V1BitableGateway } = require('../../services/v1BitableGateway');
const { createLabelPrintService } = require('../../services/labelPrintService');
const { QUERY_FAILED_FALLBACK } = require('../../config/labelPrint');
const { logInfo } = require('../../utils/logger');

const createWorkbenchLabelRoutes = (options = {}) => {
  const router = express.Router();
  const labelPrint = options.labelPrint || createLabelPrintService(options.gateway || new V1BitableGateway());

  router.get('/labels', async (req, res) => {
    try {
      const result = await labelPrint.listLabels({
        keyword: req.query.keyword,
        state: req.query.state,
        category: req.query.category,
        size: req.query.size,
        recentDays: req.query.recentDays,
        sort: req.query.sort,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      return controller.respondQueryFailure(res, error, {
        requestId: req.requestId, event: 'workbench.labels.failed', fallback: QUERY_FAILED_FALLBACK,
      });
    }
  });

  router.get('/products/numbers', async (req, res) => {
    try {
      const result = await labelPrint.listProductNumbers({
        keyword: req.query.keyword,
        limit: req.query.limit,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      return controller.respondQueryFailure(res, error, {
        requestId: req.requestId, event: 'workbench.products.numbers.failed', fallback: QUERY_FAILED_FALLBACK,
      });
    }
  });

  router.post('/labels/scan-report', (req, res) => {
    const body = req.body || {};
    logInfo('label_print.scan.report', {
      request_id: req.requestId,
      ok: body.ok === true,
      phase: String(body.phase || '').slice(0, 32),
      reason: String(body.reason || '').slice(0, 64),
      err_msg: String(body.err_msg || '').slice(0, 200),
      raw: String(body.raw || '').slice(0, 300),
      url: String(body.url || '').slice(0, 300),
    });
    return res.json({ success: true });
  });

  return router;
};

module.exports = { createWorkbenchLabelRoutes };
