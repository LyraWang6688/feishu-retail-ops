'use strict';

// 2026-10-18 从 `services/purchaseWebhookService.js` **原样搬出**（task-6 文件大小门禁）。
const { mergeCorrelation } = require('../../utils/correlationFields');

/**
 * 采购侧的关联键包（只进日志，**不改任何业务判断、不进任何业务 input**）。
 *
 * 与销售链路的 `options.correlation` 是同一个范式：显式传参、不用 AsyncLocalStorage
 * （库存引擎有跨请求重放，从上下文读会指向错的那一笔）。
 *
 * 三个键各自"从哪来"（**拿不到就不传**，`mergeCorrelation` 会把空值 / 非白名单键丢掉，
 * 所以不会写成 `"batch_no":""`）：
 *   · `task_id`                    —— 本地采购任务（扫码补货 = `scan_replenish_…`；
 *                                     到货核对 = `arrival_reconcile_…`，那是另一套 task，如实照传）
 *   · `batch_no`                   —— 采购批次号（代码生成的 `CGD-YYYYMMDD-NNNN`；旧数据可能是手填的 `202610071` 或旧的 `BH-…`）
 *   · `purchase_batch_record_id`   —— ⭐ **「报货批次」那条记录**（2026-10-07 晚替换掉了原来的
 *                                      `purchase_arrival_record_id`：到货落点从已删除的
 *                                      「到货验收」表搬到「报货批次」，那条旧记录 id 已无来源）
 *
 * ⛔ 原先还有第四个 `purchase_report_record_id`（「信息填写」那条报单记录）——
 *    **2026-10-09 已删**：那张表被业务负责人整个删掉、报单入口退场 ⇒ 这个键**已无来源**；
 *    按「删写入点 ＋ 删白名单键」处理（`utils/correlationFields.js` 里那一行也一并删掉），
 *    否则日志里会永远缺一个"本该有值"的键，反而误导排查。
 */
const purchaseCorrelation = ({ taskId, batchNo, batchRecordId } = {}) =>
  mergeCorrelation({
    task_id: taskId,
    batch_no: batchNo,
    purchase_batch_record_id: batchRecordId,
  });

module.exports = { purchaseCorrelation };
