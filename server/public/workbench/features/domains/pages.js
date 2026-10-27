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
 * 一个 `kind: 'entry'` 子页的 HTML（表单本体；提交在 `features/domains/index.js` 里统一接）。
 *
 * ⭐ 2026-10-10（业务负责人真机反馈）：**不画同名标题、不画描述行、不画使用步骤、不画提示句** ——
 *    子 tab 上已经写了这一页叫什么，剩下的只留"能填能点的"（编号输入 + 按钮 + 相关入口卡）。
 *    （她点名的正是"标题下面那一堆文字"。）见 `test/workbenchNoManualText.test.js` AC3 / AC4。
 *
 * ⭐⭐ 2026-10-15（业务负责人逐字：「**是否可以就让用户选择呢？然后它的选项是来自于货品信息里面的编号**」）：
 *    配了 `numberPicker: true` 的入口页，在编号框下面多一格**可搜索的编号选择器**的壳
 *    （选项区 + 状态区；**内容由 `features/labels/number-picker.js` 按只读端点回填** ⇒ 这里不写死数据）。
 *    ⚠️ 本文件**不 import 选择器模块**：这里只画空壳（选项由 JS 填），逻辑与取数都在那个模块里，
 *      领域骨架（`features/domains/index.js`）负责挂 —— 三者职责不混（模块化）。
 *    ⚠️ 壳里**一个 `<p>` 都没有**、也不用 `page-hint`/`subtitle` 那些"说明书"类名（既有哨兵照旧成立）。
 */
export function entryPageHtml(page) {
  const links = page.links?.length
    ? `<div class="domain-cards">${cardsHtml(page.links)}</div>`
    : '';
  // 编号选择器的壳（配置驱动：只有配了 `numberPicker` 的入口页才有这两块）
  const picker = page.numberPicker
    ? `
          <div class="number-picker" data-number-picker>
            <ul class="number-picker-options" id="number-picker-options" data-view="number-options" role="listbox"></ul>
            <div class="number-picker-status" data-view="number-status" role="status" aria-live="polite"></div>
          </div>`
    : '';
  return `
      <div class="domain-page" data-page-kind="entry">
        <form class="action-form entry-open" data-entry-form data-target-template="${escapeHtml(page.targetTemplate)}">
          <label class="form-field">${escapeHtml(page.fieldLabel || '编号')}
            <input name="number" type="text" autocomplete="off" enterkeyhint="go" placeholder="${escapeHtml(page.placeholder || '')}"${picker ? ' role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="number-picker-options"' : ''}>
          </label>
          ${picker}
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
