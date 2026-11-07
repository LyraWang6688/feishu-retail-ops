'use strict';

/**
 * 采购提交成功后的「销售明细.采购明细」回填（业务负责人 2026-11-08）。
 *
 * 🔴 背景：生产「销售明细」新增**单向关联**「采购明细」→「采购明细」表。
 *   语义：这条销售明细**已经被补货报过**。
 *   · 读侧：`procurementPageData.buildReplenishView` 排除已关联行（默认；避免 3 天窗口重叠重复报货）；
 *   · 写侧（本文件）：采购单异步写成功后，把「这次报过的销售明细」关联到**本次生成的采购明细记录**。
 *
 * 🔴 匹配口径（业务负责人定）：「**用编号和尺码匹配记录**」——
 *   不依赖页面传销售明细 record_id、也不绑销售单号：
 *   ① 从**本地采购任务**取本次写库结果：`request_ids[i]`（采购明细记录 id，与 `posting_plan.items[i]` 一一对应）；
 *   ② 编号 = 货品信息.编号（按 `posting_plan.items[i].product_record_id` 批量反查，非页面传值）；
 *   ③ 读同一补货筛选（库存=0 + 近 N 天窗口）的销售明细，只取**尚未关联**的行；
 *   ④ 同「编号+尺码」按**销售日旧→新**取，最多取该采购明细的「数量」条；
 *   ⑤ 关联值 = `relation(采购明细 record_id)`（单向关联列只认 id 数组）。
 *
 * ⚠️ 顺手保证：
 *   · **幂等**：已经关联到某条采购明细的行数先抵扣（重试不会多链）；
 *   · **绝不抛**：失败只记 warn，不影响采购单本身（采购事实已在主表/明细里）；
 *   · **只写一处**：只写「销售明细.采购明细」这一列，不写/不改任何采购表。
 */

const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { SCAN_WRITE } = require('../config/scanWrite');
const { PROCUREMENT_PAGE } = require('../config/procurementPage');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { relation } = require('./v1ReferenceResolver');
const { textOf, numberOf, linkedIdsOf } = require('./procurementPageData');
const { isSalesTradeType, tradeTypeCodeFromLabel } = require('../config/salesMovements');
const { logInfo, logWarn } = require('../utils/logger');

const fill = (template, values) => String(template || '').replace(/\{(\w+)\}/g, (match, key) => (
  Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
));

/**
 * @param {object} deps
 * @param {object} deps.gateway       真实/假 `V1BitableGateway`（`getBatch` / `listByFilter` / `update`）
 * @param {object} [deps.schema]      `V1_BITABLE_SCHEMA`
 * @param {object} [deps.config]      `PROCUREMENT_PAGE`（窗口 / 筛选 / 事件名）
 * @param {object} [deps.taskStore]   本地采购任务 store（默认 `SCAN_WRITE.replenish.taskDir`）
 * @param {Function} [deps.readSalesRows] 读销售明细（默认按 config 筛选；用例/特殊环境可注入）
 * @param {object} [deps.logger]      可注入（用例断言日志/防噪声）
 * @param {number} [deps.maxRows]     每次最多关联多少行（防手滑跑飞；默认 200）
 */
const createProcurementSalesLinkBackfill = ({
  gateway, schema = V1_BITABLE_SCHEMA, config = PROCUREMENT_PAGE, taskStore, readSalesRows, logger = { logInfo, logWarn }, maxRows = 200,
} = {}) => {
  if (!gateway) throw new Error('procurementSalesLinkBackfill 需要 gateway');
  const store = taskStore || new JsonTaskStore({ dir: SCAN_WRITE.replenish.taskDir, idField: 'task_id' });
  const info = typeof logger.logInfo === 'function' ? logger.logInfo : () => {};
  const warn = typeof logger.logWarn === 'function' ? logger.logWarn : () => {};
  const salesFields = (schema.tables?.salesDetail?.fields) || {};
  const productFields = (schema.tables?.product?.fields) || {};

  const defaultReadSales = () => {
    const filter = fill(config.filters.replenish, {
      stockField: salesFields.stockQuantity,
      dateField: salesFields.soldAt,
      days: config.window.replenishDays,
    });
    return gateway.listByFilter('salesDetail', filter);
  };

  const run = async ({ taskId } = {}) => {
    if (!taskId) return { ok: false, reason: 'no_task_id', linked: 0 };
    try {
      const task = await store.get(taskId).catch(() => null);
      const planItems = Array.isArray(task?.posting_plan?.items) ? task.posting_plan.items : [];
      const requestIds = Array.isArray(task?.request_ids) ? task.request_ids : [];
      const batchNo = String(task?.batch_no || '');
      if (!batchNo || !planItems.length || !requestIds.length) {
        return { ok: true, linked: 0, reason: 'no_purchase_facts', batch_no: batchNo };
      }
      // 编号只从「货品信息」反查（不信页面传值）；一次批量读，避免 N 次请求
      const productIds = [...new Set(planItems.map((one) => String(one?.product_record_id || '').trim()).filter(Boolean))];
      const products = productIds.length ? await gateway.getBatch('product', productIds) : [];
      const numberById = new Map((products || []).map((record) => [record.record_id, textOf(record.fields?.[productFields.number])]));
      const sales = await (typeof readSalesRows === 'function' ? readSalesRows() : defaultReadSales());
      // 交易类型判据（与补货读模型同一份口径）：行为表 id → 编码; 认不出 ⇒ 丢弃（页面上本来就不会出现）
      const behaviors = await gateway.listAll('behavior').catch(() => []);
      const behaviorCodeById = new Map((behaviors || []).map((record) => [
        record.record_id, textOf(record.fields?.[schema.tables?.behavior?.fields?.code]),
      ]));
      const tradeCodeOf = (cell) => {
        for (const id of linkedIdsOf(cell)) {
          const code = behaviorCodeById.get(id);
          if (isSalesTradeType(code)) return code;
        }
        const byLabel = tradeTypeCodeFromLabel(textOf(cell));
        return isSalesTradeType(byLabel) ? byLabel : '';
      };
      const rows = (sales || []).map((record) => {
        const tradeCode = tradeCodeOf(record.fields?.[salesFields.tradeType]);
        return {
          id: record.record_id,
          product: textOf(record.fields?.[salesFields.product]),
          size: String(numberOf(record.fields?.[salesFields.size]) ?? ''),
          soldAt: numberOf(record.fields?.[salesFields.soldAt]) ?? 0,
          linkedDetailIds: linkedIdsOf(record.fields?.[salesFields.purchaseDetail]),
          tradeCode,
          prepaid: tradeCode === config.behavior?.prepaid,
        };
      }).filter((row) => row.id && row.product && row.size && row.tradeCode);
      // 已关联到某条采购明细的行数（幂等：重试不会把同一组链更多）
      const linkedByDetail = new Map();
      for (const row of rows) {
        for (const detailId of row.linkedDetailIds) linkedByDetail.set(detailId, (linkedByDetail.get(detailId) || 0) + 1);
      }
      // 关联顺序：**预订优先**（预订必补／默认已选），同类型内按销售日旧→新。
      //   理由：补货数量默认 = 预订数；先链预订，剩下的才是"没报的现货"（下次页面显示现货，默认 0），
      //   不会出现"明明报了预订却还剩预订待补"的错觉。
      const pool = rows.filter((row) => row.linkedDetailIds.length === 0).sort((a, b) => {
        if (a.prepaid !== b.prepaid) return a.prepaid ? -1 : 1;
        return a.soldAt - b.soldAt;
      });
      const used = new Set();
      let linked = 0;
      const failed = [];
      for (let index = 0; index < planItems.length && index < maxRows; index += 1) {
        const detailId = String(requestIds[index] || '');
        const item = planItems[index] || {};
        const product = numberById.get(String(item.product_record_id || '')) || '';
        const size = String(numberOf(item.size) ?? '');
        const quantity = Math.max(numberOf(item.quantity) || 0, 0);
        if (!detailId || !product || !size || quantity <= 0) continue;
        let remaining = quantity - (linkedByDetail.get(detailId) || 0);
        if (remaining <= 0) continue; // 这一行已经关联满（重放/重试）
        for (const candidate of pool) {
          if (remaining <= 0) break;
          if (used.has(candidate.id)) continue;
          if (candidate.product !== product || candidate.size !== size) continue;
          try {
            await gateway.update('salesDetail', candidate.id, { purchaseDetail: relation(detailId) });
            used.add(candidate.id);
            linked += 1;
            remaining -= 1;
          } catch (error) {
            failed.push({ sales_detail_id: candidate.id, error: String(error?.message || error) });
          }
        }
        if (remaining > 0) {
          warn(config.events.salesLinkBackfillFailed, {
            task_id: taskId, batch_no: batchNo, purchase_detail_id: detailId,
            product, size, quantity, remaining, reason: 'not_enough_unlinked_sales_rows',
          });
        }
      }
      const summary = { ok: true, batch_no: batchNo, linked, failed: failed.length, details: planItems.length };
      if (failed.length) {
        warn(config.events.salesLinkBackfillFailed, { task_id: taskId, ...summary, failures: failed.slice(0, 10) });
      } else {
        info(config.events.salesLinkBackfilled, { task_id: taskId, ...summary });
      }
      return summary;
    } catch (error) {
      // 🔴 回填失败不影响采购事实（主表/明细已写成功）⇒ 只记日志
      warn(config.events.salesLinkBackfillFailed, { task_id: taskId, error: String(error?.message || error) });
      return { ok: false, linked: 0, error: String(error?.message || error) };
    }
  };

  return { run };
};

module.exports = { createProcurementSalesLinkBackfill };
