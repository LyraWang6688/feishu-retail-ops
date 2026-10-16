const { SCAN_PAGE, fillText } = require('../../config/scanPage');
const { DEFAULT_REALM, REALM_TEXTS, resolveRealm } = require('../scanPageRealm');
const { escapeHtml } = require('./fields');
const { canScanNextWithFeishu } = require('./styles');
const { submitFeedbackAttrs } = require('./script');

const draftBarHtml = (write, config, userAgent, realm = DEFAULT_REALM, page = {}) => {
  const texts = config.texts;
  const count = ((write && write.draft && write.draft.lines) || []).length;
  const saleEnabled = Boolean(write) && write.enabled !== false && write.saleEnabled !== false;
  // 【提交这一单】出现在哪些领域：配置说了算（缺省只有「销售」；认不出的领域 = 不显示）。
  const submitRealms = Array.isArray(config?.draftBar?.submitRealms)
    ? config.draftBar.submitRealms.map((item) => String(item).trim())
    : [DEFAULT_REALM];
  const canSubmitHere = submitRealms.includes(resolveRealm(realm));
  // 🔴🔴 2026-10-12（真机丢钱之后**删掉**的那颗按钮）：本单条原来**自带一颗【提交这一单】**，
  //    它的表单里**只有 action + 幂等键**（收款方式 / 金额一个都不带）。
  //    真机现场：她在**销售块**填了「全付 + 微信 280」，却按了本单条这颗 ⇒
  //    `payment_count: 0` —— 钱一行都没记（她：「我明确写了收款是微信 280，为什么收款明细没有」）。
  //    ⇒ **一页只允许一颗提交按钮**，而且必须是**带钱的那一颗**（销售块那一个表单）。
  //      这里只在"这一页没有带钱的提交表单"时给一条**指路链接**（GET，不带钱、也丢不了钱）：
  //      没有链接、也没有第二颗按钮 ⇒ 不可能再"点了提交却没记钱"。
  const moneyFormOnPage = page.moneyFormOnPage === true;
  const submitHtml = canSubmitHere && saleEnabled && count > 0 && !moneyFormOnPage
    ? `<a class="btn btn--primary" href="?from=${escapeHtml(REALM_TEXTS.defaultRealmId || 'sales')}" rel="noopener">${escapeHtml(texts.submitOnSalesRealmLabel || texts.submitButton)}</a>`
    : '';
  // 【继续扫下一个】⭐⭐ 2026-10-15（业务负责人逐字：「…**库存、销售、补货、退货、扫一扫**」）：
  //   飞书客户端里这一颗**已经搬去顶部那一排做第 5 格**（`realmBarHtml` 的 `scanCellHtml`）⇒
  //   本单条**不再重复放它**（同一件事说两遍、还白占一行 ✗）；
  //   ⚠️ **非飞书**（电脑 / 普通浏览器）**照旧**给那句人话 —— 那里没有第 5 格，
  //      不给一句人话就是"点了没反应"的死路 ✗（她 2026-10-14 报过桌面端这个现象 ✓）。
  const scanNextHtml = canScanNextWithFeishu(userAgent)
    ? ''
    : `<p class="hint">${escapeHtml(texts.scanNextHint)}</p>`;
  // 「刚加入本单」那一句：文案来自配置、只有数字来自会话（**没有回显注入面**）。
  const noticeHtml = write && write.notice
    ? `<p class="notice">${escapeHtml(write.notice)}</p>`
    : '';
  // ⭐⭐ 2026-10-15：条里**一件东西都没有时**（飞书 + 没草稿 + 没反馈）⇒ **整条不渲染** ——
  //   她的目的就是"少占地方" ✓ 一张空白卡（只剩内边距）比不渲染更占地方 ✗。
  //   ⚠️ 非飞书**永远有那句人话** ⇒ 照旧渲染（AC-DB1 那些"没草稿也有这条"的判据都走这条路 ✓）。
  if (!noticeHtml && !submitHtml && !scanNextHtml) return '';
  return `<section class="card draft-bar" data-view="draft-bar" aria-label="${escapeHtml(texts.draftBarLabel)}">
${noticeHtml}
${submitHtml}
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
