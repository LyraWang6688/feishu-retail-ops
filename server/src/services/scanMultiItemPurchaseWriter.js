'use strict';

/**
 * 扫码页「一单多货」→ 补货 的**写入件适配层**（2026-10-29 授权解冻 `scanWriteService.js` 时拆出的小件）。
 *
 * 🔴 为什么需要它（P0）：`multiItemOrderService` 调写入件时传的是**扁平 payload**
 *   （`writer(taskId, payload, { supplierGroups })`），而既有
 *   `PurchaseWebhookService.publishPurchaseRequest(taskId, task)` 读的是**本地任务记录**的 `task.draft`
 *   ⇒ 直接转手会 `Cannot read properties of undefined (reading 'is_batch')`
 *   ⇒ 页面成功、采购批次/明细零写入（假成功）。
 *
 * 本层只做**形状适配**（与单货品 `submitReplenish` 逐字同形），不新开写库路径：
 *   ① 先建/更新本地采购任务记录 `{ task_id, kind:'scan_replenish', status:'posting', draft }`
 *      —— 既有 `ensurePostingPlan` 会 `store.update(taskId, …)`，没有这条记录就走不下去；
 *   ② 再调**既有** `publishPurchaseRequest(taskId, task, { supplierGroups })`。
 * 🔴 真正写业务表的一行代码都不在这里（全部仍在 `purchaseWebhookService`）。
 *
 * ⚠️ 边界（Lead 钉死）：只服务 `multiItemWriters().purchase`；
 *   `purchaseReturn` / 单货品补货路径 / 其他链路**一个字没动**。
 *
 * @param {object} input
 * @param {string} input.taskId                 引擎算出的 task id（幂等键）
 * @param {object} input.payload                引擎给的扁平 payload（`is_batch` / `items` / …）
 * @param {object} [input.options]              第三个实参：`{ supplierGroups }`
 * @param {object} input.purchaseStore          `JsonTaskStore`（`get/create/update`）
 * @param {() => object} input.purchase         **延迟**取既有 `PurchaseWebhookService`（装配同 `scanWriteService`）
 */
const publishMultiItemPurchase = async ({
  taskId, payload, options = {}, purchaseStore, purchase,
}) => {
  const draft = payload && typeof payload === 'object' ? payload : {};
  const existing = await purchaseStore.get(taskId).catch(() => null);
  const task = existing
    ? await purchaseStore.update(taskId, (current) => ({ ...current, draft }))
    : await purchaseStore.create({ task_id: taskId, kind: 'scan_replenish', status: 'posting', draft });
  return purchase().publishPurchaseRequest(taskId, task, {
    supplierGroups: Array.isArray(options.supplierGroups) ? options.supplierGroups : null,
  });
};

module.exports = { publishMultiItemPurchase };
