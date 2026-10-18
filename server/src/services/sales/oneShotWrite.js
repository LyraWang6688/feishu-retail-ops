'use strict';

/**
 * ⭐⭐ 2026-10-18（第 4 步提速）：**货品页只建主表 / 资金页一次跑完**那两条路的接线件。
 *
 * 为什么单独一个文件（Lead 的文件大小门禁要求）：
 *   `services/scanWriteService.js` 是**存量超限件**（基线只许变小），
 *   `services/salesOrderService.js` 也受"相对 PR base 净增 ≤100 行"约束。
 *   ⇒ 本刀新增的接线逻辑集中在这里（新文件只受 800 行硬上限约束）；
 *   两个老文件里只留**几行调用**，业务语义仍然住在业务层（`SalesOrderService`）✓。
 *
 * 三件事：
 *   ① `goodsOnlyTouched()`  —— 货品页那一屏到底写了什么（**如实报 0 明细 / 0 收款**）；
 *   ② `planOneShotRun()`    —— 资金页那一跑要不要"第一次"（省两次整表读）＋ 会话标记；
 *   ③ `finalizeSalesEntryOnce()` / `finalizeSaleOnce()` —— **一次收口**（总金额 + 赠品 + 写入状态）。
 */
const { TABLE_FIELDS } = require('../../config/salesWritePlan');
const { SALES_STATUS_WRITE_VALUES: WRITE } = require('../../config/salesStatusDimensions');
const { logInfo, logWarn } = require('../../utils/logger');
const { mergeCorrelation } = require('../../utils/correlationFields');

/** 货品页那一屏的返回形状（只建主表 + 单号；「写入状态=未完成」由建单函数写）。 */
const goodsOnlyResult = ({ wasResume, orderNo, salesEntryRecordId }) => ({
  ok: true,
  reused: wasResume,
  master_only: true,
  order_no: orderNo,
  sales_entry_record_id: salesEntryRecordId,
  // ⚠️ 如实报 0（这一屏真的没写明细 / 收款 / 流水）—— 调用方不许猜。
  detail_count: 0,
  payment_count: 0,
});

/**
 * 资金页那一跑的"第一次吗"判定（**显式布尔**，只看会话里已有的进度标记）。
 * `fresh = true` ⇒ 业务层可以省掉"读主表 + 读整张销售明细"两次大读；
 * 但**写之前**必须先落会话标记（`children_started`）⇒ 中途崩了再点就走安全路径 ✓。
 */
const planOneShotRun = ({ sale, singlePass, orderNo, childrenStartedFlag }) => {
  const current = sale || {};
  const hadChildren = current.children_started === true
    || (Array.isArray(current.detail_ids) && current.detail_ids.some(Boolean))
    || (Array.isArray(current.payment_ids) && current.payment_ids.some(Boolean));
  const fresh = singlePass === true && !hadChildren;
  return {
    fresh,
    markChildrenStarted: fresh ? String(childrenStartedFlag || '') : '',
    // 交给业务层的几个键（不传 / 非一次跑 ⇒ 调用方**整组不传** ⇒ 入参逐字同今天 ✓）
    confirmArgs: { oneShot: true, freshOneShot: fresh, orderNo },
  };
};

/**
 * ⭐ **一次收口**（写在 `SalesOrderService.finalizeOneShot` 里的那一段）：
 * 总金额 ＋ 赠品 ＋ 写入状态**同一次 update**；成功判据就是这一下（**不吞错**）。
 */
const finalizeSalesEntryOnce = async (gateway, input = {}, options = {}) => {
  const salesEntryRecordId = String(input.salesEntryRecordId || '').trim();
  if (!salesEntryRecordId) throw new Error('收口缺少销售主表 record_id');
  const writeStatus = String(input.writeStatus || '').trim();
  if (![WRITE.writeStatus.done, WRITE.writeStatus.partial, WRITE.writeStatus.failed].includes(writeStatus)) {
    throw new Error(`收口的写入状态不在值域内：${writeStatus}`);
  }
  // ⚠️ 一次 `update` 里只放**配置声明**的字段：多余的键一律不放（写错列比少写更糟）。
  const declared = TABLE_FIELDS.salesEntry.final || [];
  const values = {};
  if (declared.includes('gift')) values.gift = String(input.gift ?? '');
  if (declared.includes('totalAmount') && input.totalAmountKnown === true
    && Number.isFinite(Number(input.totalAmount))) {
    values.totalAmount = Number(input.totalAmount);
  }
  if (declared.includes('writeStatus')) values.writeStatus = writeStatus;
  const correlation = mergeCorrelation(options.correlation, { sales_entry_record_id: salesEntryRecordId });
  // 🔴 **不吞错**：这是"成功判据"本身 —— 写不上就抛，调用方会如实回失败页。
  await gateway.update('salesEntry', salesEntryRecordId, values, { correlation });
  // ⚠️ 事件名沿用既有的两条（不新增事件 ⇒ 事件目录不用重新生成）：
  //    · `sales.entry.total_amount.written`：总金额这一格真的写了（旧位置就在 `_confirm` 里）；
  //    · `v1.sale.posted`：这一单的"落表完成"那一下（与旧链路同一个事件名/字段形状）。
  if (values.totalAmount !== undefined) {
    logInfo('sales.entry.total_amount.written', {
      sales_entry_record_id: salesEntryRecordId, total_amount: values.totalAmount, ...correlation,
    });
  } else {
    logWarn('sales.entry.total_amount.skipped', {
      sales_entry_record_id: salesEntryRecordId, reason: 'line_amount_missing', ...correlation,
    });
  }
  logInfo('v1.sale.posted', {
    sales_entry_record_id: salesEntryRecordId,
    write_status: writeStatus,
    gift_written: declared.includes('gift'),
    step: 'one_shot_finalize',
    inventory_applied_by_this_step: false,
    ...correlation,
  });
  return { salesEntryRecordId, writeStatus, values };
};

/**
 * `scanWriteService` 那一侧的收口入口：**只认真实业务层**回的 `oneShot` 结果。
 * 注入的假 sales（既有单测替身）没有这一支 ⇒ 返回 `false`，调用方退回旧收口（不硬造写入）。
 */
const finalizeSaleOnce = async ({ salesService, salesEntryRecordId, result, writeStatus, correlation, timing }) => {
  if (typeof salesService?.finalizeOneShot !== 'function') return false;
  const startedAt = Date.now();
  await salesService.finalizeOneShot({
    salesEntryRecordId,
    gift: String(result?.giftText ?? ''),
    totalAmountKnown: result?.orderAmountsKnown === true,
    totalAmount: Number(result?.totalCents || 0) / 100,
    writeStatus,
  }, { correlation });
  if (timing) timing.finalize_ms = Math.max(0, Date.now() - startedAt);
  return true;
};

module.exports = {
  goodsOnlyResult,
  planOneShotRun,
  finalizeSalesEntryOnce,
  finalizeSaleOnce,
};
