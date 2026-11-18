import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { showPageError } from '../../core/ui.js';
import { INVENTORY_LEDGER_PAGE as PAGE } from '../../config/inventoryLedger.js';

const fill = (text, values = {}) => String(text || '').replace(/\{(\w+)\}/g, (m, key) => (values[key] == null ? '' : String(values[key])));

const cellText = (value) => (value === null || value === undefined ? '' : String(value));

const rowHtml = (row) => `<div class="ledger-row" role="row">
  ${PAGE.columns.map((column) => `<span class="ledger-cell" role="cell" data-ledger-field="${escapeHtml(column.key)}">${escapeHtml(cellText(row[column.key]))}</span>`).join('')}
</div>`;

const tableHtml = (rows) => `<div class="ledger-table" role="table" aria-label="${escapeHtml(PAGE.label)}">
  <div class="ledger-row ledger-row--head" role="row">${PAGE.columns.map((column) => `<span class="ledger-cell" role="columnheader">${escapeHtml(column.label)}</span>`).join('')}</div>
  ${rows.map(rowHtml).join('')}
</div>`;

export function createInventoryLedgerModule() {
  const state = { host: null };

  async function load() {
    const host = state.host;
    const summary = host?.querySelector('[data-ledger-summary]');
    const body = host?.querySelector('[data-ledger-body]');
    if (!body) return;
    body.innerHTML = `<p class="ledger-empty">${escapeHtml(PAGE.texts.loading)}</p>`;
    if (summary) summary.textContent = '';
    try {
      const data = await api.get(PAGE.api);
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      const total = Number.isFinite(Number(data?.total)) ? Number(data.total) : rows.length;
      if (summary) {
        summary.textContent = data?.truncated
          ? `${fill(PAGE.texts.total, { total })} · ${fill(PAGE.texts.recent, { shown: rows.length })}`
          : fill(PAGE.texts.total, { total });
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
      host.innerHTML = `<div class="domain-page ledger-page">
        <p class="ledger-summary" data-ledger-summary></p>
        <div data-ledger-body></div>
      </div>`;
      void load();
    },
  };
}
