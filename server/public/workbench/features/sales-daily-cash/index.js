import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { showPageError } from '../../core/ui.js';
import { showToast } from '../shared/toast.js';
import { SALES_DAILY_CASH_API, SALES_DAILY_CASH_TEXTS as T } from '../../config/salesDailyCash.js';

const money = (value) => Number(value || 0).toLocaleString('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const amountText = (value) => (value == null ? '—' : `¥${money(value)}`);

export function createSalesDailyCashModule() {
  const state = { host: null, record: null, date: '' };

  const render = () => {
    const host = state.host;
    if (!host) return;
    const record = state.record;
    const hasRecord = Boolean(record);
    host.innerHTML = `<div class="domain-page dc-page" data-page-kind="sales-daily-cash">
      <div class="dc-head"><h1 class="dc-title">${escapeHtml(T.title)}</h1><span class="dc-date">${escapeHtml(state.date || '')}</span></div>
      <section class="dc-card dc-opening">
        <div class="dc-card-head"><h2>${escapeHtml(T.openingTitle)}</h2><span class="dc-hint">${escapeHtml(T.openingHint)}</span></div>
        <div class="dc-input-row">
          <label class="dc-field">${escapeHtml(T.openingLabel)}
            <input data-dc-opening type="number" inputmode="decimal" min="0" step="0.01" value="${hasRecord ? escapeHtml(String(record.opening_amount)) : ''}" placeholder="0.00">
          </label>
          <button class="dc-btn" type="button" data-dc-save-opening>${escapeHtml(T.saveOpening)}</button>
        </div>
      </section>
      <section class="dc-realtime">
        <span>${escapeHtml(T.realtimeTitle)}</span>
        <strong data-dc-realtime>${hasRecord ? escapeHtml(amountText(record.realtime_amount)) : '—'}</strong>
      </section>
      <section class="dc-card dc-withdrawal"${hasRecord ? '' : ' hidden'}>
        <div class="dc-card-head"><h2>${escapeHtml(T.withdrawalTitle)}</h2><span class="dc-hint">${escapeHtml(T.withdrawalHint)}</span></div>
        <div class="dc-input-row">
          <label class="dc-field">${escapeHtml(T.withdrawalLabel)}
            <input data-dc-withdrawal type="number" inputmode="decimal" min="0" step="0.01" value="${hasRecord ? escapeHtml(String(record.withdrawal_amount)) : ''}" placeholder="0.00">
          </label>
          <button class="dc-btn" type="button" data-dc-save-withdrawal>${escapeHtml(T.saveWithdrawal)}</button>
        </div>
      </section>
      <p class="dc-empty" data-dc-empty${hasRecord ? ' hidden' : ''}>${escapeHtml(T.notStarted)}</p>
    </div>`;
    bind();
  };

  const load = async () => {
    const host = state.host;
    if (!host) return;
    host.innerHTML = `<p class="dc-loading">${escapeHtml(T.loading)}</p>`;
    try {
      const data = await api.get(SALES_DAILY_CASH_API);
      state.date = String(data?.date || '');
      state.record = data?.record || null;
      render();
    } catch (error) {
      host.innerHTML = `<p class="dc-empty">${escapeHtml(T.failed)}</p>`;
      showPageError(String(error?.message || ''));
    }
  };

  const save = async (body, input) => {
    const host = state.host;
    if (!host) return;
    const raw = String(input?.value || '').trim();
    if (raw === '' || !Number.isFinite(Number(raw)) || Number(raw) < 0) {
      showPageError(body.openingAmount !== undefined ? T.openingInvalid : T.withdrawalInvalid);
      return;
    }
    showPageError('');
    try {
      const data = await api.post(SALES_DAILY_CASH_API, body);
      state.date = String(data?.date || state.date);
      state.record = data?.record || state.record;
      showToast(T.saved);
      render();
    } catch (error) {
      const code = String(error?.message || '');
      const message = code === 'opening_amount_required' ? T.openingRequired
        : (code.includes('opening') ? T.openingInvalid
          : (code.includes('withdrawal') ? T.withdrawalInvalid : T.saveFailed));
      showPageError(message);
    }
  };

  const bind = () => {
    const host = state.host;
    if (!host) return;
    const opening = host.querySelector('[data-dc-opening]');
    const withdrawal = host.querySelector('[data-dc-withdrawal]');
    host.querySelector('[data-dc-save-opening]')?.addEventListener('click', () => {
      void save({ openingAmount: opening?.value }, opening);
    });
    host.querySelector('[data-dc-save-withdrawal]')?.addEventListener('click', () => {
      void save({ withdrawalAmount: withdrawal?.value }, withdrawal);
    });
  };

  return {
    mount(host) {
      state.host = host;
      showPageError('');
      void load();
    },
  };
}
