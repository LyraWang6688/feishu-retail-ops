import { cardsHtml } from '../domains/pages.js';
import { escapeHtml } from '../../core/formatters.js';
import { PLACEHOLDER_STATUS } from '../shared/placeholder.js';

/**
 * 货品 → 标签打印：两级卡片。
 *   一级：标签二维码 / 销售凭证（占位）
 *   二级：标签二维码 → 扫码打印 / 批量打印
 *
 * 卡片外观统一用 `.domain-cards` + `.entry-card`（与工作台其它入口卡同一套模板）；
 * 二级动作直接复用 `features/domains/pages.js` 的 `cardsHtml`，不另写一份卡片样式。
 */
const topCardsHtml = (cards = []) => cards.map((card) => {
  if (card.placeholder === true) {
    return `<div class="entry-card disabled-card" data-placeholder-card="${escapeHtml(card.id || '')}">
        <div class="icon">${escapeHtml(card.icon || '')}</div>
        <h3>${escapeHtml(card.title || '')}</h3>
        <span class="tag tag-info">${escapeHtml(PLACEHOLDER_STATUS)}</span>
      </div>`;
  }
  return `<button class="entry-card card-button" type="button" data-label-card="${escapeHtml(card.id || '')}"
      data-tap-target="${escapeHtml(card.tapTarget || `label:${card.id || ''}`)}">
      <div class="icon">${escapeHtml(card.icon || '')}</div>
      <h3>${escapeHtml(card.title || '')}</h3>
    </button>`;
}).join('\n');

const actionsPageHtml = (card) => `
  <div class="domain-page" data-page-kind="label-print-actions">
    <div class="page-head"><button class="back" type="button" data-label-back>‹ 返回</button><h2>${escapeHtml(card.title || '')}</h2></div>
    <div class="domain-cards">${cardsHtml(card.actions || [])}</div>
  </div>`;

export function createLabelPrintHubModule() {
  let host = null;
  let page = null;

  const render = () => {
    if (!host || !page) return;
    host.innerHTML = `<div class="domain-page" data-page-kind="label-print"><div class="domain-cards">${topCardsHtml(page.cards || [])}</div></div>`;
  };

  return {
    mount(container, config) {
      host = container;
      page = config;
      host.addEventListener('click', (event) => {
        const back = event.target.closest('[data-label-back]');
        if (back) {
          render();
          return;
        }
        const card = event.target.closest('[data-label-card]');
        if (!card) return;
        const selected = (page.cards || []).find((item) => item.id === card.dataset.labelCard);
        if (!selected || !selected.actions?.length) return;
        host.innerHTML = actionsPageHtml(selected);
      });
      render();
    },
  };
}
