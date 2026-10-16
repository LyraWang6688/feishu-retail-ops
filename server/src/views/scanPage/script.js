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
const ANNOTATE_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'public', 'workbench', 'shared', 'annotate.js'), 'utf8',
);

/** 标注脚本（**只在 `?annotate=1` 时才会做任何事** —— 见上面注释与 `shared/annotate.js` 的文件头）。 */
const annotateScriptHtml = () => `<script data-view="annotate">
${ANNOTATE_SOURCE}</script>`;

const submitFeedbackScriptHtml = () => `<script data-view="submit-feedback">
${UI_TAP_SHARED_SOURCE}
(function () {
  var forms = document.querySelectorAll('form');
  for (var i = 0; i < forms.length; i += 1) {
    forms[i].addEventListener('submit', function (event) {
      var button = event.target.querySelector('button[type="submit"]');
      if (!button || button.disabled) return;
      var form = event.target;
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
          var hintView = 'accept-amount-required';
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
      // Return form: she taps the button with nothing checked, or with a quantity that is not a positive
      //    integer. Field names / limits / all wording live on THIS form as data-* attributes
      //    (no field-name concatenation and no user-visible text inside this script).
      var returnSizesField = form.getAttribute('data-return-sizes-field') || '';
      if (returnSizesField) {
        var boxes = form.querySelectorAll('[name="' + returnSizesField + '"]');
        var picked = [];
        for (var b = 0; b < boxes.length; b += 1) { if (boxes[b].checked) picked.push(boxes[b]); }
        var returnHintView = form.getAttribute('data-return-hint-view') || '';
        var showReturnHint = function (text, focusEl) {
          event.preventDefault();
          var hint = returnHintView ? form.querySelector('[data-view="' + returnHintView + '"]') : null;
          if (hint) { hint.textContent = text; hint.removeAttribute('hidden'); }
          if (focusEl && focusEl.focus) focusEl.focus();
        };
        if (!picked.length) {
          showReturnHint(form.getAttribute('data-return-required-text') || '', null);
          return;
        }
        var maxSizes = parseInt(form.getAttribute('data-return-max-sizes') || '', 10);
        if (maxSizes > 0 && picked.length > maxSizes) {
          showReturnHint(form.getAttribute('data-return-limit-text') || '', null);
          return;
        }
        var maxQuantity = parseInt(form.getAttribute('data-return-max-quantity') || '', 10);
        for (var p = 0; p < picked.length; p += 1) {
          var quantityName = picked[p].getAttribute('data-qty-name') || '';
          var quantityInput = quantityName ? form.querySelector('[name="' + quantityName + '"]') : null;
          var raw = String((quantityInput && quantityInput.value) || '').replace(/^\s+|\s+$/g, '');
          var isInteger = /^[0-9]+$/.test(raw);
          var quantity = isInteger ? parseInt(raw, 10) : 0;
          if (!isInteger || quantity < 1 || (maxQuantity > 0 && quantity > maxQuantity)) {
            showReturnHint(form.getAttribute('data-return-quantity-text') || '', quantityInput);
            return;
          }
          // Her rule (2026-10-15): a return may not exceed the stock this size still has.
          //    The row's cap is on the checkbox as data-stock; a row WITHOUT it means "stock unknown"
          //    -- never treated as zero (that would block every size when the read failed).
          var stockAttr = picked[p].getAttribute('data-stock');
          if (stockAttr !== null && stockAttr !== '') {
            var stockCap = parseInt(stockAttr, 10);
            if (!isNaN(stockCap) && quantity > stockCap) {
              var stockText = String(form.getAttribute('data-return-stock-text') || '')
                .split('{size}').join(String(picked[p].value))
                .split('{stock}').join(String(stockCap));
              showReturnHint(stockText, quantityInput);
              return;
            }
          }
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

module.exports = {
  submitSubmittingText,
  submitSubmittingElapsedText,
  annotateScriptHtml,
  submitFeedbackScriptHtml,
  realmScanScriptTagHtml,
  submitFeedbackAttrs,
};
