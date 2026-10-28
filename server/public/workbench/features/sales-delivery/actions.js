/**
 * 「销售交割单」页的**动作 UI**：交付是每行一个按钮（无表单）；付款仍走预览表单。
 * 文案 / 按钮名 / 占位符全部来自 `config/sales-delivery.js` 的 `T.forms` / `T.buttons`。
 */

import { escapeHtml } from '../../core/formatters.js';
import { formatMoney } from './format.js';

const option = (value, label, { selected = false, placeholder = false } = {}) => (
  `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}${placeholder ? ' disabled' : ''}>${escapeHtml(label)}</option>`
);

const optionsHtml = (values, emptyLabel) => [
  option('', emptyLabel, { placeholder: true }),
  ...values.map((value) => option(value, value)),
].join('');

/** 每行未交付明细自己的「交付」按钮（不带尺码下拉/数量输入；点谁只交谁）。 */
export const deliveryButtonHtml = (line, T) => `<button class="sd-action-btn" type="button" data-sd-deliver="${escapeHtml(line.recordId || '')}">${escapeHtml(T.buttons.delivery)}</button>`;

/** 付款入口（一张卡一个；金额默认 = 整单待付；方式来自接口，不硬编码）。 */
export const paymentParts = (item, methods = [], T) => ({
  button: `<button class="sd-action-btn" type="button" data-sd-toggle="payment">${escapeHtml(T.buttons.payment)}</button>`,
  form: `<div class="sd-form-slot hidden" data-sd-form="payment"><form class="sd-form" data-sd-preview-form="payment">
        <p class="muted">${escapeHtml(T.forms.paymentTitle)}</p>
        <label class="sd-field">${escapeHtml(T.forms.paymentAmount)}
          <input data-sd-field="amount" type="text" inputmode="decimal" value="${escapeHtml(formatMoney(item.pendingAmount))}">
        </label>
        <label class="sd-field">${escapeHtml(T.forms.paymentMethod)}
          ${methods.length
    ? `<select data-sd-field="method">${optionsHtml(methods, T.forms.paymentMethod)}</select>`
    : `<span class="muted">${escapeHtml(T.forms.paymentMethodEmpty)}</span>`}
        </label>
        <p class="sd-preview-note">${escapeHtml(T.forms.previewOnly)}</p>
        <button class="btn btn-primary" type="submit">${escapeHtml(T.forms.previewSubmit)}</button>
      </form></div>`,
});

/** 预览提交：只改提示文案（**不发任何写请求**）。 */
export const markPreviewFilled = (form, T) => {
  const note = form?.querySelector?.('.sd-preview-note');
  if (note) note.textContent = T.forms.previewFilled;
};
