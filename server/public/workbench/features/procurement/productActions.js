/**
 * 2026-11-19：采购补货卡片的两个快捷入口（只补货 tab 用）。
 * 数据由后端 resolveProductActions 算好，这里只渲染。
 */
import { escapeHtml } from '../../core/formatters.js';

export const productActionsHtml = (group, config) => {
  const fallback = config.productActions || {};
  const labels = group.product_action_labels || {};
  const adjustLabel = labels.adjust || fallback.adjustLabel || '';
  const infoLabel = labels.info || fallback.infoLabel || '';
  const adjustHref = String(group.product_adjust_url || '').trim();
  const recordHref = String(group.product_record_url || '').trim();
  const missing = String(group.product_missing_text || '').trim();
  const adjust = adjustHref
    ? `<a class="pr-product-action pr-product-action--adjust" href="${escapeHtml(adjustHref)}">${escapeHtml(adjustLabel)}</a>`
    : '';
  const info = missing && recordHref
    ? `<a class="pr-product-action pr-product-action--gap" href="${escapeHtml(recordHref)}" target="_blank" rel="noopener">${escapeHtml(infoLabel)}</a>`
    : '';
  return adjust || info ? `<div class="pr-product-actions">${adjust}${info}</div>` : '';
};
