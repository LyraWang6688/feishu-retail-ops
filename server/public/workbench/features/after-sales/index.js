/**
 * 售后**扫一扫落地页** + 点动作后的**弹窗原型**（业务负责人 2026-10-29）。
 *
 * 用户路径：工作台「售后单」→ 飞书扫一扫 → 扫货品二维码 → 落到这一页：
 *   ① 读「近 7 天、这款货品、还没售后过」的销售明细；
 *   ② 每条候选摆「销售日 / 尺码 / 总金额」；
 *   ③ 选中一条 ⇒ 那条卡片原地变成三个按钮：**换货 · 退货 · 赔货**（赔货灰置不可点）；
 *   ④ 点「退货 / 换货」⇒ 弹窗（居中，样式对齐交割单页付款弹窗）。
 *
 * ⚠️ 当前是**页面原型**（业务负责人：「先把页面做好」）：
 *   确认只弹 toast（退货「数据提交成功」/ 换货「信息提交成功」），**不发任何写请求**；
 *   源码哨兵钉住"本文件没有 api.post"。接异步写库是下一步。
 *
 * 数据来源（只读）：
 *   GET `/api/workbench/sales/after-sales/scan-candidates?productRecordId=…&days=7`
 *   → `services/afterSalesScanService.js`
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

/** 一条候选卡：**从左到右一行**摆「销售日 / 尺码 / 总金额」。 */
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

/** 选中的那条卡片 ⇒ 原地变成三个按钮（换货 / 退货 / 赔货；赔货灰置不可点）。 */
const candidateActionsHtml = () => `
  <div class="candidate-card candidate-card-actions" role="group" aria-label="${escapeHtml(AFTER_SALES_PAGE.actionLabel)}">
    ${AFTER_SALES_ACTIONS.map((action) => `
      <button class="candidate-action" type="button" data-action="${escapeHtml(action.value)}"
        ${action.disabled ? `disabled aria-disabled="true" title="${escapeHtml(AFTER_SALES_PAGE.compensationDisabled)}"` : ''}>${escapeHtml(action.label)}</button>`).join('')}
  </div>`;

const candidateHtml = (item, selected) => (selected ? candidateActionsHtml() : candidateCardHtml(item));

/** 弹窗骨架（居中；确认只 toast —— 原型阶段不写库）。 */
const modalHtml = () => `
  <div class="as-modal" data-as-modal hidden>
    <div class="as-modal-backdrop" data-as-modal-close></div>
    <div class="as-modal-dialog" role="dialog" aria-modal="true" aria-label="售后操作">
      <div class="as-modal-body" data-as-modal-body></div>
      <p class="as-modal-error" data-as-modal-error hidden></p>
    </div>
  </div>
  <p class="as-toast" data-as-toast hidden role="status"></p>`;

/** 选项下拉（原型：退款方式 / 差价方式先用配置里的兜底清单；接接口后替换为统一配置）。 */
const optionsHtml = (items, selected = '') => items
  .map((item) => `<option value="${escapeHtml(item)}"${item === selected ? ' selected' : ''}>${escapeHtml(item)}</option>`)
  .join('');

/**
 * @param {HTMLElement} container 页面容器（`#after-sales-app`）
 * @param {{ productRecordId?: string, apiBase?: string }} [options]
 *   ⚠️ 这两个只给**本地预览**用（HTML 标注插件会重新宿主，URL 参数/请求源会丢）。
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
  /** 当前弹窗状态：退货 {action:'return', moneyMode, method} / 换货 {action:'exchange', kind, size, method, stock} */
  let modal = null;

  const showStatus = (text, isError = false) => {
    status.textContent = text;
    status.classList.toggle('hidden', !text);
    status.classList.toggle('error', Boolean(isError));
  };

  const selectedCandidate = () => candidates.find((item) => item.sales_detail_record_id === selectedDetailId) || null;
  const modalNode = () => container.querySelector('[data-as-modal]');
  const modalBody = () => container.querySelector('[data-as-modal-body]');
  const modalError = (text) => {
    const node = container.querySelector('[data-as-modal-error]');
    if (!node) return;
    node.textContent = text || '';
    node.hidden = !text;
  };
  const toast = (text) => {
    const node = container.querySelector('[data-as-toast]');
    if (!node) return;
    node.textContent = text;
    node.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { node.hidden = true; }, 2200);
  };

  const renderCandidates = () => {
    body.innerHTML = candidates.length
      ? `<p class="candidate-hint">${escapeHtml(AFTER_SALES_PAGE.chooseHint)}</p>
         <div class="candidate-list" data-view="after-sales-candidates">${candidates
    .map((item) => candidateHtml(item, item.sales_detail_record_id === selectedDetailId))
    .join('')}</div>
         ${modalHtml()}`
      : '';
  };

  /** 尺码卡（销售扫码页同一套：一行 4 个码、整块 ≥44px、选中高亮）。 */
  const sizeChipsHtml = (items) => items.map((item) => Number(item.size ?? item)).filter((size) => Number.isFinite(size)).map((size) => `
    <button class="as-size-chip${Number(modal.size) === Number(size) ? ' active' : ''}" type="button"
      data-as-size-value="${escapeHtml(String(size))}">${escapeHtml(String(size))} 码</button>`).join('');

  /** 换尺码：按销售扫码页口径摆三组（现货 / 预定 / 特殊码折叠）。 */
  const sizeGroupsHtml = () => {
    if (modal.stockError) return `<p class="as-modal-error">${escapeHtml(AFTER_SALES_PAGE.sizesFailed)}</p>`;
    if (!modal.stock) return `<p class="as-hint">${escapeHtml(AFTER_SALES_PAGE.sizesLoading)}</p>`;
    const { inStock = [], reserve = [], special = [] } = modal.stock;
    return `
      <fieldset class="as-size-group">
        <legend class="as-size-legend"><span>${escapeHtml(AFTER_SALES_PAGE.sizeGroupInStock)}</span><span class="tag tag-info">${escapeHtml(AFTER_SALES_PAGE.areaTagInStock)}</span></legend>
        <div class="as-size-chips">${inStock.length ? sizeChipsHtml(inStock) : `<span class="as-hint">—</span>`}</div>
      </fieldset>
      <fieldset class="as-size-group">
        <legend class="as-size-legend"><span>${escapeHtml(AFTER_SALES_PAGE.sizeGroupReserve)}</span><span class="tag tag-warning">${escapeHtml(AFTER_SALES_PAGE.areaTagReserve)}</span></legend>
        <div class="as-size-chips">${reserve.length ? sizeChipsHtml(reserve) : `<span class="as-hint">—</span>`}</div>
      </fieldset>
      ${special.length ? `
      <details class="as-size-group as-size-fold">
        <summary class="as-size-legend"><span>${escapeHtml(AFTER_SALES_PAGE.sizeGroupSpecial)}</span><span class="tag tag-warning">${escapeHtml(String(special.length))}</span></summary>
        <div class="as-size-chips">${sizeChipsHtml(special)}</div>
      </details>` : ''}`;
  };

  /** 读「这一款」的尺码分组（销售扫码页口径；只读接口）。 */
  const loadStockSizes = async () => {
    if (!modal || modal.action !== 'exchange' || modal.kind !== 'same') return;
    if (modal.stock || modal.stockError) return;
    try {
      const data = await api.get(`${apiBase}${AFTER_SALES_PAGE.stockSizesApi}?${new URLSearchParams({ productRecordId })}`);
      if (!modal) return;
      modal.stock = data?.groups || {};
    } catch {
      if (!modal) return;
      modal.stockError = true;
    }
    if (modal) renderModal();
  };

  /** 弹窗内容（按动作 / 子状态渲染）。 */
  const renderModal = () => {
    const node = modalNode();
    if (!node || !modal) return;
    const item = selectedCandidate() || {};
    const host = modalBody();
    const amount = Number(item.actual_amount);
    if (modal.action === 'return') {
      host.innerHTML = `
        <div class="as-modal-line as-modal-field">
          <div class="as-segmented" role="group" aria-label="${escapeHtml(AFTER_SALES_PAGE.returnModeLabel)}">
            <button class="as-segment${modal.moneyMode === 'refund' ? ' active' : ''}" type="button" data-as-money-mode="refund">${escapeHtml(AFTER_SALES_PAGE.returnRefund)}</button>
            <button class="as-segment${modal.moneyMode === 'retained' ? ' active' : ''}" type="button" data-as-money-mode="retained">${escapeHtml(AFTER_SALES_PAGE.returnRetain)}</button>
          </div>
        </div>
        ${modal.moneyMode === 'refund' ? `
        <div class="as-modal-line as-modal-field">
          <span class="as-modal-label">${escapeHtml(AFTER_SALES_PAGE.returnMethodLabel)}</span>
          <select class="as-modal-select" data-as-method>
            <option value=""${modal.method ? '' : ' selected'}>${escapeHtml(AFTER_SALES_PAGE.select)}</option>
            ${optionsHtml(AFTER_SALES_PAGE.demoPaymentMethods, modal.method)}
          </select>
        </div>` : ''}`;
    } else {
      host.innerHTML = `
        <div class="as-modal-line as-modal-field">
          <div class="as-segmented" role="group" aria-label="${escapeHtml(AFTER_SALES_PAGE.exchangeModeLabel)}">
            <button class="as-segment${modal.kind === 'same' ? ' active' : ''}" type="button" data-as-exchange-kind="same">${escapeHtml(AFTER_SALES_PAGE.exchangeSameItem)}</button>
            <button class="as-segment${modal.kind === 'new' ? ' active' : ''}" type="button" data-as-exchange-kind="new">${escapeHtml(AFTER_SALES_PAGE.exchangeNewItem)}</button>
          </div>
        </div>
        ${modal.kind === 'same' ? sizeGroupsHtml() : ''}`;

    }
  };

  const openModal = (action) => {
    if (!selectedCandidate()) return;
    modal = action === 'return'
      ? { action: 'return', moneyMode: '', method: '' }
      : { action: 'exchange', kind: '', size: '', method: '', scanned: false };
    modalError('');
    renderModal();
    const node = modalNode();
    if (node) node.hidden = false;
  };

  const closeModal = () => {
    const node = modalNode();
    if (node) node.hidden = true;
    modal = null;
  };

  container.addEventListener('click', (event) => {
    const candidate = event.target.closest('[data-detail]');
    if (candidate) {
      selectedDetailId = candidate.dataset.detail || '';
      showStatus('');
      renderCandidates();
      return;
    }
    const action = event.target.closest('[data-action]');
    if (action) {
      if (action.disabled) return; // 赔货：灰置占位，不弹窗、不处理
      openModal(action.dataset.action);
      return;
    }
    if (event.target.closest('[data-as-modal-close]')) { closeModal(); return; }
    const mode = event.target.closest('[data-as-money-mode]');
    if (mode && modal?.action === 'return') {
      modal.moneyMode = mode.dataset.asMoneyMode;
      renderModal();
      return;
    }
    const kind = event.target.closest('[data-as-exchange-kind]');
    if (kind && modal?.action === 'exchange') {
      modal.kind = kind.dataset.asExchangeKind;
      modal.size = '';
      renderModal();
      if (modal.kind === 'same') void loadStockSizes();
      return;
    }
    const sizeChip = event.target.closest('[data-as-size-value]');
    if (sizeChip && modal?.action === 'exchange' && modal.kind === 'same') {
      modal.size = sizeChip.dataset.asSizeValue;
      renderModal();
      return;
    }
    if (event.target.closest('[data-as-scan]')) {
      if (!modal) return;
      modal.scanned = true;
      renderModal();
      return;
    }
    if (!event.target.closest('[data-as-modal-confirm]')) return;
    if (!modal) return;
    modalError('');
    if (modal.action === 'return') {
      if (!modal.moneyMode) { modalError(AFTER_SALES_PAGE.returnModeLabel); return; }
      if (modal.moneyMode === 'refund') {
        const select = container.querySelector('[data-as-method]');
        if (select) modal.method = select.value;
        if (!modal.method) { modalError(AFTER_SALES_PAGE.returnMethodLabel); return; }
      }
      closeModal();
      toast(AFTER_SALES_PAGE.toastReturnDone);
      return;
    }
    if (modal.kind !== 'same' && modal.kind !== 'new') {
      modalError(AFTER_SALES_PAGE.exchangeModeLabel);
      return;
    }
    if (modal.kind === 'same') {
      const select = container.querySelector('[data-as-size]');
      if (select) modal.size = select.value;
      if (!modal.size) { modalError(AFTER_SALES_PAGE.exchangeSizeLabel); return; }
    } else {
      if (!modal.scanned) { modalError(AFTER_SALES_PAGE.exchangeScan); return; }
      const newPrice = Number(AFTER_SALES_PAGE.demoNewItem.price);
      const diff = newPrice - Number(selectedCandidate()?.actual_amount || 0);
      if (Math.abs(diff) >= 0.005) {
        const select = container.querySelector('[data-as-method]');
        if (select) modal.method = select.value;
        if (!modal.method) { modalError(AFTER_SALES_PAGE.exchangeDiffMethodLabel); return; }
      }
    }
    closeModal();
    toast(AFTER_SALES_PAGE.toastExchangeDone);
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
      showStatus('');
      renderCandidates();
    })
    .catch(() => {
      if (productLine) productLine.textContent = '';
      showStatus(AFTER_SALES_PAGE.failed, true);
    });
}
