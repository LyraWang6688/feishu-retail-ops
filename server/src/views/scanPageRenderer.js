/**
 * 扫码页的服务端渲染（**纯函数**：视图模型 → HTML 字符串）。
 *
 * 为什么是服务端渲染 + 内联样式（业务负责人 2026-10-08 批准的第一版就这么定）：
 *   · 手机上打开**越快越好**：一次请求就有完整内容，没有前端构建、没有第二个请求；
 *   · 不改工作台的前端（`public/workbench/**`）：这一页是**独立**的一个小页面，
 *     样式内联在这里，谁都不影响。
 *
 * ⭐ 2026-10-09 加的两件事（都只在这一层，`routes/**` 与 `config/**` 一个字没改）：
 *   ① **领域切换**（`?from=sales|inventory|purchase|product`，缺省销售）——
 *      四块操作**全都渲染进 HTML**，由 CSS 按 `<html data-realm="…">` 只显示当前领域；
 *      那一行属性由 `<head>` 里一小段内联脚本在 body 解析前从 `location.search` 读出来
 *      （细节与取舍见 `views/scanPageRealm.js`）。⚠️ 显示规则由 CSS 决定 ⇒
 *      **既有用例断言的 HTML 一个字都没少**（销售表单与补货表单都还在）。
 *   ② **主题与工作台对齐**：配色 / 间距 / 圆角 / 字号**全部来自 `styles/tokens.css`**
 *      （工作台那一个主题文件）—— 这里在模块加载时把它读出来、内联成 `:root{…}`，
 *      所以"改配色只改那一个文件"，扫码页也跟着变（见 `readThemeTokens`）。
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
 * 领域切换的两组规则（**从 `REALMS` 生成**，加减领域只改那个文件）：
 *   · `.realm-block--<id>` 默认不显示；当前领域那一个显示出来；
 *   · 当前领域的那颗按钮变主色。
 * ⚠️ `:not([data-realm])` 那一行是**没 JS 时的兜底**：四块全显示，绝不白屏。
 */
const REALM_STYLE = [
  `.realm-block--${REALMS.map((realm) => realm.id).join(', .realm-block--')} { display: none; }`,
  `html:not([data-realm]) .realm-block { display: block; }`,
  REALMS.map((realm) => `html[data-realm="${realm.id}"] .realm-block--${realm.id} { display: block; }`).join('\n'),
  REALMS.map((realm) => `html[data-realm="${realm.id}"] .realm-tab[data-realm-id="${realm.id}"] { color: var(--surface); background: var(--primary); }`).join('\n'),
].join('\n');

/**
 * 在 `<head>` 里（body 解析之前）把当前领域写到 `<html data-realm="…">` 上 ——
 * 于是 CSS 从一开始就只显示该领域，不会闪一下"四块全显示"。
 * 认不出的 `from` 与缺省一律 = 销售（`DEFAULT_REALM`）。
 */
const REALM_SCRIPT = `<script>(function(){var ids=${JSON.stringify(REALMS.map((realm) => realm.id))};`
  + 'var raw="";try{raw=String(new URLSearchParams(location.search).get("from")||"").trim().toLowerCase();}catch(e){}'
  + `document.documentElement.setAttribute("data-realm",ids.indexOf(raw)>=0?raw:${JSON.stringify(DEFAULT_REALM)});}());</script>`;

/**
 * 内联样式。刻意用**系统字体**与**浅色**：与工作台同一个主题（同一个 `tokens.css`），
 * 且不引外部字体/图片（她那边可能只有移动网络，多一个外链就多一次等待）。
 */
const STYLE = `
${THEME_ROOT}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--background); color: var(--text);
  font-family: var(--font-family); font-size: var(--font-size-base); line-height: var(--line-height);
}
.page { max-width: var(--page-max); margin: 0 auto; padding: var(--space-3) var(--space-3) var(--space-8); }
.card { background: var(--surface); border-radius: var(--radius-md); padding: var(--space-3) var(--space-4); margin: 0 0 var(--space-3); box-shadow: var(--shadow-card); }
.identity { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }
.identity__item { margin: 0; font-size: var(--font-size-2xl); font-weight: 700; letter-spacing: .3px; word-break: break-all; }
.identity__meta { margin: var(--space-1) 0 0; color: var(--text-secondary); font-size: var(--font-size-md); word-break: break-all; }
.price { text-align: right; white-space: nowrap; }
.price__label { display: block; color: var(--text-muted); font-size: var(--font-size-xs); }
.price__value { font-size: var(--font-size-xl); font-weight: 700; }
.stock__heading { margin: 0 0 var(--space-2); font-size: var(--font-size-base); }
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
.foot { margin: var(--space-1) var(--space-1) 0; color: var(--placeholder); font-size: var(--font-size-xs); word-break: break-all; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.state-msg { text-align: center; padding: var(--space-8) var(--space-4); }
.state-msg h1 { margin: 0 0 var(--space-2); font-size: var(--font-size-xl); }
.state-msg p { margin: var(--space-2) 0; color: var(--text-secondary); }
.state-msg .number { color: var(--text); font-weight: 600; }
.state-msg .hint { color: var(--text-muted); font-size: var(--font-size-sm); }
.result { margin: var(--space-3) 0 0; padding: 0; list-style: none; color: var(--text); font-size: var(--font-size-md); }
.result li { margin-top: var(--space-1); }
.draft-count { margin: 0 0 var(--space-1); font-size: var(--font-size-md); font-weight: 600; }
.notice { margin: 0; color: var(--primary); font-size: var(--font-size-md); font-weight: 600; }
.draft-list { margin: 0 0 var(--space-2); padding-left: var(--space-5); color: var(--text-secondary); font-size: var(--font-size-md); }
.write-form { margin: var(--space-2) 0 0; padding: var(--space-2) 0 0; border-top: 1px solid var(--border-light); }
.form-row { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2); }
.form-row label { flex: 0 0 42%; color: var(--text-secondary); font-size: var(--font-size-md); }
.form-row select, .form-row input { flex: 1 1 auto; min-width: 0; min-height: var(--control-height); padding: var(--space-2) var(--space-3); border: 1px solid var(--control-border); border-radius: var(--radius-sm); font-size: var(--font-size-base); background: var(--surface); }
.size-row { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2); }
.size-check { flex: 1 1 auto; min-height: var(--control-height); display: flex; align-items: center; font-size: var(--font-size-base); }
.size-qty { flex: 0 0 84px; min-height: var(--control-height); padding: var(--space-2) var(--space-3); border: 1px solid var(--control-border); border-radius: var(--radius-sm); font-size: var(--font-size-base); text-align: center; }
.hint { color: var(--text-muted); font-size: var(--font-size-sm); }
.btn { display: block; width: 100%; min-height: var(--control-height); margin-top: var(--space-1); padding: var(--space-3) var(--space-3); border: 0; border-radius: var(--radius-sm); background: var(--border-light); color: var(--text); font-size: var(--font-size-base); font-weight: 600; text-align: center; text-decoration: none; }
.btn--primary { background: var(--primary); color: var(--surface); }
.btn--ghost { background: transparent; color: var(--text-muted); font-weight: 500; }
/* ── 领域切换（一个二维码，四个领域）────────────────────────────────────── */
.realm-bar { display: flex; gap: var(--space-1); margin: 0 0 var(--space-2); padding: var(--space-1); border-radius: var(--radius-md); background: var(--surface); box-shadow: var(--shadow-card); overflow-x: auto; }
.realm-tab { flex: 1 0 auto; display: flex; align-items: center; justify-content: center; min-height: var(--control-height); padding: 0 var(--space-3); border-radius: var(--radius-sm); color: var(--text-secondary); font-size: var(--font-size-base); font-weight: 600; text-decoration: none; white-space: nowrap; }
.realm-hint { margin: 0 0 var(--space-3); color: var(--text-muted); font-size: var(--font-size-xs); text-align: center; }
${REALM_STYLE}
`;

const renderDocument = ({ title, content, requestId, config = SCAN_PAGE, realm = DEFAULT_REALM }) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
${realm ? REALM_SCRIPT : ''}
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
 * ⭐ 领域切换条（顶部）：四个领域各一颗按钮（`?from=<id>`）。
 * 当前领域的高亮由 CSS 按 `<html data-realm>` 决定（见 `REALM_STYLE`）——
 * 服务端**不需要**读 `from`（那一层在 `routes/**`，本任务不碰）。
 */
const realmBarHtml = () => `<nav class="realm-bar" aria-label="${escapeHtml(REALM_TEXTS.barLabel)}">
${REALMS.map((realm) => `<a class="realm-tab" data-realm-id="${escapeHtml(realm.id)}" href="?from=${escapeHtml(realm.id)}">${escapeHtml(realm.label)}</a>`).join('\n')}
</nav>
<p class="realm-hint">${escapeHtml(REALM_TEXTS.barHint)}</p>`;

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
  const sizes = write.sizes || [];
  const lines = write.draft?.lines || [];
  const draftList = lines.length
    ? `<ul class="draft-list">${lines.map((line) => `<li>${escapeHtml(fillText(
      t.draftItem, { itemNo: line.item_no || line.number || '', size: line.size },
    ))}</li>`).join('')}</ul>`
    : `<p class="hint">${escapeHtml(t.draftEmpty)}</p>`;
  const sizeInput = sizes.length
    ? `<select name="${escapeHtml(fields.size)}">${optionsHtml(sizes.map((item) => item.size_text), '')}</select>`
    : `<span class="hint">${escapeHtml(t.sizePlaceholder)}</span>`;
  return `<section class="card">
<h2 class="stock__heading">${escapeHtml(t.saleHeading)}</h2>
<p class="draft-count">${escapeHtml(fillText(t.draftHeading, { count: lines.length }))}</p>
${draftList}
<form method="post" action="${escapeHtml(write.postAction)}" class="write-form">
${hiddenField(fields.action, write.actions.addLine)}
${hiddenField(fields.submitKey, write.saleKey)}
<div class="form-row"><label>${escapeHtml(t.sizeLabel)}</label>${sizeInput}</div>
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

/** 补货表单：勾选缺的尺码 + 填数量 → 生成采购申请。 */
const replenishFormHtml = (view, write) => {
  const t = write.texts;
  const fields = write.fields;
  const sizes = write.sizes || [];
  if (!sizes.length) return '';
  const rows = sizes.map((item) => {
    const size = item.size_text;
    return `<div class="size-row">
<label class="size-check"><input type="checkbox" name="${escapeHtml(fields.replenishSizes)}" value="${escapeHtml(size)}"${item.missing ? ' checked' : ''}> ${escapeHtml(size)} 码</label>
<input class="size-qty" name="${escapeHtml(`${fields.replenishQuantityPrefix}${size}`)}" inputmode="numeric" placeholder="${escapeHtml(t.replenishQuantityLabel)}">
</div>`;
  }).join('');
  return `<section class="card">
<h2 class="stock__heading">${escapeHtml(t.replenishHeading)}</h2>
<p class="hint">${escapeHtml(t.replenishHint)}</p>
<form method="post" action="${escapeHtml(write.postAction)}" class="write-form">
${hiddenField(fields.action, write.actions.replenish)}
${hiddenField(fields.submitKey, write.replenishKey)}
${rows}
<button type="submit" class="btn">${escapeHtml(t.replenishButton)}</button>
</form>
</section>`;
};

/**
 * 三个领域的操作块（每个都带 `realm-block--<领域>`，CSS 只显示当前那一个）：
 *   · `sales`     —— 「刚加入本单」那一句 + 销售建单表单；
 *   · `purchase`  —— 补货报单表单；
 *   · `inventory` —— 库存表（在 `renderScanPage` 里包）；
 *   · `product`   —— 货品标签（在 `renderScanPage` 里包）。
 * ⚠️ **三块都渲染进 HTML**（既有用例断言的就是这个）：只是屏幕上按领域显示其中一块。
 */
const writeFormsHtml = (view, write) => {
  if (!write || write.enabled === false) return '';
  // 「刚加入本单」那一句：文案来自配置、只有数字来自会话（**没有回显注入面**）。
  const notice = write.notice
    ? `<div class="realm-block realm-block--sales"><section class="card"><p class="notice">${escapeHtml(write.notice)}</p></section></div>`
    : '';
  const sale = write.saleEnabled === false ? '' : `<div class="realm-block realm-block--sales">${saleFormHtml(view, write)}</div>`;
  const replenish = write.replenishEnabled === false ? '' : `<div class="realm-block realm-block--purchase">${replenishFormHtml(view, write)}</div>`;
  return `${notice}${sale}${replenish}`;
};

/** 正常页：领域切换 + 身份 + 单价 + 当前领域的操作块（库存表 / 销售建单 / 补货 / 标签）。 */
const renderScanPage = (view, config = SCAN_PAGE, write = null) => renderDocument({
  title: fillText(config.texts.pageTitle, { itemNo: view.item_no || view.number, number: view.number }),
  config,
  content: `${realmBarHtml()}
${identityHtml(view, config)}
<div class="realm-block realm-block--inventory">
${stockTableHtml(view, config)}
</div>
${write ? writeFormsHtml(view, write) : ''}
<div class="realm-block realm-block--product">
${labelBlockHtml(view)}
</div>
<p class="foot">${escapeHtml(config.texts.footerNumberLabel)} <span class="mono">${escapeHtml(view.number)}</span>`
  + `${view.updated_at_text ? ` · ${escapeHtml(config.texts.updatedAtLabel)} ${escapeHtml(view.updated_at_text)}` : ''}</p>`,
});

/**
 * 「不是库存表」的那些页（没找到 / 链接不对 / 出错 / 数据准备中 / 超上限 / **写失败**）——
 * 一张都不许白屏：标题 + 一句人话 + （有的话）她扫到的编号与我给她的重试建议。
 *
 * `details` 是**写成功/写失败**时给她看的几行事实（单号 / 双数 / 批次号…）：
 * 有就逐行列出来，没有就一个字都不多渲染（既有那几种页面**逐字不变**）。
 * ⚠️ 这些页面**不挂领域切换条**（它们是"结果页"，不是她操作的地方）：
 *    给 `realm: null` 就不注入那一行脚本，四块内容本来也不在这里。
 */
const renderScanMessagePage = ({ title, body, number = '', requestId = '', retryHint = '', details = [] }, config = SCAN_PAGE) => renderDocument({
  title,
  config,
  requestId,
  realm: null,
  content: `<section class="card state-msg">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(body)}</p>
${details.length ? `<ul class="result">${details.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
${number ? `<p>${escapeHtml(config.texts.notFoundHint)}<span class="number mono">${escapeHtml(number)}</span></p>` : ''}
${retryHint ? `<p class="hint">${escapeHtml(retryHint)}</p>` : ''}
</section>`,
});

module.exports = {
  renderScanPage, renderScanMessagePage, escapeHtml, STYLE, readThemeTokens, REALM_SCRIPT, resolveRealm,
};
