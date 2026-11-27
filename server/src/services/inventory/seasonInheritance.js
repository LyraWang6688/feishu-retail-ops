'use strict';

/**
 * 入库继承「当季」（2026-11-27 业务负责人定稿）。
 *
 * 规则（唯一一份判据，两处建行共用）：
 *   · 货品信息「当季」= 是 ⇒ 新行 当季 = true；
 *   · = 否 且该货品还有实时库存 ⇒ **不写**（保持空）；
 *   · = 否 且实时库存 0 行（首次入库 / 售罄回补）⇒ 当季 = true；
 *   · 读货品复用 `CRITICAL_READ_RETRY`；重试耗尽 ⇒ 不写 + warn，**不阻塞入库**。
 */
const { V1_BITABLE_SCHEMA } = require('../../config/v1BitableSchema');
const { INVENTORY_SEASON } = require('../../config/inventorySeason');
const { textValue } = require('../v1BitableGateway');
const { logWarn } = require('../../utils/logger');

/** 货品信息「当季」这一列的物理名（只读字段，走 schema，不写死字面量）。 */
const productSeasonField = () => {
  const readOnly = V1_BITABLE_SCHEMA.tables.product.readOnlyFields || {};
  const field = readOnly[INVENTORY_SEASON.productFieldKey] || null;
  return field && field.name ? String(field.name) : '';
};

/**
 * @param {{ gateway: object, products: Array<{productRecordId:string, hasLiveRows:boolean}>, correlation?: object, config?: object }} input
 * @returns {Promise<Map<string, true|undefined>>} true = 新行要勾当季；undefined = 不写
 */
const seasonForNewRows = async ({ gateway, products = [], correlation = {}, config = INVENTORY_SEASON } = {}) => {
  const unique = new Map();
  for (const item of Array.isArray(products) ? products : []) {
    const productRecordId = String(item?.productRecordId || '').trim();
    if (!productRecordId) continue;
    unique.set(productRecordId, { hasLiveRows: item?.hasLiveRows === true });
  }
  const result = new Map([...unique.keys()].map((id) => [id, undefined]));
  if (!unique.size) return result;
  const field = productSeasonField();
  if (!field) {
    logWarn('inventory.season.inherit_failed', {
      reason: 'schema_missing', product_count: unique.size, ...correlation,
    });
    return result;
  }
  const ids = [...unique.keys()];
  let records = [];
  try {
    records = await gateway.getBatch('product', ids, { retry: config.readRetry, correlation });
  } catch (error) {
    logWarn('inventory.season.inherit_failed', {
      reason: 'read_failed',
      error: String(error?.message || error).slice(0, 300),
      product_ids: ids.join(','),
      ...correlation,
    });
    return result;
  }
  const byId = new Map((records || []).map((record) => [String(record?.record_id || ''), record]));
  for (const id of ids) {
    const record = byId.get(id);
    if (!record) {
      logWarn('inventory.season.inherit_failed', { reason: 'product_missing', product_record_id: id, ...correlation });
      continue;
    }
    const label = textValue(record.fields?.[field]).trim();
    if (label === config.currentLabel) { result.set(id, true); continue; }
    if (config.firstIntakeWhenNoLiveRows && unique.get(id).hasLiveRows === false) result.set(id, true);
  }
  return result;
};

module.exports = { seasonForNewRows, productSeasonField };
