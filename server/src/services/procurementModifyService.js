'use strict';

/**
 * 采购批次修改（只保留最新版）。
 *
 * 本 service 只做“批次对账 + 采购明细增改删 + 主表数量更新 + 销售关联裁剪”；
 * 单据重出 / 群消息通过注入的 deliverRevision 完成，避免把出图/群发送逻辑复制一份。
 */
const { relation } = require('./v1ReferenceResolver');
const { linkedRecordIds } = require('./v1Gateway/cells');
const { createOnceByKey, IDEMPOTENCY_KEY_FIELD } = require('../infrastructure/idempotencyKey');
const { planModification } = require('./procurementModifyPlan');
const { PURCHASE_BEHAVIORS } = require('../config/purchaseBehaviors');

const reject = (code, message) => ({ ok: false, code, message });
const productIdsOf = (items) => [...new Set(items.map((item) => item.productRecordId).filter(Boolean))];

const createProcurementModifyService = ({
  gateway, schema, submissionIndex, purchaseQuery, orderBatches, sizeReferences,
  deliverRevision, now = () => Date.now(), logger = {},
} = {}) => {
  if (!gateway) throw new Error('procurementModifyService 需要 gateway');
  if (!submissionIndex || !purchaseQuery || !orderBatches) throw new Error('procurementModifyService 缺少依赖');
  const salesFields = schema?.tables?.salesDetail?.fields || {};

  const linkedSalesOf = async (recordId) => {
    const cell = await gateway.get('purchaseRequest', recordId);
    const field = schema?.tables?.purchaseRequest?.readOnlyFields?.salesDetails?.name || '销售明细';
    return linkedRecordIds(cell?.fields?.[field]).filter(Boolean);
  };

  const unlinkSales = async (salesIds) => {
    for (const id of [...new Set(salesIds.filter(Boolean))]) {
      await gateway.update('salesDetail', id, { purchaseDetail: [] });
    }
  };

  const trimSalesForQuantity = async (recordId, quantity) => {
    const ids = await linkedSalesOf(recordId);
    if (ids.length <= quantity) return;
    const records = await gateway.getBatch('salesDetail', ids);
    const ordered = (records || [])
      .map((record) => ({ record, soldAt: Number(record?.fields?.[salesFields.soldAt]) || 0 }))
      .sort((a, b) => a.soldAt - b.soldAt)
      .map((entry) => entry.record?.record_id)
      .filter(Boolean);
    await unlinkSales(ordered.slice(quantity));
  };

  const modify = async ({ openId, batchNo, submitKey, items = [] } = {}) => {
    const wantedBatch = String(batchNo || '').trim();
    if (!wantedBatch) return reject('batch_missing', '缺少报货批次号');
    const today = await submissionIndex.listToday(openId);
    if (!today.some((row) => String(row.batch_no) === wantedBatch)) {
      return reject('not_modifiable', '只能修改当前登录人今天提交的批次');
    }
    const currentRows = (await purchaseQuery.listPurchaseRequestsForBatch({ batchNo: wantedBatch }))
      .filter((row) => row.behavior_code === PURCHASE_BEHAVIORS.order);
    if (!currentRows.length) return reject('not_modifiable', '这个批次不是未到货的报货批次');
    const batch = await orderBatches.findByBatchNo(wantedBatch);
    if (!batch) return reject('batch_missing', '找不到这个采购批次');
    const plan = planModification({ currentItems: currentRows, finalItems: items });
    if (!plan.final.length) return reject('empty_batch', '至少要保留一件货品');

    const productIds = productIdsOf(plan.creates);
    const products = productIds.length ? await gateway.getBatch('product', productIds) : [];
    const productMap = new Map((products || []).map((record) => [record.record_id, record]));
    const productFields = schema?.tables?.product?.fields || {};
    const batchSupplier = String(currentRows[0]?.supplier_record_id || '');
    const createdItems = [];
    for (const row of plan.creates) {
      const product = productMap.get(row.productRecordId);
      const supplierId = linkedRecordIds(product?.fields?.[productFields.supplier])[0] || '';
      if (batchSupplier && supplierId && supplierId !== batchSupplier) {
        return reject('supplier_mismatch', '修改批次不能加入其他供应商的货品');
      }
      const size = await sizeReferences.resolveByNumber(row.size);
      if (!size?.recordId) return reject('size_missing', '尺码不存在');
      const key = 'purchase_modify:' + wantedBatch + ':' + row.productRecordId + ':' + row.size + ':' + String(submitKey || '');
      await createOnceByKey({
        gateway,
        tableKey: 'purchaseRequest',
        keyField: IDEMPOTENCY_KEY_FIELD,
        keyValue: key,
        label: '采购修改明细',
        values: {
          batchNo: relation(batch.record_id),
          product: relation(row.productRecordId),
          size: relation(size.recordId),
          quantity: row.quantity,
          idempotencyKey: key,
        },
      });
      createdItems.push(row);
    }
    for (const row of plan.updates) {
      await gateway.update('purchaseRequest', row.recordId, { quantity: row.quantity });
      await trimSalesForQuantity(row.recordId, row.quantity);
    }
    for (const row of plan.deletes) {
      const salesIds = await linkedSalesOf(row.recordId).catch(() => []);
      await gateway.delete('purchaseRequest', row.recordId);
      await unlinkSales(salesIds);
    }
    await gateway.update('purchaseOrderBatch', batch.record_id, { quantity: plan.totalQuantity });

    const finalRows = [
      ...currentRows.filter((row) => !plan.deletes.some((gone) => gone.recordId === row.record_id)),
      ...createdItems,
    ].map((row) => ({ ...row, quantity: plan.updates.find((up) => up.recordId === row.record_id)?.quantity ?? row.quantity }));

    let delivery = { ok: true, skipped: true };
    if (typeof deliverRevision === 'function') {
      delivery = await deliverRevision({
        batchNo: wantedBatch,
        batchRecordId: batch.record_id,
        openId,
        items: finalRows,
        totalQuantity: plan.totalQuantity,
        updatedAt: new Date(now()).toISOString(),
      });
    }
    return { ok: true, plan, delivery };
  };

  return { modify };
};

module.exports = { createProcurementModifyService };
