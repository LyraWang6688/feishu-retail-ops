import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { showPageError } from '../../core/ui.js';
import { SALES_QUERY_PAGE as PAGE } from '../../config/salesQuery.js';

const fill = (text, values = {}) => String(text || '').replace(/\{(\w+)\}/g, (m, key) => (values[key] == null ? '' : String(values[key])));
const money = (value) => Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const amountText = (value) => `¥${money(value)}`;
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
const statusClass = (status) => (status === '已交付' ? 'ok' : (status === '未交付' ? 'wait' : 'back'));

function methodsHtml(methods, pendingMethods, revenue) {
  const max = Math.max(...methods.map((item) => Number(item.amount) || 0), 1);
  const normal = methods.map((item) => `<div class="sq-bar-row">
    <span>${escapeHtml(item.method || '未标注方式')}</span>
    <div class="sq-bar"><i style="width:${Math.max(2, (Number(item.amount) || 0) / max * 100)}%"></i></div>
    <b>${escapeHtml(amountText(item.amount))}</b>
  </div>`).join('');
  const pending = (pendingMethods || []).map((item) => `<div class="sq-pending-row">
    <span>${escapeHtml(item.method || '未标注方式')}</span>
    <b>${escapeHtml(amountText(item.amount))}</b>
    <em>${escapeHtml(PAGE.texts.pendingExcluded)}</em>
  </div>`).join('');
  return normal + pending || `<p class="sq-empty">${escapeHtml(PAGE.texts.empty)}</p>`;
}

function breakdownRows(rows) {
  if (!rows.length) return `<tr><td colspan="3" class="sq-empty">${escapeHtml(PAGE.texts.empty)}</td></tr>`;
  return rows.map((row) => `<tr>
    <td>${escapeHtml(row.name)}</td>
    <td>${row.delivered_count} / ${escapeHtml(amountText(row.delivered_amount))}</td>
    <td>${row.undelivered_count} / ${escapeHtml(amountText(row.undelivered_amount))}</td>
  </tr>`).join('');
}

function ordersHtml(orders) {
  if (!orders.length) return `<p class="sq-empty">${escapeHtml(PAGE.texts.empty)}</p>`;
  return orders.map((order) => {
    const pays = (order.payments || []).length
      ? order.payments.map((payment) => `<span class="sq-pay-tag">${escapeHtml(payment.method)} <b>${escapeHtml(amountText(payment.amount))}</b> · ${escapeHtml(payment.status)}</span>`).join('')
      : `<span class="sq-pay-tag">未收款</span>`;
    const details = (order.details || []).map((detail) => `<div class="sq-detail-row">
      <span class="sq-detail-product">${escapeHtml(detail.number || '')}</span>
      <span class="sq-detail-size">${escapeHtml(detail.size == null ? '' : detail.size)} 码</span>
      <span class="sq-detail-amount">${escapeHtml(amountText(detail.actual_amount))}</span>
      <span class="sq-status ${statusClass(detail.fulfillment_status)}">${escapeHtml(detail.fulfillment_status || '')}</span>
    </div>`).join('');
    return `<article class="sq-order">
      <div class="sq-order-head">
        <div class="sq-order-title"><b>${escapeHtml(order.order_no)}</b></div>
        <div class="sq-order-total">${order.total_amount == null ? '—' : escapeHtml(amountText(order.total_amount))}</div>
        <div class="sq-order-time">${escapeHtml(timeText(order.recorded_at))}</div>
        <div class="sq-order-pays">${pays}</div>
      </div>
      ${details}
    </article>`;
  }).join('');
}

export function createSalesQueryModule() {
  const state = { host: null };

  async function load() {
    const host = state.host;
    const from = host?.querySelector('[data-sq-from]')?.value || '';
    const to = host?.querySelector('[data-sq-to]')?.value || '';
    const body = host?.querySelector('[data-sq-body]');
    if (!body) return;
    if (from && to && from > to) {
      body.innerHTML = `<p class="sq-empty">${escapeHtml(PAGE.texts.invalidRange)}</p>`;
      return;
    }
    body.innerHTML = `<p class="sq-empty">${escapeHtml(PAGE.texts.loading)}</p>`;
    try {
      const query = new URLSearchParams();
      if (from) query.set('from', from);
      if (to) query.set('to', to);
      const data = await api.get(query.toString() ? `${PAGE.api}?${query}` : PAGE.api);
      const summary = data?.summary || {};
      const revenue = Number(summary.revenue || 0);
      const methods = Array.isArray(summary.payment_methods) ? summary.payment_methods : [];
      const pendingMethods = Array.isArray(summary.pending_methods) ? summary.pending_methods : [];
      const delivered = summary.delivered || { count: 0, amount: 0 };
      const undelivered = summary.undelivered || { count: 0, amount: 0 };
      body.innerHTML = `
        <div class="sq-section-head"><h2>${escapeHtml(PAGE.texts.amountTitle)}</h2></div>
        <div class="sq-top">
          <div class="sq-revenue"><span>${escapeHtml(PAGE.texts.revenue)}</span><b>${escapeHtml(amountText(revenue))}</b></div>
          <div class="sq-card"><div class="sq-section-head"><h2>${escapeHtml(PAGE.texts.methods)}</h2></div>${methodsHtml(methods, pendingMethods, revenue)}</div>
        </div>
        <div class="sq-section-head"><h2>${escapeHtml(PAGE.texts.volumeTitle)}</h2></div>
        <div class="sq-volume-cards">
          <div class="sq-volume-card"><span>${escapeHtml(PAGE.texts.delivered)}</span><b>${delivered.count}</b><small>双 · ${escapeHtml(amountText(delivered.amount))}</small></div>
          <div class="sq-volume-card"><span>${escapeHtml(PAGE.texts.undelivered)}</span><b>${undelivered.count}</b><small>双 · ${escapeHtml(amountText(undelivered.amount))}</small></div>
        </div>
        <div class="sq-breakdown">
          <div class="sq-card"><div class="sq-section-head"><h2>${escapeHtml(PAGE.texts.byCategory)}</h2></div>
            <table class="sq-table"><thead><tr><th>类别</th><th>已交付（双 / 元）</th><th>未交付（双 / 元）</th></tr></thead><tbody>${breakdownRows(summary.by_category || [])}</tbody></table>
          </div>
          <div class="sq-card"><div class="sq-section-head"><h2>${escapeHtml(PAGE.texts.byType)}</h2></div>
            <table class="sq-table"><thead><tr><th>品类</th><th>已交付（双 / 元）</th><th>未交付（双 / 元）</th></tr></thead><tbody>${breakdownRows(summary.by_type || [])}</tbody></table>
          </div>
        </div>
        <div class="sq-section-head"><h2>${escapeHtml(PAGE.texts.orders)}</h2></div>
        <div class="sq-orders">${ordersHtml(data.orders || [])}</div>`;
    } catch (error) {
      body.innerHTML = `<p class="sq-empty">${escapeHtml(PAGE.texts.failed)}</p>`;
      showPageError(String(error?.message || ''));
    }
  }

  return {
    mount(host) {
      state.host = host;
      showPageError('');
      const today = todayKey();
      host.innerHTML = `<div class="domain-page sq-page">
        <div class="sq-filters">
          <label class="sq-filter"><span>${escapeHtml(PAGE.texts.startLabel)}</span><input type="date" value="${today}" max="${today}" data-sq-from></label>
          <label class="sq-filter"><span>${escapeHtml(PAGE.texts.endLabel)}</span><input type="date" value="${today}" min="${today}" data-sq-to></label>
          <label class="sq-filter"><span>${escapeHtml(PAGE.texts.quickRangeLabel)}</span><select data-sq-range>${PAGE.texts.quickRanges.map((item) => `<option value="${item.days}">${escapeHtml(item.label)}</option>`).join('')}</select></label>
          <button class="sq-btn" type="button" data-sq-query>${escapeHtml(PAGE.texts.query)}</button>
        </div>
        <div data-sq-body></div>
      </div>`;
      const fromInput = host.querySelector('[data-sq-from]');
      const toInput = host.querySelector('[data-sq-to]');
      const syncBounds = () => {
        if (!fromInput || !toInput) return;
        toInput.min = fromInput.value || '';
        fromInput.max = toInput.value || '';
        if (fromInput.value && toInput.value && fromInput.value > toInput.value) {
          toInput.value = fromInput.value;
        }
        toInput.min = fromInput.value || '';
      };
      fromInput?.addEventListener('change', () => { syncBounds(); });
      toInput?.addEventListener('change', () => {
        if (fromInput?.value && toInput.value && fromInput.value > toInput.value) {
          fromInput.value = toInput.value;
        }
        syncBounds();
      });
      host.querySelector('[data-sq-query]')?.addEventListener('click', () => { void load(); });
      host.querySelector('[data-sq-range]')?.addEventListener('change', (event) => {
        const days = Number(event.target.value) || 1;
        const end = new Date();
        const start = new Date(end.getTime() - (days - 1) * 86400000);
        fromInput.value = dateKey(start);
        toInput.value = dateKey(end);
        syncBounds();
        void load();
      });
      syncBounds();
      void load();
    },
  };
}
