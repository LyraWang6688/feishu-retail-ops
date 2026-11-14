import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { WRITE_AUDIT_PAGE, WRITE_AUDIT_TEXTS as T } from '../../config/writeAudit.js';

const fill = (text, values = {}) => String(text || '').replace(/\{(\w+)\}/g, (m, key) => (values[key] == null ? '' : String(values[key])));
const $ = (selector) => document.querySelector(selector);

const timeText = (iso) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso || '');
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
};

const fieldsHtml = (fields) => {
  const entries = Object.entries(fields || {});
  if (!entries.length) return `<p class="wa-empty">${escapeHtml(T.noFields)}</p>`;
  return `<div class="wa-fields">${entries.map(([name, value]) => `<span class="wa-field"><b>${escapeHtml(name)}</b><span>${escapeHtml(value)}</span></span>`).join('')}</div>`;
};

const eventHtml = (event) => `
  <article class="wa-row">
    <div class="wa-row-head"><span class="wa-time">${escapeHtml(timeText(event.at))}</span><span class="wa-op">${escapeHtml(event.operation)}</span></div>
    <div class="wa-row-meta"><span>${escapeHtml(T.table)}：${escapeHtml(event.table_name || event.table_key || event.table_id)}</span><span>${escapeHtml(T.record)}：${escapeHtml(event.record_id || '-')}</span></div>
    ${fieldsHtml(event.fields)}
  </article>`;

const render = (rows) => {
  const total = $('#wa-total');
  const list = $('#wa-list');
  total.textContent = fill(T.total, { count: rows.length });
  if (!rows.length) {
    list.innerHTML = `<p class="wa-empty">${escapeHtml(T.empty)}</p>`;
    return;
  }
  const groups = new Map();
  for (const row of rows) {
    const key = row.trace_id || `__no_trace__:${row.at}:${row.record_id || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const ordered = [...groups.entries()]
    .map(([key, events]) => ({
      key,
      events: events.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)) || (a.seq - b.seq)),
    }))
    .sort((a, b) => String(b.events[b.events.length - 1]?.at || '').localeCompare(String(a.events[a.events.length - 1]?.at || '')));
  list.innerHTML = `<h2 class="wa-recent-title">${escapeHtml(T.recentTitle)}</h2><p class="wa-hint">${escapeHtml(T.hint)}</p>${ordered.map(({ key, events }) => `
    <section class="wa-trace"><h2>${escapeHtml(T.trace)}：${escapeHtml(key.startsWith('__no_trace__:') ? T.noTrace : key)} <small>${escapeHtml(fill(T.taskCount, { count: events.length }))}</small></h2>${events.map(eventHtml).join('')}</section>`).join('')}`;
};

const load = async () => {
  const list = $('#wa-list');
  const total = $('#wa-total');
  list.innerHTML = `<p class="wa-empty">${escapeHtml(T.recentLoading)}</p>`;
  total.textContent = '';
  try {
    const data = await api.get(WRITE_AUDIT_PAGE.api);
    render(Array.isArray(data?.rows) ? data.rows : []);
  } catch {
    list.innerHTML = `<p class="wa-empty">${escapeHtml(T.loadFailed)}</p>`;
  }
};

void load();
