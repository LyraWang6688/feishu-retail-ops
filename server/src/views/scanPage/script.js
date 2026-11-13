const { realmScanScriptSource } = require('../scanRealmScan');
const fs = require('node:fs');
const path = require('node:path');
const { escapeHtml } = require('./fields');


/**
 * ⭐⭐ 2026-10-12（业务负责人真机反馈，逐字）：「点完之后**没有 Toast、按键置灰**之类的提示，
 *   页面完全没有及时的交互反馈 ⇒ 我不知道指令到底有没有到达，**就会一直狂点**」。
 *
 * 🔴 这是这一页**唯一**的一段 JS（她明确要"置灰"，而"置灰"没有零 JS 的等价物）：
 *   · 只做一件事：**提交时把按钮置灰 + 换成「正在下发…」**（文案从 `data-submitting` 读，配置给的）；
 *   · 不发任何请求、不碰 DOM 别的部分、不依赖任何框架/构建产物；
 *   · ⚠️ 它**只在「货品」领域**（打印表单所在的那一块）出现 —— 其余五个领域**照旧一行脚本都没有**；
 *   · 退一步：脚本没跑（webview 禁 JS）也**不影响功能** —— 表单照旧是原生提交，
 *     只是少了"按钮立刻置灰"这一层；服务端那两道（短窗去重 + 结果横幅）仍然在。
 */
const submitSubmittingText = (write) => String(write?.texts?.submitSubmitting || '');
const submitSubmittingElapsedText = (write) => String(write?.texts?.submitSubmittingElapsed || '');

/**
 * ⭐⭐ 2026-10-13（她：「领域/批次**要点 4、5 次**才切换、跳转」+「我想查我点了几次」）：
 *  点**会跳转 / 会写数据**的东西 ⇒ 立刻给反应（换文案 + 置灰 + 防重复点 ✓）并上报一条 `ui.tap`。
 *  ⚠️ 全在**同一段脚本**里（别新增第二段 ✗ —— 有哨兵钉着"整页只有一段脚本"）；
 *  ⚠️ 脚本**模板串内只写 ASCII 注释**（写中文会让硬编码中文闸门多一条假增量 ✗ 我踩过）；
 *  ⚠️ 上报用 `navigator.sendBeacon`（不阻塞跳转 ✓ 失败静默 ✓），**只带 target/page**（不采集表单值 ✗）。
 */
/**
 * ⭐⭐ 2026-10-14 晚（埋点 P0 ⑤「工作台接同一套上报」）：**同一份客户端实现**。
 *
 * 扫码页这一页的硬约束是**只有一段脚本**（`<script data-view="submit-feedback">`，有哨兵钉着；
 * 她 2026-10-09 白屏之后定的）⇒ 不能 `src=` 引外部文件 ✗。
 * ⇒ 做法：把 `public/workbench/shared/ui-tap.js`（工作台用 `<script src>` 加载的**同一个文件**）
 *   在渲染时**内联**进这一段里 —— **一份实现、两种装载方式**（绝不各抄一份 ✗）。
 * ⚠️ 文件读不到 ⇒ **当场抛**（不静默降级：页面里的脚本会引用一个不存在的全局，
 *   那比启动就报错难查得多）；⚠️ 那个文件必须是 **ASCII**（本段模板有硬编码中文闸门）。
 */
const UI_TAP_SHARED_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'public', 'workbench', 'shared', 'ui-tap.js'), 'utf8',
);

/**
 * ⭐⭐ 2026-10-16 业务负责人亲口点的功能（逐字）：
 *   「我在**页面上**加一个小开关：你打开后，**点页面上的哪一块，那一块就高亮**，
 *     并弹出它的**名字**（比如"退货折叠条"/"整单金额输入框"）⇒ 你截给我，我就**不用猜**了」
 *   她选的范围（逐字）：**扫码页 + 工作台都做** ✓
 *
 * 做法：**同一份实现、两种装载方式**（与上面 `ui-tap.js` 完全同一条口径 ✓）——
 *   · 扫码页：渲染时把这个文件**内联**进 `<script data-view="annotate">`（这一页不引外部资源）；
 *   · 工作台：`index.html` 里 `<script src="/workbench/shared/annotate.js" defer>` 引**同一个文件**。
 *   ⚠️ 两处**绝不各抄一份**：`test/pageAnnotate.test.js` 钉住"内联的 == 那个文件"逐字一致 ✓
 *
 * 🔴 **只在 `?annotate=1` 时才出现**（真实用户看不到 ✓）：
 *   这一段**开头就判**（`location.search` 里有没有 `annotate=1`），没有就**立刻早退** ——
 *   不建任何 DOM、不绑任何监听、不动任何表单。所以不带参数时这一页**运行时逐字无痕** ✓
 *   （⚠️ 不带参数时**输出里**确实多这一行脚本标签：查询串只有 `routes/scanPage.js` 拿得到，
 *     而那个文件不在本任务写作用域内 ⇒ 闸门只能落在脚本内部。成对迁移的哨兵见下。）
 *
 * ⚠️ **零 JS 哨兵的成对迁移**（`AC-W2` / `AC-6R5`）：
 *   「扫码页一行 `<script>` 都不许有」是**我方（agent 侧）**的约束，**不是她的口径** ——
 *   她 2026-10-12 两次纠正：「我可没有说过，**我们是能够进行动态交互的**」。
 *   ⇒ 那两条哨兵按"**改前逐字 → 改后逐字 → 依据 = 她 2026-10-12 逐字**"成对迁移为
 *     「**不带 `?annotate=1` 时那一页仍然是零业务脚本；那一段标注脚本必须开头早退**」✓
 */
const submitFeedbackScriptHtml = () => `<script data-view="submit-feedback">
${UI_TAP_SHARED_SOURCE}
(function () {
  var forms = document.querySelectorAll('form');
  for (var i = 0; i < forms.length; i += 1) {
    forms[i].addEventListener('submit', function (event) {
      // 2026-10-27: a form may have multiple submit buttons (add-item vs main submit).
      // Use event.submitter; never assume the first button. Before disabling it, keep its
      // name/value as a hidden field so the server still sees which action was tapped.
      var form = event.target;
      var submitter = event.submitter || form.querySelector('button[type="submit"]');
      var button = submitter;
      if (!button || button.disabled) return;
      var submitterName = String(button.name || '');
      var submitterValue = String(button.value || '');
      if (submitterName) {
        var kept = document.createElement('input');
        kept.type = 'hidden';
        kept.name = submitterName;
        kept.value = submitterValue;
        form.appendChild(kept);
      }
      // 2026-10-12: her words -- "tapping seems to do nothing, so I keep tapping".
      //    The button label must never become empty: with no attribute configured, fall back to the button's own text.
      var label = button.getAttribute('data-submit-feedback') || form.getAttribute('data-submit-feedback') || button.textContent;
      var elapsedTemplate = button.getAttribute('data-submitting-elapsed')
        || form.getAttribute('data-submit-feedback-elapsed') || '';
      // Amount is required (>0): tapping always gives feedback -- empty/zero shows a hint and sends no request.
      //    Field name and hint text live on THIS form (no hardcoded Chinese into the script).
      var amountName = form.getAttribute('data-amount-field') || '';
      var amountInput = amountName ? form.querySelector('[name="' + amountName + '"]') : null;
      if (amountInput) {
        var amountValue = parseFloat(String(amountInput.value || '').replace(/[^0-9.]/g, ''));
        if (!(amountValue > 0)) {
          event.preventDefault();
          // 2026-10-29: hint slot is configurable via data-amount-hint-view (return form uses its own
          //   slot; forms without it keep the legacy accept-amount-required slot -- byte-for-byte same).
          var hintView = form.getAttribute('data-amount-hint-view') || 'accept-amount-required';
          var hintText = form.getAttribute('data-amount-hint-text') || '';
          var hint = hintView ? form.querySelector('[data-view="' + hintView + '"]') : null;
          if (!hint && hintView) {
            hint = document.createElement('p');
            hint.className = 'hint';
            hint.setAttribute('data-view', hintView);
            form.insertBefore(hint, form.firstChild);
          }
          if (hint) { hint.textContent = hintText; hint.removeAttribute('hidden'); }
          amountInput.focus();
          return;
        }
      }
      // Return form guard (quantity-only: blank / 0 = not returned).
      //   2026-10-29 (business-owner annotation: "what is this checkbox for?"): the return form has
      //   ONE quantity input per size -- blank / 0 means "not returned", >=1 means "return this size".
      //   2026-11-08 (business-owner: "no compatibility needed"): the legacy checkbox branch was
      //   DELETED -- a stale page posting only the old return-sizes field is now rejected by the
      //   write layer (return_empty 400 + zero writes), no silent fallback.
      var returnQtyPrefix = form.getAttribute('data-return-qty-prefix') || '';
      if (returnQtyPrefix) {
        var returnHintView = form.getAttribute('data-return-hint-view') || '';
        var showReturnHint = function (text, focusEl) {
          event.preventDefault();
          var hint = returnHintView ? form.querySelector('[data-view="' + returnHintView + '"]') : null;
          if (hint) { hint.textContent = text; hint.removeAttribute('hidden'); }
          if (focusEl && focusEl.focus) focusEl.focus();
        };
        var maxSizes = parseInt(form.getAttribute('data-return-max-sizes') || '', 10);
        var maxQuantity = parseInt(form.getAttribute('data-return-max-quantity') || '', 10);
        var qtyInputs = form.querySelectorAll('[name^="' + returnQtyPrefix + '"]');
        var qtyPicked = [];
        for (var q = 0; q < qtyInputs.length; q += 1) {
          var qtyRaw = String(qtyInputs[q].value || '').replace(/^\\s+|\\s+$/g, '');
          if (qtyRaw === '') continue;                      // blank = not returned (not an error)
          if (!/^[0-9]+$/.test(qtyRaw)) {                   // not an integer => block (user typo)
            showReturnHint(form.getAttribute('data-return-quantity-text') || '', qtyInputs[q]);
            return;
          }
          var qtyValue = parseInt(qtyRaw, 10);
          if (qtyValue === 0) continue;                     // explicit 0 = not returned
          if (maxQuantity > 0 && qtyValue > maxQuantity) {
            showReturnHint(form.getAttribute('data-return-quantity-text') || '', qtyInputs[q]);
            return;
          }
          var rowStockAttr = qtyInputs[q].getAttribute('data-stock');
          if (rowStockAttr !== null && rowStockAttr !== '') {
            var rowStockCap = parseInt(rowStockAttr, 10);
            if (!isNaN(rowStockCap) && qtyValue > rowStockCap) {
              var rowSize = qtyInputs[q].getAttribute('data-size') || '';
              var rowStockText = String(form.getAttribute('data-return-stock-text') || '')
                .split('{size}').join(rowSize)
                .split('{stock}').join(String(rowStockCap));
              showReturnHint(rowStockText, qtyInputs[q]);
              return;
            }
          }
          qtyPicked.push(qtyInputs[q]);
        }
        if (!qtyPicked.length) {
          showReturnHint(form.getAttribute('data-return-required-text') || '', null);
          return;
        }
        if (maxSizes > 0 && qtyPicked.length > maxSizes) {
          showReturnHint(form.getAttribute('data-return-limit-text') || '', null);
          return;
        }
      }
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = label || button.textContent;
      // While the server is slow it must never look like "nothing happened": append elapsed seconds.
      if (!elapsedTemplate) return;
      var seconds = 0;
      setInterval(function () {
        seconds += 1;
        button.textContent = elapsedTemplate.replace('{seconds}', String(seconds));
      }, 1000);
    });
  }
  // 2026-10-13: instant feedback on navigation links + one ui.tap report.
  // ASCII-only inside this template (a Chinese comment here would trip the hardcoded-Chinese gate).
  var tapLinks = document.querySelectorAll('a[data-tap-target]');
  for (var t = 0; t < tapLinks.length; t += 1) {
    tapLinks[t].addEventListener('click', function (event) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      var link = event.currentTarget;
      tapReport(link.getAttribute('data-tap-target') || '');
      // 2026-10-14: highlight the tapped realm cell IMMEDIATELY (her rule: feedback must not
      //   wait for the data). The server stays authoritative on the next load -- this only
      //   pre-marks the cell so a tap is visibly acknowledged. ASCII only in this template.
      var realmId = link.getAttribute('data-realm-id');
      if (realmId) {
        var bar = link.closest ? link.closest('.realm-bar') : null;
        if (bar) {
          var cells = bar.querySelectorAll('.realm-tab');
          for (var c = 0; c < cells.length; c += 1) {
            cells[c].classList.toggle('realm-tab--active', cells[c] === link);
          }
        }
      }
      // 2026-10-13 late: this block used to be
      //   if (data-opening === '1') { event.preventDefault(); return; }
      // which set data-opening=1 on the FIRST tap; if that navigation did not
      // actually go through (same path, only the query changed), EVERY later tap
      // was swallowed by preventDefault -- exactly the "taps do nothing" report.
      // The external tab (xin shang) has no data-tap-target, so it was never bound
      // and kept working. Never swallow a tap: show feedback, always navigate.
      if (link.getAttribute('data-opening') !== '1') {
        link.setAttribute('data-opening', '1');
      }
      link.style.opacity = '0.55';
      var openLabel = link.getAttribute('data-open-label');
      if (openLabel && link.textContent !== openLabel) link.textContent = openLabel;
    });
  }
  var tapForms = document.querySelectorAll('form');
  for (var f2 = 0; f2 < tapForms.length; f2 += 1) {
    tapForms[f2].addEventListener('submit', function (event) {
      var form = event.target;
      var btn = form.querySelector('button[type="submit"][name="action"]');
      // 2026-10-14: one tap -> BEACON + a hidden tap_id on THIS form, so the write request
      //   that follows can be correlated with the tap (the server logs ui.tap.result for it).
      var tapId = tapReport('submit:' + (btn && btn.value ? btn.value : ''));
      try { dshUiTap.stampForm(form, { tapId: tapId }); } catch (error) { /* never block submit */ }
    });
  }
  function tapReport(target) {
    try {
      if (!target || !dshUiTap) return '';
      var seg = location.pathname.split('/')[1] || 's';
      // 2026-10-14 cut B: the /s/accept page is gone, so the page value here is
      //   always 'scan' now (that branch could never hit again). ASCII only in this block.
      var page = 'scan';
      // Shared implementation (inlined at the top of this block):
      //   it reports target/tap_id/since_ms; the SERVER decides tap vs tap.repeated.
      return dshUiTap.track(target, { path: '/' + seg + '/ui-tap', page: page });
    } catch (error) {
      // silent: a failed report must never block navigation
      return '';
    }
  }
})();
</script>`;

/**
 * ⭐⭐ 2026-10-16（task-61 · 领域内扫一扫）：**只有这一页真有那个配置块时才出现**（否则空串 ⇒
 *   页面上**一个字都不多** ✓ `AC-ML5` 的零回归逐字节比对就靠它 ✓）。
 */
const realmScanScriptTagHtml = () => `<script data-view="realm-scan">${realmScanScriptSource()}</script>`;

/**
 * ── 两个写入口的表单（销售建单 / 补货报单）────────────────────────────────────
 *
 * 都是**原生 HTML 表单**（没有一行业务 JS）：手机浏览器直接打开就能用，也不给这一页
 * 添任何前端构建产物（与第一版只读页的取舍一致）。
 *
 * 🔴 每个表单里都带一个 `submit_key`（**幂等键**，由服务端会话给出）：
 *   连点两次 = 同一个键 = 只写一次（见 `services/scanWriteService.js`）。
 * ⚠️ 所有值都 `escapeHtml`：它们从表里来（货号 / 尺码），不是可信 HTML。
 */
/**
 * ⭐⭐ 2026-10-12（业务负责人拍板，落进 AGENTS.md《前端交互反馈纪律》）：
 *   「用户点击完之后**一定要有交互**：要么按钮置灰 · 要么弹出 Toast · 要么更改当前的提示文案……
 *     **不然用户以为点了没反应，就会多次提交**。」
 *   ⇒ 扫码页**所有会发起写操作的按钮**都挂这两个属性：
 *     · `data-submit-feedback` —— 点下去**立刻**换成的文案（按钮也同时 disabled）；
 *     · `data-submitting-elapsed` —— 服务端慢时每秒刷新的"处理中（已 N 秒）"模板。
 *   ⚠️ 属性值统一从配置来（`scanWrite.texts.submitSubmitting*`），渲染层不写死中文。
 */
const submitFeedbackAttrs = (writeLike = {}) => {
  const texts = writeLike?.texts || {};
  return ` data-submit-feedback="${escapeHtml(texts.submitSubmitting || '')}"`
    + ` data-submitting-elapsed="${escapeHtml(texts.submitSubmittingElapsed || '')}"`;
};

/**
 * ⭐⭐ 2026-10-17 C（业务负责人逐字：「**默认一行 ＋ ＋ 再加一种付款方式**」）：
 *   点一下 ⇒ **克隆最后一行收款**并清空值（方式回到"不记"、金额清空）。
 *   **纯前端**：不提交、不发请求、不写库 ✓（这一颗是 `<button type="button">`，不在提交链上 ✓）。
 *   ⚠️ 只有页面真有 `data-payment-add` 时才注入（否则一个字节都不多 ✓）。
 */
const paymentAddRowScriptHtml = () => `<script data-view="payment-add-row">
(function(){
  var btns = document.querySelectorAll('[data-payment-add]');
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', function(){
      var rows = document.querySelectorAll('.form-row--pay');
      if (!rows.length) return;
      var last = rows[rows.length - 1];
      var clone = last.cloneNode(true);
      var selects = clone.querySelectorAll('select');
      for (var s = 0; s < selects.length; s++) { selects[s].value = ''; }
      var inputs = clone.querySelectorAll('input');
      for (var n = 0; n < inputs.length; n++) { inputs[n].value = ''; }
      if (!clone.querySelector('[data-payment-remove]')) {
        var remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn payment-row__remove';
        remove.setAttribute('data-payment-remove', '');
        remove.textContent = '×';
        clone.appendChild(remove);
      }
      last.parentNode.insertBefore(clone, last.nextSibling);
    });
  }
  document.addEventListener('click', function(event) {
    var remove = event.target.closest && event.target.closest('[data-payment-remove]');
    if (!remove) return;
    var row = remove.closest('.form-row--pay');
    if (row) row.remove();
  });
})();
</script>`;

module.exports = {
  submitSubmittingText,
  submitSubmittingElapsedText,
  submitFeedbackScriptHtml,
  realmScanScriptTagHtml,
  paymentAddRowScriptHtml,
  submitFeedbackAttrs,
};

/**
 * 资金页「赠品」行：默认不出现；点添加才拉候选并出现一行，
 * 数量默认 1，可删除；提交前把「名称×数量、…」写进既有 hidden gift 字段。
 * 仅当页面有 `data-gift-add` 时注入。
 */
const giftRowsScriptHtml = () => `<script data-view="gift-rows">
(function(){
  var section = document.querySelector('[data-gift-section]');
  if (!section) return;
  var rows = section.querySelector('[data-gift-rows]');
  var tpl = section.querySelector('[data-gift-template]');
  var value = section.querySelector('[data-gift-value]');
  var error = section.querySelector('[data-gift-error]');
  var add = section.querySelector('[data-gift-add]');
  if (!rows || !tpl || !value || !add) return;
  var options = null;
  var loading = null;
  function load() {
    if (options) return Promise.resolve(options);
    if (loading) return loading;
    loading = fetch('/api/workbench/accessories/gifts', { credentials: 'same-origin' })
      .then(function (res) { return res.json(); })
      .then(function (data) { options = Array.isArray(data.items) ? data.items : []; return options; })
      .catch(function () { options = []; return options; });
    return loading;
  }
  function refresh() {
    var parts = [];
    var list = rows.querySelectorAll('[data-gift-row]');
    for (var i = 0; i < list.length; i++) {
      var select = list[i].querySelector('[data-gift-name]');
      var qty = list[i].querySelector('[data-gift-quantity]');
      var name = select ? String(select.value || '').trim() : '';
      var n = qty ? Math.max(1, Math.floor(Number(qty.value) || 1)) : 1;
      if (name) parts.push(name + '×' + n);
    }
    value.value = parts.join('、');
    if (error) error.hidden = true;
  }
  function addRow() {
    load().then(function (items) {
      if (!items.length) { if (error) error.hidden = false; return; }
      var row = tpl.content.firstElementChild.cloneNode(true);
      var select = row.querySelector('[data-gift-name]');
      var placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = section.getAttribute('data-gift-placeholder') || '';
      select.appendChild(placeholder);
      for (var i = 0; i < items.length; i++) {
        var option = document.createElement('option');
        option.value = String(items[i].name || '');
        option.textContent = String(items[i].name || '');
        select.appendChild(option);
      }
      var qty = row.querySelector('[data-gift-quantity]');
      if (qty) qty.value = '1';
      row.querySelector('[data-gift-remove]').addEventListener('click', function () {
        row.remove();
        refresh();
      });
      rows.appendChild(row);
      refresh();
    });
  }
  add.addEventListener('click', addRow);
  rows.addEventListener('input', refresh);
  rows.addEventListener('change', refresh);
  refresh();
})();
</script>`;

module.exports.giftRowsScriptHtml = giftRowsScriptHtml;
