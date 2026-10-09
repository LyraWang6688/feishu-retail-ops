/**
 * 扫码页的服务端渲染（**纯函数**：视图模型 → HTML 字符串）。
 *
 * 为什么是服务端渲染 + 内联样式（业务负责人 2026-10-08 批准的第一版就这么定）：
 *   · 手机上打开**越快越好**：一次请求就有完整内容，没有前端构建、没有第二个请求；
 *   · 不改工作台的前端（`public/workbench/**`）：这一页是**独立**的一个小页面，
 *     样式内联在这里，谁都不影响。
 *
 * ⭐ 2026-10-09 加的两件事：
 *   ① **领域切换**（`?from=sales|inventory|purchase|product`，缺省销售）——
 *      **服务端按 `from` 只渲染该领域那一块**，另外三块**连 HTML 都不进**；
 *      切换条是**真链接**（`<a href="?from=…">`）。
 *      ⚠️ 这一点在 **2026-10-09 真机反馈（手机在飞书 webview 里白屏）之后重做过**：
 *      旧版是"四块全渲染进 HTML + `<head>` 内联脚本读 `location.search` 设
 *      `<html data-realm>` + CSS 显隐"。那一版**多了一层"行为取决于脚本有没有跑"**，
 *      在飞书 webview 里是额外的不确定性；而这一页的初衷本来就是"没有 JS"。
 *      现在整页**一行前端脚本都没有**，没 JS / 脚本被拦 / 老内核**行为完全一样**。
 *   ② **主题与工作台对齐**：配色 / 间距 / 圆角 / 字号**全部来自 `styles/tokens.css`**
 *      （工作台那一个主题文件）—— 这里在模块加载时把它读出来、内联成 `:root{…}`，
 *      所以"改配色只改那一个文件"，扫码页也跟着变（见 `readThemeTokens`）。
 *      ⚠️ 读不到时 `:root` 就是空的（页面退化成浏览器默认外观），
 *      **内容照常可读可点** —— 显隐 / 可见性一律不依赖任何令牌（那是白屏的另一个可能成因）。
 *
 * ⚠️ 这一页是**给她在手机上扫开看的**，所以：
 *   · `viewport` + `max-width: 480px` 居中：手机上不横向滚动、平板上也不会拉成一条；
 *   · 字号按移动端可读性给（正文 16px 起、尺码/数量 17–18px，避免 iOS 自动放大）；
 *   · 表格只有 4 列（尺码 + 三种状态），窄屏也放得下；缺码那一行**整行高亮**，
 *     标记 `⚠️ 缺` 放在**尺码格子里**（设计稿把标记画在行尾，窄屏上第五列会被挤掉）。
 *   · 领域切换的那一排按钮 **≥44px 命中区**（`--control-height`）—— 手机上点得准。
 *
 * ⚠️ 所有来自表里的值（编号 / 颜色 / 品类 / 尺码 / 状态）一律 `escapeHtml` ——
 *    这些是**业务数据**，不是可信 HTML。
 */
const fs = require('node:fs');
const path = require('node:path');
const { SCAN_PAGE, fillText } = require('../config/scanPage');
const {
  REALMS, DEFAULT_REALM, REALM_TEXTS, resolveRealm, labelPrintUrls,
  saleSizeGroups, purchaseSizeLines, sizeGroupOf,
} = require('./scanPageRealm');

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

/**
 * ⭐ **主题唯一真源** = 工作台的 `public/workbench/styles/tokens.css`。
 * 读出来只是为了把它**内联**进这一页（保持"一次请求打开"的初衷，不再引一个外链 CSS），
 * 所以改配色 / 间距 / 圆角 / 字号**只改那一个文件**，工作台与扫码页一起变。
 *
 * 读不到时（文件被删 / 权限异常）**不抛**：`:root` 为空，页面退化成"浏览器默认字体与颜色"
 * 但内容照常可读可点（本页的值全部走 `var(--…)`，没有第二份硬编码的兜底值 —— 那正是要避免的漂移）。
 */
const THEME_FILE = path.join(__dirname, '..', '..', 'public', 'workbench', 'styles', 'tokens.css');

function readThemeTokens(file = THEME_FILE) {
  let css = '';
  try {
    css = fs.readFileSync(file, 'utf8');
  } catch (error) {
    // 读不到（文件被删 / 权限异常）⇒ 不抛：`:root` 为空，页面退化成浏览器默认外观，内容照常可读。
    return [];
  }
  // ⚠️ 先去掉注释再抓变量：注释里会写 `--xxx`（说明文字），别把它们当成真令牌。
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens = [];
  for (const match of source.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+);/gi)) {
    tokens.push(`${match[1]}: ${match[2].trim()};`);
  }
  return tokens;
}

const THEME_TOKENS = readThemeTokens();
const THEME_ROOT = `:root {\ncolor-scheme: light;\n${THEME_TOKENS.join('\n')}\n}`;

/**
 * ⭐⭐ 领域切换（**服务端**版，2026-10-09 手机白屏之后重做）。
 *
 * 旧版：四块操作**全都渲染进 HTML**，由 `<html data-realm="…">` + 几行 CSS 只显示一块，
 *       而那一行 `data-realm` 由 `<head>` 里一段内联脚本读 `location.search` 设好。
 * 新版：**请求什么领域，服务端就只拼那一块** ——
 *   · 页面里**一行前端脚本都没有**（没有 `<script>`、没有 `location.search`）；
 *   · 领域切换是**真链接**（`<a href="?from=…">`），点一下 = 一次新的服务端请求；
 *   · 没 JS / 脚本被 webview 拦 / 老内核 ⇒ **行为完全一样**（这正是要的）。
 *
 * 为什么不干脆留一点 JS：这一页的初衷就是"**一次请求就有完整内容、没有 JS**"
 *（见文件头）。旧版那一层"行为取决于脚本有没有跑"在飞书 webview 里是**额外的不确定性**，
 * 而她真机上看到的就是一张白页 —— 与其猜测 webview 干了什么，不如让它**不需要**猜。
 */

/**
 * 内联样式。刻意用**系统字体**与**浅色**：与工作台同一个主题（同一个 `tokens.css`），
 * 且不引外部字体/图片（她那边可能只有移动网络，多一个外链就多一次等待）。
 *
 * ⭐ 2026-10-09 下半场：按"移动端优先 + 现代干净"重做了一版（浅灰底 / 白卡片 / 12~16px 圆角 /
 * 很轻的阴影 / 一个主色 / 卡片整块可点 / 次要操作进 `<details>`）；
 * 颜色 / 间距 / 圆角 / 字号仍然**全部走 `tokens.css` 的令牌**（上面内联进来的那一份）。
 *
 * 🔴 这里**不许出现 `display: none`** 这种"默认藏起来、等谁来打开"的写法 ——
 *    那正是白屏的形状（服务端已经把不需要的那几块**根本没渲染**）。
 */
const STYLE = `
${THEME_ROOT}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--background); color: var(--text);
  font-family: var(--font-family); font-size: var(--font-size-base); line-height: var(--line-height);
  -webkit-font-smoothing: antialiased;
}
.page { max-width: var(--page-max); margin: 0 auto; padding: var(--space-4) var(--space-3) var(--space-8); }
.card { background: var(--surface); border-radius: var(--radius-lg); padding: var(--space-4); margin: 0 0 var(--space-3); box-shadow: var(--shadow-card); }
.identity { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }
.identity__main { min-width: 0; }
.identity__item { margin: 0; font-size: var(--font-size-xl); font-weight: 700; letter-spacing: .3px; overflow-wrap: anywhere; }
.identity__meta { margin: var(--space-1) 0 0; color: var(--text-secondary); font-size: var(--font-size-sm); overflow-wrap: anywhere; }
.price { text-align: right; white-space: nowrap; }
.price__label { display: block; color: var(--text-muted); font-size: var(--font-size-xs); }
.price__value { font-size: var(--font-size-amount); font-weight: 700; }
.stock__heading { margin: 0 0 var(--space-2); font-size: var(--font-size-lg); }
.stock { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.stock thead th { padding: var(--space-1) var(--space-1) var(--space-2); border-bottom: 1px solid var(--border); color: var(--text-muted); font-size: var(--font-size-sm); font-weight: 500; text-align: center; }
.stock thead th:first-child { text-align: left; }
.stock tbody th { padding: var(--space-3) var(--space-1); border-bottom: 1px solid var(--border-light); font-size: var(--font-size-lg); font-weight: 600; text-align: left; width: 34%; }
.stock tbody td { padding: var(--space-3) var(--space-1); border-bottom: 1px solid var(--border-light); font-size: var(--font-size-base); text-align: center; }
.stock tbody tr:last-child th, .stock tbody tr:last-child td { border-bottom: 0; }
.stock td.zero { color: var(--placeholder); }
.stock tr.missing { background: var(--warning-soft); }
.stock tr.missing th { color: var(--warning); }
.stock tr.missing td.zero { color: var(--warning); opacity: .55; }
.badge { display: inline-block; margin-left: var(--space-1); padding: 1px 7px; border-radius: var(--radius-pill); background: var(--warning-soft); color: var(--warning); font-size: var(--font-size-xs); font-weight: 600; vertical-align: 2px; }
.notes { margin: var(--space-3) 0 0; padding: 0; list-style: none; color: var(--text-muted); font-size: var(--font-size-sm); }
.notes li { margin-top: var(--space-1); }
.foot { margin: var(--space-2) var(--space-1) 0; color: var(--text-muted); font-size: var(--font-size-xs); overflow-wrap: anywhere; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.state-msg { text-align: center; padding: var(--space-8) var(--space-4); }
.state-msg h1 { margin: 0 0 var(--space-2); font-size: var(--font-size-xl); }
.state-msg p { margin: var(--space-2) 0; color: var(--text-secondary); }
.state-msg .number { color: var(--text); font-weight: 600; overflow-wrap: anywhere; }
.state-msg .hint { color: var(--text-muted); font-size: var(--font-size-sm); }
.result { margin: var(--space-3) 0 0; padding: 0; list-style: none; color: var(--text); font-size: var(--font-size-base); }
.result li { margin-top: var(--space-1); }
.draft-count { margin: 0 0 var(--space-1); font-size: var(--font-size-base); font-weight: 600; }
.notice { margin: 0; color: var(--primary); font-size: var(--font-size-base); font-weight: 600; }
.draft-list { margin: 0 0 var(--space-2); padding-left: var(--space-5); color: var(--text-secondary); font-size: var(--font-size-md); }
.write-form { margin: var(--space-3) 0 0; }
.write-form + .write-form { padding-top: var(--space-3); border-top: 1px solid var(--border-light); }
.form-row { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2); }
.form-row label { flex: 0 0 42%; color: var(--text-secondary); font-size: var(--font-size-md); }
.form-row select, .form-row input { flex: 1 1 auto; min-width: 0; min-height: var(--control-height); padding: var(--space-2) var(--space-3); border: 1px solid var(--control-border); border-radius: var(--radius-sm); font-size: var(--font-size-base); background: var(--surface); }
.size-row { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2); }
.size-check { flex: 1 1 auto; min-height: var(--control-height); display: flex; align-items: center; gap: var(--space-2); font-size: var(--font-size-base); }
.size-check input { width: 20px; height: 20px; }
.size-qty { flex: 0 0 84px; min-height: var(--control-height); padding: var(--space-2) var(--space-3); border: 1px solid var(--control-border); border-radius: var(--radius-sm); font-size: var(--font-size-base); text-align: center; }
.hint { color: var(--text-muted); font-size: var(--font-size-sm); }
.tag { display: inline-flex; align-items: center; padding: 2px 10px; border-radius: var(--radius-pill); font-size: var(--font-size-xs); font-weight: 600; }
.tag--success { color: var(--success); background: var(--success-soft); }
.tag--warning { color: var(--warning); background: var(--warning-soft); }
.btn { display: block; width: 100%; min-height: var(--control-height); margin-top: var(--space-2); padding: var(--space-3) var(--space-3); border: 0; border-radius: var(--radius-sm); background: var(--border-light); color: var(--text); font-size: var(--font-size-base); font-weight: 600; text-align: center; text-decoration: none; cursor: pointer; }
.btn--primary { background: var(--primary); color: var(--surface); }
.btn--ghost { background: transparent; color: var(--text-muted); font-weight: 500; }
summary { cursor: pointer; }
/* 【一键补货】= 一个**看起来就是按钮**的折叠头（点开才是尺码 + 数量 + 生成采购申请）。
   ⚠️ 不用 JS：summary 自己就是"点一下展开"，样式上让它长得像主按钮。 */
.disclosure { margin: var(--space-3) 0 0; padding: 0; border: 0; background: transparent; }
.disclosure__summary { display: flex; align-items: center; justify-content: center; min-height: var(--control-height); padding: var(--space-3); border-radius: var(--radius-sm); background: var(--primary); color: var(--surface); font-size: var(--font-size-base); font-weight: 600; text-align: center; overflow-wrap: anywhere; }
.disclosure[open] .disclosure__summary { margin-bottom: var(--space-2); }
.disclosure > .hint { margin: 0 0 var(--space-2); }
.disclosure .write-form { margin: 0; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-soft); }
/* ── 销售：尺码两组（有货 ⇒ 现货 / 没有 ⇒ 预订）─────────────────────────── */
.size-group { min-width: 0; margin: 0 0 var(--space-3); padding: var(--space-3); border: 1px solid var(--border-light); border-radius: var(--radius-md); background: var(--surface-soft); }
.size-group__legend { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); padding: 0; font-size: var(--font-size-base); font-weight: 700; }
.size-group .hint { display: block; margin: var(--space-1) 0 var(--space-2); }
.size-chips { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-2); }
.size-chip { display: flex; align-items: center; gap: var(--space-2); min-height: var(--control-height); padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); cursor: pointer; }
.size-chip input { flex: none; width: 20px; height: 20px; margin: 0; }
.size-chip__size { font-size: var(--font-size-lg); font-weight: 700; }
.size-chip__meta { margin-left: auto; color: var(--text-secondary); font-size: var(--font-size-sm); }
/* ── 采购：各尺码（样品 + 门盒）数量 + 一键补货 ──────────────────────────── */
.purchase-sizes { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-2); margin: var(--space-3) 0; padding: 0; list-style: none; }
.purchase-size { display: flex; align-items: center; gap: var(--space-2); min-height: var(--control-height); padding: var(--space-2) var(--space-3); border: 1px solid var(--border-light); border-radius: var(--radius-sm); background: var(--surface-soft); }
.purchase-size__size { font-size: var(--font-size-lg); font-weight: 700; }
.purchase-size__count { margin-left: auto; font-size: var(--font-size-amount); font-weight: 700; font-variant-numeric: tabular-nums; }
/* ── 领域切换（一个二维码，四个领域）────────────────────────────────────── */
.realm-bar { display: flex; gap: var(--space-1); margin: 0 0 var(--space-2); padding: var(--space-1); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-card); overflow-x: auto; }
.realm-tab { flex: 1 0 auto; display: flex; align-items: center; justify-content: center; min-height: var(--control-height); padding: 0 var(--space-3); border-radius: var(--radius-md); color: var(--text-secondary); font-size: var(--font-size-base); font-weight: 600; text-decoration: none; white-space: nowrap; }
/* 当前领域那一颗 = 主色（**服务端**决定，不是脚本切 class） */
.realm-tab--active { color: var(--surface); background: var(--primary); }
.realm-hint { margin: 0 0 var(--space-3); color: var(--text-muted); font-size: var(--font-size-xs); text-align: center; }
/* noscript 兜底那一排（webview 禁脚本时才会出现）：朴素的文字链接，不用卡片阴影 */
.realm-bar--plain { display: block; margin: 0; padding: 0; background: transparent; box-shadow: none; }
.realm-bar--plain .realm-link { display: inline-block; margin: 0 var(--space-2) var(--space-1) 0; color: var(--primary); font-size: var(--font-size-base); }
`;

const renderDocument = ({ title, content, requestId, config = SCAN_PAGE }) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="page">
${content}
</main>
${requestId ? `<p class="foot">${escapeHtml(config.texts.requestIdLabel)} <span class="mono">${escapeHtml(requestId)}</span></p>` : ''}
</body>
</html>
`;

/** 一行的数量格：有货给数字（加粗），0 给破折号。 */
const cellHtml = (count, config) => (count > 0
  ? `<td>${escapeHtml(count)}</td>`
  : `<td class="zero">${escapeHtml(config.texts.zero)}</td>`);

const identityHtml = (view, config) => {
  const meta = [view.color, view.category_name || view.category_code].filter(Boolean).join(config.texts.identitySeparator);
  return `<header class="card identity">
<div class="identity__main">
<h1 class="identity__item">${escapeHtml(view.item_no || view.number)}</h1>
${meta ? `<p class="identity__meta">${escapeHtml(meta)}</p>` : ''}
</div>
<div class="price">
<span class="price__label">${escapeHtml(config.texts.priceLabel)}</span>
<span class="price__value">${escapeHtml(view.price_text)}</span>
</div>
</header>`;
};

/**
 * ⭐ 领域切换条（顶部）：四个领域各一条**真链接**（`?from=<id>`）。
 *
 * 🔴 当前领域那一颗的高亮是**服务端**决定的（`realm-tab--active` + `aria-current="page"`），
 *    不是脚本在浏览器里切 class —— 没 JS 也完全正确。
 * 领域顺序 / 名字全部来自 `views/scanPageRealm.js`（加减领域只改那个文件）。
 */
const realmBarHtml = (realm = DEFAULT_REALM) => `<nav class="realm-bar" aria-label="${escapeHtml(REALM_TEXTS.barLabel)}">
${REALMS.map((item) => (item.id === realm
    ? `<a class="realm-tab realm-tab--active" data-realm-id="${escapeHtml(item.id)}" href="?from=${escapeHtml(item.id)}" aria-current="page">${escapeHtml(item.label)}</a>`
    : `<a class="realm-tab" data-realm-id="${escapeHtml(item.id)}" href="?from=${escapeHtml(item.id)}">${escapeHtml(item.label)}</a>`)).join('\n')}
</nav>
<p class="realm-hint">${escapeHtml(REALM_TEXTS.barHint)}</p>`;

/**
 * `<noscript>` 兜底：把四条领域链接**再给一遍**。
 *
 * ⚠️ 这一页**本来就不需要 JavaScript**（切换条是真链接、服务端只渲染当前那一块），
 *    所以这一段不是"页面能不能用"的前提，而是"万一 webview 禁脚本/样式被裁掉"的保险带
 *    —— 她的第一要求是"**手机上无论如何都要有看得见的东西**"。
 */
const noScriptHtml = () => `<noscript>
<p class="realm-hint">${escapeHtml(REALM_TEXTS.noScriptHint)}</p>
<nav class="realm-bar realm-bar--plain" aria-label="${escapeHtml(REALM_TEXTS.barLabel)}">
${REALMS.map((realm) => `<a class="realm-link" href="?from=${escapeHtml(realm.id)}">${escapeHtml(realm.label)}</a>`).join('\n')}
</nav>
</noscript>`;

const stockTableHtml = (view, config) => {
  const head = [config.texts.columnSize, ...view.columns.map((column) => column.label)]
    .map((label) => `<th>${escapeHtml(label)}</th>`).join('');
  const rows = view.rows.map((row) => {
    const badge = row.missing
      ? `<span class="badge" title="${escapeHtml(config.texts.missingBadgeTitle)}">${escapeHtml(`${config.missingSize.icon} ${config.missingSize.badge}`)}</span>`
      : '';
    const cells = row.cells.map((cell) => cellHtml(cell.count, config)).join('');
    return `<tr${row.missing ? ' class="missing"' : ''}>`
      + `<th scope="row">${escapeHtml(row.size_text)}${badge}</th>${cells}</tr>`;
  }).join('\n');
  const notes = view.notes?.length
    ? `<ul class="notes">${view.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>`
    : '';
  return `<section class="card">
<h2 class="stock__heading">${escapeHtml(fillText(config.texts.stockHeading, { total: view.total }))}</h2>
<table class="stock">
<thead><tr>${head}</tr></thead>
<tbody>
${rows}
</tbody>
</table>
${notes}
</section>`;
};

/**
 * ⭐ 「**货品**」领域那一块：打这一款的标签（**单个**）+ 去批量打印。
 * ⚠️ 复用**既有**标签打印页（`/workbench/label-print.html`，40×30mm 那一版），
 *    这里只拼链接（货号来自这一页已经读到的视图模型）—— 不在这里重做打印。
 */
const labelBlockHtml = (view) => {
  const urls = labelPrintUrls(view);
  return `<section class="card">
<h2 class="stock__heading">${escapeHtml(REALM_TEXTS.labelHeading)}</h2>
<p class="hint">${escapeHtml(REALM_TEXTS.labelHint)}</p>
<a class="btn btn--primary" href="${escapeHtml(urls.single)}" rel="noopener">${escapeHtml(REALM_TEXTS.labelSingleButton)}</a>
<a class="btn" href="${escapeHtml(urls.batch)}" rel="noopener">${escapeHtml(REALM_TEXTS.labelBatchButton)}</a>
</section>`;
};

/**
 * ── 两个写入口的表单（销售建单 / 补货报单）────────────────────────────────────
 *
 * 都是**原生 HTML 表单**（没有一行业务 JS）：手机浏览器直接打开就能用，也不给这一页
 * 添任何前端构建产物（与第一版只读页的取舍一致）。
 *
 * 🔴 每个表单里都带一个 `submit_key`（**幂等键**，由服务端会话给出）：
 *   连点两次 = 同一个键 = 只写一次（见 `services/scanWriteService.js`）。
 * ⚠️ 所有值都 `escapeHtml`：它们从表里来（货号 / 尺码），不是可信 HTML。
 */
const hiddenField = (name, value) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;

const optionsHtml = (values, selected) => values
  .map((value) => `<option value="${escapeHtml(value)}"${String(value) === String(selected) ? ' selected' : ''}>${escapeHtml(value)}</option>`)
  .join('');

/** 销售表单：加入本单（只动本地会话）＋ 提交这一单（**唯一的写库时机**）。 */
const saleFormHtml = (view, write) => {
  const t = write.texts;
  const fields = write.fields;
  const lines = write.draft?.lines || [];
  const draftList = lines.length
    ? `<ul class="draft-list">${lines.map((line) => `<li>${escapeHtml(fillText(
      t.draftItem, { itemNo: line.item_no || line.number || '', size: line.size },
    ))}</li>`).join('')}</ul>`
    : `<p class="hint">${escapeHtml(t.draftEmpty)}</p>`;
  const sizeInput = sizeGroupsHtml(view, write);
  return `<section class="card">
<h2 class="stock__heading">${escapeHtml(t.saleHeading)}</h2>
<p class="draft-count">${escapeHtml(fillText(t.draftHeading, { count: lines.length }))}</p>
${draftList}
<form method="post" action="${escapeHtml(write.postAction)}" class="write-form">
${hiddenField(fields.action, write.actions.addLine)}
${hiddenField(fields.submitKey, write.saleKey)}
${sizeInput}
<div class="form-row"><label>${escapeHtml(t.amountLabel)}</label><input name="${escapeHtml(fields.amount)}" inputmode="decimal" placeholder="${escapeHtml(t.amountPlaceholder)}"></div>
<div class="form-row"><label>${escapeHtml(t.giftLabel)}</label><input name="${escapeHtml(fields.gift)}"></div>
<button type="submit" class="btn">${escapeHtml(t.addButton)}</button>
</form>
<form method="post" action="${escapeHtml(write.postAction)}" class="write-form">
${hiddenField(fields.action, write.actions.submitOrder)}
${hiddenField(fields.submitKey, write.saleKey)}
<div class="form-row"><label>${escapeHtml(t.paymentLabel)}</label><select name="${escapeHtml(fields.paymentMethod)}">${optionsHtml(write.paymentMethods, write.defaultPaymentMethod)}</select></div>
<div class="form-row"><label>${escapeHtml(t.paymentAmountLabel)}</label><input name="${escapeHtml(fields.paymentAmount)}" inputmode="decimal" placeholder="${escapeHtml(t.paymentAmountPlaceholder)}"></div>
<button type="submit" class="btn btn--primary">${escapeHtml(t.submitButton)}</button>
<p class="hint">${escapeHtml(t.fundsPendingNote)}</p>
</form>
${lines.length ? `<form method="post" action="${escapeHtml(write.postAction)}" class="write-form">
${hiddenField(fields.action, write.actions.clearDraft)}
${hiddenField(fields.submitKey, write.saleKey)}
<button type="submit" class="btn btn--ghost">${escapeHtml(t.clearButton)}</button>
</form>` : ''}
</section>`;
};

/**
 * ⭐ 销售建单的**尺码两组**（业务负责人 2026-10-09：「选的是库存里面的 = 现货；不是 = 预订」）：
 *   · 第一组 = **有货（样品 + 门盒）**的尺码 ⇒ 选中它 = **现货**；
 *   · 第二组 = 该组（类别）**目前没有的**尺码 ⇒ 选中它 = **预订**。
 *
 * ⚠️ 分组**只来自视图模型**（`views/scanPageRealm.saleSizeGroups`）—— 页面上看到的两组
 *    与提交时判"现货 / 预订"用的是**同一份**（路由按同一份算 `inStock`）。
 * ⚠️ 没有一行 JS：两个 `<fieldset>` 里的 radio 都叫 `size`，选哪个就是哪个；
 *    每个可选项都是一整块（≥44px 命中区，见 STYLE 的 `.size-chip`）。
 * ⚠️ 视图模型里一行尺码都没有时（老数据 / 降级）退回 `write.sizes`，**不把页面空着**。
 */
const sizeGroupHtml = ({ id, heading, tag, tone, hint, note = '', items, empty }) => `
<fieldset class="size-group" data-stock-group="${escapeHtml(id)}">
<legend class="size-group__legend">
<span class="size-group__title">${escapeHtml(heading)}</span>
<span class="tag tag--${escapeHtml(tone)}">${escapeHtml(tag)}</span>
</legend>
<p class="hint">${escapeHtml(hint)}${note ? ` ${escapeHtml(note)}` : ''}</p>
<div class="size-chips">${items.length
    ? items.map((item) => `<label class="size-chip">
<input type="radio" name="size" value="${escapeHtml(item.size_text)}">
<span class="size-chip__size">${escapeHtml(item.size_text)} 码</span>
<span class="size-chip__meta">${escapeHtml(item.meta)}</span>
</label>`).join('\n')
    : `<span class="hint">${escapeHtml(empty)}</span>`}</div>
</fieldset>`;

const sizeGroupsHtml = (view, write) => {
  const t = REALM_TEXTS;
  const groups = saleSizeGroups(view);
  const fallback = (write.sizes || []).map((item) => ({ size_text: item.size_text, missing: Boolean(item.missing) }));
  const inStock = groups.inStock.length || groups.prepaid.length
    ? groups.inStock
    : fallback.filter((item) => !item.missing).map((item) => ({ size_text: item.size_text, count: null }));
  const prepaid = groups.inStock.length || groups.prepaid.length
    ? groups.prepaid
    : fallback.filter((item) => item.missing).map((item) => ({ size_text: item.size_text, count: 0 }));
  if (!inStock.length && !prepaid.length) return `<span class="hint">${escapeHtml(t.saleSizeEmpty)}</span>`;
  const countText = (item) => (item.count === null
    ? t.saleInStockTag
    : fillText(t.saleCountTemplate, { count: item.count }));
  // 「这一组是男 38–48 / 女 34–43」（她 2026-10-09 给的范围）——判据在 views/scanPageRealm。
  const group = sizeGroupOf(view.category_code);
  const groupNote = group ? `（这一组 = ${group.label} ${group.key} · ${group.from}–${group.to}）` : '';
  return sizeGroupHtml({
    id: 'in_stock',
    heading: t.saleInStockHeading,
    tag: t.saleInStockTag,
    tone: 'success',
    hint: t.saleInStockHint,
    items: inStock.map((item) => ({ ...item, meta: countText(item) })),
    empty: t.saleSizeEmpty,
  }) + sizeGroupHtml({
    id: 'prepaid',
    heading: t.salePrepaidHeading,
    tag: t.salePrepaidTag,
    tone: 'warning',
    hint: t.salePrepaidHint,
    note: groupNote,
    items: prepaid.map((item) => ({ ...item, meta: t.salePrepaidTag })),
    empty: t.saleSizeEmpty,
  });
};

/**
 * 补货表单：勾选缺的尺码 + 填数量 → 生成采购申请。
 *
 * ⭐ 2026-10-09（下半场）采购领域 = **先列各尺码（样品 + 门盒）数量** + 【**一键补货**】：
 *   · 一键补货 = 把**缺的尺码**默认勾上、**默认各 1 双**、数量可改（`<details>` 折叠，
 *     点一下 "一键补货" 就展开；没有一行 JS）；
 *   · 走的是**既有**补货写入口（`views/../services/scanWriteService.js` 的 `submitReplenish`）→
 *     既有采购免确认链路（`publishPurchaseRequest`；「信息填写」表变更那条入口
 *     已于 2026-10-09 退场，函数本身没变）—— 渲染层一行业务逻辑都没有。
 */
const replenishFormHtml = (view, write) => {
  const t = write.texts;
  const v = REALM_TEXTS;
  const fields = write.fields;
  const lines = purchaseSizeLines(view);
  const sizes = lines.length ? lines : (write.sizes || []).map((item) => ({
    size_text: item.size_text, sellable: null, missing: Boolean(item.missing), checked: Boolean(item.missing),
  }));
  if (!sizes.length) return '';
  const stockList = `<ul class="purchase-sizes" data-view="purchase-sizes">${sizes.map((item) => `
<li class="purchase-size" data-purchase-size="${escapeHtml(item.size_text)}">
<span class="purchase-size__size">${escapeHtml(item.size_text)} 码</span>
<span class="purchase-size__count">${escapeHtml(fillText(v.saleCountTemplate, { count: item.sellable ?? 0 }))}</span>
<span class="tag tag--${item.sellable > 0 ? 'success' : 'warning'}">${escapeHtml(item.sellable > 0 ? v.purchaseInStockTag : (item.missing ? v.purchaseMissingTag : v.purchaseNoneTag))}</span>
</li>`).join('')}</ul>`;
  const rows = sizes.map((item) => {
    const size = item.size_text;
    return `<div class="size-row">
<label class="size-check"><input type="checkbox" name="${escapeHtml(fields.replenishSizes)}" value="${escapeHtml(size)}"${item.checked ? ' checked' : ''}> ${escapeHtml(size)} 码</label>
<input class="size-qty" name="${escapeHtml(`${fields.replenishQuantityPrefix}${size}`)}" value="1" inputmode="numeric" aria-label="${escapeHtml(`${size} ${t.replenishQuantityLabel}`)}" placeholder="${escapeHtml(t.replenishQuantityLabel)}">
</div>`;
  }).join('');
  return `<section class="card">
<h2 class="stock__heading">${escapeHtml(t.replenishHeading)}</h2>
<p class="hint">${escapeHtml(v.purchaseSizesHint)}</p>
${stockList}
<details class="disclosure" data-view="one-tap-replenish">
<summary class="disclosure__summary">${escapeHtml(v.oneTapReplenish)}</summary>
<p class="hint">${escapeHtml(t.replenishHint)}</p>
<form method="post" action="${escapeHtml(write.postAction)}" class="write-form">
${hiddenField(fields.action, write.actions.replenish)}
${hiddenField(fields.submitKey, write.replenishKey)}
${rows}
<button type="submit" class="btn btn--primary">${escapeHtml(t.replenishButton)}</button>
</form>
</details>
</section>`;
};

/**
 * 某个领域**"没内容"**时的那张人话卡片（标题 + 为什么 + 一个下一步）。
 *
 * 🔴 为什么必须有它：这是"**手机上无论如何都要有看得见的东西**"的最后一道体验兜底 ——
 *    没有写上下文（拿不到飞书身份 / 写入口没开）时，旧版会**什么块都不渲染**，
 *    屏幕上只剩身份区那一行；现在给一张说清楚的卡片，她至少知道"为什么没有表单、下一步去哪"。
 */
const realmEmptyHtml = (realm, config) => {
  const body = realm === 'purchase' ? config.texts.realmEmptyPurchaseBody : config.texts.realmEmptySalesBody;
  return `<section class="card state-msg">
<h1>${escapeHtml(config.texts.realmEmptyTitle)}</h1>
<p>${escapeHtml(body)}</p>
<a class="btn" href="?from=${escapeHtml('inventory')}">${escapeHtml(config.texts.realmEmptyAction)}</a>
</section>`;
};

/**
 * ⭐⭐ **只渲染当前领域那一块**（2026-10-09 手机白屏之后的改法）。
 *
 * 四个领域各自的正文（每个都带 `realm-block--<领域>` 标记，方便对照 / 断言）：
 *   · `sales`     —— 「刚加入本单」那一句 + 销售建单表单；
 *   · `inventory` —— 库存表；
 *   · `purchase`  —— 补货报单表单；
 *   · `product`   —— 货品标签。
 *
 * ⚠️ **只有当前这一块进 HTML**（另外三块**连字符串都不拼**）—— 页面里没有"靠 CSS 藏起来"
 *    的东西，也就没有"脚本没跑 ⇒ 什么都没显示"的可能。
 * ⚠️ 认不出的领域一律回落缺省（`resolveRealm` 在路由那一层已经做过一次；这里再兜一次，
 *    **渲染层永远不抛、永远有正文**）。
 */
const realmBlockHtml = (realm, view, config, write) => {
  const id = REALMS.some((item) => item.id === realm) ? realm : DEFAULT_REALM;
  const wrap = (inner) => `<div class="realm-block realm-block--${escapeHtml(id)}">\n${inner}\n</div>`;
  if (id === 'inventory') return wrap(stockTableHtml(view, config));
  if (id === 'product') return wrap(labelBlockHtml(view));
  if (id === 'purchase') {
    const form = write && write.enabled !== false && write.replenishEnabled !== false
      ? replenishFormHtml(view, write)
      : '';
    // 一个尺码都没有（降级到连库存行都没有）⇒ 给一张人话卡片，而不是空 div。
    return wrap(form || realmEmptyHtml('purchase', config));
  }
  // sales（缺省）
  if (!write || write.enabled === false || write.saleEnabled === false) {
    return wrap(realmEmptyHtml('sales', config));
  }
  // 「刚加入本单」那一句：文案来自配置、只有数字来自会话（**没有回显注入面**）。
  const notice = write.notice
    ? `<section class="card"><p class="notice">${escapeHtml(write.notice)}</p></section>\n`
    : '';
  return wrap(`${notice}${saleFormHtml(view, write)}`);
};

/**
 * 正常页：领域切换（真链接）+ 身份区 + 单价 + **当前领域那一块**。
 *
 * ⚠️ 渲染层**绝不抛**：任何一块拼装出问题都退化成一张人话卡片 ——
 *    这一页对她是"扫码就能看"，**空白页是最坏的结果**（比她看到一句"暂时打不开"还坏）。
 */
const renderScanPage = (view = {}, config = SCAN_PAGE, write = null, realm = DEFAULT_REALM) => {
  const safeRealm = resolveRealm(realm);
  let block;
  try {
    block = realmBlockHtml(safeRealm, view, config, write);
  } catch (error) {
    block = `<div class="realm-block realm-block--${escapeHtml(safeRealm)}">${realmEmptyHtml(safeRealm, config)}</div>`;
  }
  return renderDocument({
    title: fillText(config.texts.pageTitle, { itemNo: view.item_no || view.number, number: view.number }),
    config,
    content: `${realmBarHtml(safeRealm)}
${noScriptHtml()}
${identityHtml(view, config)}
${block}
<p class="foot">${escapeHtml(config.texts.footerNumberLabel)} <span class="mono">${escapeHtml(view.number)}</span>`
  + `${view.updated_at_text ? ` · ${escapeHtml(config.texts.updatedAtLabel)} ${escapeHtml(view.updated_at_text)}` : ''}</p>`,
  });
};

/**
 * 「不是库存表」的那些页（没找到 / 链接不对 / 出错 / 数据准备中 / 超上限 / **写失败**）——
 * 一张都不许白屏：标题 + 一句人话 + （有的话）她扫到的编号与我给她的重试建议。
 *
 * `details` 是**写成功/写失败**时给她看的几行事实（单号 / 双数 / 批次号…）：
 * 有就逐行列出来，没有就一个字都不多渲染（既有那几种页面**逐字不变**）。
 * ⚠️ 这些页面**不挂领域切换条**（它们是"结果页"，不是她操作的地方）。
 */
const renderScanMessagePage = ({ title, body, number = '', requestId = '', retryHint = '', details = [] }, config = SCAN_PAGE) => renderDocument({
  title,
  config,
  requestId,
  content: `<section class="card state-msg">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(body)}</p>
${details.length ? `<ul class="result">${details.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
${number ? `<p>${escapeHtml(config.texts.notFoundHint)}<span class="number mono">${escapeHtml(number)}</span></p>` : ''}
${retryHint ? `<p class="hint">${escapeHtml(retryHint)}</p>` : ''}
</section>`,
});

/**
 * 🔴 **最后一道兜底页**（"绝不空白"的物理保证）。
 *
 * 为什么单独一个函数：上面那些页都依赖 `config`。万一 `config` 本身坏了 /
 * 渲染抛到一个没预料到的地方，路由需要一个**几乎不可能再抛**的渲染器 ——
 * 只有三行字符串拼接 + `escapeHtml`，不需要任何配置、不读文件、不解析任何东西。
 * ⚠️ 任何输入（`undefined` / `null` / 对象 / 带标签的字符串）都**必须**返回一段有正文的 HTML。
 */
const renderMinimalPage = (input = {}) => {
  const title = escapeHtml(input?.title || SCAN_PAGE.texts.errorTitle) || '打不开';
  const body = escapeHtml(input?.body || SCAN_PAGE.texts.errorBody) || '请稍后再试。';
  const requestId = input?.requestId ? `<p>请求号 ${escapeHtml(input.requestId)}</p>` : '';
  return '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${title}</title></head>`
    + `<body style="margin:0;padding:24px;font:16px/1.6 -apple-system,BlinkMacSystemFont,\"PingFang SC\",sans-serif;color:#1f2329;background:#fff">`
    + `<h1 style="font-size:20px">${title}</h1><p>${body}</p>${requestId}</body></html>\n`;
};

module.exports = {
  renderScanPage,
  renderScanMessagePage,
  renderMinimalPage,
  escapeHtml,
  STYLE,
  readThemeTokens,
  resolveRealm,
};
