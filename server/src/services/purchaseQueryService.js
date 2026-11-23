const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const {textValue} = require('./v1BitableGateway');
const { strictLinkedRecordIds } = require('./strictLinkIds');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { getConfigRows } = require('./configTableCache');
const { isDelistedRecord } = require('./productLifecycle');
const { PRODUCT_LIFECYCLE } = require('../config/productLifecycle');
const { CRITICAL_READ_RETRY } = require('../config/gatewayReadRetry');

const asText = (tableKey, record, semanticKey) => {
  const fieldName = V1_BITABLE_SCHEMA.tables[tableKey]?.fields?.[semanticKey];
  return fieldName ? textValue(record?.fields?.[fieldName]).trim() : '';
};

const asLinks = (tableKey, record, semanticKey) => {
  const fieldName = V1_BITABLE_SCHEMA.tables[tableKey]?.fields?.[semanticKey];
  return fieldName ? strictLinkedRecordIds(record?.fields?.[fieldName]) : [];
};

const asNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(textValue(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
};

const indexByRecordId = (records) => new Map(records.map((r) => [r.record_id, r]));

const behaviorInfoOf = (behavior) => ({
  behavior_code: behavior ? asText('behavior', behavior, 'code') : '',
  behavior_name: behavior ? asText('behavior', behavior, 'name') : '',
});

/**
 * ⭐⭐ 2026-10-14（她真机：工作台「采购 → 验收」显示"采购申请读取失败"，且那一屏很慢）：
 *   实测（服务器上只读复现）：`listPurchaseRequests` 一次要 **8~11 秒** ✗ —— 因为它**并发整表读 4 张表**
 *   （采购申请 / 货品 / 报货批次 / 行为管理 ✓）。偶发 400（像限流/超时 ✗）。
 *
 * ⇒ 这里给"整表读"加一层**短时缓存**（TTL **可配** ✓ 配置先行 ✓ 不写死 ✗）：
 *   · 🔴 **只影响读** ✗：写入路径一个字都不碰 ✓
 *   · 🔴 **不许改变查询结果**：缓存的就是 `gateway.listAll` 的原样返回 ✓（既有断言逐字不变 ✓）
 *   · ⭐ 键里**带 tableKey**（同一进程内不串表 ✓）；`ttl<=0` = 关掉缓存（测试/排查用 ✓）
 */
const createTableReadCache = ({ ttlMs, now }) => {
  const store = new Map();
  const enabled = Number(ttlMs) > 0;
  return async (tableKey, read) => {
    if (!enabled) return read();
    const hit = store.get(tableKey);
    const stamp = now();
    if (hit && stamp - hit.at < Number(ttlMs)) return hit.value;
    const value = await read();
    store.set(tableKey, { value, at: stamp });
    return value;
  };
};

const createPurchaseQueryService = (gateway, options = {}) => {
  if (!gateway) throw new Error('PurchaseQueryService requires gateway');
  // 查询结果里的尺码要还原成整数，仍走共享的尺码服务。
  const getSizeReferences = createSizeReferenceAccess({
    gateway, sizeReferences: options.sizeReferences,
  });
  // ⭐ 整表读的短时缓存（TTL 可配；`<=0` = 关 ✓）
  const tableTtlMs = options.tableCacheTtlMs === undefined ? 60_000 : options.tableCacheTtlMs;
  const cachedListAll = createTableReadCache({ ttlMs: tableTtlMs, now: options.now || (() => Date.now()) });

  /**
   * 2026-11-19：按报货批次读**本批采购明细**（不再整表读后过滤）。
   * 「供应主表.采购明细」是双向关联，直接拿本批明细 record_id → getBatch。
   * 关联字段不能用于飞书 filter（项目已实测），所以走主表 link 是最稳的按批次下推。
   */
  const listPurchaseRequestsForBatch = async ({ batchNo = '' } = {}) => {
    const wanted = String(batchNo || '').trim();
    if (!wanted) return [];
    const [batches, products, behaviors, suppliers] = await Promise.all([
      cachedListAll('purchaseOrderBatch', () => gateway.listAll('purchaseOrderBatch', { retry: CRITICAL_READ_RETRY })),
      getConfigRows({ gateway, tableKey: 'product' }),
      getConfigRows({ gateway, tableKey: 'behavior' }),
      getConfigRows({ gateway, tableKey: 'supplier' }),
    ]);
    const batch = (batches || []).find((record) => asText('purchaseOrderBatch', record, 'batchNo') === wanted);
    if (!batch) return [];
    const detailIds = asLinks('purchaseOrderBatch', batch, 'details');
    let requests = [];
    if (detailIds.length && typeof gateway.getBatch === 'function') {
      requests = await gateway.getBatch('purchaseRequest', detailIds);
    } else {
      // 老批次没有反向 link 时回退；结果仍按 batchNo 过滤。
      requests = await cachedListAll('purchaseRequest', () => gateway.listAll('purchaseRequest', { retry: CRITICAL_READ_RETRY }));
    }
    const productMap = indexByRecordId(products);
    const behaviorMap = indexByRecordId(behaviors);
    const supplierMap = indexByRecordId(suppliers);
    const behaviorIds = asLinks('purchaseOrderBatch', batch, 'behavior');
    const behavior = behaviorIds.length ? behaviorMap.get(behaviorIds[0]) : null;
    const rows = await Promise.all((requests || []).map(async (record) => {
      const productIds = asLinks('purchaseRequest', record, 'product');
      const product = productIds.length ? productMap.get(productIds[0]) : null;
      const recordBatchIds = asLinks('purchaseRequest', record, 'batchNo');
      const recordBatch = recordBatchIds.length
        ? (batches || []).find((item) => item.record_id === recordBatchIds[0]) : null;
      if (recordBatch && asText('purchaseOrderBatch', recordBatch, 'batchNo') !== wanted) return null;
      const size = await getSizeReferences().resolveLinkedCell(
        record?.fields?.[V1_BITABLE_SCHEMA.tables.purchaseRequest.fields.size]
      );
      const supplierIds = product ? asLinks('product', product, 'supplier') : [];
      return {
        record_id: record.record_id,
        batch_no: wanted,
        product_number: product ? asText('product', product, 'number') : '',
        product_record_id: productIds[0] || '',
        size: size.size,
        quantity: asNumber(record?.fields?.[V1_BITABLE_SCHEMA.tables.purchaseRequest.fields.quantity]),
        ...behaviorInfoOf(behavior),
        supplier_record_id: supplierIds[0] || '',
        product_item_no: product ? asText('product', product, 'itemNo') : '',
        product_color: product ? asText('product', product, 'color') : '',
        ...(product && isDelistedRecord(product) ? { product_delisted: true, product_delisted_label: PRODUCT_LIFECYCLE.labels.delisted } : {}),
        supplier_name: supplierIds[0] ? asText('supplier', supplierMap.get(supplierIds[0]), 'name') : '',
        arrival_created_at: asNumber(batch?.fields?.[V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields.createdAt]),
      };
    }));
    return rows.filter(Boolean).sort((a, b) => a.size - b.size);
  };

  const listPurchaseRequests = async (filters = {}) => {
    const [requests, products, batches, behaviors, suppliers] = await Promise.all([
      cachedListAll('purchaseRequest', () => gateway.listAll('purchaseRequest', { retry: CRITICAL_READ_RETRY })),
      getConfigRows({ gateway, tableKey: 'product' }),
      cachedListAll('purchaseOrderBatch', () => gateway.listAll('purchaseOrderBatch', { retry: CRITICAL_READ_RETRY })),
      // ⚠️ 第 4 张（行为管理）也要缓存 ⇒ 否则"第二次快"不成立 ✗（4 张里漏 1 张 = 白等 ✗）
      getConfigRows({ gateway, tableKey: 'behavior' }),
      // ⭐ 2026-11-09（验收页按供应商分组）：供应商名称取自「供应商管理」（configTableCache ✓）
      getConfigRows({ gateway, tableKey: 'supplier' }),
      // 「报货信息」的「采购行为」是关联「行为管理」：采购申请与采购退货写在同一张表里，
      // 查询直接投影 behavior_code / behavior_name；调用方按编码精确筛选。
    ]);
    const productMap = indexByRecordId(products);
    const batchMap = indexByRecordId(batches);
    const behaviorMap = indexByRecordId(behaviors);
    const supplierMap = indexByRecordId(suppliers);

    const rows = await Promise.all(requests.map(async (record) => {
      const productIds = asLinks('purchaseRequest', record, 'product');
      const product = productIds.length ? productMap.get(productIds[0]) : null;
      const batchIds = asLinks('purchaseRequest', record, 'batchNo');
      const batch = batchIds.length ? batchMap.get(batchIds[0]) : null;
      const batchNo = batch ? asText('purchaseOrderBatch', batch, 'batchNo') : '';
      const supplierIds = product ? asLinks('product', product, 'supplier') : [];
      // ⭐⭐ 2026-10-17（业务负责人逐字）：「直接去看采购主表里面的采购行为（字段名改成了发生行为），
      //   只筛选出『报货』的状态就可以了，退货的状态不用筛」
      //   ⇒ 分流读**报货批次**那一行的行为（明细行的那个是 Lookup、一直是空 ⇒ 全被默认成报货 ✗）。
      const behaviorIds = batch ? asLinks('purchaseOrderBatch', batch, 'behavior') : [];
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
        ...behaviorInfoOf(behavior),
        supplier_record_id: supplierIds[0] || '',
        // ⭐ 2026-11-09：验收页按「供应商 → 采购日」分组（不显示采购单号）——
        //   · supplier_name：供应商管理.供应商名称（空 ⇒ 前端显示"未标注供应商"，不编 ✗）
        //   · arrival_created_at：采购主表「报货日」（自动字段，epoch ms；空 ⇒ 前端显示"日期未知"）
        // ⭐ 2026-11-09（验收明细按「货号 · 颜色」分组，与采购页卡片标题同口径）：
        //   · 编号（语义键 `number`）= 「货号|颜色|类别」复合值（Base 里那一列就是这形状）；
        //   · 采购页显示的是「货号 · 颜色」⇒ 这里另补两个**只读**字段给明细分组用。
        product_item_no: product ? asText('product', product, 'itemNo') : '',
        product_color: product ? asText('product', product, 'color') : '',
        ...(product && isDelistedRecord(product) ? { product_delisted: true, product_delisted_label: PRODUCT_LIFECYCLE.labels.delisted } : {}),
        supplier_name: supplierIds[0]
          ? asText('supplier', supplierMap.get(supplierIds[0]), 'name') : '',
        arrival_created_at: batch
          ? asNumber(batch?.fields?.[V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields.createdAt]) : null,
        // 'purchase_request' | 'purchase_return'（读不到行为记录时按现状=采购申请）
      };
    }));

    return rows.filter((row) => {
      if (filters.batchNo && row.batch_no !== filters.batchNo) return false;
      if (filters.behaviorCode && row.behavior_code !== filters.behaviorCode) return false;
      return true;
    }).sort((a, b) => String(b.batch_no).localeCompare(String(a.batch_no)) || a.size - b.size);
  };

  return { listPurchaseRequests, listPurchaseRequestsForBatch };
};

module.exports = { createPurchaseQueryService };
