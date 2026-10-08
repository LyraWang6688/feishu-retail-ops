/**
 * 扫码页的服务端渲染（**纯函数**：视图模型 → HTML 字符串）。
 *
 * 为什么是服务端渲染 + 内联样式（业务负责人 2026-10-08 批准的第一版就这么定）：
 *   · 手机上打开**越快越好**：一次请求就有完整内容，没有前端构建、没有第二个请求、没有 JS；
 *   · 不改工作台的前端（`public/workbench/**`）：这一页是**独立**的一个小页面，
 *     样式内联在这里，谁都不影响。
 *
 * ⚠️ 这一页是**给她在手机上扫开看的**，所以：
 *   · `viewport` + `max-width: 480px` 居中：手机上不横向滚动、平板上也不会拉成一条；
 *   · 字号按移动端可读性给（正文 16px 起、尺码/数量 17–18px，避免 iOS 自动放大）；
 *   · 表格只有 4 列（尺码 + 三种状态），窄屏也放得下；缺码那一行**整行高亮**，
 *     标记 `⚠️ 缺` 放在**尺码格子里**（设计稿把标记画在行尾，窄屏上第五列会被挤掉）。
 *
 * ⚠️ 所有来自表里的值（编号 / 颜色 / 品类 / 尺码 / 状态）一律 `escapeHtml` ——
 *    这些是**业务数据**，不是可信 HTML。
 */
const { SCAN_PAGE, fillText } = require('../config/scanPage');

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

/**
 * 内联样式。刻意用**系统字体**与**浅色**：与工作台观感一致，且不引外部字体/图片
 * （她那边可能只有移动网络，多一个外链就多一次等待）。
 */
const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: #f4f5f7; color: #1f2329;
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}
.page { max-width: 480px; margin: 0 auto; padding: 12px 12px 28px; }
.card { background: #fff; border-radius: 12px; padding: 14px 16px; margin: 0 0 12px; box-shadow: 0 1px 2px rgba(31, 35, 41, .08); }
.identity { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.identity__item { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: .3px; word-break: break-all; }
.identity__meta { margin: 4px 0 0; color: #646a73; font-size: 15px; word-break: break-all; }
.price { text-align: right; white-space: nowrap; }
.price__label { display: block; color: #8f959e; font-size: 12px; }
.price__value { font-size: 22px; font-weight: 700; }
.stock__heading { margin: 0 0 10px; font-size: 16px; }
.stock { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.stock thead th { padding: 4px 4px 8px; border-bottom: 1px solid #e5e6eb; color: #8f959e; font-size: 13px; font-weight: 500; text-align: center; }
.stock thead th:first-child { text-align: left; }
.stock tbody th { padding: 11px 4px; border-bottom: 1px solid #eef0f3; font-size: 18px; font-weight: 600; text-align: left; width: 34%; }
.stock tbody td { padding: 11px 4px; border-bottom: 1px solid #eef0f3; font-size: 17px; text-align: center; }
.stock tbody tr:last-child th, .stock tbody tr:last-child td { border-bottom: 0; }
.stock td.zero { color: #c9cdd4; }
.stock tr.missing { background: #fff7e6; }
.stock tr.missing th { color: #a8710f; }
.stock tr.missing td.zero { color: #d4b483; }
.badge { display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 9px; background: #ffedd0; color: #a8710f; font-size: 12px; font-weight: 600; vertical-align: 2px; }
.notes { margin: 12px 0 0; padding: 0; list-style: none; color: #8f959e; font-size: 13px; }
.notes li { margin-top: 4px; }
.foot { margin: 4px 2px 0; color: #a9aeb8; font-size: 12px; word-break: break-all; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.state-msg { text-align: center; padding: 36px 16px; }
.state-msg h1 { margin: 0 0 10px; font-size: 20px; }
.state-msg p { margin: 8px 0; color: #646a73; }
.state-msg .number { color: #1f2329; font-weight: 600; }
.state-msg .hint { color: #8f959e; font-size: 13px; }
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

/** 正常页：身份 + 单价 + 库存表。 */
const renderScanPage = (view, config = SCAN_PAGE) => renderDocument({
  title: fillText(config.texts.pageTitle, { itemNo: view.item_no || view.number, number: view.number }),
  config,
  content: `${identityHtml(view, config)}
${stockTableHtml(view, config)}
<p class="foot">${escapeHtml(config.texts.footerNumberLabel)} <span class="mono">${escapeHtml(view.number)}</span>`
  + `${view.updated_at_text ? ` · ${escapeHtml(config.texts.updatedAtLabel)} ${escapeHtml(view.updated_at_text)}` : ''}</p>`,
});

/**
 * 「不是库存表」的那些页（没找到 / 链接不对 / 出错 / 数据准备中 / 超上限）——
 * 一张都不许白屏：标题 + 一句人话 + （有的话）她扫到的编号与我给她的重试建议。
 */
const renderScanMessagePage = ({ title, body, number = '', requestId = '', retryHint = '' }, config = SCAN_PAGE) => renderDocument({
  title,
  config,
  requestId,
  content: `<section class="card state-msg">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(body)}</p>
${number ? `<p>${escapeHtml(config.texts.notFoundHint)}<span class="number mono">${escapeHtml(number)}</span></p>` : ''}
${retryHint ? `<p class="hint">${escapeHtml(retryHint)}</p>` : ''}
</section>`,
});

module.exports = { renderScanPage, renderScanMessagePage, escapeHtml, STYLE };
