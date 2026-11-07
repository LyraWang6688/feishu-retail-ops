'use strict';

/**
 * 扫码写服务的**对外 facade**（2026-11-08 阶段 5a）。
 *
 * 真正的装配在 `services/scanWrite/createService.js`；本文件只保留对外导出，
 * 保证 `require('./scanWriteService')` 的形状与调用点一个字不变。
 */
const {
  createScanWriteService,
  createSalesEntryWithOrderNo,
} = require('./scanWrite/createService');
const { createReadOnlyReferenceCache } = require('./sales/referenceReadCache');
const { waitForPendingSaleBackgrounds } = require('./saleWriteBackgroundService');

module.exports = {
  createScanWriteService,
  createSalesEntryWithOrderNo,
  createReadOnlyReferenceCache,
  waitForPendingSaleBackgrounds,
};
