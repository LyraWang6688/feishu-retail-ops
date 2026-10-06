const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { classifyReportBehavior, REPORT_BEHAVIOR } = require('./purchaseReportBehaviorPolicy');

const asText = (tableKey, record, semanticKey) => {
  const fieldName = V1_BITABLE_SCHEMA.tables[tableKey]?.fields?.[semanticKey];
  return fieldName ? textValue(record?.fields?.[fieldName]).trim() : '';
};

const asLinks = (tableKey, record, semanticKey) => {
  const fieldName = V1_BITABLE_SCHEMA.tables[tableKey]?.fields?.[semanticKey];
  return fieldName ? linkedRecordIds(record?.fields?.[fieldName]) : [];
};

const asNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(textValue(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
};

const asDate = (value) => {
  if (value == null || value === '') return null;
  const raw = typeof value === 'number' ? value : textValue(value).trim();
  if (raw === '') return null;
  const timestamp = typeof raw === 'number' || /^\d{10,13}$/.test(raw) ? Number(raw) : null;
  const date = timestamp === null ? new Date(raw) : new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const indexByRecordId = (records) => new Map(records.map((r) => [r.record_id, r]));

const createPurchaseQueryService = (gateway, options = {}) => {
  if (!gateway) throw new Error('PurchaseQueryService requires gateway');
  // 查询结果里的尺码要还原成整数，仍走共享的尺码服务。
  const getSizeReferences = createSizeReferenceAccess({
    gateway, sizeReferences: options.sizeReferences,
  });

  const listPurchaseRequests = async (filters = {}) => {
    const [requests, products, batches, behaviors] = await Promise.all([
      gateway.listAll('purchaseRequest'),
      gateway.listAll('product'),
      gateway.listAll('purchaseOrderBatch'),
      // 「单据信息」的「采购行为」是关联「行为管理」：采购申请与采购退货写在同一张表里，
      // 靠这一列分流。分流口径复用采购链路的同一份策略（purchaseReportBehaviorPolicy），
      // 不在查询里另写一套判断——两套判断迟早在"什么算退货"上分家。
      gateway.listAll('behavior'),
    ]);
    const productMap = indexByRecordId(products);
    const batchMap = indexByRecordId(batches);
    const behaviorMap = indexByRecordId(behaviors);

    const rows = await Promise.all(requests.map(async (record) => {
      const productIds = asLinks('purchaseRequest', record, 'product');
      const product = productIds.length ? productMap.get(productIds[0]) : null;
      const batchIds = asLinks('purchaseRequest', record, 'batchNo');
      const batch = batchIds.length ? batchMap.get(batchIds[0]) : null;
      const batchNo = batch ? asText('purchaseOrderBatch', batch, 'batchNo') : '';
      const supplierIds = product ? asLinks('product', product, 'supplier') : [];
      const behaviorIds = asLinks('purchaseRequest', record, 'behavior');
      const behavior = behaviorIds.length ? behaviorMap.get(behaviorIds[0]) : null;
      const size = await getSizeReferences().resolveLinkedCell(
        record?.fields?.[V1_BITABLE_SCHEMA.tables.purchaseRequest.fields.size]
      );
      return {
        record_id: record.record_id,
        batch_no: batchNo,
        product_number: product ? asText('product', product, 'number') : '',
        product_record_id: productIds[0] || '',
        size: size.size,
        quantity: asNumber(record?.fields?.[V1_BITABLE_SCHEMA.tables.purchaseRequest.fields.quantity]),
        arrival_status: asText('purchaseRequest', record, 'arrivalStatus'),
        supplier_record_id: supplierIds[0] || '',
        // 'purchase_request' | 'purchase_return'（读不到行为记录时按现状=采购申请）
        report_behavior: classifyReportBehavior({
          name: behavior ? asText('behavior', behavior, 'name') : '',
          code: behavior ? asText('behavior', behavior, 'code') : '',
        }),
        report_behavior_name: behavior ? asText('behavior', behavior, 'name') : '',
      };
    }));

    return rows.filter((row) => {
      if (filters.batchNo && row.batch_no !== filters.batchNo) return false;
      if (filters.arrivalStatus && row.arrival_status !== filters.arrivalStatus) return false;
      if (filters.reportBehavior && row.report_behavior !== filters.reportBehavior) return false;
      return true;
    }).sort((a, b) => String(b.batch_no).localeCompare(String(a.batch_no)) || a.size - b.size);
  };

  const listPurchaseArrivals = async (filters = {}) => {
    const [arrivals, batches] = await Promise.all([
      gateway.listAll('purchaseArrival'),
      gateway.listAll('purchaseOrderBatch'),
    ]);
    const batchMap = indexByRecordId(batches);

    const rows = arrivals.map((record) => {
      const batchIds = asLinks('purchaseArrival', record, 'batch');
      const batch = batchIds.length ? batchMap.get(batchIds[0]) : null;
      const batchNo = batch ? asText('purchaseOrderBatch', batch, 'batchNo') : '';
      const images = record?.fields?.[V1_BITABLE_SCHEMA.tables.purchaseArrival.fields.images];
      const imageCount = Array.isArray(images) ? images.length : 0;
      return {
        record_id: record.record_id,
        batch_no: batchNo,
        batch_record_id: batchIds[0] || '',
        supplier_record_id: '',
        arrival_at: asDate(record?.fields?.[V1_BITABLE_SCHEMA.tables.purchaseArrival.fields.arrivalAt]),
        // ⚠️ 2026-10-05：原先这里还有 recognition_status / failure_reason 两项，
        // 它们的源字段（识别状态 / 识别失败原因）已被业务负责人从生产表删除，
        // 拍照识别链路也整体退场，所以一并去掉——留着只会永远返回空串，
        // 让查的人以为「识别还没跑」。
        confirm_status: asText('purchaseArrival', record, 'confirmStatus'),
        image_count: imageCount,
      };
    });

    return rows.filter((row) => {
      if (filters.batchNo && row.batch_no !== filters.batchNo) return false;
      if (filters.confirmStatus && row.confirm_status !== filters.confirmStatus) return false;
      return true;
    }).sort((a, b) => {
      const aTime = a.arrival_at ? new Date(a.arrival_at).getTime() : 0;
      const bTime = b.arrival_at ? new Date(b.arrival_at).getTime() : 0;
      return bTime - aTime;
    });
  };

  return { listPurchaseRequests, listPurchaseArrivals };
};

module.exports = { createPurchaseQueryService, REPORT_BEHAVIOR };
