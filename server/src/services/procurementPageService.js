'use strict';

/**
 * 采购页**只读读模型**（一个模块只干一件事：把飞书原始记录读成页面要的结构）。
 *
 * 边界：
 *   · 只读 —— 本模块**不出现**任何 `gateway.create/update`（提交走 `procurementPageSubmitService`）；
 *   · 字段名一律从 `config/v1BitableSchema.js` 的语义键解析（不写死中文列名）；
 *   · 分组 / 窗口 / 统计这些**纯逻辑**在 `services/procurementPageData.js`（本文件只做 I/O + 判据注入）；
 *   · 交易类型判据**复用 `config/salesMovements.js`**（行为表里认不出 ⇒ 不计入，不猜）。
 *
 * 补货读两个来源（2026-11-21）：
 *   · 销售明细（近 7 天、库存数量=0）→ 现货 / 预订；
 *   · 采购明细（数量 - 已入库数量 > 0）→ 未到货。
 */

const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { PROCUREMENT_PAGE } = require('../config/procurementPage');
const { PURCHASE_BEHAVIORS } = require('../config/purchaseBehaviors');
const { isSalesTradeType, tradeTypeCodeFromLabel } = require('../config/salesMovements');
const { createProductEnricher } = require('./procurementProductEnricher');
const { filterActiveProductsFor } = require('./productLifecycle');
const { logInfo, logWarn } = require('../utils/logger');
const { getConfigRows } = require('./configTableCache');
const { textOf, buildReplenishView } = require('./procurementPageData');
const { linkedRecordIds } = require('./v1Gateway/cells');
const { buildNewProductsView } = require('./procurementPageNewProductsData');
const { resolveOrderReadRetryConfig, isRetriableOrderReadError } = require('../config/orderReadRetry');

const fill = (template, values) => String(template || '').replace(/\{(\w+)\}/g, (match, key) => (
  Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
));

const createProcurementPageService = (options = {}) => {
  const gateway = options.gateway || null;
  const schema = options.schema || V1_BITABLE_SCHEMA;
  const config = options.config || PROCUREMENT_PAGE;
  const now = options.now || (() => Date.now());
  const logger = options.logger || { logInfo, logWarn };
  const info = typeof logger.logInfo === 'function' ? logger.logInfo : () => {};
  const warn = typeof logger.logWarn === 'function' ? logger.logWarn : () => {};
  if (!gateway) throw new Error('procurementPageService 需要 gateway');

  const salesFields = () => (schema.tables?.salesDetail?.fields) || {};
  const purchaseBatchFields = () => (schema.tables?.purchaseOrderBatch?.fields) || {};
  const supplierFields = () => (schema.tables?.supplier?.fields) || {};
  const loadSupplierNames = async () => {
    const fields = supplierFields();
    const rows = await getConfigRows({ gateway, tableKey: 'supplier' });
    const map = new Map();
    for (const row of rows || []) {
      const name = textOf(row?.fields?.[fields.name]).trim();
      if (row?.record_id && name) map.set(String(row.record_id), name);
    }
    return map;
  };
  const purchaseFields = () => ({
    ...(schema.tables?.purchaseRequest?.fields || {}),
    ...Object.fromEntries(Object.entries(schema.tables?.purchaseRequest?.readOnlyFields || {})
      .map(([key, value]) => [key, value?.name || value])),
  });
  const enricher = options.enricher || createProductEnricher({ gateway, schema, logger });
  const productFields = () => (schema.tables?.product?.fields) || {};
  const readRetry = options.readRetry || resolveOrderReadRetryConfig();
  const sleep = options.sleep || ((ms) => (ms > 0 ? new Promise((resolve) => { setTimeout(resolve, ms); }) : Promise.resolve()));
  const retryRead = async (tableKey, read) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await read();
      } catch (error) {
        if (!isRetriableOrderReadError(error) || attempt >= readRetry.maxRetries) throw error;
        const delayMs = Math.max(0, Number(readRetry.delayMs)) * (attempt + 1);
        warn('workbench.procurement.read_retry', {
          table_key: tableKey, attempt: attempt + 1, of: readRetry.maxRetries + 1, delay_ms: delayMs,
        });
        await sleep(delayMs);
      }
    }
  };
  const listByFilterWithRetry = (tableKey, filter) => retryRead(tableKey, () => gateway.listByFilter(tableKey, filter));
  const listAllWithRetry = (tableKey) => retryRead(tableKey, () => gateway.listAll(tableKey));

  // ── 行为表索引（记录ID → 行为编码）—— 唯一用途：把「销售明细.交易类型」的关联解析成现货/预订 ──
  const loadBehaviorIndex = async () => {
    const fields = (schema.tables?.behavior?.fields) || {};
    const records = await getConfigRows({ gateway, tableKey: 'behavior' });
    const index = new Map();
    for (const record of records || []) {
      const code = textOf(record?.fields?.[fields.code]).trim();
      if (record?.record_id && code) index.set(String(record.record_id), code);
    }
    return index;
  };

  /** 交易类型单元格 → 编码（关联记录优先，回落显示文本；认不出 ⇒ ''，由纯函数丢弃该行）。 */
  const tradeTypeCodeOf = (cell, index) => {
    for (const id of linkedRecordIds(cell)) {
      const code = index.get(id);
      if (isSalesTradeType(code)) return code;
    }
    const byLabel = tradeTypeCodeFromLabel(textOf(cell));
    return isSalesTradeType(byLabel) ? byLabel : '';
  };

  const loadReplenish = async ({ requestId = '' } = {}) => {
    const startedAt = Date.now();
    const fields = salesFields();
    const filter = fill(config.filters.replenish, {
      stockField: fields.stockQuantity, dateField: fields.soldAt, days: config.window.replenishDays,
    });
    const records = await listByFilterWithRetry('salesDetail', filter);
    // 补货来源 B：采购明细中「已入库数量 < 数量」的行；读失败如实让页面失败，不静默少来源。
    const pendingFieldNames = purchaseFields();
    const behaviorIndex = await loadBehaviorIndex();
    const pendingRows = await listAllWithRetry('purchaseRequest');
    const batches = await listAllWithRetry('purchaseOrderBatch');
    const batchFields = purchaseBatchFields();
    const batchById = new Map((batches || []).map((row) => [row.record_id, row]));
    const pendingRecords = (pendingRows || []).filter((row) => {
      const batchIds = linkedRecordIds(row?.fields?.[pendingFieldNames.batchNo]);
      // 老行没有批次关联时保留；有批次的必须排除「采购退货」批次。
      if (!batchIds.length) return true;
      return !batchIds.some((id) => {
        const batch = batchById.get(id);
        const behaviorIds = linkedRecordIds(batch?.fields?.[batchFields.behavior]);
        return behaviorIds.some((behaviorId) => behaviorIndex.get(behaviorId) === PURCHASE_BEHAVIORS.return);
      });
    });
    const productIds = [
      ...(records || []).flatMap((record) => linkedRecordIds(record?.fields?.[fields.product])),
      ...(pendingRecords || []).flatMap((record) => linkedRecordIds(record?.fields?.[pendingFieldNames.product])),
    ];
    // 补货卡片要用「货号 / 颜色」—— 从「货品信息」按记录 ID 批量反查并**归一化**
    // （getBatch 的形状与列表接口不同：颜色是关联列无显示文本 ⇒ 由 enricher 解析颜色名）
    const products = await enricher.enrich([...new Set(productIds.filter(Boolean))]);
    const supplierNames = await loadSupplierNames();
    const productsWithSupplier = new Map([...products].map(([id, dto]) => [id, {
      ...dto,
      supplierName: supplierNames.get(String(dto?.supplierRecordId || '')) || dto?.supplierName || '',
    }]));
    const view = buildReplenishView({
      records, pendingRecords, products: productsWithSupplier, fields, productFields: productFields(), purchaseFields: pendingFieldNames,
      config, now: now(), tradeTypeCodeOf: (cell) => tradeTypeCodeOf(cell, behaviorIndex),
    });
    // ⭐ 只有**真的认不出贸易类型**的行才记 `trade_type_unknown`。
    if (view.tradeTypeUnknownRows > 0) {
      warn(config.events.tradeTypeUnknown, {
        request_id: requestId,
        skipped_rows: view.skippedRows,
        trade_type_unknown_rows: view.tradeTypeUnknownRows,
      });
    }
    info(config.events.replenishLoaded, {
      request_id: requestId,
      rows: (records || []).length,
      groups: view.stats.productCount,
      spot_sold: view.stats.spotSold,
      prepaid_pending: view.stats.prepaidPending,
      not_arrived: view.stats.notArrived,
      pending_rows: (pendingRecords || []).length,
      // 只报事实：跳过多少、其中"已报过货"多少（排查"补货怎么少了"用）
      skipped_rows: view.skippedRows,
      duration_ms: Date.now() - startedAt,
    });
    return { ok: true, ...view };
  };

  const loadNewProducts = async ({ requestId = '' } = {}) => {
    const startedAt = Date.now();
    const fields = productFields();
    const filter = fill(config.filters.newProducts, {
      dateField: fields.createdAt,
      // 7 个自然日（含今天）= 往前 6 天。
      days: Math.max(0, Number(config.window.newProductsDays || 1) - 1),
    });
    // 上新建议同样排除已下架货品（与补货建议同一份生命周期判据）。
    const records = filterActiveProductsFor(await listByFilterWithRetry('product', filter), 'purchasePicker');
    const view = buildNewProductsView({ records, fields, config, now: now() });
    info(config.events.newProductsLoaded, {
      request_id: requestId,
      rows: (records || []).length,
      products: view.stats.productCount,
      duration_ms: Date.now() - startedAt,
    });
    return { ok: true, ...view };
  };

  return {
    loadReplenish,
    loadNewProducts,
    // 只读暴露（排查 / 用例）
    _tradeTypeCodeOf: tradeTypeCodeOf,
    _loadBehaviorIndex: loadBehaviorIndex,
  };
};

module.exports = { createProcurementPageService };
