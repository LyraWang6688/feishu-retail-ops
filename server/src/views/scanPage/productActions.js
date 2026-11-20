'use strict';

/**
 * 扫码页「货品卡」上那两个入口（2026-11-17 · 业务负责人）：
 *   · **库存调整** —— 点一下直达 工作台 → 库存 → 手工调整 → 单双调整，并带出这一款；
 *   · **信息完善** —— 只在「商品信息缺失 / 标签信息缺失」不是「齐备」时出现，
 *     点它打开飞书里这条货品记录去补；按钮只显示固定文案，不拼缺失明细。
 *
 * 只渲染 `config.productActions.realms` 里点名的领域（默认 sales / purchase_return）——
 * 别的领域**一个字节都不多**（库存 / 补货 / 货品页的既有判据不受影响）。
 *
 * 渲染层不判断"资料齐不齐"、也不拼 URL：`product_missing_text` / `product_record_url` /
 * `product_adjust_url` 都由 `services/scanPageService.js` 从**同一份 schema 与配置**算好。
 */
const { escapeHtml } = require('./fields');

const productActionsHtml = (view, config, realm) => {
  const cfg = (config && config.productActions) || {};
  const realms = Array.isArray(cfg.realms) ? cfg.realms : [];
  if (!realms.includes(String(realm || ''))) return '';
  const adjustHref = String(view?.product_adjust_url || '').trim();
  const recordHref = String(view?.product_record_url || '').trim();
  const missing = String(view?.product_missing_text || '').trim();
  const adjust = adjustHref
    ? `<a class="identity__action identity__action--adjust" href="${escapeHtml(adjustHref)}" data-view="product-adjust">${escapeHtml(cfg.adjustLabel || '')}</a>`
    : '';
  // ⚠️ 资料齐备 ⇒ 不渲染（`missing` 为空），不留空壳；记录 URL 取不到时也不给死链。
  const info = missing && recordHref
    ? `<a class="identity__action identity__action--gap" href="${escapeHtml(recordHref)}" target="_blank" rel="noopener" data-view="product-info">${escapeHtml(cfg.infoLabel || '')}</a>`
    : '';
  if (!adjust && !info) return '';
  return `<div class="identity__actions">${adjust}${info}</div>`;
};

module.exports = { productActionsHtml };
