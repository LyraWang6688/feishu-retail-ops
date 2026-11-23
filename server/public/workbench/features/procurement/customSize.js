/** 补货自定义尺码：纯校验 + 聚焦，不持有状态、不改草稿。 */
const sizesOfGroup = (group) => {
  if (Array.isArray(group?.sizes)) return group.sizes.map((row) => String(row?.size ?? row));
  return [...(group?.sizes?.normal || []), ...(group?.sizes?.special || [])].map(String);
};

const visibleStandardSizes = ({ bodies, tabs }) => {
  const standard = new Map();
  for (const tab of tabs) {
    for (const group of bodies?.[tab]?.groups || []) {
      const recordId = String(group?.productRecordId || '');
      if (recordId) standard.set(recordId, new Set(sizesOfGroup(group)));
    }
  }
  return standard;
};

/** 返回具体原因：invalid（格式）/ duplicate（与标准或自定义重复）。 */
export const customSizesValidation = ({ draft, bodies, tabs, store }) => {
  const standard = visibleStandardSizes({ bodies, tabs });
  for (const product of Object.values(draft.products || {})) {
    const recordId = String(product?.productRecordId || '');
    if (!standard.has(recordId)) continue;
    if (Object.entries(product.entries || {}).some(([size, quantity]) => Number(size) === 0 && Number(quantity) > 0)) {
      return { ok: false, reason: 'invalid' };
    }
  }
  for (const [recordId, sizes] of Object.entries(draft.customSizes || {})) {
    if (!standard.has(recordId)) continue;
    const seen = new Set();
    for (const size of sizes || []) {
      const text = String(size ?? '').trim();
      if (!text && !store.quantityOf(draft, recordId, text)) continue;
      if (!/^[1-9]\d*$/.test(text)) return { ok: false, reason: 'invalid' };
      if (standard.get(recordId)?.has(text) || seen.has(text)) return { ok: false, reason: 'duplicate' };
      seen.add(text);
    }
  }
  return { ok: true, reason: '' };
};

export const customSizesValid = (input) => customSizesValidation(input).ok;

export const customSizeErrorMessage = (input, config) => {
  const result = customSizesValidation(input);
  return result.ok ? '' : (result.reason === 'duplicate' ? config.texts.customSizeDuplicate : config.texts.customSizeInvalid);
};

/** 只保留当前可见货品的有效自定义尺码；失效/重复/格式错误的旧项在刷新时清掉。 */
export const pruneCustomSizes = ({ draft, bodies, tabs }) => {
  const standard = visibleStandardSizes({ bodies, tabs });
  const customSizes = { ...(draft.customSizes || {}) };
  let changed = false;
  for (const [recordId, sizes] of Object.entries(customSizes)) {
    if (!standard.has(recordId)) {
      delete customSizes[recordId];
      changed = true;
      continue;
    }
    const seen = new Set();
    const kept = (sizes || []).filter((size) => {
      const text = String(size ?? '').trim();
      if (!/^[1-9]\d*$/.test(text)) return false;
      if (standard.get(recordId)?.has(text) || seen.has(text)) return false;
      seen.add(text);
      return true;
    });
    if (kept.length !== (sizes || []).length) changed = true;
    if (kept.length) customSizes[recordId] = kept; else delete customSizes[recordId];
  }
  return changed ? { ...draft, customSizes } : draft;
};

export const customRowsError = ({ group, draft, recordId, rows, store }) => {
  const standard = new Set(sizesOfGroup(group));
  const existing = new Set((store.customSizesOf(draft, recordId) || []).map(String));
  const seen = new Set();
  if (!Array.isArray(rows) || !rows.length) return 'required';
  for (const row of rows) {
    const size = String(row?.size ?? '').trim();
    const quantity = String(row?.quantity ?? '').trim();
    if (!/^[1-9]\d*$/.test(size) || !/^[1-9]\d*$/.test(quantity)) return 'invalid';
    if (standard.has(size) || existing.has(size) || seen.has(size)) return 'duplicate';
    seen.add(size);
  }
  return '';
};
