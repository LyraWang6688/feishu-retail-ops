/**
 * 轻量 toast（页面内短提示）—— 业务负责人 2026-11-10 要的「轻量 toast」。
 *
 * 与 `shared/toast.js`（服务端 303 回执、读 `?toast=` 的那个）不是同一个场景。
 *
 * 2026-11-11：页面内提示也支持「跟数据/页面走」——
 *   · 普通提示：默认 3 秒；
 *   · `{ sticky: true }`：一直显示到
 *       ① 页面切换（`workbench:view-change`）
 *       ② 数据读请求空闲（`workbench:reads-idle`，且确实发生过读请求）
 *       ③ 20 秒兜底
 *     用于「正在读取品类和库存…」这类不能提前消失的提示。
 * 样式复用 `styles/base.css` 的 `.workbench-toast`（同一个视觉，不新造一套）。
 */
const MAX_STICKY_MS = 20000;
let current = null;

function cleanup() {
  if (!current) return;
  if (current.timer) clearTimeout(current.timer);
  if (current.onViewChange) window.removeEventListener('workbench:view-change', current.onViewChange);
  if (current.onReadStart) window.removeEventListener('workbench:reads-start', current.onReadStart);
  if (current.onReadIdle) window.removeEventListener('workbench:reads-idle', current.onReadIdle);
  current = null;
}

export const showToast = (text, options = {}) => {
  const content = String(text || '').trim();
  if (!content) return;
  cleanup();
  let toast = document.querySelector('.workbench-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'workbench-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    document.body.appendChild(toast);
  }
  toast.textContent = content;

  const state = { timer: null, onViewChange: null, onReadStart: null, onReadIdle: null };
  current = state;
  const remove = () => { cleanup(); if (toast.parentNode) toast.remove(); };
  const duration = Number(options.durationMs);
  if (options.sticky === true) {
    let readSeen = false;
    state.onViewChange = remove;
    state.onReadStart = () => { readSeen = true; };
    state.onReadIdle = () => { if (readSeen) remove(); };
    window.addEventListener('workbench:view-change', state.onViewChange);
    window.addEventListener('workbench:reads-start', state.onReadStart);
    window.addEventListener('workbench:reads-idle', state.onReadIdle);
    state.timer = setTimeout(remove, MAX_STICKY_MS);
  } else {
    state.timer = setTimeout(remove, Number.isFinite(duration) && duration > 0 ? duration : 3000);
  }
};
