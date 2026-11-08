'use strict';

const express = require('express');
const { logInfo } = require('../../utils/logger');

/**
 * 工作台「货品 / 标签打印」路由（从 routes/workbench.js 拆出，行为不变）。
 * 鉴权、no-store、ui-tap 仍由 workbench.js 的父 router 统一加；本 router 只挂业务端点。
 *
 * 🔴 2026-11-09（业务负责人）：「选择编号打印」那个页面也不要了（「点击批量打印的时候，
 *   只选择一个就可以了」）⇒ 两个只读查询端点**物理删除**：
 *     · `GET /api/workbench/labels`（单品页的标签列表）
 *     · `GET /api/workbench/products/numbers`（旧的编号选择器候选）
 *   只保留扫码打印的**只读上报**端点（它不写业务表，只写日志）。
 */
const createWorkbenchLabelRoutes = () => {
  const router = express.Router();

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
