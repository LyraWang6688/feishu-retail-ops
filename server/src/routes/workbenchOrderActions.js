/**
 * 工作台【订单列表】的单条操作 —— 写入口（业务负责人 2026-10-09）。
 *
 *   POST /api/workbench/sales/after-sales      售后：退 / 换 / 赔
 *   POST /api/workbench/sales/second-delivery  二次交付（收尾款 + 交付）
 *
 * ⭐ 2026-10-29：另加一条**只读**入口给「售后扫一扫落地页」——
 *   GET  /api/workbench/sales/after-sales/scan-candidates
 *   为什么放这里：落地页要摆「销售日 + 销售主表总金额」，而既有候选接口
 *   （`salesFollowupService.listAfterSalesCandidates`，订单列表那条读路径）**没有读这两列**；
 *   那个 service 属于另一条任务的作用域（本分支不改它）。
 *   ⇒ 这一条走**独立的只读取数**（`services/afterSalesScanService.js`）：不写库、不改任何既有接口。
 *
 * 🔴 鉴权**不新开一套**：本路由挂在 `createWorkbenchRouter` 内部，于是自动带上
 *    **既有**的 `requireWorkbenchAccess`（未启用认证 503 / 未登录 401 / 白名单外 403）。
 * 🔴 失败口径与 `workbenchInventoryAdjustment.js` 同一套：她填错的（statusCode=400）→ 400，
 *    业务拒绝 → 502，**两种都把原因原样回到页面**（页面上看得见原因，不许静默）。
 * 🔴 这里**没有任何写库逻辑** —— 全部交 `WorkbenchOrderActionService` → 既有业务处理层。
 */
const express = require('express');
const { WorkbenchOrderActionService } = require('../services/workbenchOrderActionService');
const { AfterSalesScanService } = require('../services/afterSalesScanService');
const { tapIdFromRequest } = require('../utils/correlationFields');
const { logError } = require('../utils/logger');

/**
 * ⭐ 2026-10-12：**写库成功之后要作废订单列表的缓存**（TTL 缓存见 `services/workbenchOrdersCache.js`）。
 * ⚠️ 缓存层不认业务，**路由层才认**"这是一笔写" ⇒ 失效动作放在这里。
 *    `options.ordersCache` 由 `routes/workbench.js` 传同一个实例进来（不新开一份）。
 */
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
      const result = await work(req);
      // ⭐ 写成功了才作废缓存（失败 / 被拒的那几次一个字节都没写，不该影响缓存）。
      options.ordersCache?.invalidate();
      return res.json({ success: true, ...result });
    } catch (error) {
      logError(event, { request_id: req.requestId, error: error.message });
      // 503 只给"整条动作被开关关掉"这一种（她在页面上会看见那句人话）。
      const status = error?.statusCode === 400 ? 400 : error?.statusCode === 503 ? 503 : 502;
      return res.status(status).json({ success: false, error: error.message || fallback });
    }
  };

  router.post('/sales/after-sales', handle(
    'workbench.orders.after_sales.failed', '售后没做成',
    // ⭐ 2026-10-15（task-48 b）：关联键走**尾部可选参数**（既有约定 ✓）——
    //    ⚠️ **不塞进入参**：入参形状逐字不变 ⇒ 既有 AC6 那条 deepEqual 一行都不用改 ✓
    (req) => resolveService().afterSales(
      { ...req.body, operatorOpenId: req.workbenchUser?.open_id },
      { correlation: tapIdFromRequest(req) },
    ),
  ));

  router.post('/sales/second-delivery', handle(
    'workbench.orders.second_delivery.failed', '二次交付没做成',
    // ⭐ 2026-10-15（task-48 b）：同上 —— 尾部可选参数，**不动入参形状** ✓
    (req) => resolveService().secondDelivery(
      { ...req.body, operatorOpenId: req.workbenchUser?.open_id },
      { correlation: tapIdFromRequest(req) },
    ),
  ));

  // ⭐⭐⭐ 2026-10-29：售后**扫一扫落地页**的只读候选（不写库、不作废缓存 —— 它什么都没改）。
  //   入参：`productRecordId`（二维码里的货品记录 id）+ `days`（默认 7，配置里封顶）。
  //   出错口径与上面两条写入口一致：她那边的问题（缺参数 / 货品不存在）→ 400，读库失败 → 502；
  //   **两种都把原因原样回页面**（页面上看得见原因，不许静默）。
  //   ⚠️ 事件名复用既有的 `workbench.sales.after_sales.candidates.failed`（同一件事：售后候选读失败），
  //      不新造事件（新事件要进 `config/events.js`，那是另一条任务的作用域）。
  let scanService = options.scanService || null;
  const resolveScanService = () => {
    if (!scanService) scanService = new AfterSalesScanService({ gateway: options.gateway });
    return scanService;
  };
  router.get('/sales/after-sales/scan-candidates', async (req, res) => {
    try {
      const result = await resolveScanService().listCandidates({
        productRecordId: req.query?.productRecordId || req.query?.product_record_id,
        days: req.query?.days,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      logError('workbench.sales.after_sales.candidates.failed', {
        request_id: req.requestId,
        product_record_id: req.query?.productRecordId || req.query?.product_record_id || '',
        error: error.message,
      });
      return res.status(error?.statusCode === 400 ? 400 : 502)
        .json({ success: false, error: error.message });
    }
  });

  return router;
};

module.exports = { createWorkbenchOrderActionsRouter };
