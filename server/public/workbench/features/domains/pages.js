import { escapeHtml } from '../../core/formatters.js';
import { PLACEHOLDER_STATUS } from '../shared/placeholder.js';

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

/**
 * 卡片体（与 `features/common` / `features/query` 的卡长得一样，复用 base.css 的类）。
 *
 * ⭐ 2026-10-10（业务负责人真机反馈：「下面的这些文字解释就不用了」）：
 *    卡片**只留标题 + 动作** —— 那句副标题（`desc`，例「供应商报货（飞书表单）—— 填完直接生成报货单」）
 *    **一个字都不再渲染**（配置里的 `desc` 字段也一并退场，免得将来又长回来）。
 */
const cardBody = (card, arrow) => `
        <div class="icon">${escapeHtml(card.icon || '')}</div>
        <h3>${escapeHtml(card.title || '')}</h3>
        <div class="arrow">${escapeHtml(arrow)}</div>`;

/**
 * 卡片组：`href` = 外链 / 工作台内页；`jumpTo` = 同一个 tab 里的另一个子页。
 * ⚠️ 2026-10-10：`anchor`（本页锚点）与内嵌宿主**整层退场** —— 「验收到货」已经是独立子页，
 *    报货 / 退货页上只剩"去飞书表单"的外链卡（她：「不应该是一点完之后在同一个 tab 页里下面出现」）。
 */
export function cardsHtml(cards = []) {
  return cards.map((card) => (card.jumpTo
    ? `<button class="entry-card card-button" type="button" data-jump="${escapeHtml(card.jumpTo)}">${cardBody(card, card.arrow || '打开 →')}
      </button>`
    : `<a class="entry-card" href="${escapeHtml(card.href || '')}" rel="noopener">${cardBody(card, card.arrow || '进入 →')}
      </a>`)).join('\n');
}

/**
 * 一个 `kind: 'entry'` 子页的 HTML（表单本体；提交在 `features/domains/index.js` 里统一接）。
 *
 * ⭐ 2026-10-10（业务负责人真机反馈）：**不画同名标题、不画描述行、不画使用步骤、不画提示句** ——
 *    子 tab 上已经写了这一页叫什么，剩下的只留"能填能点的"（编号输入 + 按钮 + 相关入口卡）。
 *    （她点名的正是"标题下面那一堆文字"。）见 `test/workbenchNoManualText.test.js` AC3 / AC4。
 */
export function entryPageHtml(page) {
  const links = page.links?.length
    ? `<div class="domain-cards">${cardsHtml(page.links)}</div>`
    : '';
  return `
      <div class="domain-page" data-page-kind="entry">
        <form class="action-form entry-open" data-entry-form data-target-template="${escapeHtml(page.targetTemplate)}">
          <label class="form-field">${escapeHtml(page.fieldLabel || '编号')}
            <input name="number" type="text" autocomplete="off" enterkeyhint="go" placeholder="${escapeHtml(page.placeholder || '')}">
          </label>
          <button class="btn btn-primary" type="submit">${escapeHtml(page.buttonLabel || '打开 →')}</button>
        </form>
        ${links}
      </div>`;
}

/**
 * 一个 `kind: 'links'` 子页的 HTML（纯卡片，没有表单）。
 *
 * ⭐ 2026-10-10：同名标题 / 描述行删掉；**卡片 + 动作**就是这一页的全部
 *    （「验收到货」已经改成独立子页 ⇒ 这一页不再有任何"本页锚点 / 内嵌宿主"）。
 */
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
