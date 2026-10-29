'use strict';

/**
 * ⭐ 2026-10-29（业务负责人批准 **A 方案·安全并行**）：在**写表的同时**先把各供应商组的 PNG 渲染好。
 *
 * 只渲染、不发送/不回填/不写表（`documentImages.prepareSupplierImages`）；发送仍严格在写表成功之后。
 * 本件只做两件薄编排（拆出来是为了让 `purchaseWebhookService.js` 不涨过 800 行门禁）：
 *   ① **重放不重复渲染**：本地任务已经建过批次（`batch_record_id` / status=posted）⇒ 返回 null，
 *      交给 deliver 既有的「按单据附件跳过」判据（保住 AC-SS4「重放 0 张图」✓）；
 *   ② 渲染失败**不抛**：记 `purchase.request.image.prepare_failed` 并返回 null
 *      ⇒ deliver 现场再渲染一次（逐字退化为今天的行为 ✓）。
 */
const { logWarn } = require('../../utils/logger');

const startPreparedImages = async ({ service, taskId, task, plan }) => {
  const stored = await service.store.get(taskId).catch(() => null);
  const current = stored || task || {};
  const alreadyPosted = Boolean(
    current.batch_record_id || current.posting_progress?.batch_record_id || current.status === 'posted',
  );
  if (alreadyPosted) return null;
  return service.prepareSupplierImages(taskId, task, plan).catch((error) => {
    logWarn('purchase.request.image.prepare_failed', { task_id: taskId, error: String(error?.message || error) });
    return null;
  });
};

module.exports = { startPreparedImages };
