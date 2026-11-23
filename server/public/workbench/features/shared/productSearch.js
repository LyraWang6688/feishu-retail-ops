import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { PRODUCT_SEARCH_TEXT as TEXT, productSearchMode } from '../../config/productSearch.js';

const modeAttr = (mode) => escapeHtml(String(mode || 'salesDetail'));

export function productSearchHtml({ mode = 'salesDetail', selected = null } = {}) {
  const label = selected?.number || selected?.itemNo || '';
  return `<div class="ps-search" data-ps-search data-ps-mode="${modeAttr(mode)}">
  <label class="ps-field">
    <span class="ps-input-wrap">
      <input class="ps-input" type="search" data-ps-input placeholder="${escapeHtml(TEXT.placeholder)}" autocomplete="off" aria-label="${escapeHtml(TEXT.placeholder)}">
    </span>
  </label>
  <div class="ps-selected" data-ps-selected ${label ? '' : 'hidden'}>
    <span class="ps-selected-label">${escapeHtml(TEXT.selected)}</span>
    <b data-ps-selected-label>${escapeHtml(label)}</b>
    <button class="ps-clear" type="button" data-ps-clear aria-label="${escapeHtml(TEXT.clear)}">×</button>
  </div>
  <div class="ps-results" data-ps-results role="listbox" hidden></div>
  <p class="ps-status" data-ps-status hidden></p>
</div>`;
}

/**
 * 绑定统一货品搜索的输入 / 候选 / 选中行为。
 * 结果渲染和业务过滤由调用方决定；本组件只负责「搜什么、选中谁」。
 */
export function bindProductSearch(root, {
  mode = 'salesDetail', selected = null, onSelect = () => {}, onClear = () => {},
} = {}) {
  const host = root?.querySelector?.('[data-ps-search]') || root;
  if (!host) return { selected: () => selected, destroy: () => {} };
  const config = productSearchMode(mode);
  const input = host.querySelector('[data-ps-input]');
  const results = host.querySelector('[data-ps-results]');
  const status = host.querySelector('[data-ps-status]');
  const selectedBox = host.querySelector('[data-ps-selected]');
  const selectedLabel = host.querySelector('[data-ps-selected-label]');
  let current = selected || null;
  let timer = null;
  let requestSeq = 0;

  const showStatus = (text) => {
    if (!status) return;
    status.textContent = text || '';
    status.hidden = !text;
  };
  const renderSelected = () => {
    const label = current?.number || current?.itemNo || '';
    if (selectedLabel) selectedLabel.textContent = label;
    if (selectedBox) selectedBox.hidden = !label;
  };
  const hideResults = () => {
    if (results) results.hidden = true;
    if (results) results.innerHTML = '';
    showStatus('');
  };
  const renderResults = (items) => {
    if (!results) return;
    if (!items.length) {
      results.innerHTML = '';
      results.hidden = true;
      showStatus(TEXT.empty);
      return;
    }
    results.innerHTML = items.map((item) => {
      const number = String(item.number || item.itemNo || '');
      const meta = [item.itemNo, item.color,
        item.recordId ? `${TEXT.recordIdLabel} ${String(item.recordId).slice(-6)}` : '',
      ].filter(Boolean).join(' · ');
      return `<button class="ps-result" type="button" role="option" data-ps-result data-ps-number="${escapeHtml(number)}" data-ps-record="${escapeHtml(item.recordId || '')}">
        <b>${escapeHtml(number)}</b>${meta ? `<small>${escapeHtml(meta)}</small>` : ''}
      </button>`;
    }).join('');
    results.hidden = false;
    showStatus('');
  };
  const search = async (query) => {
    const q = String(query || '').trim();
    if (!q) { hideResults(); return; }
    const seq = ++requestSeq;
    showStatus(TEXT.loading);
    if (results) results.hidden = true;
    try {
      const extra = config.includeDelisted ? '&includeDelisted=1' : '';
      const data = await api.get(`/api/workbench/products/search?q=${encodeURIComponent(q)}${extra}`);
      if (seq !== requestSeq) return;
      renderResults(Array.isArray(data?.items) ? data.items : []);
    } catch {
      if (seq !== requestSeq) return;
      if (results) results.hidden = true;
      showStatus(TEXT.failed);
    }
  };
  const selectItem = (button) => {
    const number = String(button?.dataset.psNumber || '');
    if (!number) return;
    current = { number, recordId: String(button?.dataset.psRecord || '') };
    renderSelected();
    hideResults();
    if (input) input.value = '';
    onSelect(current);
  };
  input?.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { void search(input.value); }, config.debounceMs || 0);
  });
  results?.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-ps-result]');
    if (button) selectItem(button);
  });
  host.querySelector('[data-ps-clear]')?.addEventListener('click', () => {
    current = null;
    renderSelected();
    hideResults();
    if (input) input.value = '';
    onClear();
  });
  renderSelected();
  return { selected: () => current, destroy: () => { clearTimeout(timer); requestSeq += 1; } };
}
