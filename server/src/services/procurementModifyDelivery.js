'use strict';

/**
 * 修改批次后的“重新出整批采购单 + 发回原话题”。
 * 只复用既有 PurchaseWebhookService.deliverSupplierImages，不另写一套发群/附件逻辑。
 */
const { documentFileNameOf } = require('./supplierSplitService');

const createProcurementModifyDelivery = ({ gateway, schema, config, purchaseWebhooks, orderBatches, batchLocator, now = () => Date.now() }) => {
  if (!gateway || !purchaseWebhooks || !orderBatches || !batchLocator) {
    throw new Error('procurementModifyDelivery 缺少依赖');
  }
  const docField = schema?.tables?.purchaseOrderBatch?.fields?.document;
  if (!docField) throw new Error('purchaseOrderBatch.document field is not configured');
  const modifyConfig = config?.modify || {};

  const deliver = async ({ batchNo, batchRecordId, openId, items, totalQuantity }) => {
    const batch = await orderBatches.findByBatchNo(batchNo);
    if (!batch) throw new Error('找不到采购批次，无法更新单据');
    const supplierName = String(items[0]?.supplier_name || '').trim();
    const fileName = documentFileNameOf(supplierName, modifyConfig.documentFileNameSuffix);
    const cell = Array.isArray(batch.fields?.[docField]) ? batch.fields[docField] : [];
    const remaining = cell.filter((item) => String(item?.name || '') !== fileName)
      .map((item) => ({ file_token: item.file_token || item.fileToken || item.token }))
      .filter((item) => item.file_token);
    await gateway.update('purchaseOrderBatch', batchRecordId || batch.record_id, { document: remaining });

    const messages = await batchLocator.findByBatchNo(batchNo);
    const root = (messages || []).find((row) => row?.message_id);
    if (!root?.message_id) throw new Error('原采购批次没有群话题映射，不能另开话题');

    const task = {
      draft: {
        batch_no: batchNo,
        operator_open_id: openId,
        items: (items || []).map((row) => ({
          product_record_id: row.product_record_id || row.productRecordId,
          supplier_record_id: row.supplier_record_id || '',
          size: Number(row.size),
          quantity: Number(row.quantity),
          item_no: row.product_item_no || row.item_no || '',
          number: row.product_number || row.number || '',
          color: row.product_color || row.color || '',
        })),
      },
    };
    const posting = { batch_no: batchNo, request_ids: [], total_quantity: totalQuantity };
    const delivery = await purchaseWebhooks.deliverSupplierImages(
      'procurement_modify_' + batchNo + '_' + now(),
      task,
      posting,
      {
        threadRootMessageId: root.message_id,
        noticeText: modifyConfig.noticeText,
        fileNameSuffix: modifyConfig.documentFileNameSuffix,
      },
    );
    return delivery;
  };
  return { deliver };
};

module.exports = { createProcurementModifyDelivery };
