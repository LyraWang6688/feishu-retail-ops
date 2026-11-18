import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { showPageError } from '../../core/ui.js';
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

const rowHtml = (row) => `<div class="ledger-row" role="row">
  ${PAGE.columns.map((column) => {
    const value = column.key === 'time' ? timeText(row.created_at) : cellText(row[column.key]);
    return `<span class="ledger-cell ${column.cls || ''}" role="cell" data-ledger-field="${escapeHtml(column.key)}">${escapeHtml(value)}</span>`;
  }).join('')}
</div>`;

const tableHtml = (rows) => `<div class="ledger-table" role="table" aria-label="${escapeHtml(PAGE.label)}">
  <div class="ledger-row ledger-row--head" role="row">${PAGE.columns.map((column) => `<span class="ledger-cell ${column.cls || ''}" role="columnheader">${escapeHtml(column.label)}</span>`).join('')}</div>
  ${rows.map(rowHtml).join('')}
</div>`;

export function createInventoryLedgerModule() {
  const state = { host: null };

  async function load() {
    const host = state.host;
    const from = host?.querySelector('[data-ledger-from]')?.value || '';
    const to = host?.querySelector('[data-ledger-to]')?.value || '';
    const summary = host?.querySelector('[data-ledger-summary]');
    const body = host?.querySelector('[data-ledger-body]');
    if (!body) return;
    if (from && to && from > to) {
      if (summary) summary.textContent = PAGE.texts.invalidRange;
      body.innerHTML = '';
      return;
    }
    body.innerHTML = `<p class="ledger-empty">${escapeHtml(PAGE.texts.loading)}</p>`;
    if (summary) summary.textContent = '';
    try {
      const query = new URLSearchParams();
      if (from) query.set('from', from);
      if (to) query.set('to', to);
      const data = await api.get(query.toString() ? `${PAGE.api}?${query}` : PAGE.api);
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      const total = Number.isFinite(Number(data?.total)) ? Number(data.total) : rows.length;
      const range = data?.from === data?.to ? data.from : `${data?.from || from} 至 ${data?.to || to}`;
      if (summary) {
        summary.textContent = data?.truncated
          ? `${range} · ${fill(PAGE.texts.total, { total })} · ${fill(PAGE.texts.recent, { shown: rows.length })}`
          : `${range} · ${fill(PAGE.texts.total, { total })}`;
      }
      body.innerHTML = rows.length ? tableHtml(rows) : `<p class="ledger-empty">${escapeHtml(PAGE.texts.empty)}</p>`;
    } catch (error) {
      body.innerHTML = `<p class="ledger-empty">${escapeHtml(PAGE.texts.failed)}</p>`;
      showPageError(String(error?.message || ''));
    }
  }

  return {
    mount(host) {
      state.host = host;
      showPageError('');
      const today = todayKey();
      host.innerHTML = `<div class="domain-page ledger-page">
        <div class="ledger-filters">
          <label class="ledger-filter"><span>${escapeHtml(PAGE.texts.startLabel)}</span><input type="date" value="${today}" data-ledger-from></label>
          <label class="ledger-filter"><span>${escapeHtml(PAGE.texts.endLabel)}</span><input type="date" value="${today}" data-ledger-to></label>
          <button class="ledger-btn" type="button" data-ledger-query>${escapeHtml(PAGE.texts.query)}</button>
          <button class="ledger-btn ledger-btn--ghost" type="button" data-ledger-today>${escapeHtml(PAGE.texts.today)}</button>
        </div>
        <p class="ledger-summary" data-ledger-summary></p>
        <div data-ledger-body></div>
      </div>`;
      host.querySelector('[data-ledger-query]')?.addEventListener('click', () => { void load(); });
      host.querySelector('[data-ledger-today]')?.addEventListener('click', () => {
        const key = todayKey();
        host.querySelector('[data-ledger-from]').value = key;
        host.querySelector('[data-ledger-to]').value = key;
        void load();
      });
      void load();
    },
  };
}
