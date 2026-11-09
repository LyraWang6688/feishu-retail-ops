'use strict';

/**
 * 工作台「货品 → 数据配置」：**抖音团购券目录同步**的触发端点。
 *
 * 业务负责人 2026-11-10：**不是定时任务** —— 在「数据配置」页放一个按钮，点一下才读接口、写回券表。
 * 读/写口径全在 `services/douyin/voucherCatalogSync.js`（接口返回什么就写什么），本文件只做触发。
 */
const express = require('express');
const { V1BitableGateway } = require('../../services/v1BitableGateway');
const { createLaikeClient } = require('../../services/douyin');
const { createVoucherCatalogSync } = require('../../services/douyin/voucherCatalogSync');
const { createVoucherCatalogSyncConfig } = require('../../config/voucherCatalogSync');
const { logError, logInfo } = require('../../utils/logger');

const createWorkbenchDouyinRoutes = (options = {}) => {
  const router = express.Router();

  router.post('/douyin/voucher-catalog-sync', async (req, res) => {
    try {
      const config = options.voucherCatalogConfig || createVoucherCatalogSyncConfig();
      const service = createVoucherCatalogSync({
        gateway: options.gateway || new V1BitableGateway(),
        laike: options.laike || createLaikeClient(),
        config,
      });
      const summary = await service.run();
      if (!summary.ok) {
        return res.status(400).json({ success: false, error: summary.message || config.texts.accountMissing });
      }
      logInfo('douyin.voucher_catalog.triggered', {
        written: summary.written, changed: summary.matched, unmatched: (summary.unmatchedVouchers || []).length,
      });
      return res.json({
        success: true,
        voucherRows: summary.voucherRows,
        catalogProducts: summary.catalogProducts,
        written: summary.written,
        changed: summary.matched,
        unmatchedVouchers: (summary.unmatchedVouchers || []).length,
        failedWrites: (summary.failedWrites || []).length,
      });
    } catch (error) {
      logError('workbench.douyin.voucher_catalog_sync.failed', {
        request_id: req.requestId, error: error.message,
      });
      return res.status(500).json({ success: false, error: (options.voucherCatalogConfig || {}).texts?.syncFailed || 'sync_failed' });
    }
  });

  return router;
};

module.exports = { createWorkbenchDouyinRoutes };
