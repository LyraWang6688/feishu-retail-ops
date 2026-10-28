'use strict';

/**
 * 采购页提交的**写入件适配层**（同域新件，不动冻结的 `scanWriteService.js`）。
 *
 * 🔴 为什么需要它（2026-10-28 真测试 Base 集成验证发现的 Bug-1 / P0）：
 *   `multiItemOrderService.submitDraft` 调写入件时传的是**扁平 payload**
 *   （`writer(taskId, plan.payload, { supplierGroups })`），而既有
 *   `PurchaseWebhookService.publishPurchaseRequest(taskId, task)` 期望的是
 *   **本地任务记录** `task`（`task.draft` 才是那份 payload）。
 *   直接把 payload 当 task 传进去 ⇒ `Cannot read properties of undefined (reading 'is_batch')`
 *   ⇒ **HTTP 假成功、后台零写入**。
 *
 * 本层只做**形状适配**（与单货品 `submitReplenish` 那条路逐字同形），不新开写库路径：
 *   ① 先建/更新**本地采购任务记录**（`{ task_id, kind, status:'posting', draft }`）——
 *      既有 `ensurePostingPlan` 会 `store.update(taskId, …)`，没有这条记录就走不下去；
 *   ② 再调**既有** `publishPurchaseRequest(taskId, task, { supplierGroups })`。
 * 🔴 真正写业务表的一行代码都不在这里（全部仍在 `purchaseWebhookService`）。
 *
 * ⚠️ 这是对 PR #904 的**最小修复**（只解采购页）；扫码页「一单多货」同形状 bug 另行处理。
 */

const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { PurchaseWebhookService } = require('./purchaseWebhookService');
const { SCAN_WRITE } = require('../config/scanWrite');
const { PROCUREMENT_PAGE } = require('../config/procurementPage');
const { logInfo } = require('../utils/logger');

/**
 * @param {object} deps
 * @param {object} deps.gateway       `V1BitableGateway`（真写入需要）
 * @param {object} deps.writeService  既有 `scanWriteService`（只为复用它的 `behavior` 解析；可为空）
 * @param {object} [deps.store]       本地任务存储（默认与单货品同目录 `SCAN_WRITE.replenish.taskDir`）
 * @param {object} [deps.webhooks]    `PurchaseWebhookService`（用例注入假件，硬断言 task.draft）
 * @param {object} [deps.config]      `PROCUREMENT_PAGE`
 */
const createProcurementPurchaseWriters = ({
  gateway, writeService, store, webhooks, config = PROCUREMENT_PAGE,
} = {}) => {
  const base = writeService && typeof writeService.multiItemWriters === 'function'
    ? writeService.multiItemWriters() : {};
  const taskStore = store || new JsonTaskStore({
    dir: SCAN_WRITE.replenish.taskDir, idField: 'task_id',
  });
  let publisher = webhooks || null;
  const publisherOf = () => {
    if (!publisher) publisher = new PurchaseWebhookService({ gateway, store: taskStore });
    return publisher;
  };

  /** 引擎写入件：`(taskId, payload, { supplierGroups })` → 形状正确的本地 task → 既有 publish。 */
  const purchase = async (taskId, payload, options = {}) => {
    const draft = payload && typeof payload === 'object' ? payload : {};
    const existing = await taskStore.get(taskId).catch(() => null);
    const task = existing
      ? await taskStore.update(taskId, (current) => ({ ...current, draft }))
      : await taskStore.create({
        task_id: taskId, kind: config.draft.taskKind, status: 'posting', draft,
      });
    logInfo(config.events.writeTaskReady, {
      task_id: taskId,
      existed: Boolean(existing),
      lines: Array.isArray(draft.items) ? draft.items.length : 0,
      supplier_groups: Array.isArray(options.supplierGroups) ? options.supplierGroups.length : 0,
    });
    return publisherOf().publishPurchaseRequest(taskId, task, {
      supplierGroups: Array.isArray(options.supplierGroups) ? options.supplierGroups : null,
    });
  };

  return {
    purchase,
    // 采购行为解析仍走既有那条（不另写第二份行为表查询）
    behavior: (chain) => (typeof base.behavior === 'function' ? base.behavior(chain) : Promise.resolve({ recordId: '' })),
    _taskStore: taskStore,
  };
};

module.exports = { createProcurementPurchaseWriters };
