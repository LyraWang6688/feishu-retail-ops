/**
 * 「销售交割单」原型页的**渲染层**（纯函数：给 state 出 HTML；DOM 接线在 `index.js`）。
 *
 * 2026-10-29 业务负责人批注后的口径：
 *   · 顶部标题 / 返回链接 / 排序控件都**不显示**；页面固定按销售日「远→近」排序；
 *   · 提供「货号」筛选（默认全部货号）；
 *   · **按销售日分组**：日期只在分组头出现，卡片行内不再重复日期；
 *   · 一张卡 = 一个销售单号，卡内按产品行展示；未交付行行尾一个「交付」；
 *   · 钱相关 tab 在卡底显示已付/待付 + 一个付款入口（预览表单，不提交写库）。
 * 颜色 / 间距走 CSS（只引用 tokens.css 的 var）；tab / 文案全部来自配置。
 */

import { escapeHtml } from '../../core/formatters.js';
import { detailTextOf, formatMoneyCompact } from './format.js';
import { deliveryButtonHtml, paymentButtonHtml } from './actions.js';

const detailTextOfLine = (line, T) => detailTextOf(line) || T.forms.placeholderDash;

const amountTextOf = (value, T) => (value == null ? T.forms.placeholderDash : formatMoneyCompact(value));

const amountsHtml = (item, T) => (item.hasAmounts
  ? `<span class="sd-amounts">${escapeHtml(T.amountsLine
    .replace('{payableLabel}', T.headers.payable).replace('{payableAmount}', amountTextOf(item.payableAmount, T))
    .replace('{pendingLabel}', T.headers.pending).replace('{pendingAmount}', formatMoneyCompact(item.pendingAmount)))}</span>`
  : '');

/** 产品行：一行一条明细；未交付行行尾一个「交付」（不带表单）。 */
const productRowHtml = (item, line, T, statuses) => {
  const canDeliver = item.kind !== 'money' && line.fulfillmentStatus === statuses.undelivered;
  return `<div class="sd-product-row" data-sd-detail="${escapeHtml(line.recordId || '')}">
      <span class="sd-item-main">${escapeHtml(detailTextOfLine(line, T))}</span>
      ${canDeliver ? deliveryButtonHtml(line, T) : ''}
    </div>`;
};

const productRowsHtml = (item, T, statuses) => {
  const rows = (item.details || []).map((line) => productRowHtml(item, line, T, statuses));
  return rows.length ? rows.join('') : `<div class="sd-product-row"><span class="sd-item-main">${escapeHtml(T.noDetails)}</span></div>`;
};

/** 一张卡 = 一个销售单号：多行产品 +（钱相关）已付/待付 + 付款入口。 */
const itemCardHtml = (item, T, statuses) => `
  <article class="sd-card" data-sd-item data-sd-kind="${escapeHtml(item.kind)}" data-sd-order="${escapeHtml(item.orderNo)}" data-sd-entry="${escapeHtml(item.salesEntryRecordId || '')}" data-sd-pending="${escapeHtml(item.pendingAmount ?? '')}">
    ${productRowsHtml(item, T, statuses)}
    ${item.hasAmounts ? `<div class="sd-row-footer">${amountsHtml(item, T)}<div class="sd-actions">${paymentButtonHtml(item, T)}</div></div>` : ''}
  </article>`;

/** 付款确认弹窗（居中；金额/方式在这里收集；提交由 index.js 负责）。 */
const paymentModalHtml = (state, T) => `
<div class="sd-modal" data-sd-modal hidden>
  <div class="sd-modal-backdrop" data-sd-modal-close></div>
  <div class="sd-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="sd-modal-title">
    <h2 class="sd-modal-title" id="sd-modal-title">${escapeHtml(T.forms.paymentModalTitle)}</h2>
    <label class="sd-field">${escapeHtml(T.forms.paymentAmount)}
      <input data-sd-modal-amount type="text" inputmode="decimal" value="">
    </label>
    <label class="sd-field">${escapeHtml(T.forms.paymentMethod)}
      <select data-sd-modal-method>
        <option value="" disabled selected>${escapeHtml(T.forms.paymentMethod)}</option>
        ${(state.methods || []).map((method) => `<option value="${escapeHtml(method)}">${escapeHtml(method)}</option>`).join('')}
      </select>
    </label>
    <div class="sd-modal-actions">
      <button class="btn" type="button" data-sd-modal-close>${escapeHtml(T.forms.paymentCancel)}</button>
      <button class="btn btn-primary" type="button" data-sd-modal-confirm>${escapeHtml(T.forms.paymentSubmit)}</button>
    </div>
  </div>
</div>`;

/** 三个子 tab（数量在 `<small>` 里；形态对齐采购页的分段 tab）。 */
export const tabsHtml = (state, tabs, T) => `
  <div class="sd-tabs" role="tablist" aria-label="${escapeHtml(T.tabsLabel)}">
    ${tabs.map((tab) => {
    const count = Number(state.counts?.[tab.key] || 0);
    return `<button class="sd-tab${tab.key === state.activeTab ? ' active' : ''}" type="button" role="tab" data-sd-tab="${escapeHtml(tab.key)}" aria-selected="${tab.key === state.activeTab}">${escapeHtml(tab.label)}<small>${escapeHtml(T.tabCount.replace('{count}', String(count)))}</small></button>`;
  }).join('')}
  </div>`;

/** 「货号」筛选（默认全部货号；替代原来的排序控件）。 */
export const filterHtml = (state, T) => `
  <div class="sd-toolbar">
    <label class="sd-filter">${escapeHtml(T.productFilterLabel)}
      <select data-sd-field="product">
        <option value="">${escapeHtml(T.allProducts)}</option>
        ${(state.products || []).map((product) => `<option value="${escapeHtml(product)}"${product === state.productFilter ? ' selected' : ''}>${escapeHtml(product)}</option>`).join('')}
      </select>
    </label>
  </div>`;

/** 空 / 加载 / 失败态（保留；原型是同步样例，加载/失败通常不出现）。 */
export const statusHtml = (state, activeTab, T) => {
  if (state.loading) return `<p class="sd-status" data-sd-status="loading">${escapeHtml(T.loading)}</p>`;
  if (state.error) {
    return `<div class="sd-status sd-status-error" data-sd-status="error">
      <p>${escapeHtml(T.loadFailed)}</p><p class="muted">${escapeHtml(state.error)}</p>
      <button class="btn btn-primary" type="button" data-sd-action="retry">${escapeHtml(T.retry)}</button>
    </div>`;
  }
  if (!state.groups.length) return `<p class="sd-status" data-sd-status="empty">${escapeHtml(activeTab?.empty || T.empty)}</p>`;
  return '';
};

/** 按销售日分组后的列表（每组一个日期小标题 + 卡片）。 */
export const panelHtml = (state, activeTab, T, statuses) => {
  const status = statusHtml(state, activeTab, T);
  if (status) return status;
  return state.groups.map((group) => `
    <section class="sd-day-group" data-sd-day="${escapeHtml(group.key)}">
      <h2 class="sd-day-title">${escapeHtml(group.label)}</h2>
      <div class="sd-list">${group.items.map((item) => itemCardHtml(item, T, statuses)).join('')}</div>
    </section>`).join('');
};

/** 整页正文（三个子 tab + 货号筛选 + 按销售日分组的列表）。 */
export const renderPage = (state, config, T, statuses, tabs) => {
  const activeTab = tabs.find((tab) => tab.key === state.activeTab) || tabs[0];
  return `
  ${tabsHtml(state, tabs, T)}
  ${filterHtml(state, T)}
  ${panelHtml(state, activeTab, T, statuses)}
  ${paymentModalHtml(state, T)}`;
};
