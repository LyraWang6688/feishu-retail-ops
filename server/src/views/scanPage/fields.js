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
const { SCAN_PAGE, MULTI_ITEM_RENDER_TEXTS, fillText } = require('../../config/scanPage');
// ⭐ 2026-10-15（task-23）：退货表单的**默认数量 / 上限**（`defaultQuantity` / `maxQuantity` / `maxSizes`）
//   唯一真源在**写侧**那一份配置里（后端 `parseReturnEntries` 的兜底用的就是它 ✓）——
//   页面**直接读同一份**，不在 `config/scanPage.js` 再抄一遍（抄一份必漂 ✗）。
//   ⚠️ 反向不行：`config/scanWrite.js` **require 了** `config/scanPage.js` ⇒ 在那边 require 这边会成环 ✗。
const { SCAN_WRITE } = require('../../config/scanWrite');
// ⭐ 2026-10-16（**一单多货品 · 渲染半**）：提交载荷的**字段名**与开关走 `config/multiItemOrder.js` ✓
const { MULTI_ITEM_ORDER } = require('../../config/multiItemOrder');
const { NEW_REALM, REALMS, REALM_TABS, DEFAULT_REALM, REALM_TEXTS, REALM_EMPTY_TEXT_KEYS, REPLENISH_REALM, PURCHASE_RETURN_REALM, resolveRealm, labelPrintUrls, saleSizeGroups, purchaseSizeLines, purchaseSizeGroups, foldedSpecialRowsOf, sellableCountOf } = require('../scanPageRealm');
// ⭐⭐ 2026-10-16（task-61 · 领域内扫一扫）：那一段脚本与它要读的配置块（实现见 `scanRealmScan.js`）。
const { realmScanConfigHtml, realmScanScriptSource } = require('../scanRealmScan');

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

module.exports = {
  escapeHtml,
  fs,
  path,
};
