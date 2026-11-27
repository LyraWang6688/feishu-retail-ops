'use strict';

/**
 * 2026-11-27：退货「预览」分区的纯模型。
 *
 * 一个供应商 = 提交后一个独立退货批次；这里只做只读分组，不写库、不取号、不认识飞书。
 * 分组口径与提交/出图一致：supplier_record_id（空 = 未标注供应商）。
 */

const supplierKeyOf = (item) => String(item?.supplier_record_id || item?.supplierRecordId || '').trim()
  || '__unassigned__';

const productKeyOf = (item) => String(item?.product_record_id || item?.productRecordId || '').trim()
  || String(item?.item_no || item?.number || '').trim();

const amountOf = (item) => (Number.isInteger(item?.amount_cents) && item.amount_cents >= 0
  ? item.amount_cents : null);

const entriesOf = (item) => (Array.isArray(item?.entries) ? item.entries : [])
  .map((entry) => ({ size: String(entry?.size ?? ''), quantity: Number(entry?.quantity) || 0 }))
  .filter((entry) => entry.size && entry.quantity > 0);

const buildReturnPreview = ({ items = [], current = null } = {}) => {
  const list = [...(Array.isArray(items) ? items : []), ...(current ? [current] : [])];
  const suppliers = new Map();
  for (const item of list) {
    const supplierKey = supplierKeyOf(item);
    if (!suppliers.has(supplierKey)) {
      suppliers.set(supplierKey, {
        supplierRecordId: supplierKey === '__unassigned__' ? '' : supplierKey,
        supplierName: String(item?.supplier_name || item?.supplierName || '').trim(),
        products: new Map(),
      });
    }
    const supplier = suppliers.get(supplierKey);
    const productKey = productKeyOf(item);
    if (!productKey) continue;
    if (!supplier.products.has(productKey)) {
      supplier.products.set(productKey, {
        productRecordId: productKey,
        itemNo: String(item?.item_no || '').trim(),
        color: String(item?.color || '').trim(),
        amountCents: amountOf(item),
        entries: [],
      });
    }
    const product = supplier.products.get(productKey);
    if (product.amountCents === null) product.amountCents = amountOf(item);
    product.entries.push(...entriesOf(item));
  }
  const result = [];
  for (const supplier of suppliers.values()) {
    const products = [...supplier.products.values()].map((product) => ({
      ...product,
      entries: [...product.entries].sort((left, right) => Number(left.size) - Number(right.size)),
    }));
    const entries = products.flatMap((product) => product.entries);
    const amountCents = products.reduce((sum, product) => (
      sum + (Number.isInteger(product.amountCents) ? product.amountCents : 0)
    ), 0);
    result.push({
      supplierRecordId: supplier.supplierRecordId,
      supplierName: supplier.supplierName,
      products,
      subtotalQty: entries.reduce((sum, entry) => sum + entry.quantity, 0),
      subtotalAmountCents: amountCents,
    });
  }
  return {
    suppliers: result,
    totals: {
      qty: result.reduce((sum, supplier) => sum + supplier.subtotalQty, 0),
      amountCents: result.reduce((sum, supplier) => sum + supplier.subtotalAmountCents, 0),
    },
  };
};

module.exports = { buildReturnPreview };
