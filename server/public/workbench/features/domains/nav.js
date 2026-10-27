import { QUERY_SECTIONS } from '../../config/query.js';
import { escapeHtml } from '../../core/formatters.js';
import { buildDirectJumpUrl, directJumpEnabled, renderQueryEntries } from '../query/index.js';
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
  return domain.pages.filter((page) => page.hidden !== true).map((page) => `
        <button class="sub-tab${page.id === active ? ' active' : ''}" type="button"
          data-domain-page="${escapeHtml(page.id)}" aria-selected="${page.id === active}">${escapeHtml(page.label)}</button>`).join('');
}

/**
 * ⭐ 2026-10-12：这个子页**点一次就到**吗？—— 是的话给出目标 URL，否则 `''`（照旧切页 / 画卡片）。
 *
 * 三个条件**全部**成立才跳（任何一条不成立都回落"切页 / 卡片"那条路）：
 *   ① 配置里这一页写了 `directJump: true`（`config/domains.js` —— **配置先行**，
 *      哪几页直跳是配置说了算，不是渲染层猜的）；
 *   ② 总开关是**显式 `true`**（`config/links.js` 的 `LINK_DIRECT_JUMP_ENABLED`）；
 *   ③ 目标 `href` **非空** —— 空值绝不产生目标 ⇒ **没有死链**。
 *
 * 目标从**现有配置**取（不新编 URL）：
 *   · `page.jumpHref`（显式覆盖，备用）→ 优先；
 *   · `kind: 'query'` → 对应 `config/query.js` 板块的 `href`（= `config/links.js` 里那条）；
 *   · 其余 → 只有**恰好一张卡**时取那张卡的 `href`（例：「货品上新」那张飞书表单卡）。
 *
 * `options` 是显式覆盖（测试 / 将来注入用），不传就用配置。
 */
export function directJumpUrlForPage(page, options = {}) {
  if (!page || page.directJump !== true) return '';
  if (!directJumpEnabled(options)) return '';
  const href = page.jumpHref
    ?? (page.kind === 'query'
      ? sectionById(page.sectionId).href
      : (page.cards?.length === 1 ? page.cards[0].href : ''));
  return buildDirectJumpUrl(href, options);
}

/**
 * 子 tab 被点一下的**动作**（纯函数，`features/domains/index.js` 照着执行）：
 *   · 直跳页（配了外链 + 开关开着）⇒ `{ jump: <目标 URL> }` —— **点一次就到**，
 *     不再渲染 / 等待她点第二下那张卡；
 *   · 其余一律 `{ activate: <pageId> }` —— 与原来一模一样（切到本页）。
 */
export function resolveTabClick(page, options = {}) {
  const jump = directJumpUrlForPage(page, options);
  return jump ? { jump } : { activate: page?.id };
}

/** 一个"静态"子页面的 HTML：`entry` / `links` / `query` / `placeholder`（认不出的返回空）。 */
export function domainPageHtml(page, options = {}) {
  // ⭐ 2026-10-12（业务负责人）：「点完这个按钮之后**系统可以直接自动跳转**……不需要让我再去点一下
  //    那个消息查询的卡片」⇒ **直跳页不渲染任何中间内容**（点一次就走，这一页根本不会停留）。
  //    ⚠️ 只在"直跳 + href 非空"时为空：href 为空（或直跳关掉）时**照旧**渲染下面那张卡 ——
  //       空值时是不可点的 `div.disabled-card` + 「链接待配置」，**绝不产生死链**。
  if (directJumpUrlForPage(page, options)) return '';
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
