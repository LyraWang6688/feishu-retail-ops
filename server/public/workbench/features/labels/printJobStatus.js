import { LABEL_PRINT_STATUS_TEXTS as T } from '../../config/labelPrintStatus.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fill = (text, values = {}) => String(text || '').replace(/\{(\w+)\}/g, (m, key) => (values[key] == null ? '' : String(values[key])));

const labelOf = (status) => T[status] || T.unknown;

export const mountPrintJobStatus = (panel, jobId, { api } = {}) => {
  const section = document.createElement('section');
  section.className = 'print-job-status panel no-print';
  section.dataset.view = 'print-job-status';
  section.innerHTML = `<h3>${esc(T.title)}</h3><p class="muted" data-print-job-line>${esc(T.loading)}</p>`;
  panel.prepend(section);
  const line = section.querySelector('[data-print-job-line]');
  let timer = null;
  let stopped = false;

  const render = (data) => {
    const job = data?.job || {};
    const printer = data?.printer || {};
    const numbers = Array.isArray(job.numbers) ? job.numbers.filter(Boolean).join('、') : '';
    const parts = [
      numbers ? fill(T.numbers, { numbers }) : '',
      fill(T.submittedAt, { time: job.created_at || '—' }),
      labelOf(job.status),
      printer.online ? T.online : T.offline,
    ].filter(Boolean);
    if (job.status === 'failed' && job.failure_reason) {
      parts.push(fill(T.reason, { reason: job.failure_reason }));
    }
    line.textContent = parts.join(' ｜ ');
    line.classList.toggle('error', job.status === 'failed');
    if (job.status === 'done' || job.status === 'failed') {
      stopped = true;
      if (timer) clearTimeout(timer);
      section.insertAdjacentHTML('beforeend', `<p class="hint">${esc(T.continueHint)}</p>`);
    }
  };

  const poll = async () => {
    if (stopped) return;
    try {
      render(await api.get(`/api/workbench/label-print/jobs/${encodeURIComponent(jobId)}`));
    } catch (error) {
      line.textContent = error?.message || T.missing;
      line.classList.add('error');
      stopped = true;
      return;
    }
    if (!stopped) timer = setTimeout(poll, 2000);
  };
  void poll();
  return section;
};
