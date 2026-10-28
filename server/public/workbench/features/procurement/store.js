/**
 * 采购页会话草稿（localStorage）—— **同一张草稿**给补货 + 上新共用，直到提交成功才清空。
 *
 * 形状（版本化，便于以后迁移）：
 *   { version, submitKey, products: { [productRecordId]: { source, number, itemNo, color, supplierRecordId,
 *                                                          entries: { [size]: quantity } } } }
 *
 * 🔴 规则：
 *   · key 必须带当前用户 `open_id`（`<prefix>:<openId>`）——同一浏览器换账号**不串**；
 *   · 同一 `productRecordId` + 尺码**只留一行**（`entries` 是 map，天然去重）；
 *   · `submitKey` 一次草稿一把，**提交成功才换**（服务端幂等靠它）；
 *   · 纯函数（默认数量 / 合计 / items）都导出，供单测直接钉口径。
 */
export const newSubmitKey = (prefix, now = () => Date.now(), random = () => Math.random()) => {
  const timestamp = Number(now()).toString(36);
  const noise = Math.floor(Number(random()) * 0xffffff).toString(36);
  return `${prefix}_${timestamp}_${noise}`;
};

/** 补货某个尺码的默认数量：预订必补（= 预订数）；只有现货 ⇒ 默认不选（0）。 */
export const defaultReplenishQuantity = (sizeRow) => {
  const prepaid = Number(sizeRow?.prepaidSold) || 0;
  if (prepaid > 0) return prepaid;
  return 0;
};

/** 上新某个尺码的默认数量：普通码 = normalQuantity（默认 1）；特殊码 = specialQuantity（默认 0）。 */
export const defaultNewQuantity = (kind, defaults) => (
  kind === 'special' ? Number(defaults.specialQuantity) || 0 : Number(defaults.normalQuantity) || 0
);

export const clampQuantity = (value, maxQuantity) => {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(number, Number(maxQuantity) || 99);
};

const entriesOfProduct = (draft, productRecordId) => (
  draft.products?.[productRecordId]?.entries || {}
);

/** 合计：总数 = 补货 + 上新（按草稿里的 source 归类）。 */
export const computeTotals = (draft) => {
  const totals = { total: 0, replenish: 0, newProducts: 0 };
  Object.values(draft?.products || {}).forEach((product) => {
    const sum = Object.values(product.entries || {}).reduce((acc, quantity) => acc + (Number(quantity) || 0), 0);
    if (product.source === 'new') totals.newProducts += sum; else totals.replenish += sum;
    totals.total += sum;
  });
  return totals;
};

/** 提交载荷：只产出 items（product_record_id + 尺码/数量）；供应商/批次/幂等键由既有链路处理。 */
export const buildItems = (draft) => Object.values(draft?.products || {}).map((product) => ({
  productRecordId: product.productRecordId,
  entries: Object.entries(product.entries || {})
    .map(([size, quantity]) => ({ size: Number(size), quantity: Number(quantity) }))
    .filter((entry) => Number.isInteger(entry.size) && entry.quantity > 0)
    .sort((a, b) => a.size - b.size),
})).filter((item) => item.entries.length > 0);

export const emptyDraft = (config, now) => ({
  version: config.storage.version,
  submitKey: newSubmitKey(config.submitKey.prefix, now),
  products: {},
});

export const createDraftStore = ({ openId, config, storage = window.localStorage, now = () => Date.now() }) => {
  const storageKey = `${config.storage.prefix}:${openId}`;

  const load = () => {
    try {
      const parsed = JSON.parse(storage.getItem(storageKey) || 'null');
      if (!parsed || parsed.version !== config.storage.version || !parsed.products) return null;
      if (!parsed.submitKey) parsed.submitKey = newSubmitKey(config.submitKey.prefix, now);
      return parsed;
    } catch {
      return null;
    }
  };
  const save = (draft) => {
    try { storage.setItem(storageKey, JSON.stringify(draft)); } catch { /* 存储满了/被禁用：不阻塞页面 */ }
    return draft;
  };
  const ensure = () => load() || save(emptyDraft(config, now));
  const clear = () => {
    try { storage.removeItem(storageKey); } catch { /* 同上 */ }
  };
  const rotateSubmitKey = (draft) => {
    const next = { ...draft, submitKey: newSubmitKey(config.submitKey.prefix, now) };
    return save(next);
  };

  /** 写/改某个货品某个尺码的数量（0 = 移除这一行）。 */
  const setQuantity = (draft, meta, size, quantity) => {
    const productRecordId = String(meta?.productRecordId || '');
    if (!productRecordId) return draft;
    const products = { ...(draft.products || {}) };
    const current = products[productRecordId] || {
      productRecordId, source: meta.source, number: '', itemNo: '', color: '', supplierRecordId: '', entries: {},
    };
    const entries = { ...(current.entries || {}) };
    const nextQuantity = clampQuantity(quantity, config.defaults.maxQuantity);
    if (nextQuantity > 0) entries[Number(size)] = nextQuantity; else delete entries[Number(size)];
    products[productRecordId] = {
      ...current,
      ...{
        source: current.source || meta.source,
        number: meta.number || current.number || '',
        itemNo: meta.itemNo || current.itemNo || '',
        color: meta.color || current.color || '',
        supplierRecordId: meta.supplierRecordId || current.supplierRecordId || '',
        entries,
      },
    };
    if (!Object.keys(entries).length) delete products[productRecordId];
    return save({ ...draft, products });
  };

  /**
   * 把服务端数据里的**默认选中**并进草稿（只补不覆盖：她已经改过的数量/取消的勾选都保留）。
   * @param {'replenish'|'new'} source
   */
  const seedDefaults = (draft, source, groups = []) => {
    const products = { ...(draft.products || {}) };
    for (const group of groups) {
      const productRecordId = String(group?.productRecordId || '');
      if (!productRecordId) continue;
      const existing = products[productRecordId];
      const entries = { ...((existing && existing.entries) || {}) };
      const meta = {
        productRecordId, source: existing?.source || source,
        number: group.number || '', itemNo: group.itemNo || '', color: group.color || '',
        supplierRecordId: group.supplierRecordId || '',
      };
      if (source === 'replenish') {
        for (const row of group.sizes || []) {
          const size = Number(row.size);
          if (!Number.isInteger(size) || size in entries) continue;
          const quantity = defaultReplenishQuantity(row);
          if (quantity > 0) entries[size] = clampQuantity(quantity, config.defaults.maxQuantity);
        }
      } else {
        const all = [
          ...(group.sizes?.normal || []).map((size) => ({ size, kind: 'normal' })),
          ...(group.sizes?.special || []).map((size) => ({ size, kind: 'special' })),
        ];
        for (const { size, kind } of all) {
          if (!Number.isInteger(Number(size)) || Number(size) in entries) continue;
          const quantity = defaultNewQuantity(kind, config.defaults);
          if (quantity > 0) entries[Number(size)] = clampQuantity(quantity, config.defaults.maxQuantity);
        }
      }
      // ⚠️ 只补不覆盖：已经存在的 entries 原样保留；空 entries 的货品不新增（避免空空的行）
      if (!Object.keys(entries).length && !existing) continue;
      products[productRecordId] = { ...meta, ...(existing || {}), entries };
    }
    return save({ ...draft, products });
  };

  return {
    storageKey, load, save, ensure, clear, rotateSubmitKey, setQuantity, seedDefaults,
    quantityOf: (draft, productRecordId, size) => Number(entriesOfProduct(draft, productRecordId)[size]) || 0,
    productOf: (draft, productRecordId) => draft.products?.[productRecordId] || null,
  };
};
