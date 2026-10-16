const { fillText } = require('../../config/scanPage');
const { escapeHtml } = require('./fields');
const { cellHtml } = require('./layout');

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
  // ⚠️ 只渲染**有字的**备注：某条备注的文案被删掉（配置里只剩一个空位）时，
  //    绝不留下一个空的 `<li>`（她看到的会是"莫名其妙的一条空行"）。
  const notes = (Array.isArray(view.notes) ? view.notes : []).filter((note) => String(note ?? '').trim());
  const notesHtml = notes.length
    ? `<ul class="notes">${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>`
    : '';
  return `<section class="card">
<h2 class="stock__heading">${escapeHtml(fillText(config.texts.stockHeading, { total: view.total }))}</h2>
<table class="stock">
<thead><tr>${head}</tr></thead>
<tbody>
${rows}
</tbody>
</table>
${notesHtml}
</section>`;
};

/**
 * ⭐ 「**货品**」领域那一块：**打印这一款**（送到店里那台电脑）+ 去标签打印页。
 *
 * ⭐⭐ 2026-10-11（业务负责人：「**扫码页应该是有货品的吧？你不是有六个领域吗？**」）：
 *    扫到某款 ⇒「货品」领域 ⇒【**打印这一款**】—— 点一下把这一款排进**打印队列**，
 *    由店里那台 Windows 电脑（"打印小助手"）出纸。
 *
 * 🔴 **零 JS**（这一页的硬约束）：提交 = 一个**原生表单** `<form method="post">`；
 *    成功后 303 回本领域，**状态由服务端重新渲染**（在线 / 未连接（任务已排队）/
 *    已打印 / 失败 + 原因）。这一页**永远不会**因为脚本没跑而点不动。
 *
 * ⚠️ **每个字都来自配置**：
 *    · 主按钮 / 在线 / 未连接 / 已提交 / 最近一次 —— `page.print.texts`
 *      （= `config/labelPrintQueue.js` 的 `texts`，**唯一真源**，本文件不抄第二份）；
 *    · 动作字段名与动作值 —— `page.print.actionField` / `actionValue`（来自 `config/scanWrite.js`）；
 *    · 回跳地址 —— `page.print.postAction`（路由拼，含 `?from=product`）。
 * ⚠️ `print` 拿不到（队列坏了 / 没接上）**绝不留空白**：退回原来那两条链接 + 一句如实的话。
 */

module.exports = {
  stockTableHtml,
};
