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
  // ⭐ 2026-10-11：**她真想再打一份**的路 —— 这个按钮带 `again=1`，**绕过**防连点窗口。
  printBatchAgain: '再打一份',
  refresh: '刷新状态',
  lastJobPrefix: '最近一次：',
  enqueuedTitle: '已提交打印',
  duplicatedBanner: '刚刚已经发过一次：本次 {count} 张（没有重复提交）',
  unavailable: '打印服务暂时不可用，稍后再试',
};

/** 这一块的外壳（按钮 + 状态位）。**不写死任何文案**（文案在 `data-view` 里由 JS 填）。 */
export function queueBarHtml() {
  return `
      <div class="label-queue-bar" data-view="queue-bar">
        <button class="btn btn-primary" type="button" data-action="queue-print" disabled>打印到店里那台电脑</button>
        <button class="btn" type="button" data-action="queue-again" disabled>再打一份</button>
        <button class="btn btn-ghost" type="button" data-action="queue-refresh">刷新状态</button>
        <label class="queue-rotate">打印方向
          <select data-field="queue-rotate" data-view="queue-rotate">
            <option value="">跟随服务器设置</option>
            <option value="90">90°</option>
            <option value="180">180°</option>
            <option value="270">270°</option>
          </select>
        </label>
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
    // ⭐ 幂等键：**一批查询结果一个 key**（同一批连点 ⇒ 服务端只建一个任务）。
    //   每次查询成功由 `setBatchKey` 换新（= 新的一批 = 一次新的提交意图）。
    batchKey: '',
  };
  let root = null;
  let getFilters = () => ({});

  const pick = (name) => (root ? root.querySelector(`[data-action="${name}"]`) : null);
  const view = (name) => (root ? root.querySelector(`[data-view="${name}"]`) : null);
  /** 选中的打印方向（'' = 跟随服务器配置）。 */
  const currentRotate = () => {
    const select = view('queue-rotate');
    return select ? String(select.value || '') : '';
  };

  function render() {
    if (!root) return;
    const button = pick('queue-print');
    const againButton = pick('queue-again');
    const badge = view('queue-badge');
    const jobs = view('queue-jobs');
    const notice = view('queue-notice');
    const canClick = state.online !== null && !state.submitting && state.hasLabels;
    if (button) {
      button.textContent = state.texts.printBatch;
      // ⚠️ 状态还没拿到之前**不许点**（免得提交到一个"不知道在不在线"的队列上，让她以为没反应）。
      button.disabled = !canClick;
    }
    if (againButton) {
      // ⭐ 「再打一份」= **她明确知道刚打过、还要再打一份**（绕过防连点窗口）。
      againButton.textContent = state.texts.printBatchAgain;
      againButton.disabled = !canClick;
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

  /** `again = true` ⇒ 明确表达"再打一份"（服务端会绕过防连点窗口）。 */
  async function submit({ again = false } = {}) {
    if (!root || state.submitting) return null;
    state.submitting = true;
    state.notice = '';
    render();
    try {
      const rotate = currentRotate();
      const result = await api.post('/api/workbench/label-print/jobs', {
        mode: 'batch',
        filters: getFilters(),
        // 同一批查询结果用同一个 key ⇒ 连点只建一个任务。
        submit_key: state.batchKey,
        ...(again ? { again: true } : {}),
        // ⭐ 打印方向：空 = 跟随服务器配置；选了就只对这一次生效（试 90°/270° 用，不用重启）。
        ...(rotate ? { rotate } : {}),
      });
      await refresh();
      // 提交了就说提交了几张（**不静默**）；命中去重就**说清楚没有重复提交**（她上次就是不知道才连点的）。
      state.notice = result?.reused
        ? filledText(state.texts.duplicatedBanner, { count: result.total_labels ?? 0 })
        : submittedText(result, state.texts);
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
      const againButton = pick('queue-again');
      const refreshButton = pick('queue-refresh');
      if (printButton) printButton.addEventListener('click', () => { void submit(); });
      if (againButton) againButton.addEventListener('click', () => { void submit({ again: true }); });
      if (refreshButton) refreshButton.addEventListener('click', () => { void refresh(); });
      render();
    },
    refresh,
    submit,
    /** 每次查询成功换一把新 key（同一批结果 = 同一个提交意图）。 */
    setBatchKey(key) {
      state.batchKey = String(key || '');
    },
    setEnabled(hasLabels) {
      // 没有可打印的标签时，按钮一起挂起（与旁边那颗「打印这些标签」同一条口径）。
      state.hasLabels = Boolean(hasLabels);
      render();
    },
    render,
  };
}

/** 文案模板填充（`{count}`）。认不出的占位符**原样留着**（不静默吞掉）。 */
export function filledText(template, values = {}) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  ));
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
