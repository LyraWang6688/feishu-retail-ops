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
const { createAsyncJobService } = require('../services/asyncJobService');
const { ASYNC_JOB_TYPES } = require('../config/asyncJobs');
const { PAIR_ADJUSTMENT_TEXTS } = require('../config/inventoryPairAdjustment');

const userError = (message) => Object.assign(new Error(message), { statusCode: 400 });
const { logError } = require('../utils/logger');

const createInventoryAdjustmentRouter = (options = {}) => {
  const router = express.Router();
  // 默认依赖**延迟构建**：传了 service（或 inventory）就不要再去 new 一个网关 ——
  // 否则"只想注入一个桩"的调用方（测试、以及将来别的入口）会被迫先配好飞书凭证。
  let pairAdjustment = options.pairService || null;
  let asyncJobs = options.asyncJobs || null;
  const resolveInventory = () => options.inventory || new InventoryService({ gateway: options.gateway || new V1BitableGateway() });
  const resolveAsyncJobs = () => {
    if (!asyncJobs) asyncJobs = createAsyncJobService();
    return asyncJobs;
  };
  const resolvePairAdjustment = () => {
    if (!pairAdjustment) pairAdjustment = new InventoryPairAdjustmentService({ inventory: resolveInventory() });
    return pairAdjustment;
  };

  router.post('/pairs', async (req, res) => {
    try {
      const rows = normalizeRows(req.body?.rows);
      const requestId = String(req.body?.requestId || '').trim();
      if (!req.body?.productRecordId || !requestId) throw userError('缺少货品或请求编号');
      const jobs = resolveAsyncJobs();
      const jobId = jobs.jobIdFor(ASYNC_JOB_TYPES.INVENTORY_ADJUSTMENT, `pairs:${requestId}`);
      await jobs.enqueue({ jobId, type: ASYNC_JOB_TYPES.INVENTORY_ADJUSTMENT,
        ownerOpenId: req.workbenchUser?.open_id || '', operatorName: req.workbenchUser?.name || '' });
      void jobs.run({ jobId, run: () => resolvePairAdjustment().adjustPairs({
        productRecordId: req.body?.productRecordId, rows, requestId,
        operatorOpenId: req.workbenchUser?.open_id,
      }) }).catch(() => {});
      return res.status(202).json({ success: true, queued: true, job_id: jobId });
    } catch (error) {
      const status = error?.statusCode === 400 ? 400 : 502;
      return res.status(status).json({ success: false, error: error.message || PAIR_ADJUSTMENT_TEXTS.pairFailed });
    }
  });

  router.post('/season-flag', async (req, res) => {
    try {
      const category = String(req.body?.category || '').trim();
      const season = req.body?.season;
      const requestId = String(req.body?.requestId || '').trim();
      if (!category || typeof season !== 'boolean' || !requestId) throw userError('品类 / 当季 / 请求编号不完整');
      const jobs = resolveAsyncJobs();
      const jobId = jobs.jobIdFor(ASYNC_JOB_TYPES.INVENTORY_ADJUSTMENT, `season:${requestId}`);
      await jobs.enqueue({ jobId, type: ASYNC_JOB_TYPES.INVENTORY_ADJUSTMENT,
        ownerOpenId: req.workbenchUser?.open_id || '', operatorName: req.workbenchUser?.name || '' });
      void jobs.run({ jobId, run: () => resolvePairAdjustment().setSeason({ category, season }) }).catch(() => {});
      return res.status(202).json({ success: true, queued: true, job_id: jobId });
    } catch (error) {
      const status = error?.statusCode === 400 ? 400 : 502;
      return res.status(status).json({ success: false, error: error.message || PAIR_ADJUSTMENT_TEXTS.seasonFlagFailed });
    }
  });

  return router;
};

module.exports = { createInventoryAdjustmentRouter };
