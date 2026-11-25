import { escapeHtml } from '../../core/formatters.js';
import { PLACEHOLDER_STATUS } from '../shared/placeholder.js';

/**
 * 货品 → 标签打印：四张独立卡。
 *
 *   扫码打印     → 具体货品扫码页 /r/
 *   批量打印     → 飞书批量打印表单（只选货品组为空的货品）
 *   货品组打印   → 飞书货品组表单（写「标签打印.货品组」→ /g/ 组标签）
 *   销售凭证     → 占位
 *
 * 卡片统一用 .domain-cards + .entry-card；有 href 的直接是链接，不再展开二级动作。
 */
const cardHtml = (card) => {
  if (card.placeholder === true) {
    return `<div class="entry-card disabled-card" data-placeholder-card="${escapeHtml(card.id || '')}">
        <div class="icon">${escapeHtml(card.icon || '')}</div>
        <h3>${escapeHtml(card.title || '')}</h3>
        <span class="tag tag-info">${escapeHtml(PLACEHOLDER_STATUS)}</span>
      </div>`;
  }
  return `<a class="entry-card" href="${escapeHtml(card.href || '')}" rel="noopener"
      data-label-card="${escapeHtml(card.id || '')}"
      data-tap-target="${escapeHtml(card.tapTarget || `label:${card.id || ''}`)}">
      <div class="icon">${escapeHtml(card.icon || '')}</div>
      <h3>${escapeHtml(card.title || '')}</h3>
    </a>`;
};

export function createLabelPrintHubModule() {
  let host = null;
  let page = null;

  const render = () => {
    if (!host || !page) return;
    host.innerHTML = `<div class="domain-page" data-page-kind="label-print"><div class="domain-cards">${(page.cards || []).map(cardHtml).join('\n')}</div></div>`;
  };

  return {
    resetToCards: render,
    mount(container, config) {
      host = container;
      page = config;
      if (typeof window !== 'undefined') window.addEventListener('pageshow', render);
      render();
    },
  };
}
