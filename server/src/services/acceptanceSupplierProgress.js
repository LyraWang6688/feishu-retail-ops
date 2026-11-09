'use strict';

/**
 * ⭐ 2026-11-10：验收「按供应商分批」的本地进度读取（文件体量棘轮拆出）。
 *
 * 数据源 = 统一任务存储里的 `arrival_reconcile_<batch>_<supplier>` 任务（posted = 已验完）。
 * 注意：**判断"全批是否到货"的生产真源已改成主表两个字段**
 *   （「供应商」Lookup vs 「已到货供应商」关联，见 `purchaseOrderBatchService`）；
 *   本模块只负责本地累计值（实际数量/金额）与前端"已验收供应商"提示，不参与最终状态判定。
 */

const crypto = require('node:crypto');

const taskIdForBatch = (batchNo, supplierRecordId = '') => {
  const base = `arrival_reconcile_${crypto.createHash('sha256').update(String(batchNo || '')).digest('hex').slice(0, 24)}`;
  const supplier = String(supplierRecordId || '').trim();
  return supplier ? `${base}_${supplier}` : base;
};

/** 这一批里已验收（posted）的供应商累计实际数量/金额；allDone 仅作单测/旧路径兜底。 */
const computeSupplierTotals = async (service, task, batchNo) => {
  const ids = [...new Set((task.supplier_record_ids || [])
    .map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return null;
  let quantity = 0;
  let amount = 0;
  let doneCount = 0;
  for (const supplierId of ids) {
    const supplierTask = await service.store.get(taskIdForBatch(batchNo, supplierId)).catch(() => null);
    if (!supplierTask || supplierTask.status !== 'posted') continue;
    doneCount += 1;
    quantity += (supplierTask.plan || []).reduce((sum, row) => sum + Number(row.actual || 0), 0);
    amount += Number(supplierTask.actual_amount || 0);
  }
  return { quantity, amount, doneCount, total: ids.length, allDone: doneCount > 0 && doneCount === ids.length };
};

/** { batch_no: [supplier_record_id] } —— 前端用来隐掉已验收完的供应商卡（任务 posted）。 */
const listAcceptedSuppliers = async (service) => {
  const accepted = {};
  let tasks = [];
  try {
    tasks = await service.store.list();
  } catch { return accepted; }
  for (const task of tasks || []) {
    if (String(task?.status || '') !== 'posted') continue;
    const batchNo = String(task?.batch_no || '').trim();
    const supplierId = String(task?.supplier_record_id || '').trim();
    if (!batchNo || !supplierId) continue;
    if (!accepted[batchNo]) accepted[batchNo] = [];
    if (!accepted[batchNo].includes(supplierId)) accepted[batchNo].push(supplierId);
  }
  return accepted;
};

module.exports = { taskIdForBatch, computeSupplierTotals, listAcceptedSuppliers };
