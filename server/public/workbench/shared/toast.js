/**
 * 2026-10-27：异步销售提交后直接回工作台，并在工作台顶部显示 5 秒 toast。
 * 文案由服务端放在 `?toast=` 里（不在前端写死中文）；显示完清掉 URL 参数，刷新不重复弹。
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
  setTimeout(function () {
    toast.style.display = 'none';
  }, 5000);
})();
