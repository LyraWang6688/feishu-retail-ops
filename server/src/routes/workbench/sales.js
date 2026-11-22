'use strict';

/**
 * 工作台「销售」路由（从 `routes/workbench.js` 拆出）。
 * 鉴权、no-store、ui-tap 仍由 `workbench.js` 的父 router 统一加。
 *
 * ⭐ 2026-10-29（业务负责人定稿：销售订单列表只剩三条路径）：本文件只保留
 *   · 售后扫一扫候选（`GET /sales/after-sales/candidates`，独立售后页在用读侧的另一条 `scan-candidates`）；
 *   · 订单列表读（`GET /sales/orders`，三卡入口的首屏缓存仍在用）；
 *   · 两个 sub-router：订单动作（售后 / 扫一扫候选）/ 交割单独立页（`/sales/delivery*`）。
 * 🔴 已删（旧订单列表前端退场，连带无人调用的后端路由；**业务服务层保留**）：
 *   `POST /sales/payments` · `/sales/deliveries`（PR #923 删）· `/sales/sample-fill` ·
 *   `/sales/retry` · `/sales/detail-amounts`。`/sales/second-delivery` 在
 *   `routes/workbenchOrderActions.js` 里一并删除。
 */
const express = require('express');
const { createWorkbenchOrderActionsRouter } = require('../workbenchOrderActions');
const { createWorkbenchSalesDeliveryRoutes } = require('../workbenchSalesDelivery');
const { createSalesQueryService } = require('../../services/salesQueryService');
const { createSalesDailyCashService } = require('../../services/salesDailyCashService');
const { createSalesDailyCashAsyncService } = require('../../services/salesDailyCashAsyncService');
const { getAsyncJobService } = require('../../services/asyncJobRuntime');
const { logError } = require('../../utils/logger');

const createWorkbenchSalesRoutes = ({ options = {}, followup, ordersCache } = {}) => {
  const router = express.Router();
  // 订单动作（售后）与售后扫一扫候选：2026-10-28 第一阶段拆分时误删，现恢复。
  router.use(createWorkbenchOrderActionsRouter({
    gateway: options.gateway || followup.gateway,
    service: options.orderActions,
    ordersCache,
  }));
  // 交割单独立页（只读 + 异步交付/收款）；**不属于**旧订单列表，保留。
  router.use(createWorkbenchSalesDeliveryRoutes({ options, followup, ordersCache }));
  router.get('/sales/after-sales/candidates', async (req, res) => {
    try {
      const result = await followup.listAfterSalesCandidates({
        productRecordId: req.query.productRecordId || req.query.product_record_id,
        days: req.query.days,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      logError('workbench.sales.after_sales.candidates.failed', {
        request_id: req.requestId, error: error.message,
      });
      return res.status(error?.statusCode === 400 ? 400 : 502)
        .json({ success: false, error: error.message || 'after-sales candidates failed' });
    }
  });

  router.get('/sales/orders', async (req, res) => {
    try { return res.json({ success: true, ...await followup.listOrders() }); }
    catch (error) {
      logError('workbench.sales.orders.failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: error.message });
    }
  });

  let salesDailyCashAsyncInstance = null;
  const salesDailyCashAsync = () => {
    if (!salesDailyCashAsyncInstance) {
      salesDailyCashAsyncInstance = options.salesDailyCashAsync || createSalesDailyCashAsyncService({
        gateway: options.gateway || followup.gateway,
        asyncJobs: options.asyncJobs || getAsyncJobService(),
      });
    }
    return salesDailyCashAsyncInstance;
  };
  let salesDailyCashInstance = null;
  const salesDailyCash = () => {
    if (!salesDailyCashInstance) {
      salesDailyCashInstance = options.salesDailyCash || createSalesDailyCashService({
        gateway: options.gateway || followup.gateway,
      });
    }
    return salesDailyCashInstance;
  };
  router.get('/sales/daily-cash', async (req, res) => {
    try {
      return res.json({ success: true, ...await salesDailyCash().getToday() });
    } catch (error) {
      logError('workbench.sales.daily_cash.read_failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: 'sales_daily_cash_failed' });
    }
  });
  router.post('/sales/daily-cash', async (req, res) => {
    try {
      const accepted = await salesDailyCashAsync().submit({
        openingAmount: req.body?.openingAmount,
        withdrawalAmount: req.body?.withdrawalAmount,
        submitKey: req.body?.submitKey,
        operatorOpenId: req.workbenchUser?.open_id || '',
        operatorName: req.workbenchUser?.name || '',
        correlation: { request_id: req.requestId },
      });
      return res.status(202).json({
        success: true,
        accepted: true,
        reused: accepted.reused === true,
        job_id: accepted.jobId,
        toast: accepted.toast,
        redirect_url: accepted.redirect_url || '',
      });
    } catch (error) {
      const status = error?.statusCode === 400 ? 400 : 502;
      logError('workbench.sales.daily_cash.save_failed', {
        request_id: req.requestId, error: error.message,
      });
      return res.status(status).json({ success: false, error: error.message || 'sales_daily_cash_failed' });
    }
  });

  let salesQueryInstance = null;
  const salesQuery = () => {
    if (!salesQueryInstance) salesQueryInstance = createSalesQueryService({
      gateway: options.gateway || followup.gateway,
    });
    return salesQueryInstance;
  };
  router.get('/sales/query', async (req, res) => {
    try {
      return res.json({ success: true, ...await salesQuery().getSalesQuery({
        from: req.query.from, to: req.query.to, product: req.query.product,
      }) });
    } catch (error) {
      logError('workbench.sales.query.failed', { request_id: req.requestId, error: error.message });
      return res.status(error?.statusCode === 400 ? 400 : 502)
        .json({ success: false, error: error.message || 'sales query failed' });
    }
  });

  return router;
};

module.exports = { createWorkbenchSalesRoutes };
