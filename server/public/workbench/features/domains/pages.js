import { escapeHtml } from '../../core/formatters.js';

/**
 * 领域子页里的「**输入编号 → 打开既有页面**」小入口（配置驱动，纯渲染 + 一个纯函数）。
 *
 * 为什么要有它（而不是在四个 tab 里各做一套建单 / 查询界面）：
 *   · 业务负责人 2026-10-09 的原话是「在 4 个 tab 页里面，我们**都能扫同一个二维码**，
 *     但是**点击的按钮不同，触发的逻辑就不一样**」⇒ 她要的是**扫码页上的领域切换**；
 *   · 工作台里再放一个入口，解决的是"**手上没有那个标签 / 扫码不方便**"的情形 ——
 *     它把编号交给**同一个扫码页**（`/s/{编号}?from=…`）或**同一个标签打印页**，
 *     ⇒ 销售建单 / 库存查询 / 标签打印**仍然只有一套实现**（各领域共用既有业务处理层）。
 *
 * ⚠️ 目标 URL 模板来自 `config/domains.js`（`targetTemplate`），**本文件不写死任何路径**。
 *    模板里两个占位符：
 *      `{number}` = 她输入的原文（URL 编码过）—— 例如 `YD6693-2|黑色|A`；
 *      `{itemNo}` = 第一段（`|` 之前）= 货号 —— 标签打印页的 `keyword` 认的是货号。
 */
export function entryTarget(template, rawNumber) {
  const number = String(rawNumber ?? '').trim();
  if (!number) return '';
  const itemNo = number.split('|')[0].trim();
  return String(template ?? '')
    .split('{number}').join(encodeURIComponent(number))
    .split('{itemNo}').join(encodeURIComponent(itemNo));
}

const stepsHtml = (steps = []) => (steps.length
  ? `<ol class="domain-steps">${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>`
  : '');

/** 卡片体（与 `features/common` / `features/query` 的卡长得一样，复用 base.css 的类）。 */
const cardBody = (card, arrow) => `
        <div class="icon">${escapeHtml(card.icon || '')}</div>
        <h3>${escapeHtml(card.title || '')}</h3>
        <p>${escapeHtml(card.desc || '')}</p>
        <div class="arrow">${escapeHtml(arrow)}</div>`;

/** 卡片组：`href` = 外链 / 工作台内页；`jumpTo` = 同一个 tab 里的另一个子页。 */
export function cardsHtml(cards = []) {
  return cards.map((card) => (card.jumpTo
    ? `<button class="entry-card card-button" type="button" data-jump="${escapeHtml(card.jumpTo)}">${cardBody(card, card.arrow || '打开 →')}
      </button>`
    : `<a class="entry-card" href="${escapeHtml(card.href || '')}" rel="noopener">${cardBody(card, card.arrow || '进入 →')}
      </a>`)).join('\n');
}

/** 一个 `kind: 'entry'` 子页的 HTML（表单本体；提交在 `features/domains/index.js` 里统一接）。 */
export function entryPageHtml(page) {
  const links = page.links?.length
    ? `<h4 class="section-title">相关入口</h4><div class="domain-cards">${cardsHtml(page.links)}</div>`
    : '';
  return `
      <div class="domain-page" data-page-kind="entry">
        <h3 class="section-title">${escapeHtml(page.title)}</h3>
        <p class="subtitle">${escapeHtml(page.subtitle || '')}</p>
        ${stepsHtml(page.steps)}
        <form class="action-form entry-open" data-entry-form data-target-template="${escapeHtml(page.targetTemplate)}">
          <label class="form-field">${escapeHtml(page.fieldLabel || '编号')}
            <input name="number" type="text" autocomplete="off" enterkeyhint="go" placeholder="${escapeHtml(page.placeholder || '')}">
          </label>
          <button class="btn btn-primary" type="submit">${escapeHtml(page.buttonLabel || '打开 →')}</button>
        </form>
        ${page.hint ? `<p class="page-hint">${escapeHtml(page.hint)}</p>` : ''}
        ${links}
      </div>`;
}

/** 一个 `kind: 'links'` 子页的 HTML（纯卡片，没有表单）。 */
export const linksPageHtml = (page) => `
      <div class="domain-page" data-page-kind="links">
        <h3 class="section-title">${escapeHtml(page.title)}</h3>
        <p class="subtitle">${escapeHtml(page.subtitle || '')}</p>
        <div class="domain-cards">${cardsHtml(page.cards || [])}</div>
      </div>`;
