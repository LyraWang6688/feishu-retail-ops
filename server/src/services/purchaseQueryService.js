const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');

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
  let sizeReferences = options.sizeReferences || null;
  const getSizeReferences = () => {
    if (!sizeReferences) {
      const { SizeReferenceService } = require('./sizeReferenceService');
      sizeReferences = new SizeReferenceService({ gateway });
    }
    return sizeReferences;
  };

  const listPurchaseRequests = async (filters = {}) => {
    const [requests, products, batches] = await Promise.all([
      gateway.listAll('purchaseRequest'),
      gateway.listAll('product'),
      gateway.listAll('purchaseOrderBatch'),
    ]);
    const productMap = indexByRecordId(products);
    const batchMap = indexByRecordId(batches);

    const rows = await Promise.all(requests.map(async (record) => {
      const productIds = asLinks('purchaseRequest', record, 'product');
      const product = productIds.length ? productMap.get(productIds[0]) : null;
      const batchIds = asLinks('purchaseRequest', record, 'batchNo');
      const batch = batchIds.length ? batchMap.get(batchIds[0]) : null;
      const batchNo = batch ? asText('purchaseOrderBatch', batch, 'batchNo') : '';
      const supplierIds = product ? asLinks('product', product, 'supplier') : [];
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
      };
    }));

    return rows.filter((row) => {
      if (filters.batchNo && row.batch_no !== filters.batchNo) return false;
      if (filters.arrivalStatus && row.arrival_status !== filters.arrivalStatus) return false;
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
        recognition_status: asText('purchaseArrival', record, 'recognitionStatus'),
        confirm_status: asText('purchaseArrival', record, 'confirmStatus'),
        failure_reason: asText('purchaseArrival', record, 'failureReason'),
        image_count: imageCount,
      };
    });

    return rows.filter((row) => {
      if (filters.batchNo && row.batch_no !== filters.batchNo) return false;
      if (filters.confirmStatus && row.confirm_status !== filters.confirmStatus) return false;
      if (filters.recognitionStatus && row.recognition_status !== filters.recognitionStatus) return false;
      return true;
    }).sort((a, b) => {
      const aTime = a.arrival_at ? new Date(a.arrival_at).getTime() : 0;
      const bTime = b.arrival_at ? new Date(b.arrival_at).getTime() : 0;
      return bTime - aTime;
    });
  };

  return { listPurchaseRequests, listPurchaseArrivals };
};

module.exports = { createPurchaseQueryService };
