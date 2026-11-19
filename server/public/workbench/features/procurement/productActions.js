/**
 * 2026-11-19：采购补货卡片的两个快捷入口（只补货 tab 用）。
 * 数据由后端 resolveProductActions 算好，这里只渲染。
 */
import { escapeHtml } from '../../core/formatters.js';

const fill = (text, values = {}) => String(text || '').replace(/\{(\w+)\}/g, (match, key) => (
  Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
));

export const productActionsHtml = (group, config) => {
  const labels = config.productActions || {};
  const adjustHref = String(group.product_adjust_url || '').trim();
  const recordHref = String(group.product_record_url || '').trim();
  const missing = String(group.product_missing_text || '').trim();
  const adjust = adjustHref
    ? `<a class="pr-product-action pr-product-action--adjust" href="${escapeHtml(adjustHref)}">${escapeHtml(labels.adjustLabel || '')}</a>`
    : '';
  const gap = missing && recordHref
    ? `<a class="pr-product-action pr-product-action--gap" href="${escapeHtml(recordHref)}" target="_blank" rel="noopener">${escapeHtml(fill(labels.gapLabel || '', { missing }))}${escapeHtml(labels.gapSeparator || '')}<span>${escapeHtml(labels.gapLinkLabel || '')} →</span></a>`
    : '';
  return adjust || gap ? `<div class="pr-product-actions">${adjust}${gap}</div>` : '';
};
