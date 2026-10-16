const { REALM_TEXTS, labelPrintUrls } = require('../scanPageRealm');
const { escapeHtml } = require('./fields');

const labelBlockHtml = (view, print = null) => {
  const urls = labelPrintUrls(view);
  const heading = `<h2 class="stock__heading">${escapeHtml(REALM_TEXTS.labelHeading)}</h2>`;
  const batchLink = `<a class="btn" href="${escapeHtml(urls.batch)}" rel="noopener">${escapeHtml(REALM_TEXTS.labelBatchButton)}</a>`;
  const pageLink = `<a class="btn btn--ghost" href="${escapeHtml(urls.single)}" rel="noopener">${escapeHtml(REALM_TEXTS.labelSingleButton)}</a>`;

  // `print` 没给（渲染层被单独调用 / 这条链路还没接上）⇒ **退回改动前那一块**：只有那两条链接。
  if (!print) {
    return `<section class="card">
${heading}
${batchLink}
${pageLink}
</section>`;
  }

  const texts = print.texts || {};
  // 打印服务不可用（队列坏了 / 明确关掉）⇒ 如实说一句 + 仍然让她能去标签打印页，**绝不留空白**。
  if (print.enabled === false) {
    const notice = texts.unavailable
      ? `<p class="hint">${escapeHtml(texts.unavailable)}</p>`
      : '';
    return `<section class="card">
${heading}
${notice}
${batchLink}
${pageLink}
</section>`;
  }

  const job = print.job || null;
  const bannerJob = print.banner_job || null;
  const statusText = print.online ? texts.online : texts.offline;
  const badgeClass = print.online ? 'label-print-badge--online' : 'label-print-badge--offline';
  const filled = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  ));
  /**
   * ⭐⭐ 2026-10-11 真机反馈（「点完没有反馈 ⇒ 她以为没点上、连点几次 ⇒ 多打了好几张」）之后
   * 加的**显眼横幅**（放在这一块最上面，她一眼就看见，不是在"最近一次"那种小字里）：
   *   · 刚提交成功（`?printed=1`）⇒ 绿条：**已发送给打印电脑：本次 N 张** +
   *     在线/未连接（在线⇒马上打 / 未连接⇒已排队自动补打）+ **已提交，不用重复点**；
   *   · 命中去重（`?dup=1`）⇒ 黄条：**刚刚已经发过一次：本次 N 张（没有重复提交）** +
   *     一句"确实要再打一张" + **【再打一张】** 按钮（`again=1`，**绕过**去重窗口）——
   *     她的正当重复打印需求**不许被锁死**。
   * ⚠️ `N` 从**那条任务上读**（`banner_job.total_labels`），不是页面上猜的。
   * ⚠️ 仍然**零 JS**：横幅是服务端拼的静态 HTML，【再打一张】是一个小表单。
   */
  const count = Number(bannerJob?.total_labels ?? job?.total_labels ?? 0);
  // ⚠️ 「刚提交成功」那条横幅只在**读到那条任务**（`count > 0`；生产上永远读得到）时才出 ——
  //    宁可不出，也不给她一句"本次 0 张"那种假话。
  const showSubmitted = print.submitted && count > 0;
  const banner = print.duplicated
    ? `<div class="label-print-banner label-print-banner--dup">
<p class="label-print-banner__title">${escapeHtml(filled(texts.duplicatedBanner, { count }))}</p>
<p class="label-print-banner__note">${escapeHtml(texts.duplicatedHint || '')}</p>
<form class="label-print-form" method="post" action="${escapeHtml(print.postAction)}" data-submit-feedback-elapsed="${escapeHtml(texts.submitSubmittingElapsedForPrint || texts.printSubmitting || '')}">
<input type="hidden" name="${escapeHtml(print.actionField)}" value="${escapeHtml(print.actionValue)}">
<input type="hidden" name="${escapeHtml(print.againField || 'again')}" value="1">
<button class="btn" type="submit" data-submit-feedback="${escapeHtml(texts.printSubmitting || '')}">${escapeHtml(texts.printAgain || '再打一张')}</button>
</form>
</div>`
    : (showSubmitted
      ? `<div class="label-print-banner label-print-banner--ok">
<p class="label-print-banner__title">${escapeHtml(filled(texts.submittedBanner, { count }))}</p>
<p class="label-print-banner__note">${escapeHtml(print.online
        ? (texts.submittedOnline || statusText)
        : (texts.submittedOffline || statusText))}</p>
<p class="label-print-banner__note">${escapeHtml(texts.submittedNoRepeat || '')}</p>
${print.queue_position && texts.submittedQueueNote
    ? `<p class="label-print-banner__note" data-view="print-queue-position">${escapeHtml(filled(texts.submittedQueueNote, { position: print.queue_position }))}</p>`
    : ''}
</div>`
      : '');
  // 「最近一次：<状态>」+（失败时）原因 —— 她要"失败要给原因"，所以原因**同一行看得见**。
  const jobLine = job
    ? `<p class="label-print-job">${escapeHtml(`${texts.lastJobPrefix || ''}${job.status_label || job.status}`)}${job.status === 'failed' && job.failure_reason ? ` — ${escapeHtml(job.failure_reason)}` : ''}</p>`
    : '';
  return `<section class="card">
${heading}
${banner}
<form class="label-print-form" method="post" action="${escapeHtml(print.postAction)}">
<input type="hidden" name="${escapeHtml(print.actionField)}" value="${escapeHtml(print.actionValue)}">
<button class="btn btn--primary" type="submit" data-submit-feedback="${escapeHtml(texts.printSubmitting || '')}">${escapeHtml(texts.printSingle || REALM_TEXTS.labelHeading)}</button>
</form>
<p class="label-print-status"><span class="label-print-badge ${badgeClass}">${escapeHtml(statusText || '')}</span></p>
${jobLine}
${batchLink}
${pageLink}
</section>`;
};

module.exports = {
  labelBlockHtml,
};
