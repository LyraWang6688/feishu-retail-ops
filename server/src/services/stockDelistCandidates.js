'use strict';

/**
 * 库存清零候选的纯计算：
 *   · 当前实时库存按货品汇总（所有尺码 / 所有状态）；
 *   · 本次操作数量从总数里扣掉；
 *   · 扣到 0 且未下架 ⇒ 下架候选。
 *
 * 只做计算，不读表、不写表；调用方传入已有库存行/本次 items。
 */
const { strictLinkedRecordIds } = require('./strictLinkIds');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');

const productIdOfLive = (record, fields = V1_BITABLE_SCHEMA.tables.liveInventory.fields) => (
  strictLinkedRecordIds(record?.fields?.[fields.product])[0] || ''
);

const stockTotalsOf = (liveRecords = []) => {
  const totals = new Map();
  for (const record of Array.isArray(liveRecords) ? liveRecords : []) {
    const productId = productIdOfLive(record);
    if (!productId) continue;
    totals.set(productId, (totals.get(productId) || 0) + 1);
  }
  return totals;
};

const delistCandidatesOf = ({
  liveRecords = [], items = [], delistedProductIds = [],
} = {}) => {
  const stock = stockTotalsOf(liveRecords);
  const delisted = new Set((Array.isArray(delistedProductIds) ? delistedProductIds : []).map(String));
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const productId = String(item?.productRecordId || '').trim();
    const quantity = Number(item?.quantity || 0);
    if (!productId || !Number.isFinite(quantity) || quantity <= 0 || seen.has(productId)) continue;
    seen.add(productId);
    if (delisted.has(productId)) continue;
    const current = stock.get(productId) || 0;
    const remaining = current - quantity;
    if (current > 0 && remaining === 0) {
      out.push({ productRecordId: productId, currentStock: current, quantity, remaining });
    }
  }
  return out;
};

/** 打印候选：只保留未下架 + 操作后仍有库存的货品。 */
const printableProductsOf = ({
  products = [], stock = new Map(), delistedProductIds = [],
} = {}) => {
  const delisted = new Set((Array.isArray(delistedProductIds) ? delistedProductIds : []).map(String));
  return (Array.isArray(products) ? products : []).filter((product) => {
    const id = String(product?.recordId || product?.productRecordId || '').trim();
    if (!id || delisted.has(id)) return false;
    return (stock.get(id) || 0) > 0;
  });
};

module.exports = {
  stockTotalsOf,
  delistCandidatesOf,
  printableProductsOf,
};
