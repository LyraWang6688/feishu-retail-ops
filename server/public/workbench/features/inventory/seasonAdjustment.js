import { api } from '../../core/api-client.js';
import { waitForAsyncJob } from '../shared/asyncJob.js';
import { escapeHtml } from '../../core/formatters.js';
import { describeError, showPageError } from '../../core/ui.js';
import { showToast } from '../shared/toast.js';
import { scanCodeRaw, scanTargetUrl } from '../scan/launch.js';
import { INVENTORY_MANUAL_TEXTS as T } from '../../config/inventoryAdjustment.js';

const fill = (text, values = {}) => String(text || '').replace(/\{(\w+)\}/g, (m, key) => (values[key] == null ? '' : String(values[key])));
const rowKey = (row) => [row.size, row.state, row.season].join('|');
const changeOf = (product, row) => ({
  productRecordId: product.recordId,
  size: Number(row.size),
  state: row.state,
  currentSeason: row.season === true,
  targetSeason: !(row.season === true),
  quantity: Number(row.quantity) || 0,
});

export function mountSeasonAdjustment(host) {
  if (!host) return undefined;
  const state = { tab: 'adjust', current: null, selected: new Set(), cart: new Map(), busy: false, hasScanned: false };

  const productOf = (rows) => {
    const first = rows[0] || {};
    return {
      recordId: first.product_record_id || '',
      number: first.product_number || first.item_no || '',
      itemNo: first.item_no || '',
      color: first.color || '',
      category: first.category || '',
    };
  };
  const currentChanges = () => {
    if (!state.current) return [];
    return state.current.rows.filter((row) => state.selected.has(rowKey(row))).map((row) => changeOf(state.current.product, row));
  };
  const allChanges = () => [
    ...[...state.cart.values()].flatMap((group) => group.changes),
    ...currentChanges(),
  ];
  const totals = (changes) => ({
    total: changes.reduce((sum, item) => sum + item.quantity, 0),
    freeze: changes.filter((item) => item.targetSeason === false).reduce((sum, item) => sum + item.quantity, 0),
    release: changes.filter((item) => item.targetSeason === true).reduce((sum, item) => sum + item.quantity, 0),
  });

  const renderBottom = () => {
    const values = totals(allChanges());
    const bar = host.querySelector('[data-season-bottom]');
    if (!bar) return;
    bar.innerHTML = `<div class="season-bottom-total">${escapeHtml(fill(T.seasonPreviewCount, { count: values.total }))}<small>${escapeHtml(fill(T.seasonFreeze, { count: values.freeze }))} · ${escapeHtml(fill(T.seasonRelease, { count: values.release }))}</small></div>
      <button class="btn small season-clear" type="button" data-season-clear>${escapeHtml(T.seasonClear)}</button>
      <button class="btn primary season-submit" type="button" data-season-submit${state.busy || values.total <= 0 ? ' disabled' : ''}>${escapeHtml(state.busy ? T.seasonSubmitting : T.seasonSubmit)}</button>`;
  };

  const productHtml = () => {
    if (!state.current) return `<p class="empty compact">${escapeHtml(T.seasonScanEmpty)}</p>`;
    return `<div class="season-product">
      <div class="row-top"><div class="row-num">${escapeHtml([state.current.product.itemNo || state.current.product.number, state.current.product.color, state.current.product.category].filter(Boolean).join('｜'))}</div><span class="tag season">${escapeHtml(T.seasonCurrent)}</span></div>
      <div class="season-rows">${state.current.rows.length ? state.current.rows.map((row) => `
        <label class="edit-row season-row">
          <input type="checkbox" data-season-row="${escapeHtml(rowKey(row))}"${state.selected.has(rowKey(row)) ? ' checked' : ''} aria-label="${escapeHtml(T.seasonAdjust)}">
          <span class="season-size">${escapeHtml(row.size)}</span>
          <span class="season-state">${escapeHtml(row.state)}</span>
          <span class="tag ${row.season ? 'season' : ''}">${escapeHtml(row.season ? T.seasonCurrentSeason : T.seasonNotCurrent)}</span>
          <span class="season-qty">${escapeHtml(row.quantity)}</span>
        </label>`).join('') : `<p class="empty compact">${escapeHtml(T.seasonScanEmpty)}</p>`}</div>
      <p class="hint">${escapeHtml(T.seasonCheckHint)}</p>
      <div class="row-actions"><button class="btn small" type="button" data-season-scan>${escapeHtml(T.seasonRescan)}</button></div>
    </div>`;
  };

  const previewHtml = () => {
    const groups = [...state.cart.values()];
    if (!groups.length) return `<p class="empty compact">${escapeHtml(T.seasonPreviewEmpty)}</p>`;
    return groups.map((group) => `<section class="season-preview-group">
      <div class="row-top"><div class="row-num">${escapeHtml([group.product.itemNo || group.product.number, group.product.color, group.product.category].filter(Boolean).join('｜'))}</div><button class="btn small" type="button" data-season-remove="${escapeHtml(group.product.recordId)}">${escapeHtml(T.seasonRemove)}</button></div>
      ${group.changes.map((change) => `<div class="edit-row season-row"><span></span><span class="season-size">${escapeHtml(change.size)}</span><span class="season-state">${escapeHtml(change.state)}</span><span class="tag ${change.targetSeason ? 'season' : ''}">${escapeHtml(change.targetSeason ? T.seasonCurrentSeason : T.seasonNotCurrent)}</span><span class="season-qty">${escapeHtml(change.quantity)}</span></div>`).join('')}
    </section>`).join('');
  };

  const render = () => {
    host.innerHTML = `<div class="season-page">
      <div class="page-head"><h2>${escapeHtml(T.seasonTitle)}</h2></div>
      <div class="season-tabs"><button class="season-tab ${state.tab === 'adjust' ? 'active' : ''}" type="button" data-season-tab="adjust">${escapeHtml(T.seasonAdjust)}</button><button class="season-tab ${state.tab === 'preview' ? 'active' : ''}" type="button" data-season-tab="preview">${escapeHtml(T.seasonPreview)}</button></div>
      <div class="season-panel">${state.tab === 'adjust' ? productHtml() : previewHtml()}</div>
      ${state.tab === 'adjust' && !state.current ? `<button class="btn primary season-scan-start" type="button" data-season-scan>${escapeHtml(state.hasScanned ? T.seasonScanAgain : T.seasonScan)}</button>` : ''}
      <div class="season-bottom" data-season-bottom></div>
    </div>`;
    renderBottom();
  };

  const scan = async () => {
    if (state.busy) return;
    state.busy = true;
    try {
      const scanned = await scanCodeRaw('inventory');
      const target = scanTargetUrl(scanned, 'inventory');
      const match = String(target || '').match(/\/r\/([^/?#]+)/);
      if (!match) { showPageError(T.seasonScanNoProduct); return; }
      const productId = decodeURIComponent(match[1]);
      const data = await api.get(`/api/workbench/inventory?productRecordId=${encodeURIComponent(productId)}&groupBy=season`);
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      state.current = { product: productOf(rows), rows };
      state.selected.clear();
      state.hasScanned = true;
      state.tab = 'adjust';
      render();
    } catch (error) {
      showPageError(String(error?.message || '') === 'jssdk_missing' ? T.seasonScanFailed : describeError(error) || T.seasonScanFailed);
    } finally {
      state.busy = false;
    }
  };

  const scanNext = async () => {
    const changes = currentChanges();
    if (changes.length) {
      const id = state.current.product.recordId;
      const existing = state.cart.get(id);
      const merged = new Map((existing?.changes || []).map((change) => [
        [change.productRecordId, change.size, change.state, change.currentSeason].join('|'), change,
      ]));
      for (const change of changes) merged.set([change.productRecordId, change.size, change.state, change.currentSeason].join('|'), change);
      state.cart.set(id, { product: state.current.product, changes: [...merged.values()] });
    }
    state.current = null;
    state.selected.clear();
    render();
    await scan();
  };

  const submit = async () => {
    if (state.busy) return;
    const changes = allChanges();
    if (!changes.length) { showToast(T.seasonNoSelection); return; }
    state.busy = true;
    renderBottom();
    try {
      const result = await api.post('/api/workbench/inventory/adjustments/season-scan', { requestId: crypto.randomUUID(), changes });
      const jobId = String(result?.job_id || '').trim();
      if (jobId) await waitForAsyncJob(jobId);
      state.cart.clear();
      state.current = null;
      state.selected.clear();
      state.hasScanned = true;
      showToast(T.seasonSubmitSuccess);
      render();
    } catch (error) {
      showToast(error?.message || T.seasonSubmitFailed);
    } finally {
      state.busy = false;
      renderBottom();
    }
  };

  host.addEventListener('change', (event) => {
    const row = event.target.closest?.('[data-season-row]');
    if (!row) return;
    if (row.checked) state.selected.add(row.dataset.seasonRow); else state.selected.delete(row.dataset.seasonRow);
    renderBottom();
  });
  host.addEventListener('click', (event) => {
    const tab = event.target.closest?.('[data-season-tab]');
    if (tab) { state.tab = tab.dataset.seasonTab; render(); return; }
    if (event.target.closest?.('[data-season-scan]')) { void (state.current ? scanNext() : scan()); return; }
    if (event.target.closest?.('[data-season-remove]')) { state.cart.delete(event.target.closest('[data-season-remove]').dataset.seasonRemove); render(); return; }
    if (event.target.closest?.('[data-season-clear]')) { state.cart.clear(); state.selected.clear(); render(); return; }
    if (event.target.closest?.('[data-season-submit]')) { void submit(); return; }
  });

  render();
  return { render };
}
