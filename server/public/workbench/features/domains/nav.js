import { QUERY_SECTIONS } from '../../config/query.js';
import { escapeHtml } from '../../core/formatters.js';
import { renderQueryEntries } from '../query/index.js';
import { entryPageHtml, linksPageHtml, placeholderPageHtml } from './pages.js';

/**
 * 领域 tab 的**纯渲染**（不碰 DOM、不发请求）—— 单独一个文件是为了能被测试直接跑：
 *   · `domainSubTabsHtml()` —— 子页面那一排按钮；
 *   · `domainPageHtml()`    —— `entry` / `links` / `query` 三种子页面的 HTML。
 * `orders` 与 `inventory-adjustment` 两种**不在这里画**：它们是既有模块，由 `index.js` 挂进去。
 *
 * ⚠️ 子 tab 的标记是 `data-domain-page`（**不是** `data-subtab`）：
 *    内嵌的「订单列表」「库存手工调整」模块自己也在用 `data-subtab` 做**它们内部**的子 tab，
 *    两边混用的话，点它们内部的子 tab 会把领域页切走。
 */

const sectionById = (id) => {
  const section = QUERY_SECTIONS.find((item) => item.id === id);
  if (!section) throw new Error(`config/query.js 找不到板块：${id}`);
  return section;
};

/** 子 tab 按钮（选中态；`data-domain-page` = 子页面 id）。 */
export function domainSubTabsHtml(domain, active = domain.pages[0].id) {
  return domain.pages.map((page) => `
        <button class="sub-tab${page.id === active ? ' active' : ''}" type="button"
          data-domain-page="${escapeHtml(page.id)}" aria-selected="${page.id === active}">${escapeHtml(page.label)}</button>`).join('');
}

/** 一个"静态"子页面的 HTML：`entry` / `links` / `query` / `placeholder`（认不出的返回空）。 */
export function domainPageHtml(page) {
  if (page.kind === 'entry') return entryPageHtml(page);
  if (page.kind === 'links') return linksPageHtml(page);
  if (page.kind === 'placeholder') return placeholderPageHtml(page);
  if (page.kind === 'query') {
    // ⭐ 2026-10-10：同名标题与那句「在飞书多维表格里看——点一下直接打开」都删掉 ——
    //    子 tab 上已经写了这一页叫什么，卡片本身就是能点的外链（她：「文字解释就不用了」）。
    return `
      <div class="domain-page" data-page-kind="query">
        <div class="domain-cards domain-cards-single">${renderQueryEntries([sectionById(page.sectionId)])}</div>
      </div>`;
  }
  return '';
}
