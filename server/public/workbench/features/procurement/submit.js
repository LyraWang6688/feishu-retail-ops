/**
 * 底部提交条 + 提交动作：**点提交只发 1 次 POST**（提交中禁用；连点无效）。
 *
 * · 提交前 0 写请求（两个只读 GET 之外没有任何请求）；
 * · 成功：清空草稿（换一把新 submitKey）+ 统一提示「已提交成功，数据会更新」；
 * · 失败：人话提示 + **草稿保留**（她刷新/重进还在）；
 * · 服务端幂等：同一个 `submitKey` 重复提交只写一次（页面这里再保证"只发一次"）。
 */
import { buildItems, computeTotals } from './store.js';
import { fill } from './render.js';

export const createSubmitController = ({ config, api, getStore }) => {
  let busy = false;
  let toastTimer = null;

  const toast = (root, text) => {
    const node = root.querySelector('[data-pr-toast]');
    if (!node) return;
    node.textContent = String(text || '');
    node.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 3200);
  };

  const renderBottom = (root, draft) => {
    const totals = computeTotals(draft);
    const total = root.querySelector('[data-pr-total]');
    const breakdown = root.querySelector('[data-pr-breakdown]');
    if (total) total.textContent = `${totals.total} ${config.units.pair}`;
    if (breakdown) {
      breakdown.textContent = fill(config.units.pickedBreakdown, {
        replenish: totals.replenish, newProducts: totals.newProducts,
      });
    }
  };

  const setBusy = (root, value) => {
    busy = value;
    const button = root.querySelector('[data-pr-submit]');
    if (!button) return;
    button.disabled = value;
    button.textContent = value ? config.texts.submitting : config.texts.submit;
  };

  /**
   * @returns {Promise<{ok:boolean, cleared?:boolean, error?:string}>}
   */
  const submit = async (root, draft) => {
    if (busy) return { ok: false, error: '' };
    const items = buildItems(draft);
    if (!items.length) {
      toast(root, config.texts.noSelection);
      return { ok: false, error: '' };
    }
    setBusy(root, true);
    try {
      const response = await api.submit({ submitKey: draft.submitKey, items });
      // 成功才清空（并换一把新 submitKey ⇒ 下一单不会被这一单吸收）
      const store = getStore();
      store.clear();
      store.rotateSubmitKey(store.ensure());
      toast(root, response?.message || config.texts.submitted);
      return { ok: true, cleared: true };
    } catch (error) {
      toast(root, error?.message || config.texts.submitFailed);
      return { ok: false, error: String(error?.message || config.texts.submitFailed) };
    } finally {
      setBusy(root, false);
    }
  };

  return { renderBottom, submit, toast };
};
