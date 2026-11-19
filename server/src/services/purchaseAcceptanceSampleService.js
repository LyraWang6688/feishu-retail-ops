'use strict';

/**
 * 验收页「要不要让她选样品尺码」的只读判断（2026-11-18）。
 *
 * 复用「实时库存」现有的读法：一次 listAll，按货品聚合；
 * 不新写状态判断 —— 只看两件事：
 *   · 这个编号有没有任何库存记录；
 *   · 有没有「样品」记录。
 *
 * 口径：没有样品 ⇒ 需要她选（无库存也算没有样品）；已有样品 ⇒ 不需要。
 * 读取失败 ⇒ 如实记 warn，返回 unavailable，调用方按“不知道”处理（不假装没有样品）。
 */
const { textValue } = require('./v1BitableGateway');
const { strictLinkedRecordIds } = require('./strictLinkIds');
const { INBOUND_STATE } = require('../config/inventoryStatePolicy');
const { logWarn } = require('../utils/logger');
const { CRITICAL_READ_RETRY } = require('../config/gatewayReadRetry');
const { equalsFormula, orFormula } = require('./bitableFilterFormula');

const createPurchaseAcceptanceSampleService = ({ gateway, cacheTtlMs = 30_000, now = Date.now } = {}) => {
  const cache = new Map();
  const loadRecords = async (productIds = []) => {
    const key = [...productIds].sort().join('|');
    const hit = cache.get(key);
    if (hit && Number(cacheTtlMs) > 0 && now() - hit.at < Number(cacheTtlMs)) return hit.records;
    const table = gateway?.table?.('liveInventory');
    const recordIdField = table?.fields?.recordId;
    const formula = recordIdField && Array.isArray(productIds) && productIds.length
      ? orFormula(productIds.map((id) => equalsFormula(recordIdField, id)))
      : null;
    let records = null;
    if (formula && typeof gateway.listByFilter === 'function') {
      try {
        records = await gateway.listByFilter('liveInventory', formula, { retry: CRITICAL_READ_RETRY });
      } catch (error) {
        records = null;
      }
    }
    if (!Array.isArray(records)) {
      records = await gateway.listAll('liveInventory', { retry: CRITICAL_READ_RETRY });
    }
    cache.set(key, { records, at: now() });
    return records;
  };
  const stateOfProducts = async (productIds = []) => {
    const ids = [...new Set((Array.isArray(productIds) ? productIds : [])
      .map((id) => String(id || '').trim()).filter(Boolean))];
    const out = new Map(ids.map((id) => [id, {
      hasStock: false, hasSample: false, needsSampleChoice: true, unavailable: false,
    }]));
    if (!ids.length) return out;
    try {
      const table = gateway?.table?.('liveInventory');
      const productField = table?.fields?.product;
      const stateField = table?.fields?.state;
      if (!productField || !stateField || typeof gateway.listAll !== 'function') {
        for (const value of out.values()) value.unavailable = true;
        return out;
      }
      const records = await loadRecords(ids);
      for (const record of Array.isArray(records) ? records : []) {
        const productId = strictLinkedRecordIds(record?.fields?.[productField])[0] || '';
        const value = out.get(productId);
        if (!value) continue;
        value.hasStock = true;
        if (textValue(record?.fields?.[stateField]).trim() === INBOUND_STATE.SAMPLE) {
          value.hasSample = true;
        }
      }
      for (const value of out.values()) value.needsSampleChoice = !value.hasSample;
      return out;
    } catch (error) {
      for (const value of out.values()) value.unavailable = true;
      logWarn('purchase.acceptance.sample_state_failed', {
        product_count: ids.length, error: String(error?.message || error).slice(0, 200),
      });
      return out;
    }
  };
  return { stateOfProducts };
};

module.exports = { createPurchaseAcceptanceSampleService };
