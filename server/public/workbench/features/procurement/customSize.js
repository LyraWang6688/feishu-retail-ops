/** 补货自定义尺码：纯校验 + 聚焦，不持有状态、不改草稿。 */
export const customSizesValid = ({ draft, bodies, tabs, store }) => {
  const standard = new Map();
  for (const tab of tabs) {
    for (const group of bodies[tab]?.groups || []) {
      standard.set(group.productRecordId, new Set((Array.isArray(group.sizes) ? group.sizes : []).map((row) => String(row.size))));
    }
  }
  for (const product of Object.values(draft.products || {})) {
    if (Object.entries(product.entries || {}).some(([size, quantity]) => Number(size) === 0 && Number(quantity) > 0)) {
      return false;
    }
  }
  for (const [recordId, sizes] of Object.entries(draft.customSizes || {})) {
    const seen = new Set();
    for (const size of sizes || []) {
      const text = String(size ?? '').trim();
      if (!text && !store.quantityOf(draft, recordId, text)) continue;
      if (!/^[1-9]\d*$/.test(text)) return false;
      if (standard.get(recordId)?.has(text) || seen.has(text)) return false;
      seen.add(text);
    }
  }
  return true;
};

export const customSizeError = ({ group, draft, recordId, oldSize, nextSize, store }) => {
  if (!nextSize) return '';
  if (!/^[1-9]\d*$/.test(nextSize)) return 'invalid';
  const standard = new Set((group?.sizes || []).map((item) => String(item.size)));
  const others = store.customSizesOf(draft, recordId).filter((size) => String(size) !== String(oldSize));
  if (standard.has(nextSize) || others.includes(nextSize)) return 'duplicate';
  return '';
};

export const focusCustomSize = (host, recordId) => {
  const inputs = host.querySelectorAll('[data-pr-custom-size][data-record="' + recordId + '"]');
  inputs[inputs.length - 1]?.focus();
};
