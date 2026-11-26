const { fillText } = require('../../config/scanPage');
const { escapeHtml } = require('./fields');
const { canScanNextWithFeishu } = require('./styles');

/**
 * 本单条（一单多货）：**只报数**（本单 N 双）+ 刚加入时那一句 + 非飞书设备的「再扫下一个」人话。
 *
 * ⛔ 2026-11-26（业务负责人确认删除）：这里原来还有一条`<a href="?from=sales">`的"指路链接"
 *   （2026-10-12 真机丢钱之后，用来替代本单条自带的那颗**不带钱**的提交按钮）。
 *   它从落地那天起就没有任何页面会显示（销售页有真表单 ⇒ 被 moneyFormOnPage 压掉；
 *   其它领域又不在 submitRealms 里），文案键 `submitOnSalesRealmLabel` 也从未配置。
 *   2026-10-27 裸扫默认领域改成库存后，销售页被判成"没有带钱的表单" ⇒ 它变成一个
 *   **整条宽、没有字的蓝色空按钮**（点了只是 GET 回本页）。已按她 2026-11-26 的口径整段删除。
 *   ⇒ **本单条里永远没有按钮/链接**：真正的提交只在销售页那张带钱表单里。
 */
const draftBarHtml = (write, config, userAgent, { linesHtml = '' } = {}) => {
  const texts = config.texts;
  const count = ((write && write.draft && write.draft.lines) || []).length;
  // 【继续扫下一个】⭐⭐ 2026-10-15（业务负责人逐字：「…**库存、销售、补货、退货、扫一扫**」）：
  //   飞书客户端里这一颗**已经搬去顶部那一排做第 5 格**（`realmBarHtml` 的 `scanCellHtml`）⇒
  //   本单条**不再重复放它**（同一件事说两遍、还白占一行 ✗）；
  //   ⚠️ **非飞书**（电脑 / 普通浏览器）**照旧**给那句人话 —— 那里没有第 5 格，
  //      不给一句人话就是"点了没反应"的死路 ✗（她 2026-10-14 报过桌面端这个现象 ✓）。
  const scanNextHtml = canScanNextWithFeishu(userAgent)
    ? ''
    : `<p class="hint">${escapeHtml(texts.scanNextHint)}</p>`;
  // 「本单：N 双」：一单多货时"现在共几双"永远可见（配置文案 `draftBarCount`，唯一真源）。
  const lines = Array.isArray(write?.draft?.lines) ? write.draft.lines : [];
  const countHtml = lines.length
    ? `<p class="draft-bar__count">${escapeHtml(fillText(texts.draftBarCount, { count: lines.length }))}</p>`
    : '';
  // 「刚加入本单」那一句：文案来自配置、只有数字来自会话（**没有回显注入面**）。
  const noticeHtml = write && write.notice
    ? `<p class="notice">${escapeHtml(write.notice)}</p>`
    : '';
  // ⭐⭐ 2026-10-15：条里**一件东西都没有时**（飞书 + 没草稿 + 没反馈）⇒ **整条不渲染** ——
  //   她的目的就是"少占地方" ✓ 一张空白卡（只剩内边距）比不渲染更占地方 ✗。
  //   ⚠️ 非飞书**永远有那句人话** ⇒ 照旧渲染（AC-DB1 那些"没草稿也有这条"的判据都走这条路 ✓）。
  // 2026-11-26（业务负责人）：销售页的「已加的货品」（标题 + 每行金额）搬到这里 ——
  // 原来那个"空白色块"的位置。`linesHtml` 只在销售页有；其它领域传空串。
  if (!countHtml && !noticeHtml && !linesHtml && !scanNextHtml) return '';
  return `<section class="card draft-bar" data-view="draft-bar" aria-label="${escapeHtml(texts.draftBarLabel)}">
${countHtml}
${noticeHtml}
${linesHtml}
${scanNextHtml}
</section>`;
};
/* ⛔ 2026-10-16 22:0x（业务负责人逐字：「**存草稿的功能都删除吧，不需要了，前端和后端都不需要了，
 *    整个链路都删除**」）——
 *    改前逐字：本文件里有 `判断页面上有没有草稿的那一件 / 取草稿入口配置的那一件 / 那颗**存草稿**按钮的渲染函数（名字拆开写，判据扫的是拼起来的那个字面量 ✗）
 *      （那一颗，三处入口共用：`paymentBlock` / `replenishBlock` / `returnBlock`）
 *    改后逐字：**三个函数 ＋ 三处调用点一起退场** ✓（依据 = 她那句「整个链路都删除」✓）
 *    🔴 `draftBarHtml`（**「本单：N 双」＝ 一单多货的本单条**）**保留** ✗ —— 她【要】一单多货 ✓。
 */

module.exports = {
  draftBarHtml,
};
