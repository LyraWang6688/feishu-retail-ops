'use strict';

/**
 * 工作台「货品资料」的「同步样例图」**动作接口**（业务负责人 2026-11-10）：
 *   货品资料页里放一张按钮卡「同步存量样例图」，点它 = **存量写入**（把「有图但未勾」的记录
 *   逐条传到云盘并勾「已同步云盘」）。
 *
 * 与「新增自动同步」的关系：
 *   · 新增 = 事件驱动（`routes/larkEvents.js` → `sampleImageDriveService.handleTableChanges`）；
 *   · 本接口只补历史（复用同一个 `syncRecord`，不抄第二份上传/勾选逻辑）。
 *
 * 鉴权 / no-store / ui-tap：由父 router（`routes/workbench.js`）统一加 —— 本文件**不新开鉴权**。
 *
 * 两个端点：
 *   · `POST /data-config/sample-image-sync` 启动（已在跑 ⇒ `started:false`，不并发）；
 *   · `GET  /data-config/sample-image-sync` 查进度（页面轮询用；只返回计数，不带任何图片/记录内容）。
 *
 * ⚠️ 响应文案一律英文/机器码（前端 `config/dataConfig.js` 出人话）：
 *   本文件在硬编码中文闸门的扫描范围内，用户可见中文的家在 config。
 */

const express = require('express');
const { logError } = require('../../utils/logger');
const { V1BitableGateway } = require('../../services/v1BitableGateway');
const { createSampleImageDriveService } = require('../../services/sampleImageDriveService');
const { createSampleImageBackfillService } = require('../../services/sampleImageBackfillService');
// ⭐ 2026-11-10：存量补齐接**统一异步任务**（状态可查 / 失败发运营群 / 临时错误重试）。
const { getAsyncJobService } = require('../../services/asyncJobRuntime');

const createWorkbenchDataConfigRoutes = ({ options = {} } = {}) => {
  const router = express.Router();
  // 懒建：只有真正点这个按钮才需要 gateway / 服务（不点 ⇒ 零装配、零飞书调用）
  let backfill = options.sampleImageBackfill || null;
  const resolveBackfill = () => {
    if (backfill) return backfill;
    const gateway = options.gateway || new V1BitableGateway();
    const driveService = options.sampleImageDriveService || createSampleImageDriveService({ gateway });
    // `options.asyncJobs` 显式注入（用例）；未注入 ⇒ 用进程级单例（关掉时为 null ⇒ service 退回进程内跑）
    const jobs = options.asyncJobs !== undefined ? options.asyncJobs : getAsyncJobService();
    backfill = createSampleImageBackfillService({ gateway, driveService, jobs });
    return backfill;
  };

  router.post('/data-config/sample-image-sync', async (req, res) => {
    try {
      const started = await resolveBackfill().start({
        ownerOpenId: req.workbenchUser?.open_id || '',
        operatorName: req.workbenchUser?.name || '',
      });
      const { done, ...rest } = started; // done 是后台 promise：**不进响应**
      return res.status(started.started ? 202 : 200).json({ success: true, ...rest });
    } catch (error) {
      logError('workbench.data_config.sample_image_sync.start_failed', {
        request_id: req.requestId, error: error.message,
      });
      return res.status(502).json({ success: false, error: 'sample image sync start failed' });
    }
  });

  router.get('/data-config/sample-image-sync', async (req, res) => {
    try {
      return res.json({ success: true, ...await resolveBackfill().statusWithJob() });
    } catch (error) {
      logError('workbench.data_config.sample_image_sync.status_failed', {
        request_id: req.requestId, error: error.message,
      });
      return res.status(502).json({ success: false, error: 'sample image sync status failed' });
    }
  });

  return router;
};

module.exports = { createWorkbenchDataConfigRoutes };
