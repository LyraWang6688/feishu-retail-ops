/**
 * 工作台「货品 → 标签打印」页上的**「打印到店里那台电脑」**那一块（打印队列）。
 *
 * 为什么要有它（与旁边那颗「打印这些标签」的区别）：
 *   · 「打印这些标签」= **浏览器打印**（她在这台电脑上，A4 一页铺多张，自己点对话框）；
 *   · 「打印到店里那台电脑」= **扫码页那条同一条链路**：把任务排进队列，
 *     由**店里那台 Windows 电脑**（打印小助手）出纸 —— 她人在外面也能点。
 *   ⚠️ 两条路**共用同一份"印什么"**（`config/labelPrint.js` + `labelPrintService`），
 *      只是"怎么落成一张纸"不同（HTML/CSS ↔ 服务器出的 PDF）。
 *
 * ⚠️ **不许定时轮询**（业务负责人 2026-10-11 明令"不要每 2-3 秒轮询"）：
 *    这里只有两种刷新时机 —— ① 进页面 / 查完标签后拉一次状态；② 她点【刷新状态】。
 *    实时性由**小助手那一侧的长连接**负责，页面这边看的是快照。
 *
 * ⚠️ 所有用户可见文案都**随接口下来**（`config/labelPrintQueue.js` 的 `texts`）——
 *    本文件不写第二份"在线 / 未连接"的句子。
 */
import { escapeHtml } from '../../core/formatters.js';

/** 只在这里放"接口没下来时的兜底"（真源仍是服务端 config）。 */
export const QUEUE_FALLBACK_TEXTS = {
  online: '打印电脑在线',
  offline: '未连接（任务已排队，打开小助手就会打）',
  printBatch: '打印到店里那台电脑',
  refresh: '刷新状态',
  lastJobPrefix: '最近一次：',
  enqueuedTitle: '已提交打印',
  unavailable: '打印服务暂时不可用，稍后再试',
};

/** 这一块的外壳（按钮 + 状态位）。**不写死任何文案**（文案在 `data-view` 里由 JS 填）。 */
export function queueBarHtml() {
  return `
      <div class="label-queue-bar" data-view="queue-bar">
        <button class="btn btn-primary" type="button" data-action="queue-print" disabled>打印到店里那台电脑</button>
        <button class="btn btn-ghost" type="button" data-action="queue-refresh">刷新状态</button>
        <span class="queue-badge" data-view="queue-badge"></span>
      </div>
      <p class="label-notice" data-view="queue-notice"></p>
      <p class="data-caption" data-view="queue-jobs"></p>`;
}

/** 状态徽标那一句（在线 / 未连接 —— 未连接那句就是她定的那句）。 */
export function queueBadgeText(status, texts = {}) {
  const merged = { ...QUEUE_FALLBACK_TEXTS, ...(texts || {}) };
  return status?.online ? merged.online : merged.offline;
}

/** 最近几条任务的人话（`编号 · N 张 · 状态`；失败要把原因摆出来）。 */
export function queueJobsText(jobs, texts = {}) {
  const merged = { ...QUEUE_FALLBACK_TEXTS, ...(texts || {}) };
  const list = Array.isArray(jobs) ? jobs.slice(0, 3) : [];
  if (!list.length) return '';
  return list.map((job) => {
    const number = (job.numbers || [])[0] || job.job_id || '';
    const parts = [number, `${job.total_labels ?? 0} 张`, job.status_label || job.status];
    const line = parts.join(' · ');
    return job.status === 'failed' && job.failure_reason
      ? `${line} —— ${merged.failPrefix || ''}${job.failure_reason}`
      : line;
  }).join(' ｜ ');
}

/**
 * 建这一块的控制器。`api` = 工作台的 `api`（`core/api-client.js`）。
 * 返回 `{ mount, refresh, submit, state }`。
 */
export function createLabelQueuePanel({ api, onError = () => {} } = {}) {
  const state = {
    texts: { ...QUEUE_FALLBACK_TEXTS },
    online: null,
    jobs: [],
    submitting: false,
    // ⚠️ 没查到可打印的标签时不许点（与旁边那颗「打印这些标签」同一条口径）。
    hasLabels: false,
    notice: '',
  };
  let root = null;
  let getFilters = () => ({});

  const pick = (name) => (root ? root.querySelector(`[data-action="${name}"]`) : null);
  const view = (name) => (root ? root.querySelector(`[data-view="${name}"]`) : null);

  function render() {
    if (!root) return;
    const button = pick('queue-print');
    const badge = view('queue-badge');
    const jobs = view('queue-jobs');
    const notice = view('queue-notice');
    if (button) {
      button.textContent = state.texts.printBatch;
      // ⚠️ 状态还没拿到之前**不许点**（免得提交到一个"不知道在不在线"的队列上，让她以为没反应）。
      button.disabled = state.online === null || state.submitting || !state.hasLabels;
    }
    if (badge) {
      badge.textContent = state.online === null ? '' : queueBadgeText({ online: state.online }, state.texts);
      badge.className = `queue-badge ${state.online ? 'queue-badge--online' : 'queue-badge--offline'}`;
    }
    const refreshButton = pick('queue-refresh');
    if (refreshButton) refreshButton.textContent = state.texts.refresh;
    if (notice) notice.textContent = state.notice;
    if (jobs) jobs.textContent = queueJobsText(state.jobs, state.texts);
  }

  async function refresh() {
    try {
      const data = await api.get('/api/workbench/label-print/status');
      state.online = Boolean(data.online);
      state.jobs = data.jobs || [];
      state.texts = { ...QUEUE_FALLBACK_TEXTS, ...(data.texts || {}) };
      render();
      return data;
    } catch (error) {
      state.online = false;
      render();
      onError(error);
      return null;
    }
  }

  async function submit() {
    if (!root || state.submitting) return null;
    state.submitting = true;
    state.notice = '';
    render();
    try {
      const result = await api.post('/api/workbench/label-print/jobs', {
        mode: 'batch',
        filters: getFilters(),
      });
      await refresh();
      // 提交了就说提交了几张（**不静默**）。
      state.notice = submittedText(result, state.texts);
      return result;
    } catch (error) {
      onError(error);
      return null;
    } finally {
      state.submitting = false;
      render();
    }
  }

  return {
    state,
    mount(container, filtersProvider) {
      root = container;
      getFilters = filtersProvider || (() => ({}));
      const printButton = pick('queue-print');
      const refreshButton = pick('queue-refresh');
      if (printButton) printButton.addEventListener('click', () => { void submit(); });
      if (refreshButton) refreshButton.addEventListener('click', () => { void refresh(); });
      render();
    },
    refresh,
    submit,
    setEnabled(hasLabels) {
      // 没有可打印的标签时，按钮一起挂起（与旁边那颗「打印这些标签」同一条口径）。
      state.hasLabels = Boolean(hasLabels);
      render();
    },
    render,
  };
}

/** 提交成功后给她看的那一句（**不静默**：提交了就说提交了几张）。 */
export function submittedText(result, texts = {}) {
  const merged = { ...QUEUE_FALLBACK_TEXTS, ...(texts || {}) };
  const count = result?.total_labels ?? 0;
  return `${merged.enqueuedTitle}：${count} 张`;
}

// `escapeHtml` 在这里只是**留个口子**（以后要往这一块里插表里来的值时必须用它）——
// 现在这一块显示的都是我们自己拼的字（编号 / 状态），但沿用与页面其它部分同一条纪律。
export const escapeQueueText = escapeHtml;
