/** 采购页行级纯工具（从 index.js 拆出，保持入口模块 ≤200 行）。 */
export const metaOf = (state, recordId) => {
  for (const tab of ['replenish', 'new']) {
    for (const group of state.bodies[tab]?.groups || []) {
      if (group.productRecordId !== recordId) continue;
      return {
        productRecordId: recordId, source: tab, number: group.number,
        itemNo: group.itemNo, color: group.color, supplierRecordId: group.supplierRecordId,
      };
    }
  }
  return { productRecordId: recordId, source: state.tab };
};

export const spotSoldOf = (state, recordId, size) => {
  for (const group of state.bodies.replenish?.groups || []) {
    if (group.productRecordId !== recordId) continue;
    const row = (group.sizes || []).find((one) => Number(one.size) === Number(size));
    if (row) return Number(row.spotSold) || 0;
  }
  return 0;
};

export const syncRow = (host, store, draft, recordId, size) => {
  const quantity = store.quantityOf(draft, recordId, size);
  host.querySelectorAll('[data-pr-qty]').forEach((input) => {
    if (input.dataset.record === recordId && Number(input.dataset.size) === Number(size)) {
      input.value = String(quantity);
    }
  });
};

export const quantityInput = ({ input, config, store, draft, setDraft, applyQuantity }) => {
  const { record, size } = input.dataset;
  const value = Math.min(Math.max(0, Math.round(Number(input.value === '' ? 0 : input.value))), Number(config.defaults.maxQuantity) || 99);
  applyQuantity(record, Number(size), value);
  if (input.value !== String(value)) input.value = String(value);
};
