'use strict';

/**
 * 工作台「异步任务状态」只读接口（#948 第 7 节）。
 *
 *   GET /api/workbench/async-jobs/:jobId
 *
 * 用途：排查 / 运营后台（**不用于页面失败提示** —— 页面不显示失败，失败只发运营群）。
 *
 * 🔴 鉴权**不新开一套**：本 router 挂在 `routes/workbench.js` 里、位于 `requireWorkbenchAccess` 之后
 *   （未启用认证 503 / 未登录 401 / 白名单外 403 —— 与其它工作台接口**同一个函数**）。
 * 🔴 **只能查自己的任务**：owner 不是当前登录人 ⇒ 一律 404（不泄露"这条任务存在"）。
 * 🔴 **不返回 payload / 敏感字段**：只回状态机那几个字段（见 `publicJobView`）。
 */
const express = require('express');
const { getAsyncJobService } = require('../../services/asyncJobRuntime');
const { JOB_ID_PATTERN } = require('../../services/asyncJobStore');
const { logInfo } = require('../../utils/logger');

const createWorkbenchAsyncJobRoutes = (options = {}) => {
  const router = express.Router();
  // 延迟解析：只想注入一个桩的用例不必先建 job 存储。
  const resolveService = () => options.asyncJobs || getAsyncJobService();

  router.get('/async-jobs/:jobId', async (req, res) => {
    const jobId = String(req.params?.jobId || '').trim();
    const viewerOpenId = String(req.workbenchUser?.open_id || '').trim();
    if (!JOB_ID_PATTERN.test(jobId)) {
      return res.status(400).json({ success: false, error: 'job_id invalid' });
    }
    const service = resolveService();
    if (!service) return res.status(503).json({ success: false, error: 'async jobs disabled' });
    const result = await service.view(jobId, viewerOpenId);
    if (!result?.ok) {
      // 不是自己的 / 不存在 / 没有 owner：同一个 404（不区分，避免被拿来探测）
      return res.status(404).json({ success: false, error: 'job not found' });
    }
    logInfo('workbench.async_job.viewed', {
      request_id: req.requestId, job_id: jobId, type: result.job.type, status: result.job.status,
    });
    return res.json({ success: true, job: result.job });
  });

  return router;
};

module.exports = { createWorkbenchAsyncJobRoutes };
