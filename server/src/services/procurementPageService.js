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
 * 已知口径（2026-10-28 业务负责人确认）：补货**只查「销售明细」一张表**（库存数量是它上面的公式列）。
 */

const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { PROCUREMENT_PAGE } = require('../config/procurementPage');
const { isSalesTradeType, tradeTypeCodeFromLabel } = require('../config/salesMovements');
const { logInfo, logWarn } = require('../utils/logger');
const {
  textOf, linkedIdsOf, buildReplenishView,
} = require('./procurementPageData');
const { buildNewProductsView } = require('./procurementPageNewProductsData');

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
  const productFields = () => (schema.tables?.product?.fields) || {};

  // ── 行为表索引（记录ID → 行为编码）—— 唯一用途：把「销售明细.交易类型」的关联解析成现货/预订 ──
  let behaviorCache = { at: 0, index: null };
  const loadBehaviorIndex = async () => {
    const ttl = Number(config.caches?.behaviorMs) || 0;
    if (behaviorCache.index && ttl > 0 && now() - behaviorCache.at < ttl) return behaviorCache.index;
    const fields = (schema.tables?.behavior?.fields) || {};
    const records = await gateway.listAll('behavior');
    const index = new Map();
    for (const record of records || []) {
      const code = textOf(record?.fields?.[fields.code]).trim();
      if (record?.record_id && code) index.set(String(record.record_id), code);
    }
    behaviorCache = { at: now(), index };
    return index;
  };

  /** 交易类型单元格 → 编码（关联记录优先，回落显示文本；认不出 ⇒ ''，由纯函数丢弃该行）。 */
  const tradeTypeCodeOf = (cell, index) => {
    for (const id of linkedIdsOf(cell)) {
      const code = index.get(id);
      if (isSalesTradeType(code)) return code;
    }
    const byLabel = tradeTypeCodeFromLabel(textOf(cell));
    return isSalesTradeType(byLabel) ? byLabel : '';
  };

  const productMapOf = async (ids) => {
    const unique = [...new Set((ids || []).filter(Boolean))];
    if (!unique.length) return new Map();
    const records = await gateway.getBatch('product', unique);
    return new Map((records || []).map((record) => [String(record.record_id), record]));
  };

  const loadReplenish = async ({ requestId = '' } = {}) => {
    const startedAt = Date.now();
    const fields = salesFields();
    const filter = fill(config.filters.replenish, {
      stockField: fields.stockQuantity, dateField: fields.soldAt, days: config.window.replenishDays,
    });
    const records = await gateway.listByFilter('salesDetail', filter);
    const productIds = (records || []).flatMap((record) => linkedIdsOf(record?.fields?.[fields.product]));
    // 补货卡片要用「货号 / 颜色」，提交要用供应商 —— 都从「货品信息」按记录 ID 批量取（一次批量读）
    const products = await productMapOf(productIds);
    const behaviorIndex = await loadBehaviorIndex();
    const view = buildReplenishView({
      records, products, fields, productFields: productFields(), config, now: now(),
      tradeTypeCodeOf: (cell) => tradeTypeCodeOf(cell, behaviorIndex),
    });
    if (view.skippedRows > 0) {
      warn(config.events.tradeTypeUnknown, { request_id: requestId, skipped_rows: view.skippedRows });
    }
    info(config.events.replenishLoaded, {
      request_id: requestId,
      rows: (records || []).length,
      groups: view.stats.productCount,
      spot_sold: view.stats.spotSold,
      prepaid_pending: view.stats.prepaidPending,
      duration_ms: Date.now() - startedAt,
    });
    return { ok: true, ...view };
  };

  const loadNewProducts = async ({ requestId = '' } = {}) => {
    const startedAt = Date.now();
    const fields = productFields();
    const filter = fill(config.filters.newProducts, { dateField: fields.createdAt });
    const records = await gateway.listByFilter('product', filter);
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
