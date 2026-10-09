/**
 * 工作台【订单列表】的单条操作 —— 写入口（业务负责人 2026-10-09）。
 *
 *   POST /api/workbench/sales/after-sales      售后：退 / 换 / 赔
 *   POST /api/workbench/sales/second-delivery  二次交付（收尾款 + 交付）
 *
 * ⚠️ 另两条写入口**本来就在** `routes/workbench.js` 里，本次一个字没动：
 *   · `POST /api/workbench/sales/payments`    补收款
 *   · `POST /api/workbench/sales/deliveries`  交付
 *
 * 🔴 鉴权**不新开一套**：本路由挂在 `createWorkbenchRouter` 内部，于是自动带上
 *    **既有**的 `requireWorkbenchAccess`（未启用认证 503 / 未登录 401 / 白名单外 403）。
 * 🔴 失败口径与 `workbenchInventoryAdjustment.js` 同一套：她填错的（statusCode=400）→ 400，
 *    业务拒绝 → 502，**两种都把原因原样回到页面**（页面上看得见原因，不许静默）。
 * 🔴 这里**没有任何写库逻辑** —— 全部交 `WorkbenchOrderActionService` → 既有业务处理层。
 */
const express = require('express');
const { WorkbenchOrderActionService } = require('../services/workbenchOrderActionService');
const { logError } = require('../utils/logger');

const createWorkbenchOrderActionsRouter = (options = {}) => {
  const router = express.Router();
  // 默认依赖**延迟构建**：只想注入一个桩的调用方（测试）不必先配好飞书凭证。
  let service = options.service || null;
  const resolveService = () => {
    if (!service) service = new WorkbenchOrderActionService({ gateway: options.gateway });
    return service;
  };

  const handle = (event, fallback, work) => async (req, res) => {
    try {
      return res.json({ success: true, ...await work(req) });
    } catch (error) {
      logError(event, { request_id: req.requestId, error: error.message });
      // 503 只给"整条动作被开关关掉"这一种（她在页面上会看见那句人话）。
      const status = error?.statusCode === 400 ? 400 : error?.statusCode === 503 ? 503 : 502;
      return res.status(status).json({ success: false, error: error.message || fallback });
    }
  };

  router.post('/sales/after-sales', handle(
    'workbench.orders.after_sales.failed', '售后没做成',
    (req) => resolveService().afterSales({
      ...req.body, operatorOpenId: req.workbenchUser?.open_id,
    }),
  ));

  router.post('/sales/second-delivery', handle(
    'workbench.orders.second_delivery.failed', '二次交付没做成',
    (req) => resolveService().secondDelivery({
      ...req.body, operatorOpenId: req.workbenchUser?.open_id,
    }),
  ));

  return router;
};

module.exports = { createWorkbenchOrderActionsRouter };
