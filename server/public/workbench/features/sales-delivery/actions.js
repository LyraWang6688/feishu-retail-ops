/**
 * 「销售交割单」页的**动作 UI**：交付是每行一个按钮（无表单）；付款仍走预览表单。
 * 文案 / 按钮名 / 占位符全部来自 `config/sales-delivery.js` 的 `T.forms` / `T.buttons`。
 */

import { escapeHtml } from '../../core/formatters.js';

/** 每行未交付明细自己的「交付」按钮（不带尺码下拉/数量输入；点谁只交谁）。 */
export const deliveryButtonHtml = (line, T, sku = '') => `<button class="sd-action-btn" type="button" data-sd-deliver="${escapeHtml(line.recordId || '')}" data-sd-sku="${escapeHtml(sku)}">${escapeHtml(T.buttons.delivery)}</button>`;

/** 付款入口（一张卡一个；点开居中弹窗，提交在弹窗里）。 */
export const paymentButtonHtml = (item, T) => `<button class="sd-action-btn" type="button" data-sd-toggle="payment">${escapeHtml(T.buttons.payment)}</button>`;
