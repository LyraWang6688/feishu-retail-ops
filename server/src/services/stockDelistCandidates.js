'use strict';

/**
 * 「卖完 → 下架候选」的唯一判据（2026-11-26 业务负责人定稿）。
 *
 * 口径（逐条都是她当次确认的）：
 *   · 剩余 = 页面**第一次读到的**库存记录数（快照） − 本单该 recordId 的数量；
 *   · 剩余 <= 0 ⇒ 卖完 ⇒ 需要确认下架；
 *   · **不查实时库存表**：快照来自页面渲染那次 lookup，数量来自前端本单；
 *   · 按 `productRecordId` 去重聚合（同款多尺码合并成一条，数量相加）；
 *   · 样品也占「库存记录数」⇒ 只剩样品时剩余仍 > 0 ⇒ **不提示**。
 *
 * 销售与供应退货共用本函数，调用方只负责把两样东西凑齐：
 *   销售：本单各行（含本次这一双）的数量 + 各自加行时的 stock_total 快照；
 *   退货：本次各尺码退货数量 + 退货页渲染时的 stockTotal 快照。
 */

/** 单条剩余：快照 − 数量；不认识的数一律当成"不知道"（返回 null，不猜）。 */
const remainingOf = (snapshotCount, qty) => {
  const snapshot = Number(snapshotCount);
  const count = Number(qty);
  if (!Number.isFinite(snapshot) || !Number.isFinite(count)) return null;
  return Math.max(0, Math.round((snapshot - count) * 100) / 100);
};

/**
 * @param {Array<{productRecordId:string, snapshotCount:number, qty:number}>} items
 * @returns {Array<{productRecordId:string, snapshotCount:number, qty:number, remaining:0}>}
 *   只返回「已经卖完」的条目（按 recordId 去重后）
 */
const soldOutCandidates = (items = []) => {
  if (!Array.isArray(items)) return [];
  const byProduct = new Map();
  for (const item of items) {
    const productRecordId = String(item?.productRecordId || '').trim();
    if (!productRecordId) continue;
    const snapshotCount = Number(item?.snapshotCount);
    const qty = Number(item?.qty);
    if (!Number.isFinite(snapshotCount) || !Number.isFinite(qty) || qty <= 0) continue;
    const prev = byProduct.get(productRecordId);
    if (prev) {
      // 同 recordId：快照是同一份页面的数，只把数量加总（多尺码合并成一条）
      prev.qty += qty;
    } else {
      byProduct.set(productRecordId, { productRecordId, snapshotCount, qty });
    }
  }
  const out = [];
  for (const candidate of byProduct.values()) {
    // 快照本来就没有库存（0）⇒ 这不是"卖完"，不提示
    if (candidate.snapshotCount <= 0) continue;
    const remaining = remainingOf(candidate.snapshotCount, candidate.qty);
    if (remaining !== 0) continue;
    out.push({ ...candidate, remaining: 0 });
  }
  return out;
};

/**
 * 销售侧：把「本单已有行 + 本次这一双」拼成纯函数要的 items（按 recordId 聚合去重由 `soldOutCandidates` 做）。
 *
 * @param {{lines?: Array, current?: {productRecordId:string, snapshotCount:number}|null, alreadyInDraft?: boolean}} input
 *   lines：本单已加的行（每行一双，`product_record_id` + `stock_total` 快照）
 *   current：本次要提交的这一双（`productRecordId` + 页面快照）
 *   alreadyInDraft：同款同尺码已在草稿（本次不再加行，数量也不加 ✗）
 */
const saleItemsOf = ({ lines = [], current = null, alreadyInDraft = false } = {}) => {
  const items = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const productRecordId = String(line?.product_record_id || '').trim();
    if (!productRecordId) continue;
    const snapshot = Number(line?.stock_total);
    if (!Number.isFinite(snapshot)) continue;
    items.push({ productRecordId, snapshotCount: snapshot, qty: 1 });
  }
  if (current && !alreadyInDraft) {
    const productRecordId = String(current.productRecordId || '').trim();
    const snapshot = Number(current.snapshotCount);
    if (productRecordId && Number.isFinite(snapshot)) {
      items.push({ productRecordId, snapshotCount: snapshot, qty: 1 });
    }
  }
  return items;
};

module.exports = { soldOutCandidates, remainingOf, saleItemsOf };
