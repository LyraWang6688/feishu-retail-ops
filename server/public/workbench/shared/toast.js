/**
 * 2026-11-11：提交回执 toast 不再固定 5 秒，而是**跟页面就绪状态走**：
 *   · 出现：带 `?toast=` 打开工作台后立刻显示；
 *   · 消失：当前模块已挂载 **且** 首屏读请求已空闲，再留一小段让用户看清；
 *   · 页面切换：用户点其他 tab ⇒ 立刻消失（不把旧页面的回执带到新页面）；
 *   · 兜底：最多保留 20 秒，避免接口异常时一直挂在页面上。
 *
 * 读请求生命周期由 `core/api-client.js` 发 `workbench:reads-start` / `workbench:reads-idle`；
 * 页面切换 / 模块挂载由 `main.js` 发 `workbench:view-change` / `workbench:module-mounted`。
 * 文案仍由服务端放在 `?toast=` 里（不在前端写死中文），显示完清掉 URL 参数，刷新不重复弹。
 */
(function () {
  var params = new URLSearchParams(window.location.search);
  var text = String(params.get('toast') || '').trim();
  if (!text) return;
  var toast = document.createElement('div');
  toast.className = 'workbench-toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.setAttribute('data-view', 'workbench-toast');
  toast.textContent = text;
  document.body.appendChild(toast);
  try {
    var clean = new URL(window.location.href);
    clean.searchParams.delete('toast');
    clean.searchParams.delete('done');
    window.history.replaceState(null, '', clean.pathname + clean.search + clean.hash);
  } catch (error) { /* URL 清理失败不影响 toast */ }

  var MAX_WAIT_MS = 20000;
  var SETTLE_MS = 1200;
  var removed = false;
  var moduleMounted = false;
  var readsPending = false;
  var settleTimer = null;
  var maxTimer = null;

  function remove() {
    if (removed) return;
    removed = true;
    if (settleTimer) clearTimeout(settleTimer);
    if (maxTimer) clearTimeout(maxTimer);
    toast.remove();
  }

  function scheduleFinish() {
    if (removed || !moduleMounted || readsPending) return;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(remove, SETTLE_MS);
  }

  window.addEventListener('workbench:reads-start', function () {
    readsPending = true;
    if (settleTimer) clearTimeout(settleTimer);
  });
  window.addEventListener('workbench:reads-idle', function () {
    readsPending = false;
    scheduleFinish();
  });
  window.addEventListener('workbench:module-mounted', function () {
    moduleMounted = true;
    scheduleFinish();
  });
  window.addEventListener('workbench:view-change', remove);
  maxTimer = setTimeout(remove, MAX_WAIT_MS);
})();
