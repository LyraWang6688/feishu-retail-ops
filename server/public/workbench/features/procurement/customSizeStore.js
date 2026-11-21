/** 草稿里的自定义尺码纯函数（不碰 localStorage；由 store.js 负责 save）。 */
const ensureProduct = (draft, meta) => {
  const productRecordId = String(meta?.productRecordId || '');
  if (!productRecordId) return null;
  const products = { ...(draft.products || {}) };
  const current = products[productRecordId] || {
    productRecordId, source: meta.source, number: '', itemNo: '', color: '', supplierRecordId: '', entries: {},
  };
  products[productRecordId] = {
    ...current,
    source: current.source || meta.source,
    number: meta.number || current.number || '',
    itemNo: meta.itemNo || current.itemNo || '',
    color: meta.color || current.color || '',
    supplierRecordId: meta.supplierRecordId || current.supplierRecordId || '',
    entries: { ...(current.entries || {}) },
  };
  return { products, productRecordId };
};

export const addCustomSizeDraft = (draft, meta) => {
  const base = ensureProduct(draft, meta);
  if (!base) return draft;
  const list = [...(draft.customSizes?.[base.productRecordId] || []), ''];
  return { ...draft, products: base.products, customSizes: { ...(draft.customSizes || {}), [base.productRecordId]: list } };
};

export const renameCustomSizeDraft = (draft, meta, oldSize, nextSize) => {
  const base = ensureProduct(draft, meta);
  if (!base) return draft;
  const product = base.products[base.productRecordId];
  const entries = { ...(product.entries || {}) };
  const oldKey = String(oldSize ?? '').trim();
  const nextKey = String(nextSize ?? '').trim();
  const list = [...(draft.customSizes?.[base.productRecordId] || [])];
  const index = list.findIndex((size) => String(size) === oldKey);
  if (index < 0) return draft;
  if (oldKey && oldKey !== nextKey) {
    const quantity = Number(entries[oldKey]) || 0;
    delete entries[oldKey];
    if (nextKey && quantity > 0) entries[nextKey] = quantity;
  }
  list[index] = nextKey;
  base.products[base.productRecordId] = { ...product, entries };
  return { ...draft, products: base.products, customSizes: { ...(draft.customSizes || {}), [base.productRecordId]: list } };
};

export const removeCustomSizeDraft = (draft, meta, size) => {
  const productRecordId = String(meta?.productRecordId || '');
  if (!productRecordId) return draft;
  const key = String(size ?? '').trim();
  const products = { ...(draft.products || {}) };
  const product = products[productRecordId];
  const entries = { ...(product?.entries || {}) };
  if (key) delete entries[key];
  const list = (draft.customSizes?.[productRecordId] || []).filter((item) => String(item) !== key);
  if (product) products[productRecordId] = { ...product, entries };
  if (!Object.keys(entries).length && !list.length) delete products[productRecordId];
  return { ...draft, products, customSizes: { ...(draft.customSizes || {}), [productRecordId]: list } };
};
