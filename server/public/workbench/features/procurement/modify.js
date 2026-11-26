/** 采购已提交批次的修改上下文：预填原批次、提交 modify、成功后清空回待提交。 */
import { buildItems } from './store.js';
import { setSubmitButtonState } from './submit.js';

const hasDraftItems = (draft) => Object.values(draft?.products || {}).some((product) => (
  Object.values(product.entries || {}).some((quantity) => Number(quantity) > 0)
));

export const createModifyController = ({ host, config, api, getStore, getDraft, setDraft, toast, onDone }) => {
  let batch = null;
  let busy = false;

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
          locked: true,
        }, entry.size, entry.quantity);
      }
    }
    // 把“修改的是哪张单”一起存进采购草稿：刷新 / 重开页面后仍能走 /procurement/modify。
    const context = {
      batchNo: String(nextBatch.batch_no || ''),
      submitKey: String(nextBatch.submit_key || nextBatch.submitKey || ''),
      supplierRecordId: String(nextBatch.supplier_record_id || ''),
    };
    next = store.save({ ...next, modify: context });
    batch = nextBatch;
    setDraft(next);
    banner(textOf(config.texts.modifyBanner, { batchNo: nextBatch.batch_no }));
    setButton(config.texts.modifySubmit);
    return { ok: true };
  };

  /** 页面重新加载后，用草稿里保存的 modify 上下文恢复“正在修改哪张单”。 */
  const restore = (draft) => {
    const context = draft?.modify;
    if (!context || !context.batchNo) return null;
    batch = {
      batch_no: String(context.batchNo || ''),
      submit_key: String(context.submitKey || ''),
      supplier_record_id: String(context.supplierRecordId || ''),
    };
    banner(textOf(config.texts.modifyBanner, { batchNo: batch.batch_no }));
    setButton(config.texts.modifySubmit);
    return context;
  };

  const clear = () => {
    batch = null;
    banner('');
    setButton(config.texts.submit);
  };

  const submit = async (draft) => {
    if (!batch || busy) return { ok: false, error: '' };
    const items = buildItems(draft);
    if (!items.length) { toast(host, config.texts.noSelection); return { ok: false }; }
    busy = true;
    setSubmitButtonState(host, { disabled: true, text: config.texts.modifySubmitting });
    try {
      const response = await api.modify({ batchNo: batch.batch_no, submitKey: draft.submitKey, items });
      const store = getStore();
      store.clear();
      store.rotateSubmitKey(store.ensure());
      clear();
      if (response?.redirect_url) {
        window.location.assign(response.redirect_url);
        return { ok: true };
      }
      toast(host, response?.message || config.texts.modifySuccess);
      onDone?.();
      return { ok: true };
    } catch (error) {
      toast(host, error?.message || config.texts.modifyFailed);
      return { ok: false, error: String(error?.message || config.texts.modifyFailed) };
    } finally {
      busy = false;
      setSubmitButtonState(host, { disabled: false, text: batch ? config.texts.modifySubmit : config.texts.submit });
    }
  };

  const supplierAllowed = (supplierId) => !batch || String(supplierId || '') === String(batch.supplier_record_id || '');
  const active = () => batch;

  return { start, restore, submit, supplierAllowed, active };
};

const textOf = (template, values) => String(template || '').replace(/\{(\w+)\}/g, (match, key) => (
  Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
));
