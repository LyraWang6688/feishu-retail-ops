import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { AFTER_SALES_ACTIONS, AFTER_SALES_PAGE } from '../../config/afterSalesPage.js';

const fmtTime = (value) => {
  const n = Number(value);
  const d = new Date(Number.isFinite(n) ? n : String(value || ''));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { hour12: false });
};

const detailText = (line) => [line.product, line.color, line.size ? `${line.size} 码` : '']
  .filter(Boolean).join(' · ');

const candidatesHtml = (candidates) => candidates.map((order) => `
  <button class="entry-card order-candidate" type="button" data-order="${escapeHtml(order.record_id)}">
    <span class="entry-card-body">
      <strong>${escapeHtml(order.order_no || order.record_id)}</strong>
      <span class="muted">${escapeHtml(fmtTime(order.recorded_at))}</span>
      <span class="muted">${(order.matched_details || []).map(detailText).map(escapeHtml).join('；')}</span>
    </span>
  </button>`).join('');

const actionsHtml = () => `
  <div class="after-sales-actions">
    <p class="muted">${escapeHtml(AFTER_SALES_PAGE.chooseAction)}</p>
    <div class="domain-cards">
      ${AFTER_SALES_ACTIONS.map((action) => `<button class="entry-card" type="button" data-action="${escapeHtml(action.value)}">
        <span class="entry-card-body"><strong>${escapeHtml(action.label)}</strong></span>
      </button>`).join('')}
    </div>
  </div>`;

export function mountAfterSalesPage(container) {
  const params = new URLSearchParams(window.location.search);
  const productRecordId = String(params.get('productRecordId') || params.get('product_record_id') || '').trim();
  let selected = null;
  container.innerHTML = `<div class="domain-page">
    <div class="after-sales-head"><button class="btn btn-ghost" type="button" data-back="1">${escapeHtml(AFTER_SALES_PAGE.back)}</button>
    <h2>${escapeHtml(AFTER_SALES_PAGE.title)}</h2></div>
    <p class="section-loading" data-view="after-sales-status">${escapeHtml(AFTER_SALES_PAGE.loading)}</p>
    <div data-view="after-sales-body"></div>
  </div>`;
  const body = container.querySelector('[data-view="after-sales-body"]');
  const status = container.querySelector('[data-view="after-sales-status"]');
  const showStatus = (text, isError = false) => {
    status.textContent = text;
    status.classList.toggle('empty', isError);
  };
  container.addEventListener('click', (event) => {
    if (event.target.closest('[data-back]')) { window.location.href = '/workbench/'; return; }
    const order = event.target.closest('[data-order]');
    if (order) {
      selected = order.dataset.order;
      container.querySelectorAll('[data-order]').forEach((el) => el.classList.toggle('active', el === order));
      body.querySelector('[data-view="after-sales-actions"]')?.remove();
      body.insertAdjacentHTML('beforeend', `<div data-view="after-sales-actions">${actionsHtml()}</div>`);
      return;
    }
    const action = event.target.closest('[data-action]');
    if (!action || !selected) return;
    const target = new URL('/workbench/', window.location.origin);
    target.searchParams.set('after_sales_order', selected);
    target.searchParams.set('after_sales_action', action.dataset.action);
    window.location.href = target.href;
  });
  if (!productRecordId) { showStatus('缺少货品记录，请重新扫码。', true); return; }
  api.get(`${AFTER_SALES_PAGE.candidatesApi}?${new URLSearchParams({ productRecordId, days: String(AFTER_SALES_PAGE.days) })}`)
    .then((data) => {
      const candidates = data?.candidates || [];
      if (!candidates.length) { showStatus(AFTER_SALES_PAGE.empty); return; }
      showStatus(AFTER_SALES_PAGE.chooseOrder);
      body.innerHTML = `<div class="domain-cards">${candidatesHtml(candidates)}</div>`;
    })
    .catch(() => showStatus(AFTER_SALES_PAGE.failed, true));
}
