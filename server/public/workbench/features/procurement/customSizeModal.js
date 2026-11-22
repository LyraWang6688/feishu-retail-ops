/** 采购页自定义尺码多行弹窗（纯 DOM 控制；校验/落草稿由调用方提供）。 */
import { escapeHtml } from '../../core/formatters.js';

export const customSizeModalHtml = (config) => `<div class="pr-modal" data-pr-custom-modal hidden>
  <div class="pr-modal-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(config.texts.customSizeModalTitle)}">
    <h3>${escapeHtml(config.texts.customSizeModalTitle)}</h3>
    <div class="pr-custom-rows" data-pr-custom-rows></div>
    <button type="button" class="btn small pr-custom-add-row" data-pr-custom-add-row>${escapeHtml(config.texts.customSizeAddRow)}</button>
    <p class="pr-modal-error" data-pr-custom-error hidden></p>
    <div class="pr-modal-actions">
      <button type="button" class="btn" data-pr-custom-cancel>${escapeHtml(config.texts.customSizeCancel)}</button>
      <button type="button" class="btn primary" data-pr-custom-save>${escapeHtml(config.texts.customSizeSave)}</button>
    </div>
  </div>
</div>`;

const rowHtml = (row, index, config) => `<div class="pr-custom-row" data-pr-custom-modal-row data-index="${index}">
  <input class="pr-modal-input" inputmode="numeric" data-pr-modal-size value="${escapeHtml(row.size)}" placeholder="${escapeHtml(config.texts.customSizeSizeLabel)}" aria-label="${escapeHtml(config.texts.customSizeSizeLabel)}">
  <input class="pr-modal-input" inputmode="numeric" data-pr-modal-qty value="${escapeHtml(row.quantity)}" placeholder="${escapeHtml(config.texts.customSizeQtyLabel)}" aria-label="${escapeHtml(config.texts.customSizeQtyLabel)}">
  <button type="button" class="btn pr-custom-size-remove" data-pr-modal-remove aria-label="${escapeHtml(config.texts.customSizeRemove)}">×</button>
</div>`;

export function createCustomSizeModal({ host, config }) {
  const root = host?.querySelector('[data-pr-custom-modal]');
  if (!root) return { open: () => {}, close: () => {} };
  const rowsNode = root.querySelector('[data-pr-custom-rows]');
  const errorNode = root.querySelector('[data-pr-custom-error]');
  let recordId = '';
  let rows = [];
  let onSave = null;
  const render = () => {
    rowsNode.innerHTML = rows.map((row, index) => rowHtml(row, index, config)).join('');
    errorNode.hidden = true;
  };
  const close = () => { root.hidden = true; recordId = ''; onSave = null; };
  const showError = (message) => { errorNode.textContent = message; errorNode.hidden = !message; };
  const save = () => {
    if (!recordId) return;
    const result = onSave?.(recordId, rows);
    if (result?.error) { showError(result.error); return; }
    close();
  };
  const syncRow = (event) => {
    const rowNode = event.target.closest('[data-pr-custom-modal-row]');
    if (!rowNode) return;
    const index = Number(rowNode.dataset.index);
    if (!rows[index]) return;
    if (event.target.matches('[data-pr-modal-size]')) rows[index].size = event.target.value;
    if (event.target.matches('[data-pr-modal-qty]')) rows[index].quantity = event.target.value;
  };
  root.addEventListener('input', syncRow);
  root.querySelector('[data-pr-custom-add-row]')?.addEventListener('click', () => {
    rows.push({ size: '', quantity: 1 });
    render();
  });
  root.querySelector('[data-pr-custom-rows]')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-pr-modal-remove]');
    if (!button) return;
    const rowNode = button.closest('[data-pr-custom-modal-row]');
    const index = Number(rowNode?.dataset.index);
    rows.splice(index, 1);
    if (!rows.length) rows.push({ size: '', quantity: 1 });
    render();
  });
  root.querySelector('[data-pr-custom-cancel]')?.addEventListener('click', close);
  root.querySelector('[data-pr-custom-save]')?.addEventListener('click', save);
  return {
    open(nextRecordId, nextOnSave) {
      recordId = nextRecordId;
      onSave = nextOnSave;
      rows = [{ size: '', quantity: 1 }];
      render();
      root.hidden = false;
    },
    close,
  };
}
