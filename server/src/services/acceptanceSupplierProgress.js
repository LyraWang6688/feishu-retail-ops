'use strict';

/**
 * ⭐ 2026-11-10：验收「按供应商分批」的本地进度读取（文件体量棘轮拆出）。
 *
 * 数据源 = 统一任务存储里的 `arrival_reconcile_<batch>_<supplier>` 任务。
 * 2026-11-19 起采购提交按供应商拆独立批次 ⇒ 本模块只保留任务 id 生成；
 * 「实际数量/金额」由本任务写入，不再做跨供应商累计。
 */

const crypto = require('node:crypto');

const taskIdForBatch = (batchNo, supplierRecordId = '') => {
  const base = `arrival_reconcile_${crypto.createHash('sha256').update(String(batchNo || '')).digest('hex').slice(0, 24)}`;
  const supplier = String(supplierRecordId || '').trim();
  return supplier ? `${base}_${supplier}` : base;
};

module.exports = { taskIdForBatch };
