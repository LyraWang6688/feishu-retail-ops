const { createPurchaseQueryService } = require('./purchaseQueryService');
const { WORKBENCH_ARRIVAL_TEXTS, WORKBENCH_ARRIVAL_INPUT_REASONS } = require('../config/workbenchOrders');
const { logInfo } = require('../utils/logger');

/**
 * ⭐ 2026-10-09（业务负责人当天 15:07 定的「订单列表 · **采购**」子 tab：
 *   「**采购**，按照**采购订单**，有**验收到货**的按钮」）：
 *   工作台「验收到货」按钮的**接线层** —— 薄到只剩"翻译"：
 *
 *   ① 用**既有只读**查询（`PurchaseQueryService.listPurchaseRequests`，与「采购管理」页同一个口径）
 *      把这一批（`batch_no`）的采购申请明细读出来，取它们的 **record_id 当 request_ids**；
 *   ② 原样交给**既有**到货核对服务的薄方法 `confirmBatchArrival` —— 它会复用既有
 *      `loadRequestRows` / `buildPlan` / `confirmLocked` → **既有**
 *      `PurchaseWebhookService.confirmArrival` → **既有** `InventoryService.applyPurchase`。
 *
 * 🔴 这一层**没有任何写库 / 入库实现**：
 *    · 一次 `gateway.create/update/delete` 都没有；
 *    · 一句 `applyPurchase` / `writeAcceptance` / `markConfirmed` / `buildPlan` 都没有
 *      （由 `test/workbenchOrders.test.js` 的 AC12 源码哨兵钉住）。
 *
 * ⚠️ 只收「采购申请」的批次：`reportBehavior: 'purchase_request'` 是**既有**过滤器
 *    （`services/purchaseBehaviorPolicy`），采购退货单不进这个入口。
 * ⚠️ 失败一律**抛**（由路由按既有口径映射成 400 / 502，原因原样回到页面），
 *    参考 `services/workbenchOrderActionService.js` 的同一条纪律。
 */
class WorkbenchPurchaseArrivalService {
  constructor({ gateway, purchaseQuery, arrivalConversation } = {}) {
    if (!purchaseQuery && !gateway) throw new Error('WorkbenchPurchaseArrivalService 需要 gateway 或 purchaseQuery');
    if (!arrivalConversation) throw new Error('WorkbenchPurchaseArrivalService 需要 arrivalConversation');
    this.purchaseQuery = purchaseQuery || createPurchaseQueryService(gateway);
    this.arrivalConversation = arrivalConversation;
  }

  /** 按 reason 判 400（她填错）/ 502（业务没做成）——「页面上看得见原因」才是判据。 */
  statusFor(reason) {
    return WORKBENCH_ARRIVAL_INPUT_REASONS.includes(reason) ? 400 : 502;
  }

  /**
   * 验收这一批到货并入库（**全部按申请数到货**）。
   *
   * @param {{batchNo: string, actualAmount: number|string, acceptanceText?: string,
   *   operatorOpenId?: string}} input
   * @returns {Promise<{message: string, alreadyPosted: boolean, batchNo: string}>}
   *   `message` = 给她看的一句话（页面直接显示）。
   */
  async confirmArrival({ batchNo, actualAmount, acceptanceText = '', operatorOpenId = '' } = {}) {
    const wanted = String(batchNo || '').trim();
    if (!wanted) {
      throw Object.assign(new Error(WORKBENCH_ARRIVAL_TEXTS.needBatchNo), { statusCode: 400 });
    }
    // 既有只读查询：这一批的采购申请明细（口径与「采购管理」页一致）
    const rows = await this.purchaseQuery.listPurchaseRequests({
      batchNo: wanted, reportBehavior: 'purchase_request',
    });
    const requestIds = [...new Set((rows || []).map((row) => String(row?.record_id || '').trim()).filter(Boolean))];
    if (!requestIds.length) {
      throw Object.assign(
        new Error(`没找到报货批次 ${wanted} 的采购申请明细（${WORKBENCH_ARRIVAL_TEXTS.noRequestRows}）`),
        { statusCode: 400, reason: 'no_request_rows' },
      );
    }
    const result = await this.arrivalConversation.confirmBatchArrival({
      batch: { batch_no: wanted, request_ids: requestIds },
      acceptanceText,
      actualAmount,
      operatorOpenId,
    });
    if (!result || result.ok !== true) {
      const reason = result?.reason || 'failed';
      logInfo('workbench.purchase.arrival_confirm.rejected', {
        batch_no: wanted, reason, request_count: requestIds.length,
        note: '接线层如实把既有核对链路的原因回到页面（一个字节都没写）',
      });
      throw Object.assign(
        new Error(result?.message || '验收入库没成功，请稍后再试'),
        { statusCode: this.statusFor(reason), reason },
      );
    }
    return {
      message: result.message || `这批（${wanted}）已验收入库`,
      alreadyPosted: result.reason === 'already_posted',
      batchNo: wanted,
    };
  }
}

module.exports = { WorkbenchPurchaseArrivalService };
