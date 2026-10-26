'use strict';

/**
 * ⭐⭐ 2026-10-18（第 4 步提速 · 文件大小门禁）：**交付那一步**（"现货 ⇒ 提交即交付 + 扣库存"）。
 *
 * 🔴 **纯搬家**：从 `services/scanWriteService.js` 原样搬出（那个文件是存量超限件，基线只许变小）。
 *    判据 / 顺序 / 日志事件名 / 返回值形状**一个字没改** ✓（只是把闭包改成了显式注入：
 *    `delivery` / `now` / `events` / `logError` 都由调用方传进来）。
 *
 * 口径（照旧）：这一层自己不写任何一个库存字段 —— 它只把"哪几条明细"交给既有
 *   `SalesDeliveryService.deliver`（唯一的交付通路），并把结果**如实**折成
 *   `{ requested, delivered, failed, reasons }`；失败**不吞**。
 *
 * 「这一行要不要在**提交这一刻**交付并扣库存」的两个判据都来自配置：
 *   · 可售品属性（`config/sellableKinds`）：配品没有鞋、不跟踪库存 ⇒ 天然不参与交付；
 *   · 交易类型（`config/salesWritePlan.deliversOnSubmitFor`）：现货 ⇒ 提交即交付；预定 ⇒ 不交付。
 */
const { sellableKindOf } = require('../../config/sellableKinds');
const { deliversOnSubmitFor } = require('../../config/salesWritePlan');

/** @returns {{lineDeliversOnSubmit: Function, deliverStockLines: Function}} */
const createDeliveryStep = ({ delivery, now, events, logError }) => {
  const lineDeliversOnSubmit = (item) => {
    const kind = sellableKindOf(item);
    if (!(kind.requiresFulfillment && kind.tracksInventory)) return false;
    // 编码判据来自写计划（计划本身又与 salesMovements 同源）⇒ 不再认现货/预定字面量。
    return deliversOnSubmitFor(String(item.tradeTypeCode || '').trim());
  };

  const deliverStockLines = async ({ items, detailRecordIds, paymentRecordIds, salesEntryRecordId, correlation,
    allowUnposted = false, skipProgress = true }) => {
    const deliverable = items
      .map((item, index) => ({ item, detailRecordId: String(detailRecordIds?.[index] || '') }))
      .filter(({ item, detailRecordId }) => detailRecordId && lineDeliversOnSubmit(item));
    if (!deliverable.length) return { requested: 0, delivered: 0, failed: 0, reasons: [] };
    const detailIds = deliverable.map(({ detailRecordId }) => detailRecordId);
    try {
      const invoice = await delivery().deliver({
        salesEntryRecordId,
        detailRecordIds: detailIds,
        paymentRecordIds,
        allowUnposted,
        skipProgress,
        occurredAt: now(),
      }, { correlation });
      const failures = invoice?.failures || [];
      return {
        requested: detailIds.length,
        delivered: detailIds.length - failures.length,
        failed: failures.length,
        reasons: failures.map((failure) => String(failure?.error || '').trim()).filter(Boolean),
      };
    } catch (error) {
      // 交付这一段**整体抛**（例：明细不属于这一单 / 主表还没入账 / 库存校验失败）：
      // 同样如实报"这几双没交付"，绝不吞掉、也绝不假装成功。
      logError(events.stockFailed, {
        sales_entry_record_id: salesEntryRecordId, detail_ids: detailIds,
        error: String(error.message || error), ...correlation,
      });
      return {
        requested: detailIds.length,
        delivered: 0,
        failed: detailIds.length,
        reasons: [String(error.message || error)],
      };
    }
  };

  return { lineDeliversOnSubmit, deliverStockLines };
};

module.exports = { createDeliveryStep };
