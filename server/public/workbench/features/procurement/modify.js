/** 采购已提交批次的修改上下文：预填原批次、提交 modify、成功后清空回待提交。 */
import { buildItems } from './store.js';

const hasDraftItems = (draft) => Object.values(draft?.products || {}).some((product) => (
  Object.values(product.entries || {}).some((quantity) => Number(quantity) > 0)
));

export const createModifyController = ({ host, config, api, getStore, getDraft, setDraft, toast, onDone }) => {
  let batch = null;

  const banner = (text = '') => {
    const node = host.querySelector('[data-pr-modify-banner]');
    if (!node) return;
    node.textContent = text;
    node.classList.toggle('hidden', !text);
  };
  const button = () => host.querySelector('[data-pr-submit]');
  const setButton = (text) => { const node = button(); if (node) node.textContent = text; };

  const start = (nextBatch) => {
    const draft = getDraft();
    if (hasDraftItems(draft)) return { ok: false, error: config.texts.modifyDraftConflict };
    const store = getStore();
    let next = store.ensure();
    for (const product of nextBatch.products || []) {
      for (const entry of product.entries || []) {
        next = store.setQuantity(next, {
          productRecordId: product.product_record_id,
          source: 'replenish',
          number: product.number,
          itemNo: product.item_no,
          color: product.color,
          supplierRecordId: nextBatch.supplier_record_id,
          supplierName: nextBatch.supplier_name,
        }, entry.size, entry.quantity);
      }
    }
    batch = nextBatch;
    setDraft(next);
    banner(textOf(config.texts.modifyBanner, { batchNo: nextBatch.batch_no }));
    setButton(config.texts.modifySubmit);
    return { ok: true };
  };

  const clear = () => {
    batch = null;
    banner('');
    setButton(config.texts.submit);
  };

  const submit = async (draft) => {
    if (!batch) return { ok: false, error: '' };
    const items = buildItems(draft);
    if (!items.length) { toast(host, config.texts.noSelection); return { ok: false }; }
    const response = await api.modify({ batchNo: batch.batch_no, submitKey: draft.submitKey, items });
    const store = getStore();
    store.clear();
    store.rotateSubmitKey(store.ensure());
    clear();
    toast(host, response?.message || config.texts.modifySuccess);
    onDone?.();
    return { ok: true };
  };

  const supplierAllowed = (supplierId) => !batch || String(supplierId || '') === String(batch.supplier_record_id || '');
  const active = () => batch;

  return { start, clear, submit, supplierAllowed, active };
};

const textOf = (template, values) => String(template || '').replace(/\{(\w+)\}/g, (match, key) => (
  Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
));
