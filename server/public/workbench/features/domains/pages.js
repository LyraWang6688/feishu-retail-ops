import { escapeHtml } from '../../core/formatters.js';
import { PLACEHOLDER_STATUS } from '../shared/placeholder.js';

/**
 * 卡片体（与 `features/query` 的卡长得一样，复用 base.css 的类）。
 *
 * ⭐ 2026-10-10（业务负责人真机反馈：「下面的这些文字解释就不用了」）：
 *    卡片**只留标题 + 动作** —— 那句副标题（`desc`，例「供应商报货（飞书表单）—— 填完直接生成报货单」）
 *    **一个字都不再渲染**（配置里的 `desc` 字段也一并退场，免得将来又长回来）。
 *
 * ⭐⭐ 2026-10-16（业务负责人**亲口**点的三处改动之三 · 逐字）：
 *    她问「那两行箭头**是否就是多余的，点开入口卡片就可以实现跳转吧**」——
 *    核实结论：**是多余的** ✓。配了 `href` 的卡整张就是 `<a>`（见下面 `cardsHtml`）⇒
 *    箭头那行只是"快点这里"的提示语，卡片本体早就可点。
 *    ⇒ 渲染层改成：**只有配置里显式给了 `arrow` 才画那一行**（缺省 = 不画 ✗ 不再补
 *      `'打开 →'` / `'进入 →'` 的默认值 —— 那个默认值会让"删掉箭头"变成"换成另一句箭头"，
 *      等于没删 ✓）。⚠️ 卡片的 `href` / `jumpTo` / 可点性**一个字没变** ✗。
 */
const cardBody = (card, arrow) => `
        <div class="icon">${escapeHtml(card.icon || '')}</div>
        <h3>${escapeHtml(card.title || '')}</h3>${arrow ? `
        <div class="arrow">${escapeHtml(arrow)}</div>` : ''}`;

/**
 * 卡片组：`href` = 外链 / 工作台内页；`jumpTo` = 同一个 tab 里的另一个子页。
 * ⚠️ 2026-10-10：`anchor`（本页锚点）与内嵌宿主**整层退场** —— 「验收到货」已经是独立子页，
 *    报货 / 退货页上只剩"去飞书表单"的外链卡（她：「不应该是一点完之后在同一个 tab 页里下面出现」）。
 * ⚠️ 2026-10-16：`arrow` 缺省 = **不画那一行**（不再有默认动作文案，见 `cardBody` 上方）。
 */
export function cardsHtml(cards = []) {
  const targetOf = (card) => card.tapTarget || (card.scanRealm ? `scan:${card.scanRealm}` : card.jumpTo ? `jump:${card.jumpTo}` : `link:${card.title || ''}`);
  return cards.map((card) => (card.jumpTo
    ? `<button class="entry-card card-button" type="button" data-jump="${escapeHtml(card.jumpTo)}" data-tap-target="${escapeHtml(targetOf(card))}">${cardBody(card, card.arrow)}
      </button>`
    : `<a class="entry-card" href="${escapeHtml(card.href || '')}" rel="noopener" data-tap-target="${escapeHtml(targetOf(card))}">${cardBody(card, card.arrow)}
      </a>`)).join('\n');
}

/**
 * 一个 `kind: 'links'` 子页的 HTML（纯卡片，没有表单）。
 *
 * ⭐ 2026-10-10：同名标题 / 描述行删掉；**卡片 + 动作**就是这一页的全部
 *    （「验收到货」已经改成独立子页 ⇒ 这一页不再有任何"本页锚点 / 内嵌宿主"）。
 */
/**
 * ⭐ 2026-11-10（业务负责人）：数据配置页里放**按钮卡**（点它执行动作，不是跳转）——
 * 卡片外观与「录单」那排 `.entry-card` 完全一致，只是这里渲染成 `<button>`。
 * 动作名字走配置（`config/domains.js` 的 `cards[].action`），点击处理在
 * `features/domains/dataConfigAction.js`（本文件只负责画）。
 */
export const actionCardsPageHtml = (page) => `
      <div class="domain-page" data-page-kind="action-cards">
        <div class="domain-cards">${(page.cards || []).map((card) => (card.placeholder === true
    ? `<div class="entry-card disabled-card" data-placeholder-card="${escapeHtml(card.id || '')}">
            <div class="icon">${escapeHtml(card.icon || '')}</div>
            <h3>${escapeHtml(card.title || '')}</h3>
            <span class="tag tag-info">${escapeHtml(PLACEHOLDER_STATUS)}</span>
          </div>`
    : `<button class="entry-card card-button" type="button"
            data-domain-action="${escapeHtml(card.action || '')}"
            data-tap-target="${escapeHtml(card.tapTarget || card.action || '')}">
            <div class="icon">${escapeHtml(card.icon || '')}</div>
            <h3>${escapeHtml(card.title || '')}</h3>
          </button>`)).join('')}</div>
        <p class="placeholder-note" data-view="domain-action-note"></p>
      </div>`;

export const linksPageHtml = (page) => `
      <div class="domain-page" data-page-kind="links">
        <div class="domain-cards">${cardsHtml(page.cards || [])}</div>
      </div>`;

/**
 * ⭐ 一个 `kind: 'placeholder'` 子页面（业务负责人 2026-10-09；口径 2026-10-10 收紧）：
 * **占位页只留「待建设」一个小标记** —— 标题与子 tab 重复 ⇒ 不画，
 * 「将来放…」那句长说明也删掉（她的原话：「这些文字解释就不用了」）。
 * 仍然给她一个**彩色小标签**（一眼看出这是没建好的页面，不是加载失败）。
 */
export const placeholderPageHtml = (page) => `
      <div class="domain-page" data-page-kind="placeholder">
        <div class="placeholder-card" data-placeholder="${escapeHtml(page.id || '')}">
          <span class="tag tag-info">${escapeHtml(PLACEHOLDER_STATUS)}</span>
        </div>
      </div>`;
