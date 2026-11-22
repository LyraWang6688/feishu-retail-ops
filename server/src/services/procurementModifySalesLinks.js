'use strict';

/**
 * 修改批次时给“新增 / 增加”的补货数量补销售明细关联。
 * 只按「货品记录 + 尺码」匹配、只取尚未关联的销售明细，按销售日旧→新补。
 */
const { linkedRecordIds } = require('./v1Gateway/cells');
const { relation } = require('./v1ReferenceResolver');

const fill = (template, values) => String(template || '').replace(/\{(\w+)\}/g, (match, key) => (
  Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
));

const createProcurementModifySalesLinks = ({ gateway, schema, config }) => {
  const salesFields = schema?.tables?.salesDetail?.fields || {};
  const productFields = schema?.tables?.product?.fields || {};
  const field = schema?.tables?.salesDetail?.fields?.purchaseDetail;

  const apply = async (targets = []) => {
    const list = (Array.isArray(targets) ? targets : []).filter((target) => target?.source !== 'new' && Number(target.quantity) > 0);
    if (!list.length || !field) return { linked: 0, unmatched: 0 };
    const filter = fill(config.filters.replenish, {
      stockField: salesFields.stockQuantity,
      dateField: salesFields.soldAt,
      days: config.window.replenishDays,
    });
    const rows = await gateway.listByFilter('salesDetail', filter);
    const pool = new Map();
    for (const row of rows || []) {
      if (linkedRecordIds(row?.fields?.[field]).length) continue;
      const product = linkedRecordIds(row?.fields?.[salesFields.product])[0];
      const size = Number(row?.fields?.[salesFields.size]);
      if (!product || !Number.isInteger(size)) continue;
      const key = product + '|' + size;
      if (!pool.has(key)) pool.set(key, []);
      pool.get(key).push({ row, soldAt: Number(row?.fields?.[salesFields.soldAt]) || 0 });
    }
    for (const entries of pool.values()) entries.sort((a, b) => a.soldAt - b.soldAt);
    let linked = 0;
    let unmatched = 0;
    for (const target of list) {
      const key = String(target.productRecordId || '') + '|' + String(target.size);
      const queue = pool.get(key) || [];
      let need = Number(target.quantity) || 0;
      while (need > 0 && queue.length) {
        const sale = queue.shift();
        await gateway.update('salesDetail', sale.row.record_id, { purchaseDetail: relation(target.recordId) });
        linked += 1;
        need -= 1;
      }
      unmatched += Math.max(0, need);
    }
    return { linked, unmatched };
  };

  return { apply, productFields };
};

module.exports = { createProcurementModifySalesLinks };
