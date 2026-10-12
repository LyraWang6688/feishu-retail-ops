export function showPageError(message = '') {
  const element = document.getElementById('page-error');
  element.textContent = message;
  element.classList.toggle('hidden', !message);
}

export function describeError(error) {
  return error.requestId ? `${error.message}（请求编号：${error.requestId}）` : error.message;
}

export function setBusy(button, busy, busyText = '处理中…') {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText;
  } else if (button.dataset.originalText) {
    button.textContent = button.dataset.originalText;
    delete button.dataset.originalText;
  }
  button.disabled = busy;
}

export function bindSubTabs(container, onActivate = () => {}) {
  container.querySelectorAll('.sub-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const group = tab.closest('.sub-tabs');
      const panel = tab.closest('.panel');
      group.querySelectorAll('.sub-tab').forEach((item) => item.classList.toggle('active', item === tab));
      panel.querySelectorAll(':scope > .sub-panel').forEach((item) => {
        item.classList.toggle('hidden', item.id !== `${tab.dataset.subtab}-subpanel`);
      });
      onActivate(tab.dataset.subtab);
    });
  });
}

// ── ⭐⭐ 2026-10-12《前端交互反馈纪律》（业务负责人）：点了**立刻**要有反馈 ──────────────
//
// 她的原话（逐字）：
//   「用户点击完之后一定要有交互：**要么按钮置灰 · 要么弹出 Toast · 要么更改当前的提示文案**……
//    同样的逻辑和思路，也需要应用到扫码页和**工作台**……不然用户以为点了没反应，就会**多次提交**。」
//
// 这一处实现**同时**解决两件事（各模块只 import 它，不各写一份）：
//   ① **即时反馈**：点击那一刻就 `disabled = true` + 换文案（慢任务从第 1 秒起显示「（已 N 秒）」，纯前端计时、零额外请求）；
//   ② **防连点**：同一颗按钮在跑的时候，后续点击**直接忽略**（不发第二次请求）；
//      跑完（成功或失败）**恢复**按钮 —— 失败要能重试。

/** 提交按钮的默认"处理中"文案。 */
export const SUBMIT_PENDING_TEXT = '正在提交，请不要重复点…';

/** 慢任务第 N 秒的文案（不足 1 秒不加秒数，免得出现"已 0 秒"）。 */
export const pendingLabel = (base = SUBMIT_PENDING_TEXT, seconds = 0) => {
  const whole = Math.floor(Number(seconds) || 0);
  return whole >= 1 ? `${base}（已 ${whole} 秒）` : base;
};

/**
 * 「提交守卫」工厂（`options` 只为用例注入，生产用默认值）。
 * `run(button, task, pendingText)`：
 *   · 同一颗按钮在跑 ⇒ 直接返回 `undefined`（**这一次什么都不做**）；
 *   · 否则：立刻置灰 + 换文案 + 起秒表 → `await task()` → finally 恢复按钮并清秒表；
 *   · `task` 抛错**照原样抛**（页面用 `describeError` 显示人话、按钮已恢复可重试）。
 * `button` 拿不到（null）时**照常执行**任务 —— 不许因为"没法置灰"就不发。
 */
export const createSubmitGuard = (options = {}) => {
  const defaultText = options.pendingText || SUBMIT_PENDING_TEXT;
  const now = options.now || (() => Date.now());
  const startTimer = options.setInterval || ((fn, ms) => setInterval(fn, ms));
  const stopTimer = options.clearInterval || ((id) => clearInterval(id));
  const inFlight = new Set();

  return {
    isPending: (button) => Boolean(button) && inFlight.has(button),
    pendingText: defaultText,
    async run(button, task, pendingText) {
      if (!button) return task();
      if (inFlight.has(button)) return undefined; // ⭐ 连点：上一次还在跑，这一次直接忽略
      inFlight.add(button);
      const base = pendingText || defaultText;
      const originalText = button.textContent;
      const startedAt = now();
      button.disabled = true;
      button.textContent = pendingLabel(base, 0);
      const ticker = startTimer(() => {
        button.textContent = pendingLabel(base, (now() - startedAt) / 1000);
      }, 1000);
      try {
        return await task();
      } finally {
        stopTimer(ticker);
        inFlight.delete(button);
        button.disabled = false;
        button.textContent = originalText; // 失败也恢复 ⇒ 她能再点一次
      }
    },
  };
};

/** 全工作台共用的一个守卫（三个模块都 import 它）。 */
export const submitGuard = createSubmitGuard();

/** 写操作的统一入口：点了**立刻有反馈** + **防连点**（各模块只调这一个）。 */
export const runWriteAction = (button, task, pendingText) => submitGuard.run(button, task, pendingText);
