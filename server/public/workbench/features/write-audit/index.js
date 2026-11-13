import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { WRITE_AUDIT_PAGE, WRITE_AUDIT_TEXTS as T } from '../../config/writeAudit.js';

const fill = (text, values = {}) => String(text || '').replace(/\{(\w+)\}/g, (m, key) => (values[key] == null ? '' : String(values[key])));
const $ = (selector) => document.querySelector(selector);

const fieldsHtml = (fields) => {
  const entries = Object.entries(fields || {});
  if (!entries.length) return `<p class="wa-empty">${escapeHtml(T.noFields)}</p>`;
  return `<div class="wa-fields">${entries.map(([name, value]) => `<span class="wa-field"><b>${escapeHtml(name)}</b><span>${escapeHtml(value)}</span></span>`).join('')}</div>`;
};

const eventHtml = (event) => `
  <article class="wa-row">
    <div class="wa-row-head"><span class="wa-time">${escapeHtml(event.at)}</span><span class="wa-op">${escapeHtml(event.operation)}</span></div>
    <div class="wa-row-meta"><span>${escapeHtml(T.table)}：${escapeHtml(event.table_key || event.table_id)}</span><span>${escapeHtml(T.record)}：${escapeHtml(event.record_id || '-')}</span></div>
    ${fieldsHtml(event.fields)}
  </article>`;

const render = (rows) => {
  const list = $('#wa-list');
  const total = $('#wa-total');
  total.textContent = fill(T.total, { count: rows.length });
  if (!rows.length) {
    list.innerHTML = `<p class="wa-empty">${escapeHtml(T.empty)}</p>`;
    return;
  }
  const groups = new Map();
  for (const row of rows) {
    const key = row.trace_id || 'no_trace';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  list.innerHTML = [...groups.entries()].map(([trace, events]) => `
    <section class="wa-trace"><h2>${escapeHtml(T.trace)}：${escapeHtml(trace)}</h2>${events.map(eventHtml).join('')}</section>`).join('');
};

const query = async () => {
  const orderNo = String($('#wa-order')?.value || '').trim();
  if (!orderNo) return;
  const list = $('#wa-list');
  const total = $('#wa-total');
  list.innerHTML = `<p class="wa-empty">${escapeHtml(T.loading)}</p>`;
  total.textContent = '';
  try {
    const data = await api.get(`${WRITE_AUDIT_PAGE.api}?${WRITE_AUDIT_PAGE.orderQueryKey}=${encodeURIComponent(orderNo)}`);
    render(Array.isArray(data?.rows) ? data.rows : []);
  } catch {
    list.innerHTML = `<p class="wa-empty">${escapeHtml(T.loadFailed)}</p>`;
  }
};

const orderNo = new URLSearchParams(location.search).get(WRITE_AUDIT_PAGE.orderQueryKey) || '';
$('#wa-order').value = orderNo;
$('#wa-query').addEventListener('click', () => { void query(); });
$('#wa-order').addEventListener('keydown', (event) => { if (event.key === 'Enter') void query(); });
if (orderNo) void query();
