'use strict';

/**
 * ⭐⭐ 2026-10-18（第 4 步提速 · **提交不再白屏**）：
 *
 * 问题（线上实测）：资金页提交是**同步整页导航** —— 浏览器等到服务器把明细/收款/库存写完才渲染，
 *   她这 87 秒里**页面上什么都没有**（白屏）；按钮上那句"正在提交…"在导航后也看不见了。
 *
 * 做法（她 2026-10-12 亲口纠正过：「**我们是能够进行动态交互的**」⇒ 扫码页允许 JS ✓）：
 *   · 点【提交】时**先弹全屏进度遮罩**（文案取自按钮上已有的 `data-submit-feedback`，配置驱动 ✓
 *     —— 本段脚本里**一个新中文字面量都没有**）；
 *   · 用 `fetch` 把表单 POST 到同一个地址（同一份表单字段，`button` 的 name/value 也照带）；
 *   · 响应回来（成功页 / 资金页 / 400 提示页都是完整 HTML）⇒ `document.write` 换掉本文档
 *     ⇒ 与原生表单提交**落点完全一致**（地址栏 URL 不变、表单 action 仍可用）✓；
 *   · 网络失败（离线等）⇒ 退回**原生表单提交**（不自己编错误文案）。
 *
 * 🔴 只拦**两种**提交（其余一切表单一个字节都不变）：
 *   ① 货品页那颗【提交（N 双）】（按钮带 `data-progress-submit="1"`）；
 *   ② 资金页那张表单（`data-view="payment-pay"`，它只有一颗提交按钮）。
 *   ⚠️ 【再加一双】/【清空本单】/补货/退货/库存那几张表单**不在拦截范围**（本来是 303 跳转，很快）。
 * 🔴 防重复点：遮罩打开期间所有提交按钮 `disabled`，再点直接吞掉。
 */
const SUBMIT_PROGRESS_STYLE = `
.progress-overlay{position:fixed;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:rgba(15,23,42,.55);z-index:9999;padding:24px;text-align:center;color:#fff}
.progress-overlay[data-open="1"]{display:flex}
.progress-overlay__spinner{width:34px;height:34px;border-radius:50%;border:3px solid rgba(255,255,255,.35);border-top-color:#fff;animation:progress-spin .9s linear infinite}
@keyframes progress-spin{to{transform:rotate(360deg)}}
.progress-overlay__text{margin:0;font-size:17px;font-weight:600;line-height:1.5}
`;

/** 页面里**真有**要拦截的提交时才发这一段（其余页面逐字节不变 ✓）。 */
const hasProgressSubmit = (content) => String(content).includes('data-progress-submit="1"')
  || String(content).includes('data-view="payment-pay"');

const submitProgressScriptHtml = (failureText = '') => `<script data-view="submit-progress">
var SUBMIT_FAILURE_TEXT = ${JSON.stringify(String(failureText || ''))};
(function () {
  if (window.__scanSubmitProgress) return;
  window.__scanSubmitProgress = true;
  var busy = false;
  var overlay = null;
  function textNode(node) { return node.querySelector('[data-view="submit-progress-text"]'); }
  function overlayOf() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'progress-overlay';
    overlay.setAttribute('data-view', 'submit-progress-overlay');
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    var spinner = document.createElement('div');
    spinner.className = 'progress-overlay__spinner';
    var label = document.createElement('p');
    label.className = 'progress-overlay__text';
    label.setAttribute('data-view', 'submit-progress-text');
    overlay.appendChild(spinner);
    overlay.appendChild(label);
    document.body.appendChild(overlay);
    return overlay;
  }
  function lockButtons(disabled) {
    var buttons = document.querySelectorAll('button[type="submit"]');
    for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = disabled;
  }
  function show(label) {
    var node = overlayOf();
    textNode(node).textContent = label || '';
    node.setAttribute('data-open', '1');
    busy = true;
    lockButtons(true);
  }
  function hide() {
    busy = false;
    if (overlay) overlay.setAttribute('data-open', '0');
    lockButtons(false);
  }
  function progressFormOf(event) {
    var form = event.target;
    if (!form || String(form.tagName || '').toUpperCase() !== 'FORM') return null;
    var submitter = event.submitter || null;
    if (submitter) return submitter.getAttribute('data-progress-submit') === '1' ? form : null;
    return form.getAttribute('data-view') === 'payment-pay' ? form : null;
  }
  function deliver(response) {
    return response.text().then(function (html) {
      try { document.open(); document.write(html); document.close(); }
      catch (error) { window.location.reload(); }
    });
  }
  document.addEventListener('submit', function (event) {
    if (busy) { event.preventDefault(); return; }
    var form = progressFormOf(event);
    if (!form) return;
    if (!window.fetch || !window.FormData) return;
    event.preventDefault();
    var submitter = event.submitter || null;
    show((submitter && submitter.getAttribute('data-submit-feedback')) || '');
    var body = new FormData(form);
    if (submitter && submitter.name) body.append(submitter.name, submitter.value || '');
    // ⚠️ Do NOT read the clobbered action property: two submit buttons are named
    //    "action" (native name=value), so it becomes a RadioNodeList and the POST goes
    //    to /r/[object RadioNodeList] (unknown_action). Read the attribute instead.
    var action = form.getAttribute('action') || window.location.href;
    fetch(action, {
      method: 'POST', body: body, credentials: 'same-origin'
    }).then(deliver).catch(function () {
      // 2026-10-27: do NOT resubmit automatically; avoid two POSTs from one click.
      hide();
      show(SUBMIT_FAILURE_TEXT);
    });
  }, true);
})();
</script>`;


module.exports = { SUBMIT_PROGRESS_STYLE, hasProgressSubmit, submitProgressScriptHtml };
