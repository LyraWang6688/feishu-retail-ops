/**
 * 人工库存调整的 HTTP 入口（工作台「常用功能 → 库存手工调整」）。
 *
 *   POST /api/workbench/inventory/adjustments/pairs   单双调整（按 尺码 + 状态 保存）
 *
 * 挂载点在工作台路由内部（`createWorkbenchRouter`），所以**自动带上了飞书身份闸门**
 * （requireWorkbenchAccess）——这两个接口是**真写库存**的，绝不能匿名可调。
 */
const express = require('express');
const { V1BitableGateway } = require('../services/v1BitableGateway');
const { InventoryService } = require('../services/inventoryService');
const { InventoryPairAdjustmentService, normalizeRows } = require('../services/inventoryPairAdjustmentService');
const { createSeasonAdjustmentService } = require('../services/seasonAdjustmentService');
const { createAsyncJobService } = require('../services/asyncJobService');
const { ASYNC_JOB_TYPES, ASYNC_JOB_STATUS } = require('../config/asyncJobs');
const { PAIR_ADJUSTMENT_TEXTS } = require('../config/inventoryPairAdjustment');
const { getInventoryPrintIntentService } = require('../services/inventoryPrintIntentRuntime');
const { STOCK_DELIST } = require('../config/stockDelist');
const { getStockDelistIntentService } = require('../services/stockDelistIntentRuntime');
const { logWarn } = require('../utils/logger');

const userError = (message) => Object.assign(new Error(message), { statusCode: 400 });

const createInventoryAdjustmentRouter = (options = {}) => {
  const router = express.Router();
  // 默认依赖**延迟构建**：传了 service（或 inventory）就不要再去 new 一个网关 ——
  // 否则"只想注入一个桩"的调用方（测试、以及将来别的入口）会被迫先配好飞书凭证。
  let pairAdjustment = options.pairService || null;
  let seasonAdjustment = options.seasonAdjustment || null;
  let asyncJobs = options.asyncJobs || null;
  const stockDelist = () => options.stockDelist || getStockDelistIntentService();
  const resolveInventory = () => options.inventory || new InventoryService({ gateway: options.gateway || new V1BitableGateway() });
  const resolveAsyncJobs = () => {
    if (!asyncJobs) asyncJobs = createAsyncJobService();
    return asyncJobs;
  };
  const resolvePairAdjustment = () => {
    if (!pairAdjustment) pairAdjustment = new InventoryPairAdjustmentService({ inventory: resolveInventory() });
    return pairAdjustment;
  };
  const resolveSeasonAdjustment = () => {
    if (!seasonAdjustment) seasonAdjustment = createSeasonAdjustmentService({ inventory: resolveInventory() });
    return seasonAdjustment;
  };

  router.post('/pairs', async (req, res) => {
    try {
      // ⭐ 2026-11-15：整款清零是**显式**动作（clearAll:true + rows 必须为空）；
      //   不允许再用“一行 quantity=0”隐式清掉全部库存。
      const clearAll = req.body?.clearAll === true;
      const rows = clearAll ? [] : normalizeRows(req.body?.rows);
      const requestId = String(req.body?.requestId || '').trim();
      const delistProductIds = clearAll && STOCK_DELIST.prompts.inventoryClear
        ? [...new Set((Array.isArray(req.body?.delistProductIds) ? req.body.delistProductIds : [])
          .map((id) => String(id || '').trim()).filter(Boolean))]
        : [];
      if (!req.body?.productRecordId || !requestId) throw userError('缺少货品或请求编号');
      if (delistProductIds.length && !clearAll) throw userError('只有清零库存才能同时下架货品');
      const jobs = resolveAsyncJobs();
      const jobId = jobs.jobIdFor(ASYNC_JOB_TYPES.INVENTORY_ADJUSTMENT, `pairs:${requestId}`);
      await jobs.enqueue({ jobId, type: ASYNC_JOB_TYPES.INVENTORY_ADJUSTMENT,
        ownerOpenId: req.workbenchUser?.open_id || '', operatorName: req.workbenchUser?.name || '',
        // ⭐ #1210：打印意图成功补做要用它（按记录 ID 打这一款，不依赖前端拿到的编号）。
        payload: { productRecordId: req.body?.productRecordId || '', delistProductIds } });
      if (delistProductIds.length) {
        // 下架意图先挂到同一条库存任务；库存成功后才由 flush 执行。
        try {
          await stockDelist().request({
            jobId, ownerOpenId: req.workbenchUser?.open_id || '',
            productRecordIds: delistProductIds,
            expectedType: ASYNC_JOB_TYPES.INVENTORY_ADJUSTMENT,
          });
        } catch (error) {
          logWarn('stock.delist.intent.request_failed', {
            job_id: jobId, error: String(error?.message || error).slice(0, 300),
          });
        }
      }
      void jobs.run({
        jobId,
        run: () => resolvePairAdjustment().adjustPairs({
          productRecordId: req.body?.productRecordId, rows, clearAll, requestId,
          operatorOpenId: req.workbenchUser?.open_id,
        }),
        // 调整成功 = 业务结果（不是 async job 的 {ok} 形态）；不给分类器会被当成失败。
        classifyResult: () => ({ ok: true, retryable: false, message: '', code: '' }),
      }).then((job) => {
        // ⭐ #1210：她点过「打印」⇒ 库存成功了由**后端**建打印任务（页面关掉也不丢）。
        if (job?.status === ASYNC_JOB_STATUS.SUCCEEDED) {
          void getInventoryPrintIntentService().flush(jobId).catch(() => {});
          if (delistProductIds.length) {
            void stockDelist().flush(jobId).catch(() => {});
          }
        }
      }).catch(() => {});
      return res.status(202).json({ success: true, queued: true, job_id: jobId });
    } catch (error) {
      const status = error?.statusCode === 400 ? 400 : 502;
      return res.status(status).json({ success: false, error: error.message || PAIR_ADJUSTMENT_TEXTS.pairFailed });
    }
  });

  /**
   * ⭐ #1210：她点「打印」⇒ **一次**请求记下打印意图。
   *   · 库存 job 已成功 ⇒ 立即入队打印；
   *   · 还在跑 ⇒ 202（后端在 job 成功时补做，页面可以直接回工作台）。
   */
  router.post('/pairs/:jobId/print-intent', async (req, res) => {
    const jobId = String(req.params?.jobId || '').trim();
    if (!jobId) return res.status(400).json({ success: false, error: PAIR_ADJUSTMENT_TEXTS.printIntentMissingJob });
    try {
      const outcome = await getInventoryPrintIntentService().request({
        jobId, ownerOpenId: req.workbenchUser?.open_id || '',
      });
      if (!outcome?.ok) {
        if (outcome?.reason === 'job_failed') {
          return res.status(409).json({ success: false, error: PAIR_ADJUSTMENT_TEXTS.printIntentJobFailed });
        }
        return res.status(404).json({ success: false, error: PAIR_ADJUSTMENT_TEXTS.printIntentNotFound });
      }
      return res.status(outcome.deferred ? 202 : 200).json({ success: true, ...outcome });
    } catch (error) {
      logError('inventory.print.intent.request_failed', { job_id: jobId, error: error.message });
      return res.status(502).json({ success: false, error: PAIR_ADJUSTMENT_TEXTS.printIntentNotFound });
    }
  });

  router.post('/season-scan', async (req, res) => {
    try {
      const requestId = String(req.body?.requestId || '').trim();
      const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
      if (!requestId || !changes.length) throw userError('缺少请求编号或调整行');
      const jobs = resolveAsyncJobs();
      const jobId = jobs.jobIdFor(ASYNC_JOB_TYPES.INVENTORY_ADJUSTMENT, `season:scan:${requestId}`);
      await jobs.enqueue({ jobId, type: ASYNC_JOB_TYPES.INVENTORY_ADJUSTMENT,
        ownerOpenId: req.workbenchUser?.open_id || '', operatorName: req.workbenchUser?.name || '' });
      void jobs.run({
        jobId,
        run: () => resolveSeasonAdjustment().submit({
          requestId, changes, operatorOpenId: req.workbenchUser?.open_id,
        }),
        classifyResult: (result) => ({
          ok: result?.ok !== false,
          retryable: false,
          message: result?.code || '',
          code: result?.code || '',
        }),
      }).catch(() => {});
      return res.status(202).json({ success: true, queued: true, job_id: jobId });
    } catch (error) {
      const status = error?.statusCode === 400 ? 400 : 502;
      return res.status(status).json({ success: false, error: error.message || PAIR_ADJUSTMENT_TEXTS.seasonScanFailed });
    }
  });

  return router;
};

module.exports = { createInventoryAdjustmentRouter };
