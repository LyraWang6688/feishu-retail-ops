import { escapeHtml } from '../../core/formatters.js';
import { PLACEHOLDER_STATUS } from '../shared/placeholder.js';

/**
 * 货品 → 标签打印：一级两张卡「标签二维码 / 销售凭证」。
 *
 * 点击「标签二维码」⇒ **原卡片位置直接变成两个动作按钮**：
 *   扫码打印 / 批量打印。
 * 交互与售后单「选中一条销售记录 ⇒ 那张卡片原地变成退货/换货按钮」一致，
 * 不进入第二页、也没有返回按钮。
 *
 * 卡片统一用 `.domain-cards` + `.entry-card`；选中态用 `.candidate-card-actions` +
 * `.candidate-action`（与售后单同一套样式，样式登记在 `domains.css`）。
 */
const actionsHtml = (card) => `
  <div class="candidate-card-actions" role="group" aria-label="${escapeHtml(card.title || '')}">
    ${(card.actions || []).map((action) => `
      <a class="candidate-action" href="${escapeHtml(action.href || '')}" rel="noopener"
        data-tap-target="${escapeHtml(action.tapTarget || `link:${action.title || ''}`)}">${escapeHtml(action.title || '')}</a>`).join('')}
  </div>`;

const topCardsHtml = (cards = [], selectedId = '') => cards.map((card) => {
  if (card.id && card.id === selectedId) return actionsHtml(card);
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

export function createLabelPrintHubModule() {
  let host = null;
  let page = null;
  let selectedId = '';

  const render = () => {
    if (!host || !page) return;
    host.innerHTML = `<div class="domain-page" data-page-kind="label-print"><div class="domain-cards">${topCardsHtml(page.cards || [], selectedId)}</div></div>`;
  };

  return {
    mount(container, config) {
      host = container;
      page = config;
      host.addEventListener('click', (event) => {
        const card = event.target.closest('[data-label-card]');
        if (!card) return;
        selectedId = card.dataset.labelCard || '';
        render();
      });
      render();
    },
  };
}
