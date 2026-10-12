import {
  FEISHU_APPLINK_WEB_URL_OPEN,
  LINK_APPLINK_ENABLED,
  LINK_APPLINK_MODE,
  LINK_DIRECT_JUMP_ENABLED,
} from '../../config/links.js';
import { QUERY_SECTIONS } from '../../config/query.js';
import { escapeHtml } from '../../core/formatters.js';

// 「信息查询」tab —— **两个板块**（销售查询 · 库存查询），每个板块**一张卡**，点一下**直接打开
// 她在飞书配好的多维表格网页**。
//
// ⭐ 2026-10-08（业务负责人逐字）：
//   「**2. 信息查询**：整合已有的两个 tab 页，放到同一个 tab 页里的**两个板块**，即"销售查询"和"库存查询"」
//   「目前我采用的并不是我们自己搭建的页面，而是**多维表格里的页面**……**销售查询和库存查询点开也是
//    多维表格上的一个网页**。⇒ 在这个维度上我们**不用自己搭建接口**」
//   「现有的**我们自己搭的**销售查询/库存查询页面与接口（`/api/workbench/*`），**顺手删掉**～」
// ⇒ 本文件**只负责画两张卡**：清单在 `config/query.js`、URL 在 `config/links.js`（配置先行），
//    **一次网络调用都没有**、也**不新增任何接口 / 页面**（她明确"不用自己搭建接口"）。
//
// ⚠️ 空 URL 的行为（她还没给链接时）：**不生成 `<a>`**，改成一个不可点的
//    `<div class="entry-card disabled-card">`，arrow 文案 = 「链接待配置」
//    ⇒ 卡面说得清清楚楚，**点了不跳空链接、不报错**。
//
// ⚠️ 外链**同窗口跳转**（与「报货与退货」那张卡同一个风格，故意不加 `target="_blank"`）：
//    她实际是在手机上、多半是飞书内置浏览器里打开工作台，新窗口体验差、还可能被拦。
//    `rel="noopener"` 保底。
//
// ⭐⭐ 2026-10-12（业务负责人）：「点击了『销售查询』这个按钮之后，**系统可以直接自动跳转**……
//    **不需要让我再去点一下那个消息查询的卡片**」⇒ 两个查询子 tab 改成**点一次就到**：
//    跳转目标由 `buildQueryJumpUrl()` 拼（`config/query.js` 的 `QUERY_DIRECT_JUMP_ENABLED` /
//    `QUERY_JUMP_TARGET` 决定"直跳 or 老路卡片"、以及走普通跳转还是飞书端内 AppLink）；
//    **直跳时这一页不渲染卡片**（见 `features/domains/nav.js` 的 `domainPageHtml`）。
//    本文件仍**没有任何网络调用**，跳转只是 `window.location.assign` 一次。

/** 还没配 URL 时卡面显示的文案（配置为空值时**明确**告诉用户，而不是点了没反应）。 */
export const LINK_PENDING_TEXT = '链接待配置';

/** 这个板块配了可用的外链吗？—— 空串 / 空值一律算「没配」。 */
export const hasLink = (href) => typeof href === 'string' && href.trim() !== '';

/**
 * ⭐ 2026-10-12：**点一次就到**（业务负责人：「不需要让我再去点一下那个消息查询的卡片」）。
 * 三个子页面共用这一套装配（销售查询 / 全仓查询 / 货品上新），值都在 `config/links.js`。
 *
 * 直跳开着吗？—— 只看**显式 `true`**（不认 truthy 兜底：`0` / `'true'` / 没配一律算关）。
 * `options` 是显式覆盖（测试 / 将来注入用），不传就用配置。
 */
export const directJumpEnabled = (options = {}) => (options.enabled ?? LINK_DIRECT_JUMP_ENABLED) === true;

/** 走飞书**端内 AppLink** 吗？—— 同样只看显式 `true`；`false` = **一键回落**普通跳转（乙 → 甲）。 */
export const applinkEnabled = (options = {}) => (options.applinkEnabled ?? LINK_APPLINK_ENABLED) === true;

/**
 * 一次点击该去哪个 URL —— **纯函数**（配置可注入，便于测试两条路）。
 *
 * ⚠️ **空 href 一律返回 `''`**（`''` / 纯空白 / 非字符串都算没配）⇒ 调用方**不跳**、
 *    回落到"不可点的卡 + 「链接待配置」"那条路 ⇒ **绝不产生空 href / 死链**。
 *
 * ⚠️ **URL 一个字都不加工**：回落路（`LINK_APPLINK_ENABLED = false`）原样返回她配的那条
 *    （与现有卡片同一条导航，同窗口）；走 AppLink 时按 AGENTS §13 组装 ——
 *    `url` 必须 `encodeURIComponent`（官方文档明确要求）。
 */
export function buildDirectJumpUrl(href, options = {}) {
  const url = hasLink(href) ? String(href).trim() : '';
  if (!url) return '';
  if (!applinkEnabled(options)) return url;
  const mode = options.appLinkMode ?? LINK_APPLINK_MODE;
  return `${FEISHU_APPLINK_WEB_URL_OPEN}?mode=${encodeURIComponent(mode)}&url=${encodeURIComponent(url)}`;
}

/**
 * 一张卡的卡体（与 `features/common/index.js` 的卡长得一样，复用 `styles/base.css` 的类）。
 *
 * ⭐ 2026-10-10（业务负责人真机反馈「下面的这些文字解释就不用了」）：**只留标题** ——
 *    那句副标题（`desc`）已从 `config/query.js` 整字段退场，这里也不再拼 `<p>`。
 */
function cardBody(section, arrow) {
  return `
                <div class="icon">${escapeHtml(section.icon)}</div>
                <h3>${escapeHtml(section.title)}</h3>
                <div class="arrow">${escapeHtml(arrow)}</div>`;
}

/**
 * 把「信息查询」的板块清单渲染成卡片 HTML —— **纯函数**（配置可注入，便于测试"给了非空值会怎样"）。
 * 有 URL ⇒ `<a … href rel="noopener">`；空 URL ⇒ `<div … disabled-card>`（**绝不产生空 href**）。
 */
export function renderQueryEntries(sections = QUERY_SECTIONS) {
  return sections.map((section) => (hasLink(section.href)
    ? `<a class="entry-card" href="${escapeHtml(section.href)}" rel="noopener">${cardBody(section, '进入 →')}
              </a>`
    : `<div class="entry-card disabled-card" aria-disabled="true">${cardBody(section, LINK_PENDING_TEXT)}
              </div>`)).join('');
}

// ⚠️ 2026-10-09：原先这里还有一个 `createQueryModule()`（渲染独立页「信息查询」整页）。
//    那个独立页 2026-10-08 就没了（「销售查询 / 库存查询」两个板块现在分别嵌在
//    领域 tab 里：`features/domains/nav.js` 的 `query` 子页 **只调 `renderQueryEntries`**）——
//    它**已经没有任何调用方**（全仓 grep 只有测试），业务负责人 2026-10-09 点头按
//    「代码从仓库里删，不是隐藏」删掉。
//    ⭐ **`renderQueryEntries` 保留**：两个飞书多维表格外链卡仍在用（销售查询 / 全仓查询）。
