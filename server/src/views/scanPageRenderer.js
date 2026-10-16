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
const { SCAN_PAGE, MULTI_ITEM_RENDER_TEXTS, fillText } = require('../config/scanPage');
// ⭐ 2026-10-15（task-23）：退货表单的**默认数量 / 上限**（`defaultQuantity` / `maxQuantity` / `maxSizes`）
//   唯一真源在**写侧**那一份配置里（后端 `parseReturnEntries` 的兜底用的就是它 ✓）——
//   页面**直接读同一份**，不在 `config/scanPage.js` 再抄一遍（抄一份必漂 ✗）。
//   ⚠️ 反向不行：`config/scanWrite.js` **require 了** `config/scanPage.js` ⇒ 在那边 require 这边会成环 ✗。
const { SCAN_WRITE } = require('../config/scanWrite');
// ⭐ 2026-10-16（**一单多货品 · 渲染半**）：提交载荷的**字段名**与开关走 `config/multiItemOrder.js` ✓
const { MULTI_ITEM_ORDER } = require('../config/multiItemOrder');
const { NEW_REALM, REALMS, REALM_TABS, DEFAULT_REALM, REALM_TEXTS, REALM_EMPTY_TEXT_KEYS, REPLENISH_REALM, PURCHASE_RETURN_REALM, resolveRealm, labelPrintUrls, saleSizeGroups, purchaseSizeLines, purchaseSizeGroups, foldedSpecialRowsOf, sellableCountOf } = require('./scanPageRealm');
// ⭐⭐ 2026-10-16（task-61 · 领域内扫一扫）：那一段脚本与它要读的配置块（实现见 `scanRealmScan.js`）。
const { realmScanConfigHtml, realmScanScriptSource } = require('./scanRealmScan');

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

/**
 * ⭐ 2026-10-11：**这台设备能不能"点一下直接扫下一个"**（纯函数，供用例钉住）。
 *
 * 为什么是 UA 判据（服务端判、不是前端判）：这一页的硬性设计是"一行前端脚本都没有"
 * （2026-10-09 手机白屏之后定的），所以**不能用 JS 探测能力** —— 只能在服务端按 UA 认。
 *
 * 判据 = **飞书客户端**（`Lark/x` / `Feishu/x`）**且手机端**：
 *   · 飞书客户端 ⇒ 页内 AppLink（`https://applink.feishu.cn/client/qrcode/main`）能调起飞书扫一扫；
 *   · **PC 端不支持扫一扫**（飞书官方文档逐字：「PC端不支持」），飞书**桌面端**的 UA 也带
 *     `Lark/x`，所以必须再判一次移动端关键字（Android / iPhone / HarmonyOS…）；
 *   · 电脑浏览器与手机自带浏览器 ⇒ 不是飞书客户端，页面里**不给按钮**，只给一句
 *     `scanNextHint` 人话（"这里不能扫码：请用飞书的「扫一扫」…"）——
 *     她 2026-10-11 的硬要求：**绝不允许点了没反应**。
 */
const canScanNextWithFeishu = (userAgent) => {
  const ua = String(userAgent || '');
  return /(Lark|Feishu)\//i.test(ua) && /(Android|iPhone|iPad|iPod|HarmonyOS|Mobile)/i.test(ua);
};

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
/* ⭐ 2026-10-12 提交成功页（业务负责人要让"提交成功"一眼看得出）：
   H1 走主色；「再录一单」是一颗**真链接**（a 版的主按钮），下面挂一句轻提示。
   ⚠️ 只有 tone=success / 传了 backPath 时才用得到这几条规则 ⇒ 其它结果页逐字不变。
   ⚠️ "成功"挂在 h1 的 class 上（**不在 section 上加属性/class**）——
   既有的 card state-msg 那一串逐字不变，按它取卡片的断言不受影响。 */
.state-msg__title--success { color: var(--primary); }
.state-msg__mark { margin: 0 0 var(--space-2); font-size: 40px; line-height: 1; }
.state-msg .back-link { margin-top: var(--space-4); }
.state-msg .back-link span { display: block; margin-top: var(--space-1); font-size: var(--font-size-sm); font-weight: 400; opacity: .85; }
.result { margin: var(--space-3) 0 0; padding: 0; list-style: none; color: var(--text); font-size: var(--font-size-base); }
.result li { margin-top: var(--space-1); }
.draft-count { margin: 0 0 var(--space-1); font-size: var(--font-size-base); font-weight: 600; }
.notice { margin: 0; color: var(--primary); font-size: var(--font-size-base); font-weight: 600; }
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
/* ── ⭐⭐ 2026-10-11 销售建单两层结构（每件实收 + 多笔收款）──────────────────
   ① 校验失败原地给她的人话（差额）—— 挂在表单**上方**，她改一下就能再提交；
   ② 收款行 = 方式 + 金额（两栏并排，各自 ≥44px 命中区）；
   ③ 每件实收 = 本单里一行一双、行尾一个输入框。 */
.form-alert { margin: 0 0 var(--space-3); padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); background: var(--warning-soft); color: var(--warning); font-size: var(--font-size-md); font-weight: 600; }
.form-row--pay select { flex: 1 1 55%; }
.form-row--pay input { flex: 1 1 45%; }
/* ⭐⭐ 2026-10-11（最终口径）：「付款情况」（**整单**）三档 ——
   一个 fieldset 里三个 radio，每个都是一整块（≥44px 命中区）；**零 JS**：
   哪一档被选中由浏览器自己提交，服务端按取值分支（见 services/scanWriteService.js）。 */
.pay-status { margin: 0 0 var(--space-2); padding: 0; border: 0; }
.pay-status__legend { padding: 0; margin-bottom: var(--space-1); color: var(--text-secondary); font-size: var(--font-size-md); }
.pay-status__options { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-2); }
.pay-status__option { display: flex; align-items: center; gap: var(--space-2); min-height: var(--control-height); padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); cursor: pointer; }
.pay-status__option input { flex: none; width: 20px; height: 20px; margin: 0; }
.pay-status__label { font-size: var(--font-size-base); font-weight: 600; }
.draft-lines { margin: 0 0 var(--space-2); }
.draft-line { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2); }
.draft-line__text { flex: 1 1 auto; min-width: 0; font-size: var(--font-size-md); overflow-wrap: anywhere; }
.draft-line__amount { flex: 0 0 38%; min-height: var(--control-height); padding: var(--space-2) var(--space-3); border: 1px solid var(--control-border); border-radius: var(--radius-sm); font-size: var(--font-size-base); text-align: right; }
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
/* ── 销售：尺码两组（有货 ⇒ 现货 / 没有 ⇒ 预订）───────────────────────────
   ⭐⭐ 2026-10-11（业务负责人）：**从"一行一码"改成"一行 4 个"** ——
     · 四列网格（repeat(4, minmax(0, 1fr))）：3 个码就排一行 3 个、5 个码排 4+1；
       列宽用 minmax(0, …) ⇒ 窄屏**可压缩、不横向滚动**（她手机上要不横滑）；
     · **不显示数量**（她：「你不用管数量，只要它实时库存表里面有，你显示就行」）
       ⇒ 数量只在「库存」页看，这里只有"能选的码"；
     · 命中区**不缩小**（.size-chip 仍是 ≥44px）——"紧凑"不等于"难点"。
   目标：移动端一屏不下滑就把两组的码看全（所以外框间距也收了一档）。
   ⚠️ 这里在模板字符串里，注释**不许出现反引号**（会提前结束字符串）。 */
.size-group { min-width: 0; margin: 0 0 var(--space-2); padding: var(--space-2); border: 1px solid var(--border-light); border-radius: var(--radius-md); background: var(--surface-soft); }
.size-group__legend { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); padding: 0; font-size: var(--font-size-base); font-weight: 700; }
.size-group .hint { display: block; margin: var(--space-1) 0 var(--space-2); }
/* ⭐ 2026-10-14：特殊码折叠块的**折叠头** —— 与尺码卡同一条命中区口径（≥44px ⇒ 手机上点得到 ✓）。
   收起时"不可见 + 不占布局高度"由浏览器原生 details 保证（**不自己写"藏起来"的规则** ✗）。
   ⚠️ 本段在模板字符串里 ⇒ 注释里**不许出现反引号**（会提前结束字符串）。 */
.size-fold__summary { min-height: var(--control-height); cursor: pointer; list-style: none; }
.size-fold__summary::after { content: '▾'; margin-left: auto; font-size: var(--font-size-lg); color: var(--text-secondary); }
.size-fold[open] .size-fold__summary::after { content: '▴'; }
.size-fold .size-chips { margin-top: var(--space-2); }
.size-chips { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-1); }
.size-chip { display: flex; align-items: center; justify-content: center; gap: var(--space-1); min-width: 0; min-height: var(--control-height); padding: var(--space-1); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); cursor: pointer; }
.size-chip input { flex: none; width: 20px; height: 20px; margin: 0; }
.size-chip__size { font-size: var(--font-size-md); font-weight: 700; white-space: nowrap; }
/* ── 采购：各尺码（样品 + 门盒）数量 + 一键补货 ──────────────────────────── */
/* ⭐ 2026-10-14（她：「尺码×数量 · 一行 3 个 · 多了换行 · 保持一行 3 个」）：
   固定列数（--size-cols 来自配置）+ 每列**平分宽度**（minmax(0, 1fr) ⇒ 内容再长也不撑爆 ⇒ 不会变 2 个 ✗）
   ⚠️ 不用 auto-fit / auto-fill（那会随宽度变 2/4 列 ✗）· 超出自动换行（grid 天生行为 ✓）
   ⚠️ 本段在模板字符串里 ⇒ 注释里**不许出现反引号**（会提前结束字符串）。 */
.purchase-size-grid { display: grid; grid-template-columns: repeat(var(--size-cols, 3), minmax(0, 1fr)); gap: var(--space-2); margin: var(--space-3) 0; padding: 0; list-style: none; }
.purchase-size-cell { min-height: var(--control-height); display: flex; align-items: center; justify-content: space-between; gap: var(--space-1); overflow-wrap: anywhere; padding: var(--space-1) var(--space-2); border: 1px solid var(--border-light); border-radius: var(--radius-sm); background: var(--surface-soft); }
.purchase-size__amount { display: inline-flex; align-items: center; gap: 2px; font-variant-numeric: tabular-nums; }
.purchase-size__times { color: var(--text-muted); }
.size-fold__list { display: grid; grid-template-columns: repeat(var(--size-cols, 3), minmax(0, 1fr)); gap: var(--space-2); margin: var(--space-2) 0 0; padding: 0; list-style: none; }
.size-fold__item { min-height: var(--control-height); display: flex; align-items: center; justify-content: space-between; gap: var(--space-1); padding: var(--space-1) var(--space-2); border: 1px solid var(--border-light); border-radius: var(--radius-sm); background: var(--surface-soft); }
.size-fold__times { color: var(--text-muted); }
.purchase-sizes { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-2); margin: var(--space-3) 0; padding: 0; list-style: none; }
.purchase-size { display: flex; align-items: center; gap: var(--space-2); min-height: var(--control-height); padding: var(--space-2) var(--space-3); border: 1px solid var(--border-light); border-radius: var(--radius-sm); background: var(--surface-soft); }
.purchase-size__size { font-size: var(--font-size-lg); font-weight: 700; }
.purchase-size__count { margin-left: auto; font-size: var(--font-size-amount); font-weight: 700; font-variant-numeric: tabular-nums; }
/* ── ⭐ 2026-10-11「货品」：**打印到店里那台电脑**（表单 POST，零 JS）────────────
   一颗主按钮（.btn 已是整行 + ≥44px 命中区）+ 一行状态徽标 + 最近一次任务那行。
   ⚠️ 这里**没有脚本**：提交是原生表单，状态靠服务端重新渲染（她刷新 / 提交后就能看到）。
   ⚠️ 本段在模板字符串里，注释里**不许出现反引号**（会提前结束字符串）。 */
.label-print-form { margin: var(--space-2) 0 0; }
/* ⭐ 提交后的**显眼横幅**（她上次就是因为"看不出点没点上"才连点几次）：整块底色 + 大一号的字。 */
.label-print-banner { margin: var(--space-2) 0; padding: var(--space-3); border-radius: var(--radius-md); }
.label-print-banner--ok { background: var(--success-soft); border-left: 4px solid var(--success); }
.label-print-banner--dup { background: var(--warning-soft); border-left: 4px solid var(--warning); }
.label-print-banner__title { margin: 0; font-size: var(--font-size-md); font-weight: 700; }
.label-print-banner__note { margin: var(--space-1) 0 0; font-size: var(--font-size-base); }
.label-print-banner .label-print-form { margin-top: var(--space-2); }
.label-print-status { margin: var(--space-2) 0 0; }
.label-print-badge { display: inline-block; padding: var(--space-1) var(--space-2); border-radius: var(--radius-sm); font-size: var(--font-size-base); font-weight: 700; }
.label-print-badge--online { color: var(--surface); background: var(--primary); }
.label-print-badge--offline { color: var(--text-secondary); background: var(--border-light); }
.label-print-job { margin: var(--space-1) 0 0; font-size: var(--font-size-base); color: var(--text-secondary); }
/* ── 领域切换（一个二维码，**六个领域**）────────────────────────────────────
   ⭐⭐ 2026-10-11（业务负责人批准）：六个领域 = 销售 · 补货 · 退货 · 验收 · 库存 · 货品。
   ⚠️ 她要的是「**紧凑两行网格**」⇒ grid 三列 × 两行（6 格正好两行）、
      **不横滑**（去掉原先的 overflow-x: auto + flex: 1 0 auto）、
      每格 min-height: var(--control-height)（既有 ≥44px 的可点高度）。 */
.realm-bar { display: grid; grid-template-columns: 1fr; width: 100%; max-width: 100%; overflow-x: auto; gap: var(--space-1); margin: 0 0 var(--space-2); padding: var(--space-1); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-card); }
.realm-tab { -webkit-tap-highlight-color: rgba(0,0,0,.12); display: flex; align-items: center; justify-content: center; min-height: var(--control-height); min-width: 0; padding: 0 var(--space-2); border-radius: var(--radius-md); color: var(--text-secondary); font-size: var(--font-size-base); font-weight: 600; text-decoration: none; white-space: nowrap; }
/* ── ⭐⭐ 2026-10-12 验收领域「未到货批次」那一块：单列堆叠、不横滑、每行 ≥44px ── */
.batch-list { list-style: none; margin: 0; padding: 0; }
.realm-tab:active, .batch-row:active { opacity: .55; }
.batch-row { -webkit-tap-highlight-color: rgba(0,0,0,.12); display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); text-align: left; font-weight: 600; border: 1px solid var(--primary); }
.batch-row__cta { color: var(--primary); font-weight: var(--weight-bold); font-size: var(--font-size-lg); }
.batch-row__meta { color: var(--text-muted); font-weight: 500; font-size: var(--font-size-sm); }
/* 当前领域那一颗 = 主色（**服务端**决定，不是脚本切 class） */
.realm-tab--active { color: var(--surface); background: var(--primary); }
/* noscript 兜底那一排（webview 禁脚本时才会出现）：朴素的文字链接，不用卡片阴影 */
.realm-bar--plain { display: block; margin: 0; padding: 0; background: transparent; box-shadow: none; }
.realm-bar--plain .realm-link { display: inline-block; margin: 0 var(--space-2) var(--space-1) 0; color: var(--primary); font-size: var(--font-size-base); }
/* ── ⭐ 2026-10-11 本单条（一单多双 · 多次扫码）─────────────────────────────
   每个扫码页（任意领域）**顶部固定一条**：本单几双 + 有草稿才出现的【提交这一单】
   + 【继续扫下一个】。position: sticky 让她**扫到第 3 个码时**也一眼看得到"本单几双、
   去哪提交"（原来【提交这一单】只在她扫第 1 双那一页上）。
   ⚠️ 只有一条 1px 分隔线与一行按钮，不写任何用法说明。 */
.draft-bar { position: sticky; top: 0; z-index: 2; margin: 0 0 var(--space-2); }
.draft-bar__count { margin: 0 0 var(--space-2); font-size: var(--font-size-lg); font-weight: 700; font-variant-numeric: tabular-nums; }
.draft-bar .notice { margin: 0 0 var(--space-2); }
.draft-bar .btn { margin-top: 0; }
.draft-bar .btn + .btn, .draft-bar .write-form + .btn { margin-top: var(--space-2); }
`;

/**
 * 2026-10-13 (whole-order payment step): the step-2 block's own styles.
 * Kept as a **separate** literal on purpose: the big `STYLE` template above must stay
 * byte-identical (the hardcoded-Chinese gate extracts that whole literal as one string,
 * so touching it - even with ASCII - reads as a "new" entry). ASCII-only here.
 */
/**
 * 2026-10-13: realm tab bar must never overlap its labels.
 *   The base `.realm-tab` rule above sets `white-space: nowrap` inside a 3-column
 *   equal-width grid; on a narrow phone the columns get squeezed and two labels
 *   ("inventory" + "label") render on top of each other.
 *   Fix by overriding here (ASCII only, and the big STYLE literal above stays
 *   byte-identical - the hardcoded-Chinese gate reads that whole literal).
 *   Layout stays the three-by-three she asked for; wrapping is allowed so a label
 *   is always fully readable, and the 44px touch height is untouched.
 */
// 2026-10-14: the skeleton screen is ONE centered card with a single line --
//   her words: a card centered horizontally and vertically, showing the loading copy.
//   Copy comes from config (`texts.skeletonLoading`), nothing hardcoded here.
const SKELETON_STYLE = `
.skeleton-stage { display: flex; align-items: center; justify-content: center; min-height: 70vh; padding: var(--space-4); }
.skeleton-card { width: 100%; max-width: 320px; text-align: center; font-size: var(--font-size-lg); font-weight: 600; color: var(--text-secondary); }
.skeleton-retry { margin-top: var(--space-3); min-height: var(--control-height); padding: 0 var(--space-4); border: 1px solid var(--control-border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text-primary); font-size: var(--font-size-base); font-weight: 600; }`;
const REALM_BAR_STYLE = `.realm-tab { white-space: nowrap; font-size: var(--font-size-sm); padding: 0 2px;
  overflow: hidden; text-overflow: clip; letter-spacing: 0; min-width: 0; text-align: center; }
.realm-bar { grid-auto-rows: minmax(var(--control-height), auto); }`;

/** 第 5 格「扫一扫」的内部标记（不是领域 ⇒ 不与 `REALM_TABS` 的对象混用 ✓）。 */
const SCAN_TAB_MARKER = Symbol('scan-tab');

const PAYMENT_STEP_STYLE = `.pay-status__options { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.pay-status__option { display: flex; align-items: center; justify-content: center; gap: 4px;
  border: 1px solid #d9d9d9; border-radius: 8px; padding: 8px 4px; font-size: 14px; }
.payment-step { display: flex; flex-direction: column; gap: 8px; margin: 10px 0; }`;

const renderDocument = ({ title, content, requestId, config = SCAN_PAGE, head = '' }) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
${head}
<style>${STYLE}${PAYMENT_STEP_STYLE}${REALM_BAR_STYLE}${SKELETON_STYLE}</style>
</head>
<body>
<main class="page">
${content}
</main>
${requestId ? `<p class="foot">${escapeHtml(config.texts.requestIdLabel)} <span class="mono">${escapeHtml(requestId)}</span></p>` : ''}
${content.includes('data-submit-feedback=') ? submitFeedbackScriptHtml() : ''}${content.includes('data-view="realm-scan-config"') ? `\n${realmScanScriptTagHtml()}` : ''}
${annotateScriptHtml()}
</body>
</html>
`;

/** 一行的数量格：有货给数字（加粗），0 给破折号。 */
const cellHtml = (count, config) => (count > 0
  ? `<td>${escapeHtml(count)}</td>`
  : `<td class="zero">${escapeHtml(config.texts.zero)}</td>`);

/**
 * ⭐⭐ 2026-10-14 晚（业务负责人逐字）：
 *   「`category_name` ⇒ **品类**（类别表名字）· `category_code` ⇒ **类别**（货品表原值），
 *    **两个都显示**，**有就显示，没有就不显示**」＋「需要做个映射，**A 等于男，B 等于女**」
 *
 * ⭐ 映射**复用既有那一份配置**（`sizeSegments.ranges[code].label` ✓ 那里本来就是 A⇒男 / B⇒女 ✓）——
 *   **不新造映射表** ✗ · **不散写 if** ✗（她定了"配置先行"✓）
 * ⚠️ 认不出的类别码 ⇒ **原样显示那个码**（**不猜** ✗ 不吞 ✗）
 */
const categoryLabelOf = (code, config) => {
  const key = String(code || '').trim().toUpperCase();
  if (!key) return '';
  const ranges = (config && config.sizeSegments && config.sizeSegments.ranges) || {};
  return String(ranges[key] && ranges[key].label ? ranges[key].label : '').trim();
};

const identityHtml = (view, config) => {
  // ⭐ 三段：颜色 · **品类**（category_name）· **类别**（category_code ⇒ 映射成 男/女，认不出就原样）
  const categoryLabel = categoryLabelOf(view.category_code, config) || view.category_code;
  const meta = [view.color, view.category_name, categoryLabel]
    .filter(Boolean)
    .join(config.texts.identitySeparator);
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
 * ⭐ 领域切换条（顶部）：**六个领域**各一条**真链接**（`?from=<id>`；3 列 × 2 行、不横滑）。
 *
 * 🔴 当前领域那一颗的高亮是**服务端**决定的（`realm-tab--active` + `aria-current="page"`），
 *    不是脚本在浏览器里切 class —— 没 JS 也完全正确。
 * 领域顺序 / 名字全部来自 `views/scanPageRealm.js`（加减领域只改那个文件）。
 */
/**
 * ⭐⭐ 2026-10-15（业务负责人逐字）：「…**我希望我们的排序可以改下，库存、销售、补货、退货、扫一扫**。默认还是销售页。」
 *   ⇒ 上条的**显示顺序**由 `SCAN_PAGE.realmBar.order` 定（**配置先行** ✓）：
 *     `scanPageRealm.js` 只回答「**有哪些领域**」（成员唯一真源 ✓），"先摆哪个"是**视图参数** ⇒ 放配置里。
 *   ⚠️ **兜底（不静默丢格 ✗）**：配置缺失 / 与 `REALM_TABS` **不是同一个集合** ⇒ 回落 `REALM_TABS`
 *      自己的顺序（宁可顺序旧，也不能少一格/多一格 ✗）。
 */
const orderedRealmTabs = () => {
  const configured = (SCAN_PAGE.realmBar && SCAN_PAGE.realmBar.order) || [];
  const ids = REALM_TABS.map((item) => item.id);
  const picked = configured.map(String).filter((id) => ids.includes(id));
  if (picked.length !== ids.length || new Set(picked).size !== ids.length) return REALM_TABS;
  return picked.map((id) => REALM_TABS.find((item) => item.id === id));
};

/** 第 5 格：「扫一扫」（AppLink；**只在调得起来的设备上出现** —— 文案来自配置 ✓）。 */
const scanCellHtml = () => `<a class="realm-tab realm-tab--scan" data-realm-id="scan" href="${escapeHtml(SCAN_PAGE.scanNext.applink)}" rel="noopener">${escapeHtml((SCAN_PAGE.realmBar && SCAN_PAGE.realmBar.scanLabel) || SCAN_PAGE.texts.scanNextLabel)}</a>`;

const realmBarHtml = (realm = DEFAULT_REALM, userAgent = '') => {
  // ⭐⭐ 2026-10-15（现状，改了就要同步这里）：**一整排** = 4 个领域（顺序见上面的 `orderedRealmTabs`）
  //   ＋（只有飞书客户端）第 5 格「扫一扫」；列数 = 格数 ⇒ 铺满整宽、手机上不需要横滑 ✓
  //   ⚠️ 2026-10-13 那个"两行三列 / 标签·上新·配品"的版式**已经不存在了**（配品搬去工作台、
  //      上新与标签不上条 ⇒ 见 `scanPageRealm.js` 的沿革）—— 别再照那句话理解本函数 ✗
  const tabHtml = (item) => {
    if (item.external === true) {
      return `<a class="realm-tab" data-realm-id="${escapeHtml(item.id)}" href="${escapeHtml(SCAN_PAGE.realmBar.newFormUrl)}" target="_blank" rel="noopener">${escapeHtml(item.label)}</a>`;
    }
    const active = item.id === realm;
    return `<a class="realm-tab${active ? ' realm-tab--active' : ''}" data-realm-id="${escapeHtml(item.id)}" href="?from=${escapeHtml(item.id)}"${active ? ' aria-current="page"' : ''} data-tap-target="realm:${escapeHtml(item.id)}" data-open-label="${escapeHtml(SCAN_PAGE.tapFeedback && SCAN_PAGE.tapFeedback.label || '')}">${escapeHtml(item.label)}</a>`;
  };
  // ⭐⭐ 2026-10-14（她：「6 个领域……**没有铺满屏幕的水平方向**……最后一格被截」）：
  //   真因：**容器 `.realm-bar` 自己是 3 列网格**，里面却塞了**两个** `.realm-row`
  //   ⇒ 每个 row 只占容器宽的 1/3，右边那一列空着 ✗（看起来就是"没铺满 + 最后一格像被截"）
  //   ⇒ 现在：容器**一整列**（每个 row 占满整宽 ✓）＋ **一行六格**、六列等分（`minmax(0,1fr)` ✓）
  //     每格 `min-width: 0`（长文案不会撑宽自己 ⇒ 不会把最后一格挤出去 ✗）；窄屏交给 `overflow-x: auto` ✓
  // ⭐⭐ 2026-10-15：列数 = **实际格数**（4 个领域，飞书客户端再加「扫一扫」这第 5 格）——
  //   改前逐字：`repeat(6, minmax(0,1fr))`（固定 6 列 ⇒ 4 格时右边空两列 ✗ 看着"没铺满"）
  //   改后逐字：`repeat(${cells.length}, minmax(0,1fr))` ⇒ **整排铺满、等分**，手机上**不需要横滑** ✓
  //   ⚠️ `minmax(0,1fr)` 与每格 `min-width: 0`（见 `REALM_BAR_STYLE`）一起保证长文案不撑宽 ✗
  const row = (htmlCells) => `<div class="realm-row" style="display:grid;grid-template-columns:repeat(${htmlCells.length},minmax(0,1fr));width:100%;gap:8px">${htmlCells.join('')}</div>`;
  // 第 5 格只在**能调起飞书扫一扫**的设备上出现（电脑 / 普通浏览器不给假按钮 ✗ —— 那里照旧由
  // 本单条的 `scanNextHint` 说人话 ✓，见 `draftBarHtml`）。
  const cells = orderedRealmTabs().slice();
  const scanTab = canScanNextWithFeishu(userAgent);
  if (scanTab) cells.push(SCAN_TAB_MARKER);
  const rendered = cells.map((item) => (item === SCAN_TAB_MARKER ? scanCellHtml() : tabHtml(item)));
  return `<nav class="realm-bar" aria-label="${escapeHtml(REALM_TEXTS.barLabel)}">
${row(rendered)}
</nav>`;
};

/**
 * `<noscript>` 兜底：把四条领域链接**再给一遍**（**只给能点的，不解释怎么用**）。
 *
 * ⚠️ 这一页**本来就不需要 JavaScript**（切换条是真链接、服务端只渲染当前那一块），
 *    所以这一段不是"页面能不能用"的前提，而是"万一 webview 禁脚本/样式被裁掉"的保险带
 *    —— 她的第一要求是"**手机上无论如何都要有看得见的东西**"。
 * ⭐ 2026-10-10：原来那句「本页不需要 JavaScript；点下面的领域换个用法：」是**说明书**，删掉；
 *    四条领域链接（能点的）一个字不动。
 */
const noScriptHtml = () => `<noscript>
<nav class="realm-bar realm-bar--plain" aria-label="${escapeHtml(REALM_TEXTS.barLabel)}">
${orderedRealmTabs().map((realm) => (realm.external === true
  ? `<a class="realm-link" href="${escapeHtml(SCAN_PAGE.realmBar.newFormUrl)}" target="_blank" rel="noopener">${escapeHtml(realm.label)}</a>`
  : `<a class="realm-link" href="?from=${escapeHtml(realm.id)}">${escapeHtml(realm.label)}</a>`)).join('\n')}
</nav>
</noscript>`;

/**
 * ⭐⭐ 2026-10-11「**本单条**」—— 每个扫码页（**任意领域**）顶部固定的一条。
 *
 * 她的原话（逐字）：
 *   「因为比如说我们在**扫码页卖了多双鞋**的时候，怎么可以**一双订单多次扫码**呢？」
 * 要解决的三个缺口（都是真机上的真麻烦）：
 *   ① 加完本单**没有"继续扫下一个"的入口** ⇒ 要退回去再扫，容易漏扫 / 忘了提交；
 *   ② **看不到"本单已经有几双"**；
 *   ③ 扫到第 3 个码时，【提交这一单】在**第 1 个码那一页**上 ⇒ 得回去找。
 * ⇒ 这一条把 ①②③ 一次解决：`本单：N 双`（从扫码会话实时读，**跨编号共用**）
 *   ＋（**有草稿才出现**）【提交这一单】＋【继续扫下一个】。
 *
 * 硬约束（她 2026-10-10 / 2026-10-11）：
 *   · **不留说明书**：只有"能点、能做的事" + 状态（几双 / 已加入本单那一句；
 *     加单反馈见 `config/scanWrite.js` 的 `lineAddedBanner`，**极简**）；
 *   · **没有草稿时不要显示成灰按钮** ⇒ `count > 0` 才渲染【提交这一单】那一个表单；
 *   · 【继续扫下一个】**能调就真能调**（飞书客户端内 = AppLink 打开扫一扫），
 *     调不了就**明说人话**（`scanNextHint`），**绝不给点了没反应的按钮**；
 *     判据在 `canScanNextWithFeishu`（服务端看 UA，页面上依然零 JS）。
 *
 * ⚠️ 提交表单里只带 `action=submit_order` + 幂等键：收款方式 / 金额**都不带** ——
 *    留空 = 既有口径的"先货后钱"（`scanWriteService.submitSale` 里
 *    `payments = []`），首页那一颗只是想让她**不必回到第 1 双那一页**去提交。
 *    要记钱仍然回到【销售】那一块的表单填（那里有收款方式 / 金额）。
 *
 * ⭐⭐ 2026-10-11（业务负责人定的，**改写了一条旧断言**）：「**提交这一单只在销售页显示**」
 *    —— 本单条在**每个领域**都有（`本单：N 双` ＋【继续扫下一个】），
 *    但那颗**提交按钮只在她点名的领域**里出现（取值在 `config/scanPage.js` 的 `draftBar.submitRealms`，
 *    渲染层**不写死 `'sales'`**）。
 *    ⚠️ 这一条推翻了 2026-10-11 上午那条旧断言（`scanPageDraftBar.test.js` 的 AC-DB7：
 *       「有草稿 ⇒ **库存页上也能提交**」）—— 口径变了，断言按新口径改写，理由逐字写在报告里。
 */
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

/**
 * ⭐⭐ 2026-10-16（task-S2 ·「**存草稿 · 接着录**」· **渲染半**）—— 两块 UI：
 *   ① **三处入口**：销售货品页 / 补货页 / 退货页各一颗「**存报货草稿**」（她点名的是销售页那颗）；
 *   ② **「你有一份草稿，接着录吗？」提示条**（她先前定的"进去就提示、接着录"）。
 *
 * 她的口径（逐字）与**不许自己定**的那一条：
 *   · 「我们的**销售货品页上面也需要加一个按钮**，叫「**存报货草稿**」」← **只有这一颗被她点名**；
 *   · 「我们的**补货和退货需要支持存草稿**功能」；
 *   · ⚠️ 补货页 / 退货页那两颗**她没点名** ✗ ⇒ 本刀**三处共用同一句文案**（配置 `SCAN_PAGE.draftEntry`），
 *     **不自己另起名字** ✗ —— 来源如实登记在 `config/scanPage.js` 的 `resolveDraftEntryConfig` ✓。
 *
 * 🔴 **零回归的物理保证**（`AC-D2e`）：两块都只在 `page.draft.enabled === true` 时才**可能**出字节；
 *   **今天所有调用方都不传 `page.draft`**（路由那半步 = S3）⇒ 本函数返回**空串** ⇒
 *   渲染结果与改动前**逐字相同** ✓（既有那几十条页面判据一条都不用改 ✓）。
 *   ⚠️ **没有草稿**（`hasDraft !== true`）⇒ **提示条一个字都不出** ✓（塞进提示条 ⇒ `AC-D2e` 红 ✓）。
 *
 * ⚠️ 这一块**没有一行 JS**：入口是**同一张表单里的第二颗 submit**（原生，带得走她刚填的尺码/数量）；
 *   【接着录】是一颗**真链接**（同一路径 + `?resume=1`，查询键走配置 ✓）。
 *   🔴 **如实标「待接线」**：【接着录】那一下要**路由**（S3）读 `?resume=1` 才真的接着录 ——
 *     本刀**不碰 `routes/**`** ✗ ⇒ 渲染层已按配置画好链接与查询键，**路由那一步在 S3** ✓。
 */
const draftUiOf = (page) => {
  const draft = page && page.draft;
  if (!draft || draft.enabled !== true) return null; // 缺省（今天所有调用方）⇒ 一个字节都不出 ✓
  return draft;
};

/** 草稿那一块的配置（**优先用传进来的那一份** ⇒ 用例可以拿一份改过的 config 直接钉"改配置即改文案" ✓）。 */
const draftEntryConfigOf = (config) => (config && config.draftEntry) || SCAN_PAGE.draftEntry || {};

/**
 * 「存报货草稿」那一颗（**三处入口共用这一个渲染点** ⇒ 形状只有一份，不会三处各写一遍 ✗）。
 *   · 落在**既有那张表单里**（`write.fields.action` 是既有字段名 ⇒ 不新造隐藏字段 ✓）；
 *   · 提交的值 = 配置里的 `saveAction`（**路由 S3 按它分派**；今天还没有接住者 = **待接线** ✓）。
 */
const draftSaveButtonHtml = (write, realm, config, page) => {
  if (!draftUiOf(page)) return '';
  if (!write || write.enabled === false) return '';
  const cfg = draftEntryConfigOf(config);
  const realms = Array.isArray(cfg.realms) ? cfg.realms.map((item) => String(item).trim()) : [];
  // 认不出的领域 ⇒ 那一页**不显示**（绝不猜 ✗）；取值必须是 `scanPageRealm.js` 的 `REALMS[].id`
  if (!realms.includes(resolveRealm(realm))) return '';
  const fields = write.fields || {};
  return `<button data-draft-save="1" type="submit" class="btn" name="${escapeHtml(fields.action)}" value="${escapeHtml(cfg.saveAction || '')}"${submitFeedbackAttrs(write)}>${escapeHtml(cfg.saveLabel || '')}</button>`;
};

/**
 * 「你有一份草稿，接着录吗？」那一条。
 *   · **只有真的有草稿才出** ✓（`page.draft.hasDraft === true`；路由用 S1 的 `readDraft` 判定 ✓）；
 *   · 数字（几个货品 / 几行）**只有路由喂了才写** —— 拿不到就**不写**（**不编 0** ✗）；
 *   · 【接着录】= 真链接（`?from=<当前领域>&<resumeQueryKey>=<resumeQueryValue>`）；
 *     ⚠️ **不点它 = 正常新建** ✓（页面上别的东西一个字都不动 ⇒ 她的零回归 ✓）。
 */
const draftNoticeHtml = (realm, config, page) => {
  const draft = draftUiOf(page);
  if (!draft || draft.hasDraft !== true) return '';
  const cfg = draftEntryConfigOf(config);
  const products = Number(draft.productCount) > 0 ? Number(draft.productCount) : 0;
  const lines = Number(draft.lineCount) > 0 ? Number(draft.lineCount) : 0;
  const meta = (products || lines)
    ? `<p class="hint" data-view="draft-notice-meta">${escapeHtml(fillText(cfg.noticeMeta || '', {
      products, lines, updatedAt: String(draft.updatedAt || ''),
    }))}</p>`
    : '';
  const queryKey = String(cfg.resumeQueryKey || 'resume');
  const queryValue = String(cfg.resumeQueryValue ?? '1');
  const href = `?from=${escapeHtml(resolveRealm(realm))}`
    + `&${encodeURIComponent(queryKey)}=${encodeURIComponent(queryValue)}`;
  return `<section class="card draft-notice" data-view="draft-notice">
<p class="notice">${escapeHtml(cfg.noticeLabel || '')}</p>
${meta}
<a class="btn" data-draft-resume="1" href="${href}">${escapeHtml(cfg.resumeLabel || '')}</a>
</section>`;
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
const labelBlockHtml = (view, print = null) => {
  const urls = labelPrintUrls(view);
  const heading = `<h2 class="stock__heading">${escapeHtml(REALM_TEXTS.labelHeading)}</h2>`;
  const batchLink = `<a class="btn" href="${escapeHtml(urls.batch)}" rel="noopener">${escapeHtml(REALM_TEXTS.labelBatchButton)}</a>`;
  const pageLink = `<a class="btn btn--ghost" href="${escapeHtml(urls.single)}" rel="noopener">${escapeHtml(REALM_TEXTS.labelSingleButton)}</a>`;

  // `print` 没给（渲染层被单独调用 / 这条链路还没接上）⇒ **退回改动前那一块**：只有那两条链接。
  if (!print) {
    return `<section class="card">
${heading}
${batchLink}
${pageLink}
</section>`;
  }

  const texts = print.texts || {};
  // 打印服务不可用（队列坏了 / 明确关掉）⇒ 如实说一句 + 仍然让她能去标签打印页，**绝不留空白**。
  if (print.enabled === false) {
    const notice = texts.unavailable
      ? `<p class="hint">${escapeHtml(texts.unavailable)}</p>`
      : '';
    return `<section class="card">
${heading}
${notice}
${batchLink}
${pageLink}
</section>`;
  }

  const job = print.job || null;
  const bannerJob = print.banner_job || null;
  const statusText = print.online ? texts.online : texts.offline;
  const badgeClass = print.online ? 'label-print-badge--online' : 'label-print-badge--offline';
  const filled = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  ));
  /**
   * ⭐⭐ 2026-10-11 真机反馈（「点完没有反馈 ⇒ 她以为没点上、连点几次 ⇒ 多打了好几张」）之后
   * 加的**显眼横幅**（放在这一块最上面，她一眼就看见，不是在"最近一次"那种小字里）：
   *   · 刚提交成功（`?printed=1`）⇒ 绿条：**已发送给打印电脑：本次 N 张** +
   *     在线/未连接（在线⇒马上打 / 未连接⇒已排队自动补打）+ **已提交，不用重复点**；
   *   · 命中去重（`?dup=1`）⇒ 黄条：**刚刚已经发过一次：本次 N 张（没有重复提交）** +
   *     一句"确实要再打一张" + **【再打一张】** 按钮（`again=1`，**绕过**去重窗口）——
   *     她的正当重复打印需求**不许被锁死**。
   * ⚠️ `N` 从**那条任务上读**（`banner_job.total_labels`），不是页面上猜的。
   * ⚠️ 仍然**零 JS**：横幅是服务端拼的静态 HTML，【再打一张】是一个小表单。
   */
  const count = Number(bannerJob?.total_labels ?? job?.total_labels ?? 0);
  // ⚠️ 「刚提交成功」那条横幅只在**读到那条任务**（`count > 0`；生产上永远读得到）时才出 ——
  //    宁可不出，也不给她一句"本次 0 张"那种假话。
  const showSubmitted = print.submitted && count > 0;
  const banner = print.duplicated
    ? `<div class="label-print-banner label-print-banner--dup">
<p class="label-print-banner__title">${escapeHtml(filled(texts.duplicatedBanner, { count }))}</p>
<p class="label-print-banner__note">${escapeHtml(texts.duplicatedHint || '')}</p>
<form class="label-print-form" method="post" action="${escapeHtml(print.postAction)}" data-submit-feedback-elapsed="${escapeHtml(texts.submitSubmittingElapsedForPrint || texts.printSubmitting || '')}">
<input type="hidden" name="${escapeHtml(print.actionField)}" value="${escapeHtml(print.actionValue)}">
<input type="hidden" name="${escapeHtml(print.againField || 'again')}" value="1">
<button class="btn" type="submit" data-submit-feedback="${escapeHtml(texts.printSubmitting || '')}">${escapeHtml(texts.printAgain || '再打一张')}</button>
</form>
</div>`
    : (showSubmitted
      ? `<div class="label-print-banner label-print-banner--ok">
<p class="label-print-banner__title">${escapeHtml(filled(texts.submittedBanner, { count }))}</p>
<p class="label-print-banner__note">${escapeHtml(print.online
        ? (texts.submittedOnline || statusText)
        : (texts.submittedOffline || statusText))}</p>
<p class="label-print-banner__note">${escapeHtml(texts.submittedNoRepeat || '')}</p>
${print.queue_position && texts.submittedQueueNote
    ? `<p class="label-print-banner__note" data-view="print-queue-position">${escapeHtml(filled(texts.submittedQueueNote, { position: print.queue_position }))}</p>`
    : ''}
</div>`
      : '');
  // 「最近一次：<状态>」+（失败时）原因 —— 她要"失败要给原因"，所以原因**同一行看得见**。
  const jobLine = job
    ? `<p class="label-print-job">${escapeHtml(`${texts.lastJobPrefix || ''}${job.status_label || job.status}`)}${job.status === 'failed' && job.failure_reason ? ` — ${escapeHtml(job.failure_reason)}` : ''}</p>`
    : '';
  return `<section class="card">
${heading}
${banner}
<form class="label-print-form" method="post" action="${escapeHtml(print.postAction)}">
<input type="hidden" name="${escapeHtml(print.actionField)}" value="${escapeHtml(print.actionValue)}">
<button class="btn btn--primary" type="submit" data-submit-feedback="${escapeHtml(texts.printSubmitting || '')}">${escapeHtml(texts.printSingle || REALM_TEXTS.labelHeading)}</button>
</form>
<p class="label-print-status"><span class="label-print-badge ${badgeClass}">${escapeHtml(statusText || '')}</span></p>
${jobLine}
${batchLink}
${pageLink}
</section>`;
};

/**
 * ⭐⭐ 2026-10-12（业务负责人真机反馈，逐字）：「点完之后**没有 Toast、按键置灰**之类的提示，
 *   页面完全没有及时的交互反馈 ⇒ 我不知道指令到底有没有到达，**就会一直狂点**」。
 *
 * 🔴 这是这一页**唯一**的一段 JS（她明确要"置灰"，而"置灰"没有零 JS 的等价物）：
 *   · 只做一件事：**提交时把按钮置灰 + 换成「正在下发…」**（文案从 `data-submitting` 读，配置给的）；
 *   · 不发任何请求、不碰 DOM 别的部分、不依赖任何框架/构建产物；
 *   · ⚠️ 它**只在「货品」领域**（打印表单所在的那一块）出现 —— 其余五个领域**照旧一行脚本都没有**；
 *   · 退一步：脚本没跑（webview 禁 JS）也**不影响功能** —— 表单照旧是原生提交，
 *     只是少了"按钮立刻置灰"这一层；服务端那两道（短窗去重 + 结果横幅）仍然在。
 */
const submitSubmittingText = (write) => String(write?.texts?.submitSubmitting || '');
const submitSubmittingElapsedText = (write) => String(write?.texts?.submitSubmittingElapsed || '');

/**
 * ⭐⭐ 2026-10-13（她：「领域/批次**要点 4、5 次**才切换、跳转」+「我想查我点了几次」）：
 *  点**会跳转 / 会写数据**的东西 ⇒ 立刻给反应（换文案 + 置灰 + 防重复点 ✓）并上报一条 `ui.tap`。
 *  ⚠️ 全在**同一段脚本**里（别新增第二段 ✗ —— 有哨兵钉着"整页只有一段脚本"）；
 *  ⚠️ 脚本**模板串内只写 ASCII 注释**（写中文会让硬编码中文闸门多一条假增量 ✗ 我踩过）；
 *  ⚠️ 上报用 `navigator.sendBeacon`（不阻塞跳转 ✓ 失败静默 ✓），**只带 target/page**（不采集表单值 ✗）。
 */
/**
 * ⭐⭐ 2026-10-14 晚（埋点 P0 ⑤「工作台接同一套上报」）：**同一份客户端实现**。
 *
 * 扫码页这一页的硬约束是**只有一段脚本**（`<script data-view="submit-feedback">`，有哨兵钉着；
 * 她 2026-10-09 白屏之后定的）⇒ 不能 `src=` 引外部文件 ✗。
 * ⇒ 做法：把 `public/workbench/shared/ui-tap.js`（工作台用 `<script src>` 加载的**同一个文件**）
 *   在渲染时**内联**进这一段里 —— **一份实现、两种装载方式**（绝不各抄一份 ✗）。
 * ⚠️ 文件读不到 ⇒ **当场抛**（不静默降级：页面里的脚本会引用一个不存在的全局，
 *   那比启动就报错难查得多）；⚠️ 那个文件必须是 **ASCII**（本段模板有硬编码中文闸门）。
 */
const UI_TAP_SHARED_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'workbench', 'shared', 'ui-tap.js'), 'utf8',
);

/**
 * ⭐⭐ 2026-10-16 业务负责人亲口点的功能（逐字）：
 *   「我在**页面上**加一个小开关：你打开后，**点页面上的哪一块，那一块就高亮**，
 *     并弹出它的**名字**（比如"退货折叠条"/"整单金额输入框"）⇒ 你截给我，我就**不用猜**了」
 *   她选的范围（逐字）：**扫码页 + 工作台都做** ✓
 *
 * 做法：**同一份实现、两种装载方式**（与上面 `ui-tap.js` 完全同一条口径 ✓）——
 *   · 扫码页：渲染时把这个文件**内联**进 `<script data-view="annotate">`（这一页不引外部资源）；
 *   · 工作台：`index.html` 里 `<script src="/workbench/shared/annotate.js" defer>` 引**同一个文件**。
 *   ⚠️ 两处**绝不各抄一份**：`test/pageAnnotate.test.js` 钉住"内联的 == 那个文件"逐字一致 ✓
 *
 * 🔴 **只在 `?annotate=1` 时才出现**（真实用户看不到 ✓）：
 *   这一段**开头就判**（`location.search` 里有没有 `annotate=1`），没有就**立刻早退** ——
 *   不建任何 DOM、不绑任何监听、不动任何表单。所以不带参数时这一页**运行时逐字无痕** ✓
 *   （⚠️ 不带参数时**输出里**确实多这一行脚本标签：查询串只有 `routes/scanPage.js` 拿得到，
 *     而那个文件不在本任务写作用域内 ⇒ 闸门只能落在脚本内部。成对迁移的哨兵见下。）
 *
 * ⚠️ **零 JS 哨兵的成对迁移**（`AC-W2` / `AC-6R5`）：
 *   「扫码页一行 `<script>` 都不许有」是**我方（agent 侧）**的约束，**不是她的口径** ——
 *   她 2026-10-12 两次纠正：「我可没有说过，**我们是能够进行动态交互的**」。
 *   ⇒ 那两条哨兵按"**改前逐字 → 改后逐字 → 依据 = 她 2026-10-12 逐字**"成对迁移为
 *     「**不带 `?annotate=1` 时那一页仍然是零业务脚本；那一段标注脚本必须开头早退**」✓
 */
const ANNOTATE_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'workbench', 'shared', 'annotate.js'), 'utf8',
);

/** 标注脚本（**只在 `?annotate=1` 时才会做任何事** —— 见上面注释与 `shared/annotate.js` 的文件头）。 */
const annotateScriptHtml = () => `<script data-view="annotate">
${ANNOTATE_SOURCE}</script>`;

const submitFeedbackScriptHtml = () => `<script data-view="submit-feedback">
${UI_TAP_SHARED_SOURCE}
(function () {
  var forms = document.querySelectorAll('form');
  for (var i = 0; i < forms.length; i += 1) {
    forms[i].addEventListener('submit', function (event) {
      var button = event.target.querySelector('button[type="submit"]');
      if (!button || button.disabled) return;
      var form = event.target;
      // 2026-10-12: her words -- "tapping seems to do nothing, so I keep tapping".
      //    The button label must never become empty: with no attribute configured, fall back to the button's own text.
      var label = button.getAttribute('data-submit-feedback') || form.getAttribute('data-submit-feedback') || button.textContent;
      var elapsedTemplate = button.getAttribute('data-submitting-elapsed')
        || form.getAttribute('data-submit-feedback-elapsed') || '';
      // Amount is required (>0): tapping always gives feedback -- empty/zero shows a hint and sends no request.
      //    Field name and hint text live on THIS form (no hardcoded Chinese into the script).
      var amountName = form.getAttribute('data-amount-field') || '';
      var amountInput = amountName ? form.querySelector('[name="' + amountName + '"]') : null;
      if (amountInput) {
        var amountValue = parseFloat(String(amountInput.value || '').replace(/[^0-9.]/g, ''));
        if (!(amountValue > 0)) {
          event.preventDefault();
          var hintView = 'accept-amount-required';
          var hintText = form.getAttribute('data-amount-hint-text') || '';
          var hint = hintView ? form.querySelector('[data-view="' + hintView + '"]') : null;
          if (!hint && hintView) {
            hint = document.createElement('p');
            hint.className = 'hint';
            hint.setAttribute('data-view', hintView);
            form.insertBefore(hint, form.firstChild);
          }
          if (hint) { hint.textContent = hintText; hint.removeAttribute('hidden'); }
          amountInput.focus();
          return;
        }
      }
      // Return form: she taps the button with nothing checked, or with a quantity that is not a positive
      //    integer. Field names / limits / all wording live on THIS form as data-* attributes
      //    (no field-name concatenation and no user-visible text inside this script).
      var returnSizesField = form.getAttribute('data-return-sizes-field') || '';
      if (returnSizesField) {
        var boxes = form.querySelectorAll('[name="' + returnSizesField + '"]');
        var picked = [];
        for (var b = 0; b < boxes.length; b += 1) { if (boxes[b].checked) picked.push(boxes[b]); }
        var returnHintView = form.getAttribute('data-return-hint-view') || '';
        var showReturnHint = function (text, focusEl) {
          event.preventDefault();
          var hint = returnHintView ? form.querySelector('[data-view="' + returnHintView + '"]') : null;
          if (hint) { hint.textContent = text; hint.removeAttribute('hidden'); }
          if (focusEl && focusEl.focus) focusEl.focus();
        };
        if (!picked.length) {
          showReturnHint(form.getAttribute('data-return-required-text') || '', null);
          return;
        }
        var maxSizes = parseInt(form.getAttribute('data-return-max-sizes') || '', 10);
        if (maxSizes > 0 && picked.length > maxSizes) {
          showReturnHint(form.getAttribute('data-return-limit-text') || '', null);
          return;
        }
        var maxQuantity = parseInt(form.getAttribute('data-return-max-quantity') || '', 10);
        for (var p = 0; p < picked.length; p += 1) {
          var quantityName = picked[p].getAttribute('data-qty-name') || '';
          var quantityInput = quantityName ? form.querySelector('[name="' + quantityName + '"]') : null;
          var raw = String((quantityInput && quantityInput.value) || '').replace(/^\s+|\s+$/g, '');
          var isInteger = /^[0-9]+$/.test(raw);
          var quantity = isInteger ? parseInt(raw, 10) : 0;
          if (!isInteger || quantity < 1 || (maxQuantity > 0 && quantity > maxQuantity)) {
            showReturnHint(form.getAttribute('data-return-quantity-text') || '', quantityInput);
            return;
          }
          // Her rule (2026-10-15): a return may not exceed the stock this size still has.
          //    The row's cap is on the checkbox as data-stock; a row WITHOUT it means "stock unknown"
          //    -- never treated as zero (that would block every size when the read failed).
          var stockAttr = picked[p].getAttribute('data-stock');
          if (stockAttr !== null && stockAttr !== '') {
            var stockCap = parseInt(stockAttr, 10);
            if (!isNaN(stockCap) && quantity > stockCap) {
              var stockText = String(form.getAttribute('data-return-stock-text') || '')
                .split('{size}').join(String(picked[p].value))
                .split('{stock}').join(String(stockCap));
              showReturnHint(stockText, quantityInput);
              return;
            }
          }
        }
      }
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = label || button.textContent;
      // While the server is slow it must never look like "nothing happened": append elapsed seconds.
      if (!elapsedTemplate) return;
      var seconds = 0;
      setInterval(function () {
        seconds += 1;
        button.textContent = elapsedTemplate.replace('{seconds}', String(seconds));
      }, 1000);
    });
  }
  // 2026-10-13: instant feedback on navigation links + one ui.tap report.
  // ASCII-only inside this template (a Chinese comment here would trip the hardcoded-Chinese gate).
  var tapLinks = document.querySelectorAll('a[data-tap-target]');
  for (var t = 0; t < tapLinks.length; t += 1) {
    tapLinks[t].addEventListener('click', function (event) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      var link = event.currentTarget;
      tapReport(link.getAttribute('data-tap-target') || '');
      // 2026-10-14: highlight the tapped realm cell IMMEDIATELY (her rule: feedback must not
      //   wait for the data). The server stays authoritative on the next load -- this only
      //   pre-marks the cell so a tap is visibly acknowledged. ASCII only in this template.
      var realmId = link.getAttribute('data-realm-id');
      if (realmId) {
        var bar = link.closest ? link.closest('.realm-bar') : null;
        if (bar) {
          var cells = bar.querySelectorAll('.realm-tab');
          for (var c = 0; c < cells.length; c += 1) {
            cells[c].classList.toggle('realm-tab--active', cells[c] === link);
          }
        }
      }
      // 2026-10-13 late: this block used to be
      //   if (data-opening === '1') { event.preventDefault(); return; }
      // which set data-opening=1 on the FIRST tap; if that navigation did not
      // actually go through (same path, only the query changed), EVERY later tap
      // was swallowed by preventDefault -- exactly the "taps do nothing" report.
      // The external tab (xin shang) has no data-tap-target, so it was never bound
      // and kept working. Never swallow a tap: show feedback, always navigate.
      if (link.getAttribute('data-opening') !== '1') {
        link.setAttribute('data-opening', '1');
      }
      link.style.opacity = '0.55';
      var openLabel = link.getAttribute('data-open-label');
      if (openLabel && link.textContent !== openLabel) link.textContent = openLabel;
    });
  }
  var tapForms = document.querySelectorAll('form');
  for (var f2 = 0; f2 < tapForms.length; f2 += 1) {
    tapForms[f2].addEventListener('submit', function (event) {
      var form = event.target;
      var btn = form.querySelector('button[type="submit"][name="action"]');
      // 2026-10-14: one tap -> BEACON + a hidden tap_id on THIS form, so the write request
      //   that follows can be correlated with the tap (the server logs ui.tap.result for it).
      var tapId = tapReport('submit:' + (btn && btn.value ? btn.value : ''));
      try { dshUiTap.stampForm(form, { tapId: tapId }); } catch (error) { /* never block submit */ }
    });
  }
  function tapReport(target) {
    try {
      if (!target || !dshUiTap) return '';
      var seg = location.pathname.split('/')[1] || 's';
      // 2026-10-14 cut B: the /s/accept page is gone, so the page value here is
      //   always 'scan' now (that branch could never hit again). ASCII only in this block.
      var page = 'scan';
      // Shared implementation (inlined at the top of this block):
      //   it reports target/tap_id/since_ms; the SERVER decides tap vs tap.repeated.
      return dshUiTap.track(target, { path: '/' + seg + '/ui-tap', page: page });
    } catch (error) {
      // silent: a failed report must never block navigation
      return '';
    }
  }
})();
</script>`;

/**
 * ⭐⭐ 2026-10-16（task-61 · 领域内扫一扫）：**只有这一页真有那个配置块时才出现**（否则空串 ⇒
 *   页面上**一个字都不多** ✓ `AC-ML5` 的零回归逐字节比对就靠它 ✓）。
 */
const realmScanScriptTagHtml = () => `<script data-view="realm-scan">${realmScanScriptSource()}</script>`;

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
/**
 * ⭐⭐ 2026-10-12（业务负责人拍板，落进 AGENTS.md《前端交互反馈纪律》）：
 *   「用户点击完之后**一定要有交互**：要么按钮置灰 · 要么弹出 Toast · 要么更改当前的提示文案……
 *     **不然用户以为点了没反应，就会多次提交**。」
 *   ⇒ 扫码页**所有会发起写操作的按钮**都挂这两个属性：
 *     · `data-submit-feedback` —— 点下去**立刻**换成的文案（按钮也同时 disabled）；
 *     · `data-submitting-elapsed` —— 服务端慢时每秒刷新的"处理中（已 N 秒）"模板。
 *   ⚠️ 属性值统一从配置来（`scanWrite.texts.submitSubmitting*`），渲染层不写死中文。
 */
const submitFeedbackAttrs = (writeLike = {}) => {
  const texts = writeLike?.texts || {};
  return ` data-submit-feedback="${escapeHtml(texts.submitSubmitting || '')}"`
    + ` data-submitting-elapsed="${escapeHtml(texts.submitSubmittingElapsed || '')}"`;
};

const hiddenField = (name, value) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;

/**
 * ⭐⭐ 2026-10-12：「她那次 400 是不是**旧页面**」这个问题，日志里答不了 ✗ ⇒ 让**页面自己说**：
 * 每个**写表单**都带一个隐藏的构建标识，她提交时随 body 回来 ⇒ warn 里就能看出来 ✓
 * ⚠️ **只加一个 hidden**（既有字段名 / 语义一个字不动 ✓）；不写死中文 ✓。
 */
const pageBuildField = () => hiddenField(
  SCAN_PAGE.pageBuildField || 'page_build', SCAN_PAGE.pageBuild || '',
);

const optionsHtml = (values, selected) => values
  .map((value) => `<option value="${escapeHtml(value)}"${String(value) === String(selected) ? ' selected' : ''}>${escapeHtml(value)}</option>`)
  .join('');

/** 本单里一行的人话（配品行只有名称；鞋行是 `货号 · N 码`）。 */
const draftLineText = (t, line) => (line.accessory_record_id
  ? fillText(t.draftAccessoryItem, { name: line.accessory_name || '' })
  : fillText(t.draftItem, { itemNo: line.item_no || line.number || '', size: line.size }));

/**
 * ⭐⭐ 2026-10-11：**每件实收** —— 提交表单里**一行一双**，行尾一个数字输入框。
 *
 * 她的口径里这是第①层（每件）：`这一件实际收到多少` 是**她唯一要填的金额**；
 * 页面上**没有第二个金额输入框**（只有一个「实收金额」）。
 * ⚠️ 这些输入框同名重复（`fields.lineAmount`）⇒ POST 上来是**有序数组**，
 *    下标与本单的明细行一一对应（服务端按同一个顺序落「销售明细.实收金额」）。
 * ⚠️ 值来自会话（她加单时填过 / 上一次提交填过）—— `escapeHtml` 之后回填。
 */
const draftLinesHtml = (write) => {
  const t = write.texts;
  const fields = write.fields;
  const lines = write.draft?.lines || [];
  // ⭐ 2026-10-14 晚（她：「实收金额下的两行文字说明不需要」）⇒ 空态那句整条退场 ✗
  if (!lines.length) return '';
  const rows = lines.map((line) => {
    const label = line.accessory_record_id ? t.accessoryLineAmountLabel : t.lineAmountLabel;
    const value = line.amount === null || line.amount === undefined ? '' : String(line.amount);
    return `<div class="draft-line">
<span class="draft-line__text">${escapeHtml(draftLineText(t, line))}</span>
<input class="draft-line__amount" name="${escapeHtml(fields.lineAmount)}" inputmode="decimal" value="${escapeHtml(value)}" placeholder="${escapeHtml(t.lineAmountPlaceholder)}" aria-label="${escapeHtml(label || '')}">
</div>`;
  }).join('\n');
  return `<div class="draft-lines">${rows}</div>`;
};

/**
 * ⭐⭐ 收款行的**预置规则**（纯函数；路由与渲染层共用同一份 —— 不写第二遍）。
 *   · 正常打开页面（`rows` 没给）⇒ 预置 `count` 行，**第一行默认选中「微信」**（她 2026-10-08 定的），
 *     其余行留空（空 = 这一行不用）；
 *   · 校验失败**原地重渲染**（`rows` = 她刚填的那几行）⇒ 原样带回来，行数补齐到 `count`
 *     —— ⚠️ 补齐的那几行**不注入默认方式**（她明明没选，替她选上就等于替她记账）。
 */
const buildPaymentRows = ({ count, defaultMethod, rows } = {}) => {
  const given = Array.isArray(rows) ? rows : [];
  const total = Math.max(1, Number(count) || 1, given.length);
  return Array.from({ length: total }, (_, index) => {
    const row = given[index];
    if (row) {
      return {
        method: String(row.method || ''),
        amount: row.amount === undefined || row.amount === null ? '' : String(row.amount),
      };
    }
    return { method: given.length ? '' : (index === 0 ? String(defaultMethod || '') : ''), amount: '' };
  });
};

/**
 * ⭐⭐ 2026-10-16 A2a：**「付款情况」三档单选（全付 / 部分付 / 未付）＋「实付多少」从页面上退场** ✓
 *
 * 改前逐字：这里原来有一个 `paymentStatusHtml(write)` —— 渲染 `<fieldset class="pay-status">`
 *   三个同名 `radio`（`name="payment_status"`，取值来自 `config/scanWrite.js` 的
 *   `texts.paymentStatusOptions`）＋「实付多少」那个 `input`（`fields.paidAmount`）。
 * 改后逐字：**这一块整个不渲染**（定义删除 ＋ 两处调用点去掉 ✓）——
 *   ⇒ 页面里**没有** `name="payment_status"`、**也没有**「实付多少」✓
 * 依据 = 她 2026-10-16 逐字（「加校验，别让他带着这三个单选提交」）的**前半刀**：
 *   页面与判据**都不再依赖档位**；**档位由金额自动定**（`config/saleSettlement.js` 的 `autoModeOf` ✓，
 *   路由 `routes/scanPage.js` 在资金页那一步用它 ✓）。
 * ⚠️ **本刀不拒绝**旧档位（请求里带着它照样能提交 ✓ —— 拒绝是 A3 ✓）；
 *    `config/scanWrite.js` 里的 `PAYMENT_STATUS` / `texts.paymentStatusOptions` **仍保留**
 *    （写服务与路由换档时还要用它们 ✓ 只是**不再渲染**成控件 ✗）。
 */

/**
 * ⭐⭐ 总单层的**多笔收款**（收款方式 + 金额，一行一笔）。
 *
 * 她的例子：「本次共收 500 = 微信 200 + 现金 300」⇒ 一行一笔、方式来自「收款方式管理」。
 * ⚠️ 这一页是**零 JS** 的原生表单 ⇒"可增删行"落地成"预置 N 行（`sale.paymentRowCount`），
 *    填了金额的行才算一笔，没填的行不用"（服务端同一个判据）。
 * ⚠️ 校验失败**原地重渲染**时，`write.paymentRows` 是**她刚填的那几行**（值原样回填）。
 */
const paymentRowsHtml = (write) => {
  const t = write.texts;
  const fields = write.fields;
  const rows = Array.isArray(write.paymentRows)
    ? write.paymentRows
    : buildPaymentRows({
      count: write.paymentRowCount,
      defaultMethod: write.defaultPaymentMethod,
    });
  return rows.map((row) => `<div class="form-row form-row--pay">
<select name="${escapeHtml(fields.paymentMethod)}" aria-label="${escapeHtml(t.paymentLabel)}"><option value="">${escapeHtml(t.paymentNoneOption)}</option>${optionsHtml(write.paymentMethods, row.method)}</select>
<input name="${escapeHtml(fields.paymentAmount)}" inputmode="decimal" placeholder="${escapeHtml(t.paymentAmountPlaceholder)}" aria-label="${escapeHtml(t.paymentAmountLabel)}" value="${escapeHtml(row.amount)}">
</div>`).join('\n');
};

/** 销售表单：**每件层**（加入本单 / 加配品）+ **总单层**（每件实收 + 付款情况 + 收款行 + 提交）。
 *
 * ⭐ 2026-10-10：卡片的说明标题（`saleHeading`，「销售（可以连着扫，最后一起提交）」）
 *   与「资金不是必填…」那句说明（`fundsPendingNote`）**都删掉** —— 子 tab 上已经写着「销售」，
 *   剩下的只留能填能点的（本单双数 / 尺码 / 每件实收 / 付款情况 / 收款行 / 按钮）。
 * ⭐⭐ 2026-10-11（**最终口径**）：
 *   · 每件**只有一个金额**：「实收金额」；
 *   · 总单加**「付款情况」三档**（全付（默认）/ 部分付 / 未付）+「实付多少」；
 *   · 收款明细**预置 1 行**（方式 + 金额，填了金额才算一笔）。
 */
const saleFormHtml = (view, write, page = {}, config = SCAN_PAGE) => {
  const t = write.texts;
  const fields = write.fields;
  const lines = write.draft?.lines || [];
  const sizeInput = sizeGroupsHtml(view, write);
  // 🔴🔴 2026-10-13（业务负责人：「我们先把**扫码页里的配品逻辑拿掉**，配品**改放在工作台里面**。
  //   也就是说，**扫码的时候就不用考虑配品信息了**」）—— 这一块（配品下拉 + 配品实收金额 + 那一颗
  //   【加入本单】）**已整块退场**，改到工作台去录（见 `docs/scan-sales-payment-flow-2026-10-13.md` 第六节）。
  //   ⚠️ **只是不再渲染**：`config/scanPage.js` 的那几条文案、`scanWriteService` 的配品能力、
  //      表的字段与历史数据**一个字都没动** ✓（AC-B1..B5/B7 那些**服务层**能力用例照旧全绿 ✓）
  //   ⚠️ 「备注（可不填）」（写进销售主表「赠品」）**仍在** —— 它在②里还要用 ✓ 见下面那个输入框。
  // 校验失败原地给她的那句话（差额）—— 没有就不渲染这一个块。
  const alert = String(write.errorText || '').trim()
    ? `<p class="form-alert">${escapeHtml(write.errorText)}</p>`
    : '';
  // 🔴🔴 2026-10-12（真机丢钱之后**合并**的）：原来这里是**两个 form** ——
  //    上面那个（尺码 + 加入本单）和下面那个（每件实收 + 付款情况 + 收款行 + 提交）。
  //    本单条还有**第三颗**不带钱的提交按钮 ⇒ 她在销售块填的钱被别的按钮吃掉 ⇒ `payment_count: 0`。
  //    ⇒ 现在**整页只有一个 form**：尺码 / 每件实收 / 付款情况 / 收款行 **都在里面**，
  //      两个按钮各自带 `action` 值（HTML 原生：提交按钮的 name=value 会进 POST）——
  //      **任何一颗按钮提交，钱字段都在**，结构上不可能再丢钱；而且零 JS。
  //    ⭐ 一单一笔 = 【选尺码】+【✅ 提交这一单（1 双）】**两下**；
  //      要多笔就点【➕ 还要加一双】（本单计数 +1，主按钮文案跟着变）。
  // ⚠️ 新文案缺省回落旧文案：渲染层**绝不因为少配一个 key 就把整块弄没了**
  //    （仓库里好几个用例自带最小 config —— 2026-10-12 实测：缺 `submitButtonCount`
  //      会让 `fillText(undefined)` 抛 ⇒ 整个销售块退化成一张空卡片）。
  const countLabel = fillText(t.submitButtonCount || t.submitButton, { count: Math.max(lines.length, 1) });
  // ══════════════════════════════════════════════════════════════════════════
  // ⭐⭐ 2026-10-16（task-59 · **销售也接上「一单多货」**）—— 业务负责人逐字：「**要：销售也接上**」
  //   ＋ Lead 裁决 **甲′**（逐字见 `test/multiItemOrderSalesChain.test.js` 的文件头）。
  //
  // 🔴 为什么**不复用** `multiItemBlockHtml`（那是补货 / 退货那一块）：
  //   既有判据 `test/multiItemOrderRender.test.js` 的 **AC-MIR1** 把它的调用点数成**恰好 2**
  //   ⇒ 销售这一块必须落在**这里**（本表单**本来就有一颗 `action=add_line` 的 submit** ✓）。
  //   判据文件头逐字写明了这条约束 ⇒ **不放宽那条判据** ✗。
  //
  // ⭐ "形状与补货一致"的**可执行**含义（两条，都不是"看着像"）：
  //   ① **同一份文案配置**（`MULTI_ITEM_RENDER_TEXTS` 的 `addButton` / `title` ⇒ **零新增中文** ✓）；
  //   ② **同一个 `data-multi-add` 钩子**（补货那块那颗入口的钩子 ✓）。
  //
  // 🔴 加货这一下**必须是本表单里的 submit**（`<form method="post">`）——
  //   补货/退货那颗是 `<a href="…?add=1">`（**GET ⇒ 天生带不走**她刚填的尺码/金额 ✗）；
  //   销售这张表单本来就是 POST 的表单 ⇒ **用它自己那颗既有 submit**（`action=add_line` ✓
  //   ⇒ 既有 `addSaleLine` ⇒ `session.sale.lines` ✓ **不新造写入口** ✗）。
  //
  // ⚠️ 开关关（`MULTI_ITEM_ORDER.enabled === false`）⇒ **那一颗逐字回到今天**（`t.addAnotherButton`）✓
  //   ⇒ 既有页面判据（`scanSaleAccessoryAndRemark` 等）与"N=1 逐字不变"都靠这个闸门 ✓。
  // ⚠️「本单已加的货品」标题**只在真的加了才出现**（本单为空时那一屏**逐字不变** ✓）；
  //   列表本身沿用**既有** `draftLinesHtml`（每行一个 `line_amount` 输入框 ⇒ 她填的钱看得见、改得动 ✓）。
  // ⚠️ 属性顺序**刻意**是 `data-multi-add` 在 `type="submit"` **之前**：
  //   判据 AC-SM-A 从 `data-multi-add` 那一处切到下一个 `>` 再核 `type="submit"` / `name` / `value`
  //   ⇒ 钩子必须出现在同一个元素**靠前**的位置（这不是风格问题，是判据切片的定义 ✓）。
  //
  // 🔴 **本单为空 ⇒ 这一屏逐字回到今天**（`t.addAnotherButton || t.addButton` ＋ **没有**任何新 DOM ✗）
  //   —— 这是"N=1 逐字不变"落在**页面**上的那一半（既有的领域渲染判据 AC-W1 / AC2 / AC5 / AC7
  //   都在空单下断言那一颗按钮的文字「加入本单」⇒ 本设计**一处都不动它们** ✓ 不需要成对迁移 ✓）。
  // ⭐ **本单已有货品 ⇒ 换那颗入口**（同一颗按钮、**同一个 `action=add_line`** ✓ 只是文案与钩子换成
  //   「＋ 再加一个货品」＋`data-multi-add`）—— **不新增第二颗同义按钮**（两颗一模一样的按钮更糟 ✗）。
  //   ⚠️「加入本单」⇒「＋ 再加一个货品」是**有意的语义递进**：第一件叫"加入本单"，
  //     已经在建多货品单了才叫"再加一个货品" ✓（依据 = 她 2026-10-16「要：销售也接上」）。
  // ══════════════════════════════════════════════════════════════════════════
  const multiItemAdd = MULTI_ITEM_ORDER.enabled === true && lines.length > 0;
  const multiItemTitleHtml = multiItemAdd
    ? `<h3 class="multi-item__title">${escapeHtml(MULTI_ITEM_RENDER_TEXTS.title)}</h3>\n`
    : '';
  const addLineLabel = multiItemAdd
    ? MULTI_ITEM_RENDER_TEXTS.addButton : (t.addAnotherButton || t.addButton);
  return `<section class="card">
<p class="draft-count">${escapeHtml(fillText(t.draftHeading, { count: lines.length }))}</p>
<form method="post" action="${escapeHtml(write.postAction)}" class="write-form">
${hiddenField(write.fields.submitKey, write.saleKey)}${pageBuildField()}
${sizeInput}
<div class="form-row"><label>${escapeHtml(t.amountLabel)}</label><input name="${escapeHtml(fields.amount)}" inputmode="decimal" placeholder="${escapeHtml(t.amountPlaceholder)}"></div>
${alert}
${multiItemTitleHtml}${draftLinesHtml(write)}
${String(write.errorText || '').trim() ? `${paymentRowsHtml(write)}` : ''}
<!-- ⭐⭐ 2026-10-13（金额两步走）：整单那一组（档位 / 收款行 / 备注）**整块挪到第 2 步页**
     ⇒ 录入页只留：每双 颜色 · 尺码 · 这一双的金额 ✓（那一组的字段名与标签字面量一个都不许留，否则 AC-2S1/AC-1 会打红） -->
<button type="submit" class="btn btn--primary" name="${escapeHtml(fields.action)}" value="${escapeHtml(write.actions.submitOrder)}" data-submit-feedback="${escapeHtml(submitSubmittingText(write))}" data-submitting-elapsed="${escapeHtml(submitSubmittingElapsedText(write))}">${escapeHtml(countLabel)}</button>
<button${multiItemAdd ? ' data-multi-add' : ''} type="submit" class="btn" name="${escapeHtml(fields.action)}" value="${escapeHtml(write.actions.addLine)}"${submitFeedbackAttrs(write)}>${escapeHtml(addLineLabel)}</button>
${draftSaveButtonHtml(write, DEFAULT_REALM, config, page)}
</form>
${lines.length ? `<form method="post" action="${escapeHtml(write.postAction)}" class="write-form">
${hiddenField(fields.action, write.actions.clearDraft)}${pageBuildField()}
${hiddenField(fields.submitKey, write.saleKey)}
<button type="submit" class="btn btn--ghost"${submitFeedbackAttrs(write)}>${escapeHtml(t.clearButton)}</button>
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
 * ⭐ 2026-10-10：「选这一组 = 现货 / 预订…」那两句说明与「（这一组 = 男 A · 38–48）」那句备注
 *    **都删掉** —— 组名 + 状态小标签 + 能选的尺码就够了。
 * ⭐⭐ 2026-10-11（业务负责人）：**一行 4 个码、卡上不显示数量**（四列网格见 STYLE 的
 *    `.size-chips`）——「你不用管数量，只要它实时库存表里面有，你显示就行」。
 *    ⇒ 这里**不再渲染 `size-chip__meta`**（原来它写着「N 双」/「预订」）：
 *       数量只在「库存」页看；「预订」已经在**组标题**那颗小标签上了，卡上不必每张重复。
 */
const sizeGroupHtml = ({ id, heading, tag, tone, items, empty }) => `
<fieldset class="size-group" data-stock-group="${escapeHtml(id)}">
<legend class="size-group__legend">
<span class="size-group__title">${escapeHtml(heading)}</span>
<span class="tag tag--${escapeHtml(tone)}">${escapeHtml(tag)}</span>
</legend>
<div class="size-chips">${items.length
    ? items.map((item) => `<label class="size-chip">
<input type="radio" name="size" value="${escapeHtml(item.size_text)}">
<span class="size-chip__size">${escapeHtml(item.size_text)} 码</span>
</label>`).join('\n')
    : `<span class="hint">${escapeHtml(empty)}</span>`}</div>
</fieldset>`;

/**
 * ⭐ 2026-10-14（她的最终口径）：「特殊码」折叠块 —— 原生 `<details>`（**零 JS** ✓）
 *   · **默认收起** ⇒ 浏览器原生：内容**不可见 + 不占布局高度** ✓（不用自己写 display:none ✗）
 *   · `<summary>` ≥44px（`--control-height`）⇒ 手机上点得到 ✓
 *   · 文案全走 `config.specialSizes.toggleLabel`（**渲染层不写死中文** ✗）
 *   ⚠️ 里面那张卡与外面**同规则**（`name="size"` 的 radio、`.size-chip` ⇒ 命中区一样 ✓）
 */
const specialFoldShellHtml = (items, inner) => {
  const cfg = SCAN_PAGE.specialSizes || {};
  if (cfg.foldable === false || !items.length) return '';
  const open = cfg.collapsedByDefault === false ? ' open' : '';
  return `
<details class="size-group size-fold" data-special-fold="1"${open}>
<summary class="size-group__legend size-fold__summary">
<span class="size-group__title">${escapeHtml(cfg.toggleLabel || '')}</span>
<span class="tag tag--warning">${escapeHtml(String(items.length))}</span>
</summary>
${inner}
</details>`;
};

/** 销售页那一块（#515）：折叠块里是**能选的尺码卡**（与外面同规则：`name="size"` 的 radio ✓） */
const specialFoldHtml = (items) => specialFoldShellHtml(items, `<div class="size-chips">${items.map((item) => `<label class="size-chip">
<input type="radio" name="size" value="${escapeHtml(item.size_text)}">
<span class="size-chip__size">${escapeHtml(item.size_text)} 码</span>
</label>`).join('\n')}</div>`);

/** 库存 / 补货共用：折叠块里的条目**只是事实**（尺码 + 数量），不是可点的卡 ✓ */
const specialFactsHtml = (items, v) => specialFoldShellHtml(items, `<ul class="size-fold__list">${items.map((item) => `
<li class="size-fold__item" data-folded-size="${escapeHtml(item.size_text)}">
<span class="size-fold__size">${escapeHtml(item.size_text)} 码</span>
<span class="size-fold__times">\u00d7</span>
<span class="size-fold__count">${escapeHtml(fillText(v.saleCountTemplate, { count: item.sellable ?? 0 }))}</span>
</li>`).join('')}</ul>`);

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
  // ⚠️ 2026-10-11 起**不再算每个码的数量文案**（`countText` 已退场）：卡上只有尺码本身，
  //    数量只在「库存」页看；两组的分法由 `saleSizeGroups` 决定，一个字没变。
  return sizeGroupHtml({
    id: 'in_stock',
    heading: t.saleInStockHeading,
    tag: t.saleInStockTag,
    tone: 'success',
    items: inStock,
    empty: t.saleSizeEmpty,
  }) + sizeGroupHtml({
    id: 'prepaid',
    heading: t.salePrepaidHeading,
    tag: t.salePrepaidTag,
    tone: 'warning',
    items: prepaid,
    empty: t.saleSizeEmpty,
  }) + specialFoldHtml(groups.folded || []);
};

/**
 * ⭐⭐ 2026-10-14 晚（业务负责人**逐字**）：「**只写一个整单金额**（一次填一个总额，**和补货一样**～）」
 *   ⇒ **退货运这一个渲染片段**（一个输入、一个总额 ✓ 不按行分填 ✗）：
 *     · 字段名来自 `fields.purchaseAmount`（= 配置 `PURCHASE_AMOUNT.field` 的唯一来源 ✓）；
 *     · 标签 / 占位来自 `texts.purchaseAmount*`（改文案只改配置 ✓ 不写死 ✗）。
 *   ⚠️ 这里是**唯一**一处画这个输入的地方 —— 将来改版式/加输入属性只改这一个函数
 *     （各抄一份 = 迟早改漏一个 ✗）。
 *
 *   ⭐⭐ 2026-10-16（她逐字：「这个是报货的页面，**还是需要填写金额啊**」✗）**成对翻新**：
 *     改前逐字：**补货 + 退货两个表单各调它一次**（两处都是无条件调用的那一行 ✗）；
 *     改后逐字：**只有退货那一处无条件调它** ✓ —— 补货那一处改成
 *       一个**三元表达式**：先问配置 `rp.amountRow`，真才调它（**按配置**决定画不画 ✓
 *       缺省 `SCAN_PAGE.replenishForm.amountRow === false` ⇒ **她截图上那个框不再出现** ✓）。
 *     ⚠️ 这里**刻意不把那两处的代码原文抄进注释**：本仓有**读源码数次数**的既有哨兵
 *       （`test/scanPurchaseAmountRequired.test.js` AC-PA5 ④ 数"那个片段被调了几次"），
 *       注释里抄一遍会让计数**凭空多出来** ⇒ 那是"注释把判据顶红"的假红 ✗。
 *     依据：她 2026-10-16 真机截图（补货 tab · 货品 832-500）＋ 逐字「还是需要填写金额啊」
 *       ＋（背景）她早定的「**补货不问金额**」（校验那一半 = `requiredByRealm.replenish === false` ✓ #689）。
 *     ⚠️ **不是放宽**：这个函数**本身一个字没改**（退货的字段名/标签/占位逐字不变 ✓）；
 *       补货那一侧是**更强的反向判据**（`test/replenishTrimThreeFixes.test.js` AC-RP1：塞回即红 ✓）。
 */
const purchaseAmountRowHtml = (write) => {
  const texts = write?.texts || {};
  const fields = write?.fields || {};
  return `<div class="form-row"><label>${escapeHtml(texts.purchaseAmountLabel || '')}</label>`
    + `<input name="${escapeHtml(fields.purchaseAmount)}" inputmode="decimal"`
    + ` placeholder="${escapeHtml(texts.purchaseAmountPlaceholder || '')}"`
    + ` aria-label="${escapeHtml(texts.purchaseAmountLabel || '')}"></div>`;
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

/**
 * ⭐⭐ 2026-10-16（**一单多货品 · 渲染半**）—— 补货 / 退货**共用**那一块。
 *
 * 她的口径（逐字）：「核心就是…**销售、补货、退货支持一单多货**」⇒ 补货/退货也要能**一单加多个货品** ✓。
 *   · 形状 = 设计 §4.3（`[{product_record_id, number, item_no, color, supplier_record_id, entries:[{size, quantity}]}]`）✓
 *   · 🔴 **N=1 与今天逐字不变**：开关 `MULTI_ITEM_ORDER.enabled === false` ⇒ 本函数返回 **空串** ⇒
 *     两个表单**一个字节都不变** ✓（既有断言原样绿 ✓）
 *   · 🔴 **不新开提交路径**：整块只是往**既有那个 `<form>`** 里加一个 hidden 字段 ＋ 一个按钮 ＋ 一段脚本；
 *     `action` / `submitKey` / 尺码字段 / 金额行 / 提交按钮**顺序与内容都不动** ✗
 *   · ⚠️ 允许 JS 动态交互（她 2026-10-12 明确「**我们是能够进行动态交互的**」✓）——
 *     这是**我方**的技术选择，**不是"她的要求"** ✗
 *
 * ⚠️ 载荷**键名只在这里定义一次**（`*_KEYS`）：服务端纯函数与页面脚本**共用同一份** ⇒ 不会两处写漂 ✓
 */
const MULTI_ITEM_ITEM_KEYS = Object.freeze([
  'product_record_id', 'number', 'item_no', 'color', 'supplier_record_id', 'entries',
]);
const MULTI_ITEM_ENTRY_KEYS = Object.freeze(['size', 'quantity']);

/** 一单多货品的载荷 JSON（**纯函数**，用例直接钉它 ✓；形状 = 设计 §4.3）。 */
const multiItemPayloadJson = (items = []) => JSON.stringify(
  (Array.isArray(items) ? items : []).map((item) => {
    const out = {};
    for (const key of MULTI_ITEM_ITEM_KEYS) {
      out[key] = key === 'entries' ? undefined : String((item || {})[key] ?? '');
    }
    out.entries = (Array.isArray((item || {}).entries) ? item.entries : []).map((entry) => {
      const line = {};
      for (const key of MULTI_ITEM_ENTRY_KEYS) {
        line[key] = key === 'quantity' ? Number((entry || {})[key]) : String((entry || {})[key] ?? '');
      }
      return line;
    });
    return out;
  }),
);

/**
 * 🔴 **零 JS**（既有哨兵钉着：扫码页 HTML 里**一行 `<script>` 都不许有** —— `AC-W2` / `AC-6R5`）⇒
 *   这一块**不用任何前端脚本**：
 *   · `multi_items` 的**首件**由**服务端**渲进 hidden 字段（形状 = 设计 §4.3；`entries` 由路由在提交时合并 ✓）
 *   · 「再加一个货品」是一颗**链接**（同一路径带参数 ⇒ 路由侧去记草稿；**路由没接前 = 能点、但没人读** ✓ 自洽）
 *   · 「已加货品」列表**由服务端**从 `view.multi_items` 渲染（拿不到 ⇒ 按下面的口径处理 ✓ 不编 ✗）
 *
 * ⭐⭐ 2026-10-16（`mode` 参数 · 业务负责人真机截图 + 逐字）—— **两个领域先后各点了一次，同一个形状**：
 *   · **退货 tab**（第一次）：「退货确实没有了那个退货按钮，需要你**删除不必要的文字提示**」
 *     ＋ 弹窗确认她选的是「**说明 + 「本单已加的货品」那整块都删**」（逐字在 lead 的弹窗记录里 ✓）；
 *   · **补货 tab**（第二次 · 她 2026-10-16）：「这个是**报货的页面，还是需要填写金额啊**，以及
 *     **不需要的文字说明给删除**，**生成报货订单按钮文字改为补货**」
 *     ⇒ 「不需要的文字说明」= **与退货同一条**（那次她选的是"说明 + 整块都删"）⇒ 这里**同样处理** ✓。
 *     ⚠️ 她那次的选择**只对退货生效过**（补货那块当时**一个字没动** ✗）；**这一次她才点了补货** ✓
 *       ⇒ 现在两块**都进精简档**（**依据 = 她 2026-10-16 补货 tab 的截图 + 逐字** ✓）。
 *
 *   ⚠️ **改前**这一块在**补货 / 退货两块共用同一份 DOM**（`t.hint` 那一段 + `t.title` 那个 `<h3>`
 *     + 空态那句 `t.empty` **无条件**渲染）。
 *
 *   ⇒ **`mode === 'return'` / `mode === 'replenish'`（两块各自显式传自己那一档）**：
 *     · 🔴 **删** `t.hint` 那一段说明（她逐字：「删除不必要的文字提示」）；
 *     · 🔴 **删** `t.title` 那个标题 ＋ 空态那句 `t.empty`（弹窗：**"说明 + 整块都删"**）；
 *     · ⭐ **但"已加的货品列表"本身要保留** —— **只有真的加了第二个货品时才出现**
 *       ⇒ 空的时候 `data-view="multi-item-list"` 那个 `<ul>` **整块不渲染** ✓（有内容才显示 ✓）；
 *     · 🔴 **一个字都不动**：`data-multi-add` 那颗「＋ 再加一个货品」、那个 hidden `multi_items`
 *       字段、`data-view="multi-item"` 容器、以及 `attr(...)` 那几个 `data-product-*`（表单行为 ✓）。
 *   ⇒ **`mode` 缺省（`''`）仍逐字不变** ✓ —— 走**老分支**（`t.hint` / `t.title` / `t.empty` / 列表照旧）✓
 *     （= 本函数被直接调用时的老形状；探针 AC-RT7 靠它 ✓ **不许把缺省也一起精简** ✗）。
 *
 *   📌 判据（成对迁移，改前逐字 → 改后逐字 → 依据 = 她 2026-10-16 真机截图 + 逐字
 *     ＋ 弹窗选择「说明 + 整块都删」）：
 *     · 退货那三处 → `test/multiItemOrderReturnTrim.test.js`（AC-RT1..RT5）；
 *     · 补货那三处 → `test/replenishTrimThreeFixes.test.js`（**本刀新增** AC-RP1 / AC-RP3）；
 *     · 两块都：**有第二个货品时列表仍要出现** ✓（**正向**判据 —— 防"删过头" ✗）。
 */
const multiItemBlockHtml = (write, view = {}, mode = '', page = {}) => {
  if (!MULTI_ITEM_ORDER.enabled) return ''; // 🔴 开关关 ⇒ 空串 ⇒ 既有页面逐字不变 ✓
  const t = MULTI_ITEM_RENDER_TEXTS;
  const field = String(MULTI_ITEM_ORDER.field || '');
  if (!field) return ''; // 字段名空 ⇒ 宁可不渲染，也不发一个没人认的键 ✗
  // ⭐ 精简那一版 = **退货 / 补货两块各自显式传自己的 `mode`** ✓
  //   ⚠️ **缺省 `''` 仍是"照旧那一版"**（= 本函数被直接调用时的老形状 ✓ 探针 AC-RT7 靠它 ✓）——
  //     所以这里**必须按显式 mode 分叉**，不能把缺省也一起精简 ✗（那会动到"没人认的调用方"）。
  //   ⭐⭐ 2026-10-16（补货那三处 · 她真机截图 + 逐字）⇒ `'replenish'` 也进精简档 ✓
  //     依据：她这次点的是**补货**（退货那次她已点过 ✓）—— 两边**同一个形状**、同一句依据 ✓。
  const trimmed = mode === 'return' || mode === 'replenish';
  // ⭐⭐ 2026-10-16（task-59 · **表单半**）：加/删货那一套**只在路由半接住那个 POST 时才开** ✓
  //   —— 接线位由路由半经 `buildWriteContext` 传进来（`write.multiItem`）；
  //   🔴 缺一个键就**不接线**（退回今天那颗链接）—— **宁可不给按钮，也不发一个没人接的动作** ✗。
  //   ⚠️ 与"精简档"是**两件事**（一个是删文案、一个是那颗入口是按钮还是链接）⇒ 各读各的位 ✓。
  const wire = (write && write.multiItem) || null;
  const addAction = String((wire && wire.addAction) || '');
  const addValue = String((wire && wire.addValue) || '');
  const removeField = String((wire && wire.removeField) || '');
  const wired = Boolean(addAction && addValue);
  const first = {
    product_record_id: view.product_record_id, number: view.number, item_no: view.item_no,
    color: view.color, supplier_record_id: view.supplier_record_id, entries: [],
  };
  const already = Array.isArray(view.multi_items) ? view.multi_items : [];
  const attr = (name, value) => (value === undefined || value === null || value === ''
    ? '' : ` ${name}="${escapeHtml(value)}"`);
  // 列表行：两种 mode **共用同一份拼法**（一处定义 ✓ 不各抄一份 ✗）
  //   ⭐ 表单半：每行多一颗**删除**按钮（`name` = 接线字段 · `value` = 该件 `product_record_id`）；
  //     接线关 ⇒ **一个字都不加**（既有判据原样绿 ✓）。
  const listRows = already.map((item) => {
    const rows = Array.isArray(item?.entries) ? item.entries.length : 0;
    const removeButton = removeField && item?.product_record_id
      ? `<button type="submit" class="btn btn--ghost" data-multi-remove name="${escapeHtml(removeField)}" value="${escapeHtml(String(item.product_record_id))}"${submitFeedbackAttrs(write)}>${escapeHtml(t.remove)}</button>`
      : '';
    return `<li class="multi-item-row">${escapeHtml(String(item?.number || item?.item_no || ''))}`
      + ` <span class="hint">${escapeHtml(fillText(t.rowsTemplate, { count: rows }))}</span>${removeButton}</li>`;
  }).join('');
  // 🔴 精简档（退货 / **补货**）：**空 ⇒ 整块（含 <ul>）不渲染** ✓；缺省档：**空 ⇒ 保留那句空态人话** ✓
  const listHtml = trimmed
    ? (already.length ? `<ul class="multi-item__list" data-view="multi-item-list">${listRows}</ul>` : '')
    : `<ul class="multi-item__list" data-view="multi-item-list">`
      + `${already.length ? listRows : `<li class="hint">${escapeHtml(t.empty)}</li>`}</ul>`;
  // 「再加一个货品」：
  //   · **接线关**（今天）⇒ 一颗指向本页的**链接**（`?add=1`）—— 既有判据 `Render:73` / `ReturnTrim:166`
  //     逐字钉着它，本刀**不动**它 ✓；
  //   · **接线开** ⇒ 改成**同一张表单里的第二颗 submit**：🔴 这是"她填的尺码/数量不丢"的**唯一**办法
  //     （GET 链接天生带不走表单字段 ✗ —— 只有 POST 会把她填的那些一起发出去 ✓）。
  const addHref = `${escapeHtml(write.postAction || '')}${String(write.postAction || '').includes('?') ? '&' : '?'}add=1`;
  const addEntry = wired
    ? `<button type="submit" class="btn btn--primary" data-multi-add name="${escapeHtml(addAction)}" value="${escapeHtml(addValue)}"${submitFeedbackAttrs(write)}>${escapeHtml(t.addButton)}</button>`
    : `<a class="btn btn--primary" data-multi-add href="${addHref}">${escapeHtml(t.addButton)}</a>`;
  // ⭐⭐ 隐藏字段：**首件 + 已加的每一件**（每件**带着它自己的 `entries`**）✓
  //   🔴 为什么要带上已加的：她点「＋ 再加一个货品」时，表单里**只有当前这一件**的尺码/数量控件
  //     ⇒ 已加那几件的数量**只能靠这个字段带走**（不然点一下"加"，前面加的就全丢 ✗）。
  //   🔴 为什么首件的 `entries` 仍是空：本次表单的尺码/数量由**路由在提交时合并进首件**
  //     （`mergeFirstItemEntries` 是**赋值**语义 ⇒ 只生效一次、**不会翻倍** ✓ —— 既有判据不放宽 ✗）。
  //   🔴🔴 **必须把"当前这一件"从已加列表里排掉**（改前逐字：`const payload = wired ? [first, ...already] : [first];`）
  //     —— 因为 `view.multi_items` 是**草稿里的全部 items**（`routes/scanPage.js` 的
  //     `readMultiItemPending` 只拿到 `(openId, chain)`，**它不知道"当前是哪一件"** ⇒ **排不掉** ✗；
  //     那段注释里写的"由路由半保证不含当前这一件"**当时并没有实现**）。
  //     ⇒ 不排的话，当前这件会在载荷里**出现两次**：首件（她刚填的）＋ 草稿那份**旧的**
  //       ⇒ 提交时 `addItem` 按顺序跑、**后写的赢** ⇒ 她刚填的尺码/数量被**静默覆盖成旧值** ✗✗
  //       （`test/multiItemCurrentItemDup.test.js` 用**真引擎**把这条证了一遍 ✓）；
  //       而且"同一个货品出现两次"还会让 `groups.length` 平白多 1（本该 N=1 的那一单被当成多货品 ✗）。
  //   ⚠️ **列表照旧画全部 `already`**（她刚加的那一件**必须看得见** ✓ —— 只排**载荷**、不排列表 ✗）。
  //   ⚠️ 身份取不到（空串）⇒ **一个都不排**：宁可让引擎按 `product_missing` 当场拒单，也别误删别人 ✗。
  //   ⚠️ 身份口径**与引擎 `productKeyOf` 同一条优先级**（`product_record_id` → `number` → `item_no`）✓。
  const keyOf = (item) => String(
    (item || {}).product_record_id || (item || {}).number || (item || {}).item_no || '',
  ).trim();
  const currentKey = keyOf(first);
  const others = currentKey ? already.filter((item) => keyOf(item) !== currentKey) : already;
  //   ⚠️ 接线关 ⇒ 逐字仍是 `[first]`（既有判据 AC-MIR1 读的就是它 ✓ 零迁移 ✓）。
  const payload = wired ? [first, ...others] : [first];
  // 🔴 说明那一段 + 标题：**精简档（退货 / 补货）不渲染**（她那句"不必要的文字提示"）✓
  //   ⚠️ 拼法上把"删掉的行"做成**整行**（不是行内空串）—— 空串留在模板里会多出空行，
  //     "删掉"就应该是**那一行不在**（也让她截图里不会看到一段莫名的空隙 ✓）。
  const lines = [];
  if (!trimmed) lines.push(`<p class="hint">${escapeHtml(t.hint)}</p>`);
  lines.push(addEntry);
  lines.push(`<input type="hidden" name="${escapeHtml(field)}" value="${escapeHtml(multiItemPayloadJson(payload))}">`);
  if (!trimmed) lines.push(`<h3 class="multi-item__title">${escapeHtml(t.title)}</h3>`);
  // ⭐⭐ 2026-10-16（task-61 · 「本单已加的货品」列表）。**列表 + 载荷**两处都从那同一份 `already` 来
  //   ⇒ 只报一次即可（列表上看得见的货品号 ✓ 与她眼睛看到的那一份逐字同源 ✓）。
  //   🔴 纯 additive：只在**真的渲染这个块**时才产生；一个判定都不动 ✗。
  if (Array.isArray(page.logs) && MULTI_ITEM_ORDER.enabled) {
    page.logs.push({
      event: (MULTI_ITEM_ORDER.logFields || {}).renderEvent || 'scan.multi_item.render',
      fields: MULTI_ITEM_ORDER.logFields || {},
      chain: String(mode || ''),
      count: already.length,
      itemNos: already.map((item) => String((item || {}).number || (item || {}).item_no || '')),
    });
  }
  if (listHtml) lines.push(listHtml);
  // ⭐⭐ 2026-10-16（task-61 · 领域内扫一扫）：这一块的**扫一扫上下文**（只在开关开、且路由喂了才出 ✓）。
  //   它**不是第二颗按钮**（那颗「＋ 再加一个货品」一个字都不动 ✗）—— 它只告诉
  //   `views/scanRealmScan.js` 那一段脚本："加货回来这一发，接着扫、并落回**这个领域**" ✓。
  const realmScanBlock = realmScanConfigHtml({
    // 🔴 2026-10-16 修复（Lead 亲自改 · CodeQL 规则 `js/incomplete-sanitization` 挡的正是下面这一处 ✓）
    //   改前逐字：`escapeHtml(JSON.stringify({ … }))`
    //     ⇒ `escapeHtml`（`:48`）只转 `& < > " '` ✗ —— **不处理反斜杠 `\`** ✗
    //       ⇒ CodeQL 判「This does not escape backslash characters in the input」⇒ **PR 的 CodeQL 红** ✗（本地绿、CI 红）
    //   改后逐字：先把 `<` 换成 `\u003c`（**JSON 里 `<` 只可能出现在字符串内** ✓ ⇒ 解析回原值 **行为不变** ✓），再过 escapeHtml
    //   依据：CodeQL 官方对这条规则的推荐修法（把危险字符换成 `\uXXXX` 序列 ⇒ 与反斜杠转义无冲突 ✓）
    //   ⭐ 不是放宽：转义**更完整**（原来漏了反斜杠场景 ✓）；且**只动这一处** ✓（`escapeHtml` 本身一个字不动 ✗ 全仓共用 ✓）
    configJson: (page.realmScan
      ? escapeHtml(JSON.stringify({
        realm: String(page.realmScan.realm || ''),
        // ⭐ 落点是**扫完那一刻现算**的（"扫到的是哪一件"服务端此刻不可能知道 ✗）——
        //   所以这里只给**参数**：领域键 / 记录路径段 / 本页来源 ＋ 认不出的上限 ✓
        origin: String(page.realmScan.origin || ''),
        realmQueryKey: String(page.realmScan.realmQueryKey || ''),
        recordBasePath: String(page.realmScan.recordBasePath || ''),
        maxScannedLength: Number(page.realmScan.maxScannedLength) || 0,
        signaturePath: String(page.realmScan.signaturePath || ''),
        reportPath: String(page.realmScan.reportPath || ''),
        sdkTimeoutMs: Number(page.realmScan.sdkTimeoutMs) || 0,
        scanTimeoutMs: Number(page.realmScan.scanTimeoutMs) || 0,
        texts: page.realmScan.texts || {},
      }).replace(/</g, '\\u003c'))
      : ''),
    scanNow: page.realmScan?.scanNow === true,
  });
  if (realmScanBlock) lines.push(realmScanBlock);
  return `<div class="card multi-item" data-view="multi-item"${attr('data-product-record-id', view.product_record_id)}${attr('data-product-number', view.number)}${attr('data-product-item-no', view.item_no)}${attr('data-product-color', view.color)}${attr('data-product-supplier-record-id', view.supplier_record_id)}>
${lines.join('\n')}
</div>`;
};

const replenishFormHtml = (view, write, page = {}, config = SCAN_PAGE) => {
  const t = write.texts;
  const v = REALM_TEXTS;
  const fields = write.fields;
  // ⭐⭐ 2026-10-16（补货那三处 · 她真机截图 + 逐字）：**补货领域的渲染文案与开关**走
  //   `SCAN_PAGE.replenishForm`（与退货那一块的 `SCAN_PAGE.returnForm` 同一个形状 ✓）：
  //   · `rp.submitLabel` —— 最下面那颗蓝色按钮的文字（改前逐字 `t.replenishButton` = '生成报货订单'）；
  //   · `rp.amountRow`   —— 「整单金额」那一块**画不画**（缺省 false ⇒ 补货页上不画 ✓）。
  const rp = SCAN_PAGE.replenishForm;
  const lines = purchaseSizeLines(view);
  const sizes = lines.length ? lines : (write.sizes || []).map((item) => ({
    size_text: item.size_text, sellable: null, missing: Boolean(item.missing), checked: Boolean(item.missing),
  }));
  if (!sizes.length) return '';
  // ⭐⭐ 2026-10-14 版式改版（她：「按照**尺码×数量**的形式……**一行 3 个**，多了就换行，保持一行 3 个」）
  //   · 列数**走配置**（`--size-cols` ⇒ CSS `repeat(var(--size-cols), minmax(0, 1fr))` ⇒ 每列平分、自动换行 ✓）
  //   · 🔴 不用 `auto-fit/auto-fill`（那会随宽度变 2/4 列 ✗ 她要的是"保持一行 3 个"）
  const columnsPerRow = Number(SCAN_PAGE.purchaseSizes?.columnsPerRow) > 0
    ? Number(SCAN_PAGE.purchaseSizes.columnsPerRow) : 3;
  const cellHtml = (item, extraClass = '') => `
<li class="purchase-size-cell${extraClass}" data-purchase-size="${escapeHtml(item.size_text)}">
<span class="purchase-size__size">${escapeHtml(item.size_text)} 码</span>
<span class="purchase-size__amount"><span class="purchase-size__times">\u00d7</span>${escapeHtml(fillText(v.saleCountTemplate, { count: item.sellable ?? 0 }))}</span>
<span class="tag tag--${item.sellable > 0 ? 'success' : 'warning'}">${escapeHtml(item.sellable > 0 ? v.purchaseInStockTag : (item.missing ? v.purchaseMissingTag : v.purchaseNoneTag))}</span>
</li>`;
  // ⚠️ 判据在 realm 的 `purchaseSizeGroups`（一处逻辑 ✓）；这里只做"视图模型没给 ⇒ 退回写上下文"的兜底 ✗
  const groups = purchaseSizeGroups(view);
  const hasLines = groups.lines.length > 0 || groups.folded.length > 0;
  const visible = hasLines ? groups.lines : sizes;
  const folded = hasLines ? groups.folded : [];
  //   ⭐⭐ 2026-10-16（业务负责人真机截图 + 逐字，**补货领域**）：
  //     「我记得我要把**补货的尺码 × 数量，不用一行一个尺码，而是改为一行 3 组尺码 × 数量**这样的模式」
  //     ⚠️ **这不是"没做"** —— 2026-10-14 那次就已经加了 `.purchase-size-grid` ＋ `--size-cols`（3 列）
  //       ✓，**但一根旧 CSS 把它顶掉了**，所以线上一直是**一行一个** ✗（她截图是对的 ✓）。
  //     🔎 **根因（静默失效）**：那个 `<ul>` 上**同时挂着两个类** ——
  //       `purchase-size-grid`（**新**的 3 列网格类）＋ `purchase-sizes`（**旧一列版式的残留**）：
  //       ⚠️ 这两个类名**刻意不写成 `class="…"` 那种原文**（本仓有**读源码数次数**的既有哨兵，
  //         注释里抄一遍会让计数凭空多出来 ⇒ 假红 ✗ —— 与上面 `purchaseAmountRowHtml` 同一类坑）。
  //       · `.purchase-size-grid`（本文件 `:249`）= `repeat(var(--size-cols, 3), minmax(0, 1fr))` ⇒ **3 列** ✓
  //       · `.purchase-sizes`（本文件 `:256`，**旧一列版式的残留**）= `minmax(0, 1fr)` ⇒ **1 列** ✗
  //       两者**特异性相同**（都是单类选择器），`.purchase-sizes` 在**后面** ⇒ **后者赢** ⇒ 实际 1 列 ✗
  //     ⇒ **修法 = 把那个已无用的旧类从这两个 `<ul>` 上摘掉**（`data-view="purchase-sizes"` 锚**保留** ✓）：
  //       `.purchase-sizes` 规则随即**没有任何消费者** ⇒ `.purchase-size-grid` 的 3 列**真正生效** ✓
  //       ⚠️ **刻意不动那条 CSS 规则本身**（不删也不改）：`STYLE` 里那段 CSS 文本另有
  //         `test/fixtures/hardcodedChineseWhitelist.json` 的整块留档盯着（动它就要连带改那个夹具 ✗）
  //         ⇒ 摘一个类名是**最小且够**的那一刀 ✓（谁把类塞回来 ⇒ `test/replenishTrimThreeFixes.test.js`
  //         的 **AC-RP7** 当场红 ✓）。
  //     🔴 **功能零变化**：勾选 / 数量输入 / 字段名 / 提交顺序 / 库存数量 / 缺码·现货标记语义
  //       **一个字都没改** ✗（本刀只动那一个 `class` 属性里的一个旧类名 ✓）——
  //       钉在 AC-RP8（同一个 POST 载荷逐字相同）＋ AC-RP9（组内元素逐字仍在）✓
  const stockList = `<ul class="purchase-size-grid" data-view="purchase-sizes" style="--size-cols: ${escapeHtml(String(columnsPerRow))}">${visible.map((item) => cellHtml(item)).join('')}</ul>`
    + specialFoldShellHtml(folded, `<ul class="purchase-size-grid" data-view="purchase-sizes-folded" style="--size-cols: ${escapeHtml(String(columnsPerRow))}">${folded.map((item) => cellHtml(item, ' size-fold__item')).join('')}</ul>`);
  const rows = sizeRowsHtml({
    sizes,
    name: fields.replenishSizes,
    quantityPrefix: fields.replenishQuantityPrefix,
    quantityLabel: t.replenishQuantityLabel,
    // 补货：**缺码默认勾上**（她要补的就是缺的那些）
    checkedOf: (item) => Boolean(item.checked),
  });
  return `<section class="card">
${stockList}
<details class="disclosure" data-view="one-tap-replenish">
<summary class="disclosure__summary">${escapeHtml(v.oneTapReplenish)}</summary>
<form method="post" action="${escapeHtml(write.postAction)}" class="write-form">
${hiddenField(fields.action, write.actions.replenish)}${pageBuildField()}
${hiddenField(fields.submitKey, write.replenishKey)}
${rows}
${rp.amountRow ? purchaseAmountRowHtml(write) : ''}
${multiItemBlockHtml(write, view, 'replenish', page)}
<button type="submit" class="btn btn--primary"${submitFeedbackAttrs(write)}>${escapeHtml(rp.submitLabel)}</button>
${draftSaveButtonHtml(write, REPLENISH_REALM, config, page)}
</form>
</details>
</section>`;
};

/**
 * 一列"尺码 + 数量"的行（补货与退货**共形**，只有字段名与是否预勾不同）。
 *
 * ⚠️ 两个表单各自是独立的 `<form>`，所以同名控件互不影响；但**字段名仍然各用各的**
 *   （配置里的 `sizes` / `return_sizes`），断言与将来的合并提交都不至于互相串。
 */
/**
 * 尺码行（补货 / 退货**共用**一份 ✓ 她是对照着看的）。
 * ⚠️ 2026-10-15（task-23）：多了两个**可选**参数 —— **不传就与改动前逐字相同** ✓
 *   · `defaultQuantity`：数量输入的默认值（**不再写死 `1`** ✗ —— 走配置 ✓）
 *   · `stockOf(item)`：**退货**那一块要的"当前库存数量"列；返回 `null` = 这一块不要这一列
 *     （补货不传 ⇒ 一个字都不变 ✓ —— 有既有断言逐字钉着 'value="1"' ✓）
 *   · 勾选框上的 `data-qty-name`：给"前端拦截"那段脚本用（**脚本里不写死字段名拼接** ✗）。
 */
const sizeRowsHtml = ({
  sizes, name, quantityPrefix, quantityLabel, checkedOf, defaultQuantity = 1, stockOf = null,
}) => sizes.map((item) => {
  const size = item.size_text;
  const quantityName = `${quantityPrefix}${size}`;
  const stock = stockOf ? stockOf(item) : null;
  // ⭐ 2026-10-15 晚：这一行的**库存上限**挂在勾选框上（脚本据此拦"退货数量 > 当前库存" ✓）；
  //   **取不到库存 ⇒ 不带这个属性** ⇒ 脚本不拿 0 当库存拦她 ✗（她只会看到"取不到"那句人话 ✓）。
  const stockCapAttr = stock && Number.isFinite(stock.cap)
    ? ` data-stock="${escapeHtml(String(stock.cap))}"` : '';
  // ⚠️ 新属性**放在 `name` 之前**、`checked` 仍**紧跟在 `value` 后面** ——
  //   既有断言钉着逐字 `name="sizes" value="41" checked`（不许为了加属性把它改红 ✗ 我第一版就踩了）。
  const dataQtyNameAttr = ` data-qty-name="${escapeHtml(quantityName)}"`;
  return `<div class="size-row">
<label class="size-check"><input type="checkbox"${stockCapAttr}${dataQtyNameAttr} name="${escapeHtml(name)}" value="${escapeHtml(size)}"${checkedOf(item) ? ' checked' : ''}> ${escapeHtml(size)} 码</label>
${stock ? `<span class="hint" data-view="${escapeHtml(stock.view)}">${escapeHtml(stock.text)}</span>` : ''}
<input class="size-qty" name="${escapeHtml(quantityName)}" value="${escapeHtml(String(defaultQuantity))}" inputmode="numeric" aria-label="${escapeHtml(`${size} ${quantityLabel}`)}" placeholder="${escapeHtml(quantityLabel)}">
</div>`;
}).join('');

/**
 * ⭐⭐ 2026-10-11（业务负责人定）：采购领域的【**退货**】——与【一键补货】**同形**
 *   （同一个 POST 端点、同一套会话与幂等键风格、勾尺码 + 填数量）。
 *
 * 口径要点：
 *   · **不预勾任何尺码**：退哪几个码是**业务事实**（她现场看货才知道），替她预勾就是猜；
 *   · 数量默认 1（与补货同一条"至少一双"），可改；
 *   · **一行业务逻辑都没有**：动作名 / 字段名 / 幂等键 / 文案全来自配置，
 *     写库在既有构件里（见 `services/purchaseReturnService.js` 的文件头）。
 */
const returnFormHtml = (view, write, page = {}, config = SCAN_PAGE) => {
  const t = write.texts;
  const v = REALM_TEXTS;
  const fields = write.fields;
  const lines = purchaseSizeLines(view);
  const declaredSizes = lines.length ? lines : (write.sizes || []).map((item) => ({
    size_text: item.size_text, sellable: null, missing: Boolean(item.missing), checked: false,
  }));
  // ⭐⭐ 2026-10-15（task-28 · 她逐字）：「退货**严格按照实时库存里的数据来，只展示有数量的尺码**」
  //   · `sellable === 0` ⇒ **不列**（不是"列出来但退不了"✗ —— 那是她上一条口径的字面结果，她不认 ✓）；
  //   · `sellable` **不是数字** = **取不到 / 未确认** ⇒ ⭐ **仍然列出** + 标注"取不到" ✓
  //     🔴「**0**」与「**取不到**」**必须区分** —— 把"取不到"也当 0 藏掉会把**能退的码**藏了 ✗。
  const sizes = declaredSizes.filter((item) => !Number.isFinite(item.sellable) || item.sellable > 0);
  // 整款都是 0（且有尺码这一读）⇒ 给她一句人话（**不是空白页** ✗）
  const noReturnableStock = declaredSizes.length > 0 && sizes.length === 0;
  // ⭐⭐ 2026-10-15（task-23 · 她逐字：「直接就是出来实时库存里的**尺码和数量**」）：
  //   ① 每行多一个"当前库存数量"列 —— 数从**扫码那一次已经取到的** `sellable` 来（**不新增读表** ✗）；
  //      取不到（`sellable` 不是数字）⇒ **如实说"暂时取不到"**，**绝不用假数字占位** ✗；
  //   ② 数量默认值 = 写侧那一份配置（`purchaseReturn.defaultQuantity`）—— **不再写死 1** ✗；
  //   ③ 表单上挂几个 `data-*`（字段名 / 上限 / 三句人话）⇒ 那段**唯一**脚本据此拦截 ✓
  //      （脚本里**不写死任何字段名/文字** ✗ —— 她 2026-10-09 白屏之后"只许一段脚本"那条规矩照旧 ✓）。
  const rf = SCAN_PAGE.returnForm;
  const returnConfig = SCAN_WRITE.purchaseReturn;
  const rows = noReturnableStock ? '' : sizeRowsHtml({
    sizes,
    name: fields.returnSizes,
    quantityPrefix: fields.returnQuantityPrefix,
    quantityLabel: t.replenishQuantityLabel,
    checkedOf: () => false,
    defaultQuantity: returnConfig.defaultQuantity,
    // ⚠️ 走到这里的行**一定是"有数量"的**（0 已被上面滤掉 ✓）⇒ 数量列直接就是那个数；
    //    `cap` = 她那条口径的判据（**退货数量 ≤ 当前库存** ✓ 原样保留）；
    //    取不到的行（`sellable` 不是数字）⇒ 如实说"取不到"、**不带上限** ✓
    stockOf: (item) => (Number.isFinite(item.sellable)
      ? { view: 'return-stock', text: String(item.sellable), cap: item.sellable }
      : { view: 'return-stock-unknown', text: rf.stockUnknown, cap: null }),
  });
  // ⚠️ 三种"没东西可勾"要分清（都**不空白** ✓）：
  //   · 整款 0 库存 ⇒ `return-no-stock`（她说的"这一款现在没有可退的库存" ✓）
  //   · 尺码这一读**取不到** ⇒ `return-sizes-unknown`（如实说取不到 ✓ 不硬编假尺码 ✗）
  const sizesNotice = noReturnableStock
    ? `<p class="hint" data-view="return-no-stock">${escapeHtml(rf.noReturnableStock)}</p>`
    : (sizes.length ? '' : `<p class="hint" data-view="return-sizes-unknown">${escapeHtml(rf.sizesUnknown)}</p>`);
  // ⭐⭐ 2026-10-16（task-47 · 业务负责人真机逐字：「我首先是点击了退货的 tab 页，**然后只有一个退货按钮**，
  //   点击了退货按钮之后，才出现的下面的内容」）：
  //   🔴 **改前逐字**：`<details class="disclosure" data-view="purchase-return">`（**没有 open**）
  //      —— `<details>` **默认收起** ⇒ 首屏**只剩那颗 `<summary>`**：实心主色、通栏
  //      （:215 「.disclosure__summary」= background var(--primary) + color var(--surface)），
  //      文案 = v.purchaseReturn = **「退货」** ⇒ 她看到的就是「**一颗退货按钮**」✓，点它才展开出表单 ✓
  //   ✅ **2026-10-16 晚 改后逐字（本刀）**：**去掉 `<details>` / `<summary>` 包壳**，表单直接渲染 ——
  //      改前逐字：`<details class="disclosure" data-view="purchase-return" open>` + 下一行
  //                 `<summary class="disclosure__summary">${escapeHtml(v.purchaseReturn)}</summary>`
  //      改后逐字：**这两行都删掉**（`<section class="card">` 外层保留 ✓，`<form …>` 紧跟其后 ✓）
  //      **依据**：她 2026-10-16 真机截图 + 逐字「退货那个确实点击了之后确实是出现了表单，
  //        但是那个**退货按钮为什么还有呢，不需要了**」—— 上一刀加了 `open` ⇒ 表单**已经首屏可见** ✓
  //        ⇒ 那颗实心通栏 `<summary>`（写着「退货」）就**纯多余**了 ✗（她还以为要多点一下 ✓）
  //      **判据**：`test/returnBlockFirstScreen.test.js`（塞回 `<details>`/`<summary>` ⇒ 红 ✓）
  //   ⭐⭐ **定位标记 `data-view="purchase-return"` 迁到 `<form>` 上**（**只去折叠壳、不动标记** ✓）：
  //      全仓有 6+ 处用例拿它当"退货表单从哪开始"的**锚**（例：`html.indexOf('data-view="purchase-return"')`）
  //      ⇒ 标记一起删掉会得到 `indexOf === -1` 的空切片 —— 那是**静默假绿** ✗（比红更坏）
  //      ⇒ 标记留在语义相同的位置（**退货表单那一元素**上）✓ 那些用例一个字都不用改 ✓
  //   ⚠️ 「一键补货」那个同形的 `<details>`（下面 one-tap-replenish）**这一刀不动** ✗
  //   🔴 **2026-10-16 晚 收尾（标签配对 · 改前逐字 → 改后逐字 → 依据）**：
  //      改前逐字（WIP 那一版把 `</details>` **删错了地方**）：补货块 `</form>` 之后**少了** `</details>` ✗，
  //        而本函数 `</form>` 之后**多留了一个** `</details>` ✗（开始标签已删、闭合标签还在 ⇒ 标签不配对）
  //      改后逐字：`</details>` **还给补货块**（`</form>` 后一行，与 WIP 前逐字一致 ✓）；
  //        本函数 `</form>` 后那个 `</details>` **删掉**（退货块**一个 `<details>` 标签都不剩** ✓）
  //      依据：本刀的口径是「**只去退货那一个折叠壳**」＋「**补货块一个字不动**」
  //        ⇒ 开始标签与闭合标签必须**同进同出**；`</section>` 虽然能让浏览器容错补上，
  //          但源码不再逐字可信，且"删错了那一个"正是最该被拦住的错 ✗
  //      判据：`test/collapseSemanticsSentinel.test.js` ①（补货块**自己**的 `</details>` 必须在 ⇒ 少一个即红 ✓）
  //        ＋ `test/returnBlockFirstScreen.test.js` AC-RF1a（退货块里 `</details>` 也不许有 ✓）
  return `<section class="card">
<form method="post" action="${escapeHtml(write.postAction)}" class="write-form"
data-view="purchase-return"
data-return-sizes-field="${escapeHtml(fields.returnSizes)}"
data-return-qty-prefix="${escapeHtml(fields.returnQuantityPrefix)}"
data-return-max-sizes="${escapeHtml(String(returnConfig.maxSizes))}"
data-return-max-quantity="${escapeHtml(String(returnConfig.maxQuantity))}"
data-return-required-text="${escapeHtml(rf.sizesRequiredText)}"
data-return-quantity-text="${escapeHtml(rf.quantityInvalidText)}"
data-return-limit-text="${escapeHtml(rf.sizesLimitText)}"
data-return-stock-text="${escapeHtml(rf.stockLimitText)}"
data-return-hint-view="${escapeHtml(rf.hintView)}">
${hiddenField(fields.action, write.actions.purchaseReturn)}${pageBuildField()}
${hiddenField(fields.submitKey, write.returnKey)}
${sizesNotice}
<p class="hint" data-view="${escapeHtml(rf.hintView)}" hidden></p>
${rows}
${sizes.length ? `${purchaseAmountRowHtml(write)}
${multiItemBlockHtml(write, view, 'return', page)}
<button type="submit" class="btn btn--primary"${submitFeedbackAttrs(write)}>${escapeHtml(rf.submitLabel)}</button>
${draftSaveButtonHtml(write, PURCHASE_RETURN_REALM, config, page)}` : ''}
</form>
</section>`;
};

/**
 * ⭐⭐ **只渲染当前领域那一块**（2026-10-09 手机白屏之后的改法）。
 *
 * **六个领域**各自的正文（每个都带 `realm-block--<领域>` 标记，方便对照 / 断言）：
 *   · `sales`            —— 销售建单表单；
 *   · `replenish`        —— 补货（原「采购」领域里的【一键补货】）；
 *   · `purchase_return`  —— 退货；
 *   · `inventory`        —— 库存表；
 *   · `product`          —— 货品标签（**不上条**，旧 `?from=product` 照旧能开 ✓）。
 *
 * ⭐⭐ 2026-10-14 晚 cut B（改前逐字 → 改后逐字 → 依据）：
 *   改前逐字：上面还列着「`accept` —— 验收（有活跃验收会话时那一块；没有就一张人话卡）；」
 *   改后逐字：**那一行删掉**（`accept` 已从 `REALMS` 退场）
 *   依据：业务负责人逐字「**`/s/accept` 这条路要彻底拆掉**」；旧 `?from=accept` 现在按
 *        既有口径回落缺省（销售）✓（不报错、不白屏 ✓）。
 *
 * ⚠️ **只有当前这一块进 HTML**（另外五块**连字符串都不拼**）—— 页面里没有"靠 CSS 藏起来"
 *    的东西，也就没有"脚本没跑 ⇒ 什么都没显示"的可能。
 * ⚠️ 认不出的领域一律回落缺省（`resolveRealm` 在路由那一层已经做过一次；这里再兜一次，
 *    **渲染层永远不抛、永远有正文**）。
 */
const realmEmptyHtml = (realm, config) => {
  const textKey = REALM_EMPTY_TEXT_KEYS[realm] || REALM_EMPTY_TEXT_KEYS[DEFAULT_REALM];
  const body = config.texts[textKey] || config.texts.realmEmptySalesBody;
  return `<section class="card state-msg">
<h1>${escapeHtml(config.texts.realmEmptyTitle)}</h1>
<p>${escapeHtml(body)}</p>
<a class="btn" href="?from=${escapeHtml('inventory')}">${escapeHtml(config.texts.realmEmptyAction)}</a>
</section>`;
};

/**
 * ⭐⭐ **只渲染当前领域那一块**（2026-10-09 手机白屏之后的改法）。
 *
 * **六个领域**各自的正文（每个都带 `realm-block--<领域>` 标记，方便对照 / 断言）：
 *   · `sales`            —— 销售建单表单；
 *   · `replenish`        —— 补货（原「采购」领域里的【一键补货】）；
 *   · `purchase_return`  —— 退货；
 *   · `inventory`        —— 库存表；
 *   · `product`          —— 货品标签（**不上条**，旧 `?from=product` 照旧能开 ✓）。
 *
 * ⭐⭐ 2026-10-14 晚 cut B（改前逐字 → 改后逐字 → 依据）：
 *   改前逐字：上面还列着「`accept` —— 验收（有活跃验收会话时那一块；没有就一张人话卡）；」
 *   改后逐字：**那一行删掉**（`accept` 已从 `REALMS` 退场）
 *   依据：业务负责人逐字「**`/s/accept` 这条路要彻底拆掉**」；旧 `?from=accept` 现在按
 *        既有口径回落缺省（销售）✓（不报错、不白屏 ✓）。
 *
 * ⚠️ **只有当前这一块进 HTML**（另外五块**连字符串都不拼**）—— 页面里没有"靠 CSS 藏起来"
 *    的东西，也就没有"脚本没跑 ⇒ 什么都没显示"的可能。
 * ⚠️ 认不出的领域一律回落缺省（`resolveRealm` 在路由那一层已经做过一次；这里再兜一次，
 *    **渲染层永远不抛、永远有正文**）。
 */

const realmBlockHtml = (realm, view, config, write, page = {}) => {
  const id = REALMS.some((item) => item.id === realm) ? realm : DEFAULT_REALM;
  const wrap = (inner) => `<div class="realm-block realm-block--${escapeHtml(id)}">\n${inner}\n</div>`;
  // ⭐ 2026-10-13：「上新」是**外链 tab**（`external: true`），**不是页面领域** ⇒
  //   它没有自己的块内容（也没有 `?from=new` 入口）。
  //   ⚠️ 不接这一支的话，`id` 会落到**销售**那一块（它会出现「加入本单」✗——一颗外链 tab 不该渲染成建单表单）。
  if (id === NEW_REALM) return wrap(realmEmptyHtml(NEW_REALM, config));

  if (id === 'inventory') {
    // ⭐⭐ 2026-10-14 晚（业务负责人逐字）：「**库存的表格里还是没有排除特殊码**」＋她纠正过的口径：
    //   「特殊码**有货就正常显示**，**没货就显示在折叠区**」（销售 / 补货 / 库存**同一套** ✓）
    //   ⇒ 改前：缺货的特殊码**既在表里、又在折叠区**（重复 ✗）
    //   ⇒ 改后：**表里排除"缺货的特殊码"** ✓（它们在折叠区 ✓）；
    //           ⭐ **有货的特殊码照旧在表里** ✓（一条都不许少 ✗）；普通码**一条不少** ✓
    //   ⭐ 判定复用**既有那一处** helper（`foldedSpecialRowsOf` = 缺货 ∩ 特殊码 ✓ 三处共用 ✓ 不新写 if ✗）
    const foldedRows = foldedSpecialRowsOf(view);
    const foldedSizes = new Set(foldedRows.map((row) => String(row.size_text)));
    const foldedInventory = foldedRows.map((row) => ({
      size_text: String(row.size_text), sellable: sellableCountOf(row, view?.columns),
    }));
    const tableRows = (Array.isArray(view?.rows) ? view.rows : [])
      .filter((row) => !foldedSizes.has(String(row.size_text)));
    return wrap(stockTableHtml({ ...view, rows: tableRows }, config) + specialFactsHtml(foldedInventory, REALM_TEXTS));
  }
  if (id === 'product') return wrap(labelBlockHtml(view, page?.print));
  if (id === REPLENISH_REALM) {
    // ⭐ 2026-10-11：**补货**从原「采购」领域里独立成一块（内容一个字没变）。
    const form = write && write.enabled !== false && write.replenishEnabled !== false
      ? replenishFormHtml(view, write, page, config)
      : '';
    return wrap(form || realmEmptyHtml(REPLENISH_REALM, config));
  }
  if (id === PURCHASE_RETURN_REALM) {
    // ⭐⭐ 2026-10-14（业务负责人最终口径 · 见 `docs/scan-page-tabs-2026-10-14.md`）：
    //   「退货」**回到条上** ✓ ⇒ 本块 = **退货表单**（`returnFormHtml` 一直在 ✓
    //   只是 2026-10-13 那版被"配品页"占着 ✗）· 能力一个字没删 ✗
    //   ⇒ 「配品」另开新领域 `accessory`（任务 B ✓ 待接路由/动作配置 ✓）
    const form = write && write.enabled !== false ? returnFormHtml(view, write, page, config) : '';
    // ⭐⭐ 2026-10-15（task-31 · 她真机 21:47「有库存点退货 ⇒ 只有一颗按钮」）：
    //   只读复现：**同一款 `HL55173-1|黑色|A` ⇒ `rows=11`、退货块 11 行** ✓（不是"有数据不画" ✗）；
    //   唯一能画出"一句人话 + **一颗**按钮"的是 `realmEmptyHtml` **通用兜底卡** —— 它只在
    //   "退货表单**根本没画出来**"时出现（写入口没接上 ⇒ `write` 为空 / `enabled:false` ✗）。
    //   🔴 那张卡的句子是「**这一款现在没有可退的尺码。**」＋ 一颗"看看这一款的库存 →" ⇒
    //      **有库存时这么说就是假话** ✗（她今晚看到的形状 ✓）。
    //   ⇒ 表单没画出来 ⇒ **如实说**（`returnForm.formMissing` ✓ 文案在 config 里）；
    //      "这一款真的没有可退的库存"是**另一件事**（task-28 的 `noReturnableStock` ✓）—— 两者分开 ✗。
    if (form) return wrap(form);
    return wrap(`<section class="card state-msg" data-view="return-form-missing">
<h1>${escapeHtml(config.texts.realmEmptyTitle)}</h1>
<p>${escapeHtml(SCAN_PAGE.returnForm.formMissing)}</p>
</section>`);
  }

  if (id === 'accessory') {
    // ⭐⭐ 2026-10-14（业务负责人：「配品的单独销售」· 见 `docs/scan-page-tabs-2026-10-14.md` 任务 B）：
    //   本页 = 配品单独销售：**选「其他配品」的名称 ＋ 成交金额**（都是现货 ✓）
    //   🔴 **不扣库存** —— 依据 `docs/sales-total-and-accessory-render-2026-10-07.md:75` C5 逐字：
    //      「**配品不写尺码、不产生库存动作**」✓ ⇒ 落销售主表 + 销售明细 + 收款明细 ✓（走既有能力 ✓）
    //   ⚠️ 现状：提交用**既有** `actions.addAccessory`（把配品加进本单 ✓ 能力一直都在 ✓）；
    //      ⭐「**一步到位**（不经资金页 / 数量可填 / 付款情况=全付）」需要**路由 + 动作配置**各加一处，
    //      而那两处**当前归 Lead**（他在做"异步建单"那件 ✗）⇒ **等他收完再接** ✓（不并行改同一文件 ✗）
    const accessories = Array.isArray(write?.accessories) ? write.accessories : [];
    const t = write?.texts || {};
    const fields = write?.fields || {};
    const usable = Boolean(write && write.enabled !== false && accessories.length);
    const body = usable
      ? `<h2 class="stock__heading">${escapeHtml(t.accessoryLabel || '')}</h2>
<form method="post" action="${escapeHtml(write.postAction)}" class="write-form" data-view="accessory-sell">
${hiddenField(fields.action, write.actions.addAccessory)}
${hiddenField(fields.submitKey, write.saleKey)}
<div class="form-row"><label>${escapeHtml(t.accessoryLabel || '')}</label><select name="${escapeHtml(fields.accessory)}"><option value="">${escapeHtml(t.accessoryPlaceholder || '')}</option>${accessories.map((item) => `<option value="${escapeHtml(item.record_id)}">${escapeHtml(item.name)}</option>`).join('')}</select></div>
<div class="form-row"><label>${escapeHtml(t.accessoryAmountLabel || '')}</label><input name="${escapeHtml(fields.amount)}" inputmode="decimal" placeholder="${escapeHtml(t.accessoryAmountPlaceholder || '')}"></div>
<button type="submit" class="btn"${submitFeedbackAttrs(write)}>${escapeHtml(t.addButton || '')}</button>
</form>`
      : '';
    return wrap(body || realmEmptyHtml('accessory', config));
  }

  // sales（缺省）
  if (!write || write.enabled === false || write.saleEnabled === false) {
    return wrap(realmEmptyHtml('sales', config));
  }
  // ⚠️ 2026-10-11：「刚加入本单」那一句**上移到顶部的本单条**（`draftBarHtml`）——
  //    她无论停在哪个领域（库存 / 补货 / 退货 / 验收 / 货品）都该立刻看见 N+1。
  return wrap(saleFormHtml(view, write, page, config));
};

/**
 * 正常页：**本单条**（顶部固定）+ 领域切换（真链接）+ 身份区 + 单价 + **当前领域那一块**。
 *
 * ⚠️ 渲染层**绝不抛**：任何一块拼装出问题都退化成一张人话卡片 ——
 *    这一页对她是"扫码就能看"，**空白页是最坏的结果**（比她看到一句"暂时打不开"还坏）。
 *
 * `page.userAgent`（可选，路由从请求头传）= 【继续扫下一个】那一个按钮的判据
 * （见 `canScanNextWithFeishu`）；不传 = 认成"不是飞书客户端" ⇒ 给那句人话，不给死按钮。
 */
/**
 * ⭐⭐ 2026-10-13（她的口径，逐字）：「"提交这一单"就说明**这一单已经结了**呀，如果我再操作的话，
 *   **应该就跟这一单没关系了**，除非我是选"**再加一双**"呀」
 *  ⇒ **销售领域入口页**（= 她说的"销售首页"）：**不带任何编号/货号** ✗，只有
 *     ①（可选）「上一单已提交（单号）」（来自回跳 URL 的 `?done=` ✓ 无状态）
 *     ②「请扫下一个标签」+ ③ 手输编号兜底框
 *  ⚠️ 文案全走 config（模板里不写中文 ✓）；**不含本单清单**（那是"同一单"才有的东西 ✗）。
 */
const renderSalesHome = ({ config = SCAN_PAGE, orderNo = '', basePath = '' } = {}) => {
  const texts = config.texts || {};
  const prefix = String(basePath || '');
  const notice = String(orderNo || '').trim()
    ? `<p class="notice notice--ok" data-view="sales-home-submitted">`
      + `${escapeHtml(fillText(texts.salesHomeJustSubmitted || '', { orderNo: String(orderNo).trim() }))}</p>`
    : '';
  return renderDocument({
    title: texts.salesHomeTitle || texts.pageTitle,
    config,
    content: `<main class="page" data-view="sales-home">
${notice}
<h1 class="title">${escapeHtml(texts.salesHomeTitle || '')}</h1>
<p class="notice">${escapeHtml(texts.salesHomeHint || '')}</p>
<form method="get" action="${escapeHtml(prefix)}/" class="write-form" data-view="sales-home-manual">
<label class="field"><span>${escapeHtml(texts.salesHomeManualLabel || '')}</span>
<input type="text" name="number" value="" autocomplete="off" inputmode="text"></label>
<button type="submit" class="btn btn--primary">${escapeHtml(texts.salesHomeManualSubmit || '')}</button>
</form>
</main>`,
  });
};

const renderScanPage = (view = {}, config = SCAN_PAGE, write = null, realm = DEFAULT_REALM, page = {}) => {
  const safeRealm = resolveRealm(realm);
  let block;
  try {
    block = realmBlockHtml(safeRealm, view, config, write, page);
  } catch (error) {
    block = `<div class="realm-block realm-block--${escapeHtml(safeRealm)}">${realmEmptyHtml(safeRealm, config)}</div>`;
  }
  // ⚠️ 验收模式下**不挂销售本单条**：那一条讲的是"销售本单几双"，与"这次验收扫了几双"
  //    是两件事，同屏出现只会让她看错数（验收自己的本单条在验收块里）。
  const bar = draftBarHtml(write, config, page?.userAgent, safeRealm, {
      // ⭐ 2026-10-12：销售页上那颗**带钱**的提交表单就在下面 ⇒ 本单条不再放第二颗提交按钮。
      moneyFormOnPage: safeRealm === DEFAULT_REALM && Boolean(write),
    });
  // ⭐⭐ 2026-10-16（task-S2 ·「你有一份草稿，接着录吗？」）—— **有草稿才出**（没有 = 空串 ✓）：
  //   位置放在**最上面**（本单条之后、货品卡之前）⇒ 她一进来就看得到 ✓（她的口径："进去就提示"）。
  //   🔴 **待接线**：【接着录】那颗链接的落点（路由读 `?resume=1`）在 **S3**（本刀不碰 `routes/**` ✗）。
  const draftNotice = draftNoticeHtml(safeRealm, config, page);
  // ⭐⭐ 2026-10-12（编号兜底）：编号缺段（典型 = 缺「类别」）但按（货号 + 颜色）**唯一命中**时，
  //    页面上出**一条轻提示**（一句话，不写说明书）——她才知道"这个标签该重打了"。
  const fallbackHint = view.number_fallback
    ? `<p class="notice">${escapeHtml(config.texts.numberFallbackHint)}</p>` : '';
  return renderDocument({
    title: fillText(config.texts.pageTitle, { itemNo: view.item_no || view.number, number: view.number }),
    config,
    // ⭐⭐ 2026-10-14（业务负责人逐字）：「**② 和 ③ 换一下位置，即先 3 后 2**」
    //   ⇒ **货品卡在上、6 格 tab 条在下** ✓（原来是反的 ✗）· 只改顺序 ✓ 内容一字不动 ✗
    content: `${bar}
${draftNotice}
${identityHtml(view, config)}
${realmBarHtml(safeRealm, page?.userAgent)}
${noScriptHtml()}
${fallbackHint}
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
 *
 * ⭐⭐ 2026-10-12（业务负责人真机口径）：「页面跳转到提交成功页……给一个**链接**让我能回到扫码页」——
 * `backPath` + `backLabel`（+ 可选 `backHint`）就是那颗**回扫码页**的链接；
 * `tone` 只用来加一个类（`success` ⇒ H1 走主色）。
 * 🔴 **不传这三样时，输出与改前逐字相同**（既有那些结果页一个字都没动）。
 */
const renderScanMessagePage = ({
  title, body, number = '', requestId = '', retryHint = '', details = [],
  backPath = '', backLabel = '', backHint = '', tone = '',
  // ⭐⭐ 2026-10-12（方案 A）：成功后**自动回首页**（`returnPath` = 服务端渲染的确定 URL ✓）
  //    + 一颗【返回扫码】兜底（href 与自动跳转**同一个 URL** ⇒ 唯一来源 ✓）。
  returnPath = '', returnLabel = '', returnDelaySeconds = 0, autoReturnUrl = '',
  // ⭐ 2026-10-13（成功页三入口）：透明的"追加动作块"—— 不传 = 既有页面逐字不变 ✓
  extraActionsHtml = '',
}, config = SCAN_PAGE) => renderDocument({
  title,
  config,
  requestId,
  // ⚠️ 用 `<meta http-equiv="refresh">`（**不是 JS**）：老手机 / 禁脚本也能跳，且 URL 是**服务端写的** ✓
  head: autoReturnUrl && returnDelaySeconds > 0
    ? `<meta http-equiv="refresh" content="${Number(returnDelaySeconds)};url=${escapeHtml(autoReturnUrl)}">`
    : '',
  // ⚠️ **`<section class="card state-msg">` 这一串逐字不变**（连成功页也一样）：
  //    有断言按这串取"她看得见的那张卡"，在 section 上多加属性/class 会把它们悄悄打红。
  //    所以"成功"这个色调只挂在 **h1 的 class** 与那颗 ✅ 上。
  content: `<section class="card state-msg">
${tone === 'success' ? '<p class="state-msg__mark" aria-hidden="true">✅</p>' : ''}
<h1${tone === 'success' ? ' class="state-msg__title--success"' : ''}>${escapeHtml(title)}</h1>
<p>${escapeHtml(body)}</p>
${details.length ? `<ul class="result">${details.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
${number ? `<p>${escapeHtml(config.texts.notFoundHint)}<span class="number mono">${escapeHtml(number)}</span></p>` : ''}
${retryHint ? `<p class="hint">${escapeHtml(retryHint)}</p>` : ''}
${backPath && backLabel ? `<a class="btn btn--primary back-link" href="${escapeHtml(backPath)}">${escapeHtml(backLabel)}${backHint ? `<span>${escapeHtml(backHint)}</span>` : ''}</a>` : ''}
${returnPath && returnLabel ? `<a class="btn" data-view="success-return" href="${escapeHtml(returnPath)}">${escapeHtml(returnLabel)}</a>` : ''}
${extraActionsHtml}
</section>`,
});

/**
 * ⭐⭐ **提交成功页**（`POST submit_order` 写成功之后 POST 直接渲染的就是这一页；
 * 不 303、不回原页 —— 业务负责人的口径是"点完**直接**告诉我成功"）。
 *
 * 🔴 它**不是**新的书写方式，只是"消息页 + 成功色调 + 一颗回扫码页的链接"这一组约定的**一个名字**：
 *    `renderScanMessagePage({ tone: 'success', backPath, backLabel, ... })`。
 *    这样"成功页长什么样"只有一处定义，将来改版不用满仓库找。
 * 🔴 只在**真的写成功**时用：建单失败 ⇒ 照旧报错页；建单成功但后面某步没写完 ⇒
 *    `partialFailed*`（**不许**显示成功）。
 */
/**
 * ⭐⭐ 2026-10-13「金额两步走」第 2 步：**整单付款屏**（提交成功之后落到这里）。
 *
 * 口径（业务负责人逐字）：三档「全付 / 部分付 / 未付」**横向一排**（垂直占屏太高 ✗）
 *   + 付款方式**可加多行** + **赠品** + 「**跳过**」。
 * ⭐ **可填可不填** ⇒ 不填 = 这一单先记成**待补充**的信息单（**不是失败** ✗ 不许报错拦人）。
 *
 * ⚠️ 本轮只落**页面与入口**（文案/结构/横向布局由 AC 钉住）；
 *    "填进去的钱怎么落库"要走**既有**的唯一收款入口 —— 那一支还没接（见 PR 说明），
 *    所以这一屏的按钮**不假装已经记了钱** ✗：只给「跳过」与「去工作台补收款」两条真路径。
 */
const renderSalePaymentStepPage = ({
  write = null, orderNo = '', config = SCAN_PAGE, basePath = '',
  // ⭐ 2026-10-13（ⓒ 落点）：`successPath` = 成功页（【跳过】就去那里）；
  //    `workbenchPath` = 既有「补记收款」入口（默认 `/workbench`）。
  successPath = '', workbenchPath = '',
  // ⭐ 跳过 = POST 动作（`paymentStep.skipAction`）；这三个隐藏字段把"成功页要显示的事实"带过去 ✓
  postAction = '', submitKey = '', count = 0, reused = false,
  // ⭐ 第 2 步付款要写进「收款明细」⇒ 需要刚提交那张销售主表的 record_id（`submitSale` 返回里有 ✓）
  salesEntryRecordId = '',
  // ⭐⭐ 2026-10-14（她：**点资金页按钮才建单**）：结算校验没过时**原地重渲染这一页**并把这句人话带回来 ✓
  //   （文案由**调用方**给 —— 用的是既有那几条文案真源 ✓ 这里只负责画 ✗ 不新造中文 ✓）
  notice = '',
} = {}) => {
  const step = { ...(config.paymentStep || {}) };
  const t = (write && write.texts) || {};
  const fields = (write && write.fields) || {};
  // ⚠️ `successPath` / `workbenchPath` 两个入参**保留**（调用方还在传 ⇒ 签名不动 ✓）——
  //    但 2026-10-16 那一刀之后，本页**不再渲染任何"跳走"的东西**（那颗 `<a href={销售首页}>`
  //    与工作台提示都删了 ✗）⇒ 原来"没有 successPath 就会给出一个点不动的链接"那个风险**没了** ✓。
  // ⭐ 2026-10-16 A2a：**三档那一块不再渲染**（`paymentStatusHtml` 已退场 ✓ 见上面那条注释）——
  //    资金页现在只剩：**收款行**（`paymentRowsHtml`）＋ 赠品 ✓；档位由金额自动定（路由那一步 ✓）。
  const rowsBlock = paymentRowsHtml(write);
  const giftFieldHtml = `<div class="form-row"><label>${escapeHtml(t.giftLabel || '')}</label><input name="${escapeHtml(fields.gift || 'gift')}"></div>`;
  // ⭐⭐ 2026-10-13 结构重排（**行为不变**）：三件套（三档 / 收款行 / 赠品）先攒成一块，
  //    由 `payForm` 统一放进"提交整单付款"那张表单里（**在表单外就是"提交上去什么都没有"** ✗）。
  //    ⚠️ 还没配 `payAction` 时 ⇒ 退化成原来那个 `<div class="payment-step">`（逐字同形 ✓ 不吃亏 ✓）
  //    ⭐ 2026-10-16 A2a：三件套里的**「三档」那件已退场** ⇒ 现在只有**收款行 + 赠品** ✓
  const paymentFieldsHtml = `${rowsBlock}${giftFieldHtml}`;
  const payForm = (postAction && step.payAction)
    ? `<form method="post" action="${escapeHtml(postAction)}" data-view="payment-pay">
<input type="hidden" name="${escapeHtml(fields.action || 'action')}" value="${escapeHtml(step.payAction)}">
${submitKey ? `<input type="hidden" name="${escapeHtml(fields.submitKey || 'submit_key')}" value="${escapeHtml(submitKey)}">` : ''}
<input type="hidden" name="order_no" value="${escapeHtml(orderNo)}">
<input type="hidden" name="count" value="${escapeHtml(String(count))}">
${salesEntryRecordId ? `<input type="hidden" name="sales_entry_record_id" value="${escapeHtml(salesEntryRecordId)}">` : ''}
${reused ? '<input type="hidden" name="reused" value="1">' : ''}
${paymentFieldsHtml}
<button type="submit" class="btn btn--primary" data-tap-target="${escapeHtml(step.payAction || '')}"${submitFeedbackAttrs(write)} data-submit-feedback="${escapeHtml(submitSubmittingText(write))}" data-submitting-elapsed="${escapeHtml(submitSubmittingElapsedText(write))}">${escapeHtml(step.payButton || '')}</button>
</form>`
    : `<div class="payment-step">${paymentFieldsHtml}</div>`;
  return renderDocument({
    title: step.heading,
    config,
    // ⭐ `data-view="payment-step"` = 第 2 步页的**稳定标记**（测试顺着它决定"要不要再走一步"✓）
    content: `<section class="card state-msg" data-view="payment-step">
<h1>${escapeHtml(step.heading)}</h1>
${orderNo ? `<p class="foot">${escapeHtml(orderNo)}</p>` : ''}
<p class="hint">${escapeHtml(step.pendingNote || '')}</p>
${String(notice || '').trim()
    // 🔴 2026-10-16 P0：拦下的原因**必须醒目**（她真机"看着像坏了"✗）——从 `hint`（小字）
    //   提到 `form-alert`（红色告警级 ✓）；`data-view` 钩子**保留**（既有判据还在用 ✓）
    ? `<p class="hint" role="alert" data-emphasis="alert" data-view="payment-step-notice">${escapeHtml(String(notice).trim())}</p>`
    : ''}
${payForm}
<!-- 🔴 2026-10-16（她逐字：「资金页上……那三处提示【全删】……全删就对了」）：
     原来这里还有一句工作台提示（step.workbenchHint）——**整句删** ✗（键也一起删了 ✓）。 -->
<!-- 🔴 2026-10-16（她逐字：「资金页实际上就应该有两个按钮」= 提交 / 跳过）⇒ **资金页不再渲染
     那颗跳工作台的链接** ✗（她把它误读成第三种付款方式）——补收款去成功页那颗 ✓ -->
${postAction ? `<form method="post" action="${escapeHtml(postAction)}">
<input type="hidden" name="${escapeHtml(fields.action || 'action')}" value="${escapeHtml(step.skipAction)}">
${submitKey ? `<input type="hidden" name="${escapeHtml(fields.submitKey || 'submit_key')}" value="${escapeHtml(submitKey)}">` : ''}
<input type="hidden" name="order_no" value="${escapeHtml(orderNo)}">
<input type="hidden" name="count" value="${escapeHtml(String(count))}">
${reused ? '<input type="hidden" name="reused" value="1">' : ''}
<button type="submit" class="btn"${submitFeedbackAttrs(write)} data-submit-feedback="${escapeHtml(submitSubmittingText(write))}" data-submitting-elapsed="${escapeHtml(submitSubmittingElapsedText(write))}">${escapeHtml(step.skipButton)}</button>
</form>` : ''}
</section>`,
  });
};

const renderSaleSuccessPage = (input = {}, config = SCAN_PAGE) => {
  const success = { ...(config.saleSuccess || {}) };
  const orderNo = String(input.order_no || input.orderNo || '').trim();
  const number = String(input.number || '').trim();
  // ⚠️ 单号按 `order_no` 原样显示（形如 `XSD-…`）；没有就不编一个 ✗。
  const orderLine = orderNo ? `<p class="foot">${escapeHtml(orderNo)}</p>` : '';
  return renderScanMessagePage({
    ...input,
    tone: 'success',
    // 主文案「本单提交成功」+ **单号**（她的口径：成功页要能一眼看到单号）
    title: input.title || success.title,
    // ⭐⭐ 2026-10-16（她逐字：「用户提交之后**都是一个成功页**，说『**已提交成功，数据会更新**』
    //   类似这类的话就行了……」）⇒ 四条链路**同一句**；文案的家在 `config/scanPage.js` ✓
    //   ⚠️ 调用方另有正事要说时**以它为准**（例：异步那条已给她「本单已创建成功（单号）」✓
    //      —— 那是她 2026-10-15 的逐字口径，本刀**不推翻** ✗）；没人给正文时 = **那一句** ✓
    body: input.body || success.message,
    details: [...(input.details || []), orderLine].filter(Boolean),
    // 🔴 三入口（`continueButton` / `workbenchButton` / `fillPaymentButton`）**已全删** ✗ ——
    //   她逐字：「成功页它**不需要做任何跳转**，也**不需要做任何链接**」⇒ 这里**一个 `<a>` 都不给** ✗
    //   （路由自己给的「再录一单 / 回扫码页」那几个既有去向**不归这一刀管** ✓ 见 `successReturnFields`）
    ...(number ? { number } : {}),
  }, config);
};

/**
 * 🔴 **最后一道兜底页**（"绝不空白"的物理保证）。
 *
 * 为什么单独一个函数：上面那些页都依赖 `config`。万一 `config` 本身坏了 /
 * 渲染抛到一个没预料到的地方，路由需要一个**几乎不可能再抛**的渲染器 ——
 * 只有三行字符串拼接 + `escapeHtml`，不需要任何配置、不读文件、不解析任何东西。
 * ⚠️ 任何输入（`undefined` / `null` / 对象 / 带标签的字符串）都**必须**返回一段有正文的 HTML。
 */
/**
 * 2026-10-13（她：加载到中间一直白屏）—— 骨架屏：先出页面，绝不空白。
 * 取数要 4~6 秒（真测 product 1969 + sizes 768 + inventory 1410），这段是服务端整页渲染
 * ⇒ 读数据回来之前整页是白的。这一屏不读任何表、纯字符串拼接：她扫到的那串 / 货号 / 颜色
 * + 尺码区占位 + 正在读取…，然后由同一段脚本 fetch ?data=1 填进来。
 * 整页仍然只有一段脚本（哨兵 scanAcceptSelfServe / labelPrintScanEntry / scanPrintFeedback）。
 * 路由那一半（先发骨架再取数）还没接，本函数只负责渲染。
 */
const renderScanSkeleton = (view = {}, config = SCAN_PAGE) => {
  const texts = { ...SCAN_PAGE.texts, ...(config?.texts || {}) };
  const number = String(view?.number || '').trim();
  const itemNo = String(view?.item_no || (number.split('|')[0] || '')).trim();
  const color = String(view?.color || (number.split('|')[1] || '')).trim();
  const meta = [color].filter(Boolean).join(' · ');
  const script = `<script>
(function(){
  var host = document.getElementById('scan-skeleton');
  if (!host || !window.fetch) return;
  var number = host.getAttribute('data-number') || '';
  // 2026-10-13: fetch THIS page's own data fragment - not a hardcoded /s/.
  //   The skeleton is served for both mounts (/s/<number> and /r/<recordId>); hardcoding
  //   /s/ made the record page pull the home fragment and replace itself with it
  //   (she saw the home page after scanning a label). location.pathname keeps whichever
  //   mount we were served from, and ?data=1 still goes through the same service.lookup.
  // 2026-10-14: KEEP the current query (the realm is ?from=...) when pulling the data
  //   fragment. The old line dropped it, so the fragment was always rendered for the
  //   DEFAULT realm; document.write then replaced the page with look-alike content and
  //   every realm tap looked like "nothing happened" (her report: 5 of 6 tabs dead).
  //   Keep every existing parameter and only force data=1. ASCII only in this template.
  // 2026-10-14: NO regex here. This whole script lives inside a template literal, so an
  //   escaped question mark in a regex came out as /^?/ in the browser -- an invalid regex
  //   that made the WHOLE script throw, so the data fragment was never even fetched.
  //   Plain string ops instead: leading '?' stripped by hand, then force data=1.
  var dataSearch = window.location.search || '';
  if (dataSearch.charAt(0) === '?') { dataSearch = dataSearch.slice(1); }
  var dataQuery = dataSearch.split('&').filter(function (part) {
    return part && part.indexOf('data=') !== 0;
  });
  dataQuery.push('data=1');
  // 2026-10-14: never swallow the error again (her report: the page opens and then just sits
  //   on the skeleton forever). Any failure -- request error, non-ok response, empty body, or a
  //   response that is STILL the skeleton -- shows a human line plus a retry button. No auto loop.
  var retryText = ${JSON.stringify(texts.skeletonErrorText || '')};
  var retryLabel = ${JSON.stringify(texts.skeletonRetryLabel || '')};
  function showProblem() {
    var card = document.querySelector('[data-view="scan-skeleton-loading"]');
    if (!card || card.getAttribute('data-problem') === '1') return;
    card.setAttribute('data-problem', '1');
    while (card.firstChild) { card.removeChild(card.firstChild); }
    var message = document.createElement('p');
    message.setAttribute('data-view', 'scan-skeleton-error');
    message.textContent = retryText;
    var retry = document.createElement('button');
    retry.type = 'button';
    retry.setAttribute('data-view', 'scan-skeleton-retry');
    retry.className = 'skeleton-retry';
    retry.textContent = retryLabel;
    retry.addEventListener('click', function () {
      card.removeAttribute('data-problem');
      retry.disabled = true;
      retry.setAttribute('aria-busy', 'true');
      load();
    });
    card.appendChild(message);
    card.appendChild(retry);
  }
  var slowMs = ${JSON.stringify(texts.skeletonSlowMs)};
  var slowText = ${JSON.stringify(texts.skeletonSlowText || '')};
  var attempt = 0;
  function showSlow() {
    var card = document.querySelector('[data-view="scan-skeleton-loading"]');
    if (!card || card.getAttribute('data-problem') === '1') return;
    var line = card.querySelector('[data-view="scan-skeleton-slow"]');
    if (line) { line.textContent = slowText; return; }
    line = document.createElement('p');
    line.setAttribute('data-view', 'scan-skeleton-slow');
    line.textContent = slowText;
    card.appendChild(line);
  }
  // first failure/timeout -> one automatic retry; the second one -> human line + manual retry
  function retryOrProblem() {
    if (attempt === 1) { showSlow(); load(); return; }
    showProblem();
  }
  function load() {
    attempt += 1;
    var slowTimer = window.setTimeout(function () {
      showSlow();
      if (attempt === 1) { load(); }
    }, slowMs);
    fetch(window.location.pathname + '?' + dataQuery.join('&'), { credentials: 'same-origin' })
      .then(function (response) { return response.ok ? response.text() : ''; })
      .then(function (html) {
        window.clearTimeout(slowTimer);
        if (!html) { retryOrProblem(); return; }                     // empty body
        if (html.indexOf('data-view="scan-skeleton"') !== -1) {      // still skeleton -> do NOT write it back
          retryOrProblem(); return;
        }
        document.open(); document.write(html); document.close();
      })
      .catch(function () { window.clearTimeout(slowTimer); retryOrProblem(); });   // no silent swallow
  }
  load();
})();
</script>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${escapeHtml(itemNo || number || '')}</title>
<!-- 2026-10-13: STYLE must be wrapped - emitted bare it is foster-parented into
     the body and painted as visible text (she saw the raw style rules first). -->
<style>${STYLE}${PAYMENT_STEP_STYLE}${REALM_BAR_STYLE}${SKELETON_STYLE}</style>
</head>
<body>
<div class="page">
<section id="scan-skeleton" class="skeleton-stage" data-number="${escapeHtml(number)}"
  data-view="scan-skeleton" aria-busy="true">
<div class="card skeleton-card" data-view="scan-skeleton-loading">${escapeHtml(texts.skeletonLoading || '')}</div>
</section>
</div>
${script}
</body>
</html>
`;
};

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
  renderSalePaymentStepPage,
  renderScanPage,
  // 2026-10-13 骨架屏（先出页面，治白屏）—— 与下面的 `renderSalesHome`（不带编号首页 ✓）**都要** ✓
  renderScanSkeleton,
  renderSalesHome,
  renderScanMessagePage,
  renderMinimalPage,
  // ⭐⭐ 2026-10-12：提交成功页（逐字「您的提交已成功」+「再录一单」链接回扫码页）
  renderSaleSuccessPage,
  // ⭐ 2026-10-16（一单多货品 · 渲染半）：那一块 + 载荷纯函数（用例直接钉 ✓）
  multiItemBlockHtml,
  multiItemPayloadJson,
  MULTI_ITEM_ITEM_KEYS,
  MULTI_ITEM_ENTRY_KEYS,
  escapeHtml,
  STYLE,
  readThemeTokens,
  resolveRealm,
  // ⭐ 2026-10-11：本单条的设备能力判据（用例直接钉它）。
  canScanNextWithFeishu,
  // ⭐⭐ 2026-10-11：收款行的预置规则（路由与渲染层**共用这一份**）。
  buildPaymentRows,
};
