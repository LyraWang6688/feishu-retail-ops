import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { showPageError } from '../../core/ui.js';
import { showToast } from '../shared/toast.js';
import { SALES_DAILY_CASH_API, SALES_DAILY_CASH_TEXTS as T } from '../../config/salesDailyCash.js';

const money = (value) => Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function createSalesDailyCashModule() {
  const state = { host: null, record: null, reference: null, date: '', busy: false, submitKeys: { opening: '', withdrawal: '' } };

  const render = () => {
    const host = state.host;
    if (!host) return;
    const record = state.record;
    const hasRecord = Boolean(record);
    const opening = Number(record?.opening_amount || 0);
    const withdrawalSaved = Boolean(record?.withdrawal_saved);
    const received = Number(record?.received_amount || 0);
    const realtime = Number(record?.realtime_amount || 0);
    const referenceAmount = Number(state.reference?.retained_amount || 0);
    const showReference = !hasRecord && Boolean(state.reference);
    const referenceHtml = showReference ? `<div class="dc-reference" data-dc-reference>
        <div class="dc-reference-copy"><span>${escapeHtml(T.referenceTitle)}</span><strong>¥${money(referenceAmount)}</strong></div>
        <button class="dc-btn-secondary" type="button" data-dc-fill-reference>${escapeHtml(T.fillReference.replace('{amount}', money(referenceAmount)))}</button>
      </div>` : '';
    host.innerHTML = `<div class="domain-page dc-page" data-page-kind="sales-daily-cash">
      <section class="dc-summary" data-dc-summary>
        <div class="dc-summary-head"><span>${escapeHtml(T.summaryTitle)}</span><span>${escapeHtml(state.date || '')}</span></div>
        <div class="dc-summary-grid">
          <div><span>${escapeHtml(T.openingTitle)}</span><b>¥${opening.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></div>
          <div><span>${escapeHtml(T.receivedTitle)}</span><b>¥${received.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></div>
          <div><span>${escapeHtml(T.realtimeTitle)}</span><b>¥${realtime.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></div>
        </div>
      </section>
      <section class="dc-card dc-opening">
        <div class="dc-card-head"><h2>${escapeHtml(T.openingTitle)}</h2></div>
        ${referenceHtml}
        <div class="dc-input-row">
          <label class="dc-field">${escapeHtml(T.openingLabel)}
            <input data-dc-opening type="number" inputmode="decimal" min="0" step="0.01" value="${hasRecord ? escapeHtml(String(record.opening_amount)) : ''}" placeholder="0.00">
          </label>
          <button class="dc-btn" type="button" data-dc-save-opening${hasRecord ? ' disabled' : ''}>${escapeHtml(hasRecord ? T.openingSaved : T.saveOpening)}</button>
        </div>
        <p class="dc-hint">${escapeHtml(T.openingHint)}</p>
        <p class="dc-fill-status" data-dc-fill-status aria-live="polite"></p>
      </section>
      <section class="dc-card"${hasRecord ? '' : ' hidden'}>
        <div class="dc-card-head"><h2>${escapeHtml(T.withdrawalTitle)}</h2></div>
        <div class="dc-input-row">
          <label class="dc-field">${escapeHtml(T.withdrawalLabel)}
            <input data-dc-withdrawal type="number" inputmode="decimal" min="0" step="0.01" value="${hasRecord ? escapeHtml(String(record.withdrawal_amount)) : ''}" placeholder="0.00">
          </label>
          <button class="dc-btn" type="button" data-dc-save-withdrawal${withdrawalSaved ? ' disabled' : ''}>${escapeHtml(withdrawalSaved ? T.withdrawalSaved : T.saveWithdrawal)}</button>
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
      state.reference = data?.reference || null;
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
    if (state.busy) return;
    state.busy = true;
    const kind = body.openingAmount !== undefined ? 'opening' : 'withdrawal';
    const submitKey = state.submitKeys[kind] || (globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(16).slice(2)}`);
    state.submitKeys[kind] = submitKey;
    const button = host.querySelector(kind === 'opening' ? '[data-dc-save-opening]' : '[data-dc-save-withdrawal]');
    const buttonText = button?.textContent || '';
    if (button) { button.disabled = true; button.textContent = T.submitting; }
    showPageError('');
    try {
      const accepted = await api.post(SALES_DAILY_CASH_API, { ...body, submitKey });
      state.submitKeys[kind] = '';
      // POST 已受理 ⇒ 立刻回执；后台写入失败由统一异步层通知，不让页面干等。
      if (accepted?.redirect_url) { window.location.assign(accepted.redirect_url); return; }
      if (accepted?.toast) showToast(accepted.toast);
      await load();
    } catch (error) {
      const code = String(error?.message || '');
      const message = code === 'opening_amount_required' ? T.openingRequired
        : (code.includes('opening') ? T.openingInvalid
          : (code.includes('withdrawal') ? T.withdrawalInvalid : T.saveFailed));
      state.submitKeys[kind] = '';
      showPageError(message);
    } finally {
      state.busy = false;
      if (button) { button.disabled = false; button.textContent = buttonText; }
    }
  };

  const bind = () => {
    const host = state.host;
    if (!host) return;
    const opening = host.querySelector('[data-dc-opening]');
    const withdrawal = host.querySelector('[data-dc-withdrawal]');
    host.querySelector('[data-dc-fill-reference]')?.addEventListener('click', () => {
      if (!opening || !state.reference || state.busy) return;
      const amount = money(state.reference.retained_amount);
      opening.value = String(state.reference.retained_amount);
      const status = host.querySelector('[data-dc-fill-status]');
      if (status) status.textContent = T.filledReference.replace('{amount}', amount);
      opening.focus();
      // 一键填入并提交：和手动保存走同一个异步 / toast / 工作台回执。
      void save({ openingAmount: opening.value }, opening);
    });
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
