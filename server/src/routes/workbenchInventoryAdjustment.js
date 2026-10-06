/**
 * 人工库存调整的 HTTP 入口（工作台「常用功能 → 库存手工调整」）。
 *
 *   POST /api/workbench/inventory/adjustments/count   盘点调整（改数量，可增可减）
 *   POST /api/workbench/inventory/adjustments/season  换季调整（改状态，数量不变）
 *
 * 挂载点在工作台路由内部（`createWorkbenchRouter`），所以**自动带上了飞书身份闸门**
 * （requireWorkbenchAccess）——这两个接口是**真写库存**的，绝不能匿名可调。
 */
const express = require('express');
const { V1BitableGateway } = require('../services/v1BitableGateway');
const { InventoryService } = require('../services/inventoryService');
const { InventoryAdjustmentService } = require('../services/inventoryAdjustmentService');
const { logError } = require('../utils/logger');

const createInventoryAdjustmentRouter = (options = {}) => {
  const router = express.Router();
  // 默认依赖**延迟构建**：传了 service（或 inventory）就不要再去 new 一个网关 ——
  // 否则"只想注入一个桩"的调用方（测试、以及将来别的入口）会被迫先配好飞书凭证。
  let adjustment = options.service || null;
  const resolveAdjustment = () => {
    if (!adjustment) {
      const inventory = options.inventory
        || new InventoryService({ gateway: options.gateway || new V1BitableGateway() });
      adjustment = new InventoryAdjustmentService({ inventory });
    }
    return adjustment;
  };

  const handle = (event, fallback, work) => async (req, res) => {
    try {
      return res.json({ success: true, ...await work(req) });
    } catch (error) {
      logError(event, { request_id: req.requestId, error: error.message });
      // 她填错的（statusCode=400）原样回显；其余是她要能看懂的业务拒绝
      //（例如"仓库只有 2 双、你要拿出 3 双"），也用 message，但标成 502。
      const status = error?.statusCode === 400 ? 400 : 502;
      return res.status(status).json({ success: false, error: error.message || fallback });
    }
  };

  router.post('/count', handle('workbench.inventory.adjustment.count_failed', '盘点调整失败', (req) =>
    resolveAdjustment().adjustCount({
      productRecordId: req.body?.productRecordId,
      size: req.body?.size,
      state: req.body?.state,
      mode: req.body?.mode,
      delta: req.body?.delta,
      countedQuantity: req.body?.countedQuantity,
      requestId: req.body?.requestId,
      // 「库存流水」还没有「操作人」列，所以这个 open_id 只进本地任务与结构化日志
      //（可回答"谁调的"）；表里加了列之后再补远端写入。
      operatorOpenId: req.workbenchUser?.open_id,
    })));

  router.post('/season', handle('workbench.inventory.adjustment.season_failed', '换季调整失败', (req) =>
    resolveAdjustment().adjustSeason({
      action: req.body?.action,
      targets: req.body?.targets,
      toState: req.body?.toState,
      requestId: req.body?.requestId,
      operatorOpenId: req.workbenchUser?.open_id,
    })));

  return router;
};

module.exports = { createInventoryAdjustmentRouter };
