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

/** 一行候选：左边「销售日 + 单号」，右边「尺码 / 总金额」两个小格。 */
const candidateHtml = (item) => `
  <button class="entry-card candidate-card" type="button"
    data-detail="${escapeHtml(item.sales_detail_record_id)}"
    data-order="${escapeHtml(item.sales_entry_record_id)}">
    <span class="candidate-main">
      <span class="candidate-date">${escapeHtml(formatDate(item.sales_date))}</span>
      <span class="candidate-order">${escapeHtml(AFTER_SALES_PAGE.orderLabel)} ${escapeHtml(item.order_no || '')}</span>
    </span>
    <span class="candidate-figures">
      <span class="candidate-figure">
        <span class="candidate-figure-label">${escapeHtml(AFTER_SALES_PAGE.sizeLabel)}</span>
        <strong>${escapeHtml(item.size == null ? AFTER_SALES_PAGE.sizeEmpty : `${item.size}`)}</strong>
      </span>
      <span class="candidate-figure">
        <span class="candidate-figure-label">${escapeHtml(AFTER_SALES_PAGE.totalLabel)}</span>
        <strong class="candidate-total">${escapeHtml(formatAmount(item.total_amount))}</strong>
      </span>
    </span>
  </button>`;

const actionsHtml = () => `
  <div class="after-sales-actions" data-view="after-sales-actions">
    <p class="action-hint">${escapeHtml(AFTER_SALES_PAGE.actionHint)}</p>
    <div class="action-row">
      ${AFTER_SALES_ACTIONS.map((action) => `
        <button class="action-button" type="button" data-action="${escapeHtml(action.value)}">
          <strong>${escapeHtml(action.label)}</strong>
          <span>${escapeHtml(action.hint || '')}</span>
        </button>`).join('')}
    </div>
    <p class="action-result" data-view="action-result" role="status"></p>
  </div>`;

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
         <div class="candidate-list" data-view="after-sales-candidates">${candidates.map(candidateHtml).join('')}</div>`
      : '';
    renderActions();
  };

  const renderActions = () => {
    body.querySelector('[data-view="after-sales-actions"]')?.remove();
    if (!selectedDetailId) return;
    body.insertAdjacentHTML('beforeend', actionsHtml());
  };

  // ⚠️ 2026-10-29（业务负责人 HTML 批注）：页头「← 返回 售后单」整块删掉了
  //   ⇒ 这里不再有返回按钮的处理（页面里没有那个元素，留着就是死代码）。
  container.addEventListener('click', (event) => {
    const candidate = event.target.closest('[data-detail]');
    if (candidate) {
      selectedDetailId = candidate.dataset.detail || '';
      body.querySelectorAll('[data-detail]').forEach((node) => {
        node.classList.toggle('active', node === candidate);
      });
      renderActions();
      showActionResult('');
      showStatus('');
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
