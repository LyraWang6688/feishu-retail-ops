import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { showPageError } from '../../core/ui.js';
import { bindScrollHints } from '../shared/scrollHint.js';
import { bindDateControl, dateFieldHtml } from '../shared/dateField.js';
import { bindProductSearch, productSearchHtml } from '../shared/productSearch.js';
import { INVENTORY_LEDGER_PAGE as PAGE } from '../../config/inventoryLedger.js';

const fill = (text, values = {}) => String(text || '').replace(/\{(\w+)\}/g, (m, key) => (values[key] == null ? '' : String(values[key])));
const cellText = (value) => (value === null || value === undefined ? '' : String(value));
const dateKey = (date) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type) => (parts.find((part) => part.type === type) || {}).value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
};
const todayKey = () => dateKey(new Date());
const timeText = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const get = (type) => (parts.find((part) => part.type === type) || {}).value || '';
  return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
};
const TABS = Array.isArray(PAGE.tabs) ? PAGE.tabs : [];

const rowHtml = (row) => `<tr role="row">
  ${PAGE.columns.map((column) => {
    const value = column.key === 'time' ? timeText(row.created_at) : cellText(row[column.key]);
    const delistedClass = column.key === 'number' && row.delisted ? ' product-delisted' : '';
    return `<td class="ledger-cell ${column.cls || ''}${delistedClass}" role="cell" data-ledger-field="${escapeHtml(column.key)}">${escapeHtml(value)}</td>`;
  }).join('')}
</tr>`;

const tableHtml = (rows) => `<div class="ledger-scroll-wrap scroll-hint-wrap" data-scroll-wrap><div class="ledger-viewport" data-scroll-area>
  <table class="ledger-table" role="table" aria-label="${escapeHtml(PAGE.texts.ledgerTitle)}">
    <thead><tr role="row">${PAGE.columns.map((column) => `<th class="ledger-cell ${column.cls || ''}" role="columnheader">${escapeHtml(column.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(rowHtml).join('')}</tbody>
  </table>
</div></div>`;

const tabsHtml = () => TABS.map((tab) => `<button class="ledger-tab${tab.id === 'overview' ? ' active' : ''}" type="button" role="tab" data-ledger-tab="${escapeHtml(tab.id)}" aria-selected="${tab.id === 'overview'}">${escapeHtml(tab.label)}</button>`).join('');

export function createInventoryLedgerModule() {
  const state = { host: null, tab: 'overview', data: null, loading: false, error: '', from: '', to: '', product: null };

  function activeTab() {
    return TABS.some((tab) => tab.id === state.tab) ? state.tab : (TABS[0]?.id || 'overview');
  }

  function renderTabs(host) {
    const current = activeTab();
    host.querySelectorAll('[data-ledger-tab]').forEach((button) => {
      const selected = button.dataset.ledgerTab === current;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
    });
  }

  function summaryText(data) {
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    const total = Number.isFinite(Number(data?.total)) ? Number(data.total) : rows.length;
    const range = data?.from === data?.to ? data.from : `${data?.from || state.from} 至 ${data?.to || state.to}`;
    return data?.truncated
      ? `${range} · ${fill(PAGE.texts.total, { total })} · ${fill(PAGE.texts.recent, { shown: rows.length })}`
      : `${range} · ${fill(PAGE.texts.total, { total })}`;
  }

  function renderBody() {
    const host = state.host;
    const body = host?.querySelector('[data-ledger-body]');
    const summary = host?.querySelector('[data-ledger-summary]');
    if (!body) return;
    const tab = activeTab();
    if (tab === 'overview') {
      if (summary) summary.textContent = '';
      body.innerHTML = `<div class="ledger-placeholder"><p>${escapeHtml(PAGE.texts.overviewBuilding)}</p></div>`;
      return;
    }
    if (summary) summary.textContent = state.data && !state.loading && !state.error ? summaryText(state.data) : '';
    const filter = productSearchHtml({ mode: 'inventoryLedger', selected: state.product });
    const bindFilter = () => bindProductSearch(body, {
      mode: 'inventoryLedger',
      selected: state.product,
      onSelect: (item) => { state.product = item; void load(); },
      onClear: () => { state.product = null; void load(); },
    });
    if (state.loading) { body.innerHTML = `${filter}<p class="ledger-empty">${escapeHtml(PAGE.texts.loading)}</p>`; bindFilter(); return; }
    if (state.error) { body.innerHTML = `${filter}<p class="ledger-empty">${escapeHtml(state.error)}</p>`; bindFilter(); return; }
    if (!state.data) { body.innerHTML = filter; bindFilter(); return; }
    const rows = Array.isArray(state.data.rows) ? state.data.rows : [];
    body.innerHTML = `${filter}${rows.length ? tableHtml(rows) : `<p class="ledger-empty">${escapeHtml(PAGE.texts.empty)}</p>`}`;
    bindFilter();
    if (rows.length) bindScrollHints(body);
  }

  async function load() {
    const host = state.host;
    const from = host?.querySelector('[data-ledger-from]')?.value || '';
    const to = host?.querySelector('[data-ledger-to]')?.value || '';
    state.from = from;
    state.to = to;
    const body = host?.querySelector('[data-ledger-body]');
    if (!body) return;
    const summary = host?.querySelector('[data-ledger-summary]');
    if (from && to && from > to) {
      state.loading = false;
      state.error = PAGE.texts.invalidRange;
      state.data = null;
      if (summary) summary.textContent = PAGE.texts.invalidRange;
      body.innerHTML = '';
      return;
    }
    state.loading = true;
    state.error = '';
    state.data = null;
    renderBody();
    try {
      const query = new URLSearchParams();
      if (from) query.set('from', from);
      if (to) query.set('to', to);
      if (state.product?.number) query.set('product', state.product.number);
      const data = await api.get(query.toString() ? `${PAGE.api}?${query}` : PAGE.api);
      state.data = data;
      state.loading = false;
      renderBody();
    } catch (error) {
      state.loading = false;
      state.error = PAGE.texts.failed;
      renderBody();
      showPageError(String(error?.message || ''));
    }
  }

  return {
    mount(host) {
      state.host = host;
      state.tab = 'overview';
      state.data = null;
      state.loading = false;
      state.error = '';
      state.from = '';
      state.to = '';
      state.product = null;
      showPageError('');
      const today = todayKey();
      host.innerHTML = `<div class="domain-page ledger-page">
        <div class="ledger-sticky-head">
          <div class="ledger-filters">
            ${dateFieldHtml({ label: PAGE.texts.startLabel, labelClass: 'ledger-filter', inputAttr: 'data-ledger-from', value: today, max: today })}
            ${dateFieldHtml({ label: PAGE.texts.endLabel, labelClass: 'ledger-filter', inputAttr: 'data-ledger-to', value: today, min: today })}
            <button class="ledger-btn" type="button" data-ledger-query>${escapeHtml(PAGE.texts.query)}</button>
          </div>
          <div class="ledger-tabs" role="tablist" aria-label="${escapeHtml(PAGE.texts.tabsLabel)}">${tabsHtml()}</div>
        </div>
        <p class="ledger-summary" data-ledger-summary></p>
        <div data-ledger-body></div>
      </div>`;
      const mainTabs = document.querySelector('.main-tabs');
      if (mainTabs) host.style.setProperty('--ledger-main-tabs-height', `${Math.ceil(mainTabs.getBoundingClientRect().height)}px`);
      renderTabs(host);
      const fromField = bindDateControl(host, '[data-ledger-from]');
      const toField = bindDateControl(host, '[data-ledger-to]');
      const fromInput = fromField.input;
      const toInput = toField.input;
      const syncBounds = () => {
        if (!fromInput || !toInput) return;
        toInput.min = fromInput.value || '';
        fromInput.max = toInput.value || '';
        if (fromInput.value && toInput.value && fromInput.value > toInput.value) {
          toInput.value = fromInput.value;
        }
        toInput.min = fromInput.value || '';
      };
      fromInput?.addEventListener('change', syncBounds);
      toInput?.addEventListener('change', () => {
        if (fromInput?.value && toInput.value && fromInput.value > toInput.value) {
          fromInput.value = toInput.value;
        }
        syncBounds();
      });
      host.querySelector('[data-ledger-query]')?.addEventListener('click', () => { void load(); });
      host.querySelector('.ledger-tabs')?.addEventListener('click', (event) => {
        const button = event.target.closest('[data-ledger-tab]');
        if (!button) return;
        state.tab = button.dataset.ledgerTab || 'overview';
        renderTabs(host);
        renderBody();
      });
      syncBounds();
      void load();
    },
  };
}
