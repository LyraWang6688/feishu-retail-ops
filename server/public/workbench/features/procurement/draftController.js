/** 采购草稿的服务端保存 / 恢复 UI 控制器。 */
import { computeTotals } from './store.js';

export const restoreProcurementDraft = async ({ store, api }) => {
  const local = store.load();
  if (local && Object.keys(local.products || {}).length) return local;
  try {
    const remote = await api.loadDraft();
    if (remote?.draft?.snapshot) {
      return store.save({
        ...remote.draft.snapshot,
        savedAt: remote.draft.savedAt || '',
        dirty: false,
      });
    }
  } catch { /* 服务端草稿读不到 ⇒ 继续用本地空草稿，不阻塞采购页 */ }
  return store.ensure();
};

export const saveProcurementDraft = async ({ host, draft, store, api, config, toast, setDraft }) => {
  if (computeTotals(draft).total <= 0) { toast(config.texts.noSelection); return; }
  const button = host.querySelector('[data-pr-save]');
  const original = button?.textContent || config.texts.saveDraft;
  if (button) { button.disabled = true; button.textContent = config.texts.draftSaving; }
  try {
    const result = await api.saveDraft(draft);
    const savedAt = result?.draft?.savedAt || new Date().toISOString();
    setDraft(store.save({ ...draft, savedAt, dirty: false }));
    toast(config.texts.draftSaved);
  } catch (error) {
    toast(error?.message || config.texts.draftSaveFailed);
  } finally {
    if (button) { button.disabled = false; button.textContent = original; }
  }
};
