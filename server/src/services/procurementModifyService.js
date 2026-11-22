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
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const { createProductEnricher } = require('./procurementProductEnricher');
const { createPurchaseDetailIdAllocator } = require('./purchaseDetailId');
const { planModification } = require('./procurementModifyPlan');
const { PURCHASE_BEHAVIORS } = require('../config/purchaseBehaviors');

const reject = (code, message) => ({ ok: false, code, message });
const productIdsOf = (items) => [...new Set(items.map((item) => item.productRecordId).filter(Boolean))];

const createProcurementModifyService = ({
  gateway, schema, config, submissionIndex, purchaseQuery, orderBatches, sizeReferences, salesLinks,
  deliverRevision, now = () => Date.now(), productEnricher, detailIds,
} = {}) => {
  if (!gateway) throw new Error('procurementModifyService 需要 gateway');
  if (!submissionIndex || !purchaseQuery || !orderBatches) throw new Error('procurementModifyService 缺少依赖');
  if (!sizeReferences) throw new Error('procurementModifyService 需要 sizeReferences');
  const salesFields = schema?.tables?.salesDetail?.fields || {};
  const modifyConfig = config?.modify || {};
  const texts = modifyConfig.texts || {};
  const products = productEnricher || createProductEnricher({ gateway, schema });
  const detailAllocator = detailIds || createPurchaseDetailIdAllocator({ gateway });
  const queue = new KeyedSerialQueue();

  const linkedSalesOf = async (recordId) => {
    const cell = await gateway.get('purchaseRequest', recordId);
    const field = schema?.tables?.purchaseRequest?.readOnlyFields?.salesDetails?.name;
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

  const modifyOnce = async ({ openId, batchNo, submitKey, items = [] } = {}) => {
    const wantedBatch = String(batchNo || '').trim();
    if (!wantedBatch) return reject('batch_missing', texts.batchMissing);
    const today = await submissionIndex.listToday(openId);
    if (!today.some((row) => String(row.batch_no) === wantedBatch)) {
      return reject('not_modifiable', texts.notModifiable);
    }
    const currentRows = (await purchaseQuery.listPurchaseRequestsForBatch({ batchNo: wantedBatch }))
      .filter((row) => row.behavior_code === PURCHASE_BEHAVIORS.order);
    if (!currentRows.length) return reject('not_modifiable', texts.notModifiable);
    const batch = await orderBatches.findByBatchNo(wantedBatch);
    if (!batch) return reject('batch_missing', texts.batchNotFound);
    const plan = planModification({ currentItems: currentRows, finalItems: items });
    if (!plan.final.length) return reject('empty_batch', texts.emptyBatch);

    const productIds = productIdsOf(plan.creates);
    const productMap = productIds.length ? await products.enrich(productIds) : new Map();
    const batchSupplier = String(currentRows[0]?.supplier_record_id || '');
    const batchSupplierName = String(currentRows[0]?.supplier_name || '');
    const detailCursor = await detailAllocator.open({
      batchRecordId: batch.record_id, batchNo: wantedBatch,
    });
    const createdItems = [];
    for (const row of plan.creates) {
      const product = productMap.get(row.productRecordId);
      if (!product) return reject('product_missing', config?.texts?.productMissing || texts.notModifiable);
      const supplierId = String(product.supplierRecordId || '');
      if (batchSupplier && supplierId && supplierId !== batchSupplier) {
        return reject('supplier_mismatch', texts.supplierMismatch);
      }
      const size = await sizeReferences.resolveByNumber(row.size);
      if (!size?.recordId) return reject('size_missing', texts.sizeMissing);
      const key = 'purchase_modify:' + wantedBatch + ':' + row.productRecordId + ':' + row.size + ':' + String(submitKey || '');
      const created = await createOnceByKey({
        gateway,
        tableKey: 'purchaseRequest',
        keyField: IDEMPOTENCY_KEY_FIELD,
        keyValue: key,
        label: modifyConfig.detailLabel,
        values: {
          batchNo: relation(batch.record_id),
          product: relation(row.productRecordId),
          size: relation(size.recordId),
          quantity: row.quantity,
          detailId: detailCursor.next(),
          idempotencyKey: key,
        },
      });
      createdItems.push({
        ...row,
        record_id: created.recordId,
        supplier_record_id: supplierId || batchSupplier,
        supplier_name: batchSupplierName,
        product_item_no: product.itemNo || '',
        product_number: product.number || '',
        product_color: product.color || '',
      });
    }
    const salesTargets = [];
    for (const row of plan.updates) {
      const old = plan.current.find((item) => item.recordId === row.recordId);
      const added = Number(row.quantity) - Number(old?.quantity || 0);
      if (added > 0) salesTargets.push({ recordId: row.recordId, productRecordId: row.productRecordId, size: row.size, quantity: added, source: row.source });
      await gateway.update('purchaseRequest', row.recordId, { quantity: row.quantity });
      await trimSalesForQuantity(row.recordId, row.quantity);
    }
    for (const row of plan.deletes) {
      const salesIds = await linkedSalesOf(row.recordId).catch(() => []);
      await gateway.delete('purchaseRequest', row.recordId);
      await unlinkSales(salesIds);
    }
    for (const row of createdItems) salesTargets.push({ recordId: row.record_id, productRecordId: row.productRecordId, size: row.size, quantity: row.quantity, source: row.source });
    await gateway.update('purchaseOrderBatch', batch.record_id, { quantity: plan.totalQuantity });
    const salesResult = salesLinks ? await salesLinks.apply(salesTargets) : { linked: 0, unmatched: 0 };

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
    return { ok: true, plan, delivery, sales: salesResult };
  };

  const modify = (input = {}) => queue.run(
    `procurement-modify:${String(input.batchNo || '')}`,
    () => modifyOnce(input),
  );

  return { modify };
};

module.exports = { createProcurementModifyService };
