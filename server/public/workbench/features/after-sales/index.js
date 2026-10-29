/**
 * 售后**扫一扫落地页**（业务负责人 2026-10-29 定的页面口径）。
 *
 * 用户路径：工作台「售后单」→ 飞书扫一扫 → 扫货品二维码 → 落到这一页。
 * 这一页只做三件事（**不写库**）：
 *   ① 用二维码里的货品记录 id 读「近 7 天、这款货品、还没售后过」的销售明细；
 *   ② 每条候选摆出她点名要的三个事实：**销售日 / 尺码 / 该单总金额**；
 *   ③ 选中一条之后，下面出三个按钮：**换货 · 退货 · 赔货**（她定的水平顺序）。
 *
 * ⚠️ 按钮之后的处理逻辑**还没接**（她：等页面确认没问题再谈）——
 *    点击只给一句如实提示，**不发任何写请求**（`actionPending` 文案在配置里）。
 *
 * 数据来源（一个接口，只读）：
 *   GET `/api/workbench/sales/after-sales/scan-candidates?productRecordId=…&days=7`
 *   → `services/afterSalesScanService.js`（读「销售明细 / 销售主表 / 货品信息」三张表）。
 */

import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { AFTER_SALES_ACTIONS, AFTER_SALES_PAGE } from '../../config/afterSalesPage.js';

/** 毫秒时间戳 → `2026-10-29`（上海时区；取不到就空串，不编一个今天）。 */
const formatDate = (value) => {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return '';
  const date = new Date(time + 8 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
};

/** 金额：有数才显示（空与 0 是两件事 —— 空显示 `—`，0 显示 `¥0`）。 */
const formatAmount = (value) => {
  if (value == null || value === '') return AFTER_SALES_PAGE.amountEmpty;
  const number = Number(value);
  if (!Number.isFinite(number)) return AFTER_SALES_PAGE.amountEmpty;
  return `¥${number.toLocaleString('zh-CN')}`;
};

/**
 * 一条候选卡：**从左到右一行**摆「销售日 / 尺码 / 总金额」，三样**同字号**、日期**不突出**。
 *
 * ⭐ 2026-10-29（业务负责人 HTML 批注）：
 *   「每张卡片你不需要提供销售单号信息，保持从左到右在一行显示日期、尺码、总金额就可以，
 *    然后你的日期不用突出，颜色保持不变，然后字号保持一样大」
 *   ⇒ 删掉「销售单号」那一行；日期不再是加粗大字；三样同字号（颜色保持：金额仍是主色）。
 *   ⚠️ 三个值的**含义**不能丢：`aria-label` 里逐字带上「销售日 / 尺码 / 总金额」（读屏与自动化可读）。
 */
const candidateCardHtml = (item) => {
  const date = formatDate(item.sales_date) || AFTER_SALES_PAGE.dateEmpty;
  const size = item.size == null ? AFTER_SALES_PAGE.sizeEmpty : `${item.size} 码`;
  const amount = formatAmount(item.total_amount);
  return `
  <button class="entry-card candidate-card" type="button"
    data-detail="${escapeHtml(item.sales_detail_record_id)}"
    data-order="${escapeHtml(item.sales_entry_record_id)}"
    aria-label="${escapeHtml(AFTER_SALES_PAGE.dateLabel)} ${escapeHtml(date)} · ${escapeHtml(AFTER_SALES_PAGE.sizeLabel)} ${escapeHtml(size)} · ${escapeHtml(AFTER_SALES_PAGE.totalLabel)} ${escapeHtml(amount)}">
    <span class="candidate-value">${escapeHtml(date)}</span>
    <span class="candidate-value">${escapeHtml(size)}</span>
    <span class="candidate-value candidate-total">${escapeHtml(amount)}</span>
  </button>`;
};

/**
 * ⭐⭐ 2026-10-29（业务负责人定的交互）：「用户选择哪条记录，就在那条卡片上把它变成三个按钮」
 *   ⇒ 选中的那条**原地**变成一排三个按钮：换货 / 退货 / 赔货（**只有这三个词，不做解释**）。
 *   · 没选中的卡片仍是「销售日 / 尺码 / 总金额」那一行；
 *   · 换选另一条 ⇒ 上一条变回卡片，新的那条变成按钮；
 *   · 这一排按钮**不做解释文案**（她：「那三个按钮就是单纯的换货、退货和赔货，你不用做解释」）。
 */
const candidateActionsHtml = () => `
  <div class="candidate-card candidate-card-actions" role="group" aria-label="${escapeHtml(AFTER_SALES_PAGE.actionLabel)}">
    ${AFTER_SALES_ACTIONS.map((action) => `
      <button class="candidate-action" type="button" data-action="${escapeHtml(action.value)}">${escapeHtml(action.label)}</button>`).join('')}
  </div>`;

/** 一条候选（选中 ⇒ 变成三个按钮；没选中 ⇒ 还是那一行卡片）。 */
const candidateHtml = (item, selected) => (
  selected ? candidateActionsHtml() : candidateCardHtml(item)
);

/**
 * @param {HTMLElement} container 页面容器（`#after-sales-app`）
 * @param {{ productRecordId?: string, apiBase?: string }} [options]
 *   ⚠️ 这两个只给**本地预览**用（HTML 标注插件会把页面重新宿主，URL 参数会丢、请求也会打到插件域）：
 *   · `productRecordId`：预览时直接给货品记录 id（真实运行只从 URL 读）；
 *   · `apiBase`：预览时的接口源（真实运行留空 = 同源相对路径）。
 *   页面源码里**没有**"预览专用分支"——预览服务只是在吐 HTML 时替换了这一句调用。
 */
export function mountAfterSalesPage(container, options = {}) {
  const params = new URLSearchParams(window.location.search);
  const productRecordId = String(
    options.productRecordId || params.get('productRecordId') || params.get('product_record_id') || '',
  ).trim();
  const apiBase = String(options.apiBase || '').trim();

  const productLine = container.querySelector('[data-view="after-sales-product"]');
  const status = container.querySelector('[data-view="after-sales-status"]');
  const body = container.querySelector('[data-view="after-sales-body"]');
  let selectedDetailId = '';
  let candidates = [];

  const showStatus = (text, isError = false) => {
    status.textContent = text;
    status.classList.toggle('hidden', !text);
    status.classList.toggle('error', Boolean(isError));
  };

  const showActionResult = (text) => {
    const host = body.querySelector('[data-view="action-result"]');
    if (host) host.textContent = text;
  };

  const renderCandidates = () => {
    body.innerHTML = candidates.length
      ? `<p class="candidate-hint">${escapeHtml(AFTER_SALES_PAGE.chooseHint)}</p>
         <div class="candidate-list" data-view="after-sales-candidates">${candidates
    .map((item) => candidateHtml(item, item.sales_detail_record_id === selectedDetailId))
    .join('')}</div>
         <p class="action-result" data-view="action-result" role="status"></p>`
      : '';
  };

  // ⚠️ 2026-10-29（业务负责人 HTML 批注）：页头「← 返回 售后单」整块删掉了
  //   ⇒ 这里不再有返回按钮的处理（页面里没有那个元素，留着就是死代码）。
  container.addEventListener('click', (event) => {
    // 选中某一条 ⇒ 重新画一遍列表：**选中那条原地变成三个按钮**（其余仍是卡片）。
    const candidate = event.target.closest('[data-detail]');
    if (candidate) {
      selectedDetailId = candidate.dataset.detail || '';
      showStatus('');
      renderCandidates();
      return;
    }
    const action = event.target.closest('[data-action]');
    if (!action || !selectedDetailId) return;
    body.querySelectorAll('[data-action]').forEach((node) => {
      node.classList.toggle('active', node === action);
    });
    const spec = AFTER_SALES_ACTIONS.find((item) => item.value === action.dataset.action);
    showActionResult(AFTER_SALES_PAGE.actionPending(spec?.label || ''));
  });

  if (!productRecordId) {
    if (productLine) productLine.textContent = AFTER_SALES_PAGE.productMissing;
    showStatus(AFTER_SALES_PAGE.productMissing, true);
    return;
  }
  if (productLine) productLine.textContent = AFTER_SALES_PAGE.productLoading;
  showStatus(AFTER_SALES_PAGE.loading);

  const query = new URLSearchParams({
    productRecordId,
    days: String(AFTER_SALES_PAGE.days),
  });
  api.get(`${apiBase}${AFTER_SALES_PAGE.scanCandidatesApi}?${query}`)
    .then((data) => {
      const product = data?.product || {};
      const productText = [product.item_no || product.number, product.color].filter(Boolean).join(' · ');
      if (productLine) productLine.textContent = productText;
      candidates = Array.isArray(data?.candidates) ? data.candidates : [];
      if (!candidates.length) {
        showStatus(AFTER_SALES_PAGE.empty);
        renderCandidates();
        return;
      }
      const excluded = Number(data?.excluded?.alreadyAfterSales) || 0;
      showStatus(excluded > 0 ? AFTER_SALES_PAGE.excludedHint(excluded) : '');
      renderCandidates();
    })
    .catch(() => {
      if (productLine) productLine.textContent = '';
      showStatus(AFTER_SALES_PAGE.failed, true);
    });
}
