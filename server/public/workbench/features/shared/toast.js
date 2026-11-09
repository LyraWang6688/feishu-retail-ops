/**
 * 轻量 toast（页面内的短提示，3 秒消失）—— 业务负责人 2026-11-10 要的「轻量 toast」。
 *
 * 与 `shared/toast.js`（顶部 5 秒、读 `?toast=` 参数的那个）**不是同一个场景**：
 *   · 那个 = 服务端 303 跳转回工作台后弹一次（提交回执）；
 *   · 这个 = 页面里点按钮后**即时**弹（不走跳转，比如"已开始同步…"）。
 * 样式复用 `styles/base.css` 的 `.workbench-toast`（同一个视觉，不新造一套）。
 */
export const showToast = (text) => {
  const content = String(text || '').trim();
  if (!content) return;
  let toast = document.querySelector('.workbench-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'workbench-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    document.body.appendChild(toast);
  }
  toast.textContent = content;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.remove(); }, 3000);
};
