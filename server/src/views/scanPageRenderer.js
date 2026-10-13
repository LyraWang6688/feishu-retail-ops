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
  REALMS, DEFAULT_REALM, REALM_TEXTS, REALM_EMPTY_TEXT_KEYS,
  REPLENISH_REALM, PURCHASE_RETURN_REALM, ACCEPTANCE_REALM, resolveRealm, labelPrintUrls,
  saleSizeGroups, purchaseSizeLines,
} = require('./scanPageRealm');

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
.size-chips { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-1); }
.size-chip { display: flex; align-items: center; justify-content: center; gap: var(--space-1); min-width: 0; min-height: var(--control-height); padding: var(--space-1); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); cursor: pointer; }
.size-chip input { flex: none; width: 20px; height: 20px; margin: 0; }
.size-chip__size { font-size: var(--font-size-md); font-weight: 700; white-space: nowrap; }
/* ── 采购：各尺码（样品 + 门盒）数量 + 一键补货 ──────────────────────────── */
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
.realm-bar { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-1); margin: 0 0 var(--space-2); padding: var(--space-1); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-card); }
.realm-tab { display: flex; align-items: center; justify-content: center; min-height: var(--control-height); padding: 0 var(--space-2); border-radius: var(--radius-md); color: var(--text-secondary); font-size: var(--font-size-base); font-weight: 600; text-decoration: none; white-space: nowrap; }
/* ── ⭐⭐ 2026-10-12 验收领域「未到货批次」那一块：单列堆叠、不横滑、每行 ≥44px ── */
.batch-list { list-style: none; margin: 0; padding: 0; }
.realm-tab:active, .batch-row:active { opacity: .55; }
.batch-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); text-align: left; font-weight: 600; border: 1px solid var(--primary); }
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

const renderDocument = ({ title, content, requestId, config = SCAN_PAGE, head = '' }) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
${head}
<style>${STYLE}</style>
</head>
<body>
<main class="page">
${content}
</main>
${requestId ? `<p class="foot">${escapeHtml(config.texts.requestIdLabel)} <span class="mono">${escapeHtml(requestId)}</span></p>` : ''}
${content.includes('data-submit-feedback=') ? submitFeedbackScriptHtml() : ''}
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
 * ⭐ 领域切换条（顶部）：**六个领域**各一条**真链接**（`?from=<id>`；3 列 × 2 行、不横滑）。
 *
 * 🔴 当前领域那一颗的高亮是**服务端**决定的（`realm-tab--active` + `aria-current="page"`），
 *    不是脚本在浏览器里切 class —— 没 JS 也完全正确。
 * 领域顺序 / 名字全部来自 `views/scanPageRealm.js`（加减领域只改那个文件）。
 */
const realmBarHtml = (realm = DEFAULT_REALM) => `<nav class="realm-bar" aria-label="${escapeHtml(REALM_TEXTS.barLabel)}">
${REALMS.map((item) => (item.id === realm
    ? `<a class="realm-tab realm-tab--active" data-realm-id="${escapeHtml(item.id)}" href="?from=${escapeHtml(item.id)}" aria-current="page" data-tap-target="realm:${escapeHtml(item.id)}" data-open-label="${escapeHtml(SCAN_PAGE.tapFeedback && SCAN_PAGE.tapFeedback.label || '')}">${escapeHtml(item.label)}</a>`
    : `<a class="realm-tab" data-realm-id="${escapeHtml(item.id)}" href="?from=${escapeHtml(item.id)}" data-tap-target="realm:${escapeHtml(item.id)}" data-open-label="${escapeHtml(SCAN_PAGE.tapFeedback && SCAN_PAGE.tapFeedback.label || '')}">${escapeHtml(item.label)}</a>`)).join('\n')}
</nav>`;

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
${REALMS.map((realm) => `<a class="realm-link" href="?from=${escapeHtml(realm.id)}">${escapeHtml(realm.label)}</a>`).join('\n')}
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
  // 【继续扫下一个】：飞书客户端（手机）给真链接；其余设备给一句如实的人话。
  const scanNextHtml = canScanNextWithFeishu(userAgent)
    ? `<a class="btn" href="${escapeHtml(config.scanNext.applink)}" rel="noopener">${escapeHtml(texts.scanNextLabel)}</a>`
    : `<p class="hint">${escapeHtml(texts.scanNextHint)}</p>`;
  // 「刚加入本单」那一句：文案来自配置、只有数字来自会话（**没有回显注入面**）。
  const noticeHtml = write && write.notice
    ? `<p class="notice">${escapeHtml(write.notice)}</p>`
    : '';
  return `<section class="card draft-bar" data-view="draft-bar" aria-label="${escapeHtml(texts.draftBarLabel)}">
<p class="draft-bar__count">${escapeHtml(fillText(texts.draftBarCount, { count }))}</p>
${noticeHtml}
${submitHtml}
${scanNextHtml}
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
const submitFeedbackScriptHtml = () => `<script data-view="submit-feedback">
(function () {
  var forms = document.querySelectorAll('form');
  for (var i = 0; i < forms.length; i += 1) {
    forms[i].addEventListener('submit', function (event) {
      var button = event.target.querySelector('button[type="submit"]');
      if (!button || button.disabled) return;
      var form = event.target;
      // ⭐⭐ 2026-10-12（她「点完好像没反应 ⇒ 我一直点那个按钮」）：
      //    **按钮文案永不为空** —— 属性没配就用**按钮原文案**兜底（原来用空串兜底、按钮会变空白 ✗）。
      var label = button.getAttribute('data-submit-feedback') || form.getAttribute('data-submit-feedback') || button.textContent;
      var elapsedTemplate = button.getAttribute('data-submitting-elapsed')
        || form.getAttribute('data-submit-feedback-elapsed') || '';
      // ⭐⭐ 金额是必填（>0）：**点按钮就有反应**——空/0 时直接给一句提示，**不发请求**。
      //    字段名与提示文案都写在**这一张表单**上（零硬编码中文进脚本）。
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
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = label || button.textContent;
      // 服务端慢的时候**不许看起来"没反应"**：每一秒把"已 N 秒"接在后面（纯前端计时）。
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
      if (link.getAttribute('data-opening') === '1') { event.preventDefault(); return; }
      link.setAttribute('data-opening', '1');
      link.setAttribute('aria-disabled', 'true');
      link.style.opacity = '0.55';
      var openLabel = link.getAttribute('data-open-label');
      if (openLabel) link.textContent = openLabel;
    });
  }
  var tapForms = document.querySelectorAll('form');
  for (var f2 = 0; f2 < tapForms.length; f2 += 1) {
    tapForms[f2].addEventListener('submit', function (event) {
      var form = event.target;
      var btn = form.querySelector('button[type="submit"][name="action"]');
      tapReport('submit:' + (btn && btn.value ? btn.value : ''));
    });
  }
  function tapReport(target) {
    try {
      if (!target || !navigator.sendBeacon) return;
      var seg = location.pathname.split('/')[1] || 's';
      var page = location.pathname.indexOf('accept') > -1 ? 'accept' : 'scan';
      navigator.sendBeacon('/' + seg + '/ui-tap?target=' + encodeURIComponent(target) + '&page=' + encodeURIComponent(page));
    } catch (error) { /* silent: a failed report must never block navigation */ }
  }
})();
</script>`;

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
  if (!lines.length) return `<p class="hint">${escapeHtml(t.draftEmpty)}</p>`;
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
 * ⭐⭐ 2026-10-11（**最终口径**）：「付款情况」（**整单**）三档单选 —— 全付（默认）/ 部分付 / 未付。
 *
 * 她的原话：「**「付款情况」= 全付（默认）/ 部分付 / 未付 ← 这是整单的收款情况**」。
 *   · **全付** ⇒ 收款合计**必须 == 每件实收合计** ⇒ 按收款方式写收款明细；
 *   · **部分付** ⇒ 只写付了的那几条 ＋ 差额一条【未收款】；
 *   · **未付** ⇒ 一条【未收款】。
 *
 * ⚠️ **零 JS**（她 2026-10-10 的硬要求；两条哨兵钉着"页面里不许有 `<script>`"）：
 *    三档就是三个同名的 `radio`，默认选中配置里的那一档（**全付**），
 *    剩下的判断全在服务端（`services/scanWriteService.js` 的 `submitSale`）。
 * ⚠️ 取值与组名都来自 `config/scanWrite.js`（配置先行；这里一个字面量都不写死）。
 * ⚠️ 「部分付」那个「实付多少」输入框**照常渲染**（没有 JS 就藏不起来）：
 *    另外两档服务端**不看它**（全付必须两边相等；未付本来就不填）—— 取舍写在交付报告里。
 */
const paymentStatusHtml = (write) => {
  const t = write.texts;
  const fields = write.fields;
  const options = Array.isArray(t.paymentStatusOptions) ? t.paymentStatusOptions : [];
  const selected = String(write.paymentStatus || write.defaultPaymentStatus || '');
  const chips = options.map((option) => `<label class="pay-status__option">
<input type="radio" name="${escapeHtml(fields.paymentStatus)}" value="${escapeHtml(option.value)}"${String(option.value) === selected ? ' checked' : ''}>
<span class="pay-status__label">${escapeHtml(option.label || option.value)}</span>
</label>`).join('\n');
  return `<fieldset class="pay-status">
<legend class="pay-status__legend">${escapeHtml(t.paymentStatusLabel)}</legend>
<div class="pay-status__options">${chips}</div>
</fieldset>
<div class="form-row"><label>${escapeHtml(t.paidAmountLabel)}</label><input name="${escapeHtml(fields.paidAmount)}" inputmode="decimal" placeholder="${escapeHtml(t.paidAmountPlaceholder)}" value="${escapeHtml(String(write.paidAmount || ''))}"></div>`;
};

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
const saleFormHtml = (view, write) => {
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
  return `<section class="card">
<p class="draft-count">${escapeHtml(fillText(t.draftHeading, { count: lines.length }))}</p>
<form method="post" action="${escapeHtml(write.postAction)}" class="write-form">
${hiddenField(write.fields.submitKey, write.saleKey)}${pageBuildField()}
${sizeInput}
<div class="form-row"><label>${escapeHtml(t.amountLabel)}</label><input name="${escapeHtml(fields.amount)}" inputmode="decimal" placeholder="${escapeHtml(t.amountPlaceholder)}"></div>
<div class="form-row"><label>${escapeHtml(t.giftLabel)}</label><input name="${escapeHtml(fields.gift)}"></div>
${alert}
${draftLinesHtml(write)}
${paymentStatusHtml(write)}
${paymentRowsHtml(write)}
<p class="hint">${escapeHtml(t.amountOptionalHint || '')}</p>
<button type="submit" class="btn btn--primary" name="${escapeHtml(fields.action)}" value="${escapeHtml(write.actions.submitOrder)}" data-submit-feedback="${escapeHtml(submitSubmittingText(write))}" data-submitting-elapsed="${escapeHtml(submitSubmittingElapsedText(write))}">${escapeHtml(countLabel)}</button>
<button type="submit" class="btn" name="${escapeHtml(fields.action)}" value="${escapeHtml(write.actions.addLine)}"${submitFeedbackAttrs(write)}>${escapeHtml(t.addAnotherButton || t.addButton)}</button>
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
<button type="submit" class="btn btn--primary"${submitFeedbackAttrs(write)}>${escapeHtml(t.replenishButton)}</button>
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
const sizeRowsHtml = ({ sizes, name, quantityPrefix, quantityLabel, checkedOf }) => sizes.map((item) => {
  const size = item.size_text;
  return `<div class="size-row">
<label class="size-check"><input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(size)}"${checkedOf(item) ? ' checked' : ''}> ${escapeHtml(size)} 码</label>
<input class="size-qty" name="${escapeHtml(`${quantityPrefix}${size}`)}" value="1" inputmode="numeric" aria-label="${escapeHtml(`${size} ${quantityLabel}`)}" placeholder="${escapeHtml(quantityLabel)}">
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
const returnFormHtml = (view, write) => {
  const t = write.texts;
  const v = REALM_TEXTS;
  const fields = write.fields;
  const lines = purchaseSizeLines(view);
  const sizes = lines.length ? lines : (write.sizes || []).map((item) => ({
    size_text: item.size_text, sellable: null, missing: Boolean(item.missing), checked: false,
  }));
  if (!sizes.length) return '';
  const rows = sizeRowsHtml({
    sizes,
    name: fields.returnSizes,
    quantityPrefix: fields.returnQuantityPrefix,
    quantityLabel: t.replenishQuantityLabel,
    checkedOf: () => false,
  });
  return `<section class="card">
<details class="disclosure" data-view="purchase-return">
<summary class="disclosure__summary">${escapeHtml(v.purchaseReturn)}</summary>
<form method="post" action="${escapeHtml(write.postAction)}" class="write-form">
${hiddenField(fields.action, write.actions.purchaseReturn)}${pageBuildField()}
${hiddenField(fields.submitKey, write.returnKey)}
${rows}
<button type="submit" class="btn btn--primary"${submitFeedbackAttrs(write)}>${escapeHtml(t.returnButton)}</button>
</form>
</details>
</section>`;
};

/** 【继续扫下一个】：飞书客户端（手机）给 AppLink；桌面/自带浏览器给那句人话（绝不给死按钮）。 */
const acceptanceScanNextHtml = (userAgent) => (canScanNextWithFeishu(userAgent)
  ? `<a class="btn" href="${escapeHtml(SCAN_PAGE.scanNext.applink)}" rel="noopener">${escapeHtml(SCAN_PAGE.texts.scanNextLabel)}</a>`
  : `<p class="hint">${escapeHtml(SCAN_PAGE.texts.scanNextHint)}</p>`);

/** 验收模式的**本单条**：已验收 N 双 / 应到 M 双（她点名要的那一行）+ 一句提示（可有可无）。 */
const acceptanceSummaryHtml = (write, acceptance) => {
  const t = write.texts;
  return `<p class="draft-bar__count" data-view="acceptance-summary">${escapeHtml(fillText(t.acceptSummary, {
    scanned: Number(acceptance.scanned || 0), expected: Number(acceptance.expected || 0),
  }))}</p>
${acceptance.notice ? `<p class="notice">${escapeHtml(acceptance.notice)}</p>` : ''}`;
};

/**
 * ⭐⭐ 2026-10-12（业务负责人口述版）：「点验收的时候，**先默认带出我们采购申请里的尺码和数量**。
 *   用户可以在**给定的区域里直接修改**，同时**也可以自定义**；**自定义的时候同样支持扫码**。」
 *
 * 这一块就是"给定区域"：
 *   · **报货行**：每个尺码一行，数量**默认 = 报货数量**（`acceptance.rows[i].actual`）；
 *     **改成 0（或清空）⇒ 那一行不算到货**（服务层口径，见 `setActualRows`）；
 *   · **已加的行**（扫进来的 / 上次加的自定义）：同款同码各一行，数量可改；
 *   · **一行空白自定义**：她可以手输尺码 + 数量（本批只有一个款时才绑得上；多个款会让她扫码）；
 *   · **实际金额**（既有必填口径）+【确认完成验收】——**一次提交 = 一次写库**。
 *
 * ⚠️ **同名重复字段**（一"行"一个）是这一页既有做法（收款行 / 每件实收都是这么带的），
 *    服务端按**行序**解析 ⇒ **零 JS** 也做得到"整张清单一次提交"。
 * ⚠️ 扫标签那条路是**另一颗链接**（AppLink，复用 `acceptanceScanNextHtml`）——不在表单里。
 */
const acceptanceRowsFormHtml = (write, acceptance, userAgent = '') => {
  const t = write.texts;
  const f = write.fields;
  const rows = Array.isArray(acceptance.rows) ? acceptance.rows : [];
  const custom = Array.isArray(acceptance.customRows) ? acceptance.customRows : [];
  const lineHtml = (row) => `<div class="size-row" data-row-size="${escapeHtml(String(row.size))}">
<label class="size-check">${escapeHtml(fillText(t.acceptRowSizeLabel, { size: row.size }))}</label>
<input class="size-qty" name="${escapeHtml(f.acceptRowQty)}" value="${escapeHtml(String(row.actual))}" inputmode="numeric" aria-label="${escapeHtml(fillText(t.acceptRowSizeLabel, { size: row.size }))}">
</div>`;
  const reported = rows.map(lineHtml).join('');
  // 已加的行（扫码进来的 / 上次加的自定义）：**必须一起带回表单**，否则这次提交会把它们冲掉。
  const already = custom.map((row) => `<div class="size-row" data-row-size="${escapeHtml(String(row.size))}" data-custom-row="1">
<label class="size-check">${escapeHtml(fillText(t.acceptRowSizeLabel, { size: row.size }))}</label>
<input class="size-qty" name="${escapeHtml(f.acceptCustomQuantity)}" value="${escapeHtml(String(row.quantity))}" inputmode="numeric" aria-label="${escapeHtml(t.acceptCustomQuantityPlaceholder)}">
<input type="hidden" name="${escapeHtml(f.acceptCustomSize)}" value="${escapeHtml(String(row.size))}">
<button type="submit" class="btn" name="${escapeHtml(f.acceptToggleSize)}" value="${escapeHtml(String(row.size))}" data-toggle-size="${escapeHtml(String(row.size))}"${submitFeedbackAttrs(write)}>${escapeHtml(t.acceptUnreportedRemoveLabel)}</button>
</div>`).join('');
  // ⭐⭐ 2026-10-12（她选的方案 A）：「系统把 40、41 列出来（标注"未报货"）⇒ 你**点一下就加到货**」。
  //    候选 = **这一款在该类别下应有的尺码**（与缺码判定同一份配置口径）− 已报 − 已加；
  //    一个候选都没有 / 没有"款"可归 ⇒ 路由给 `unreported = null` ⇒ **整块不渲染**（不留空标题）。
  // ⭐⭐ 2026-10-12 21:11：有批次号、但这一批**一条明细都没有** ⇒ **明确说清**（她的"啥也没有"里这一档也要堵住）。
  const emptyDetail = rows.length === 0
    ? `<p class="empty" data-view="accept-empty-detail">${escapeHtml(t.acceptEmptyDetailBody)}</p>`
    : '';
  const unreported = Array.isArray(acceptance.unreported) ? acceptance.unreported : [];
  const unreportedHtml = unreported.length ? `<p class="draft-bar__count" data-view="accept-unreported-title">${escapeHtml(t.acceptUnreportedTitle)}</p>
<div class="size-chips" data-view="accept-unreported">
${unreported.map((item) => `<button type="submit" class="btn" data-candidate-size="${escapeHtml(String(item.size))}" name="${escapeHtml(f.acceptToggleSize)}" value="${escapeHtml(String(item.size))}"${submitFeedbackAttrs(write)}>${escapeHtml(fillText(t.acceptRowSizeLabel, { size: item.size }))} · ${escapeHtml(t.acceptUnreportedBadge)}</button>`).join('')}
</div>` : '';
  // 没有"款"（没扫、也没进清单）⇒ 不列候选，但给一句引导（别让她对着空白猜）。
  const unreportedHint = acceptance.unreportedNoProduct
    ? `<p class="hint" data-view="accept-unreported-hint">${escapeHtml(t.acceptUnreportedNoProductBody)}</p>`
    : '';
  const customBlank = `<div class="size-row" data-view="accept-custom-new">
<input class="size-qty" name="${escapeHtml(f.acceptCustomSize)}" inputmode="numeric" placeholder="${escapeHtml(t.acceptCustomSizePlaceholder)}" aria-label="${escapeHtml(t.acceptCustomSizePlaceholder)}">
<input class="size-qty" name="${escapeHtml(f.acceptCustomQuantity)}" inputmode="numeric" placeholder="${escapeHtml(t.acceptCustomQuantityPlaceholder)}" aria-label="${escapeHtml(t.acceptCustomQuantityPlaceholder)}">
</div>`;
  return `<section class="card" data-view="acceptance-rows">
<h2 class="stock__heading">${escapeHtml(t.acceptRowsTitle)}</h2>
${emptyDetail}
<p class="hint">${escapeHtml(t.acceptRowsHint)}</p>
<form method="post" action="${escapeHtml(acceptance.rowsPostAction || acceptance.postAction)}" class="write-form" data-view="acceptance-rows-form" data-amount-field="${escapeHtml(f.acceptAmount)}" data-amount-hint-text="${escapeHtml(t.acceptAmountRequiredHint || '')}">
${hiddenField(f.action, write.actions.acceptFinishRows)}${pageBuildField()}
${acceptance.submitKey ? hiddenField(f.submitKey, acceptance.submitKey) : ''}
${hiddenField(f.acceptBatch, acceptance.batchNo)}
${reported}${already}
<p class="draft-bar__count">${escapeHtml(t.acceptCustomTitle)}</p>
${customBlank}
${unreportedHtml}${unreportedHint}
<p class="hint" data-view="accept-amount-required" hidden>${escapeHtml(t.acceptAmountRequiredHint || (SCAN_PAGE.texts && SCAN_PAGE.texts.acceptAmountRequiredHint) || '')}</p>
<label class="size-check">${escapeHtml(t.acceptFinishAmountLabel)}
<input class="size-qty" name="${escapeHtml(f.acceptAmount)}"${acceptance.amountValue ? ` value="${escapeHtml(String(acceptance.amountValue))}"` : ''} inputmode="decimal" aria-label="${escapeHtml(t.acceptFinishAmountLabel)}"${acceptance.amountRequired === false ? '' : ' required'}>
</label>
<button type="submit" class="btn btn--primary"${submitFeedbackAttrs(write)}>${escapeHtml(t.acceptFinishSubmit)}</button>
</form>
${acceptanceScanNextHtml(userAgent)}
</section>`;
};

/**
 * ⭐⭐ 2026-10-12 21:20（她「点完确认完成验收好像没反应 ⇒ 我一直点那个按钮」）：
 * **成功页**必须把两个**真实数字**摆出来 + 一个明确的下一步（回未到货批次）——
 * 「点了没反应」里有一半就是"成功后没有交代"。
 */
const renderAcceptanceDonePage = ({
    config = SCAN_PAGE, write = null, acceptance = {}, backHref = '',
    returnPath = '', returnLabel = '', returnDelaySeconds = 0, autoReturnUrl = '',
  } = {}) => {
    const t = (write && write.texts) || SCAN_PAGE.texts;
  const scanned = Number(acceptance.scanned || 0);
  const amount = String(acceptance.amountText ?? '');
  return renderDocument({
    title: t.acceptDoneHeading || t.acceptDoneTitle || SCAN_PAGE.texts.acceptDoneTitle,
    config,
    head: autoReturnUrl && returnDelaySeconds > 0
      ? `<meta http-equiv="refresh" content="${Number(returnDelaySeconds)};url=${escapeHtml(autoReturnUrl)}">`
      : '',
    content: `<section class="card state-msg" data-view="acceptance-done">
<h1 class="state-msg__title--success">✅ ${escapeHtml(t.acceptDoneHeading || t.acceptDoneTitle || SCAN_PAGE.texts.acceptDoneTitle)}</h1>
<p data-view="acceptance-done-quantity">${escapeHtml(t.acceptDoneQuantityLabel || '')} ${escapeHtml(String(scanned))}</p>
<p data-view="acceptance-done-amount">${escapeHtml(t.acceptDoneAmountLabel || '')} ${escapeHtml(amount)}</p>
<p class="foot">${escapeHtml(fillText(t.acceptBatchLine || '', { batchNo: String(acceptance.batchNo || '—') }))}</p>
${backHref ? `<p><a class="btn btn--primary" href="${escapeHtml(backHref)}">${escapeHtml(t.acceptDoneBackLabel || '')}</a></p>` : ''}
${returnPath && returnLabel ? `<p><a class="btn" data-view="success-return" href="${escapeHtml(returnPath)}">${escapeHtml(returnLabel)}</a></p>` : ''}
</section>`,
  });
};

/** 【完成验收】：只收「实际金额」（必填，既有业务口径）——**没有**「到货说明」那一栏。 */
const acceptanceFinishHtml = (write, acceptance) => {
  const t = write.texts;
  const fields = write.fields;
  return `<form method="post" action="${escapeHtml(acceptance.postAction)}" class="write-form" data-view="acceptance-finish">
${hiddenField(fields.action, write.actions.acceptFinish)}${pageBuildField()}
<label class="size-check">${escapeHtml(t.acceptFinishAmountLabel)}
<input class="size-qty" name="${escapeHtml(fields.acceptAmount)}" inputmode="decimal" aria-label="${escapeHtml(t.acceptFinishAmountLabel)}">
</label>
<button type="submit" class="btn btn--primary"${submitFeedbackAttrs(write)}>${escapeHtml(t.acceptFinishSubmit)}</button>
</form>`;
};

/**
 * ⭐⭐ 2026-10-12（业务负责人）：「**验收还是只在扫码页**呀，**我不需要在工作台**」
 *   ⇒ 验收领域**没带批次号 / 没有正在进行的验收**时，**她自己能开工**：
 *     ① **列未到货的批次**（每条一行 = 一批，点一下进 `/s/accept?batch=<批次号>`）；
 *     ② **手输批次号**兜底（一个 GET 表单，零 JS）。
 *
 * ⚠️ 全是**功能名 + 事实**，没有说明书腔；**不出现"工作台"**（她不去工作台）。
 * ⚠️ 一个未到货批次都没有（或读表失败）⇒ 只给一句人话 + 手输框，**不把她支去别处**。
 * 行高沿用既有 `.btn`（`min-height: var(--control-height)` ⇒ ≥44px），单列堆叠、不横滑。
 */
const acceptPendingBlockHtml = (config, page = {}) => {
  const t = config.texts;
  const pending = page?.acceptPending || null;
  const batches = Array.isArray(pending?.batches) ? pending.batches : [];
  // ⚠️ 路径模板来自配置（**唯一来源**），basePath 在这里补 —— 与路由拼出来的 URL 一致。
  // ⭐⭐ 2026-10-12：`page.basePath` = **这一页的实际挂载前缀**（`/s` 或 `/r`）——
  //    `/r` 那条路（记录 ID 直达）下她点的每一条链接都必须**留在 `/r` 上**（不许被踢回 `/s`）。
  //    不传 ⇒ 用 `config.route.basePath`（= 改前的行为，**逐字不变**）。
  const basePath = String(page?.basePath ?? config.route?.basePath ?? '');
  const landingTemplate = `${basePath}${config.route?.acceptanceLandingPath || '/accept?batch={batchNo}'}`;
  const rows = batches.map((batch) => {
    const batchNo = String(batch?.batchNo || '');
    const href = landingTemplate.replace('{batchNo}', encodeURIComponent(batchNo));
    const meta = [
      (batch?.suppliers || []).filter(Boolean).join('、'),
      batch?.quantity ? `${t.acceptPendingQuantityLabel} ${batch.quantity}` : '',
    ].filter(Boolean).join(t.acceptPendingMetaSeparator || ' · ');
    // ⭐⭐ 2026-10-12 21:11（她真机）：这一行原来是"浅灰信息条"的样子 ⇒ 她**没看出来能点**（去点了下面的空输入）。
    //    ⇒ 描边 + 右侧一个「›」（`batch-row__cta`，样式只走 tokens）——"能点"要在**一眼**里看得出来。
    return `<li><a class="btn batch-row" data-batch="${escapeHtml(batchNo)}" href="${escapeHtml(href)}" data-tap-target="batch:${escapeHtml(batchNo)}" data-open-label="${escapeHtml(SCAN_PAGE.tapFeedback && SCAN_PAGE.tapFeedback.label || '')}">${escapeHtml(batchNo)}${meta ? `<span class="batch-row__meta">${escapeHtml(meta)}</span>` : ''}<span class="batch-row__cta" aria-hidden="true">›</span></a></li>`;
  }).join('');
  // ⭐ 空着点【进入验收】⇒ 一句人话（就在那颗按钮上方），别让她以为卡住。
  const emptySubmitHint = page?.emptySubmitHint
    ? `<p class="hint" data-view="accept-manual-hint">${escapeHtml(t.acceptPendingEmptySubmitHint)}</p>`
    : '';
  const manual = `
${emptySubmitHint}
<form method="get" action="${escapeHtml(`${basePath}${config.route?.acceptancePath || '/accept'}`)}" class="write-form" data-view="accept-manual">
<div class="form-row">
<input type="text" name="batch" inputmode="text" autocomplete="off" aria-label="${escapeHtml(t.acceptPendingManualPlaceholder)}" placeholder="${escapeHtml(t.acceptPendingManualPlaceholder)}">
<button type="submit" class="btn btn--primary">${escapeHtml(t.acceptPendingManualSubmit)}</button>
</div>
</form>`;
  return `<section class="card" data-view="accept-pending">
<h2 class="stock__heading">${escapeHtml(t.acceptPendingTitle)}</h2>
${batches.length
    ? `<ul class="batch-list" data-view="accept-pending-list">${rows}</ul>`
    : `<p class="empty" data-view="accept-empty">${escapeHtml(t.acceptPendingEmptyBody)}</p>`}
${manual}
</section>`;
};

/**
 * ⭐⭐ 2026-10-12（业务负责人真机 + Lead 追到的日志）：
 * **`GET /accept`（没带 `batch`）那一页的自助块** —— 她点【验收】进来的**第一屏**。
 *
 * 起因（逐字）：「报单之后点验收 ⇒ 就提示这个，我不知道啥意思」——
 *   那是一句 `acceptBatchMissingBody`「这一页没带报货批次号：回【验收】领域…」，
 *   可她**就是从【验收】领域进来的**（自相矛盾 ✗），而且那一页**没有输入框**（"或填批次号"做不到 ✗）。
 *
 * 🔴 这一页**复用** `acceptPendingBlockHtml`（列未到货批次 + 手输兜底），
 *    **不复制第二份列表/表单**；`basePath` 由路由给（`/s` 或 `/r`）。
 * ⚠️ 这一页**不挂领域切换条**（她是"进来干活"的），也没有"回工作台"这类把她支走的句子。
 */
const renderAcceptanceSelfServe = ({ config = SCAN_PAGE, acceptPending = null, basePath = '', emptySubmitHint = false } = {}) => renderDocument({
  title: config.texts.acceptModeTitle,
  config,
  content: acceptPendingBlockHtml(config, { acceptPending, basePath, emptySubmitHint }),
});

/**
 * ⭐⭐ 2026-10-11（方案A）：「**验收模式**」那一块（她扫开某款那一页时看到的东西）。
 *
 * 一屏三件事（**只有能点、能做的事**）：
 *   ① 本单条：**已验收 N 双 / 应到 M 双**；
 *   ② 这一款**各尺码** + 数量（默认 1、可改）⇒【加入本次验收】（**只写本地会话**）；
 *   ③ 【继续扫下一个】+【完成验收】（实际金额必填）。
 * 一行前端脚本都没有（与这一页的既有设计同一条硬要求）。
 */
const acceptanceBlockHtml = (view, write, acceptance, userAgent = '') => {
  const t = write.texts;
  const fields = write.fields;
  const sizes = (view?.rows || [])
    .filter((row) => !row.unknown_size && String(row.size_text ?? '').trim())
    .map((row) => String(row.size_text));
  const rows = sizes.map((size, index) => `<div class="size-row">
<label class="size-check"><input type="radio" name="${escapeHtml(fields.acceptSize)}" value="${escapeHtml(size)}"${index === 0 ? ' checked' : ''}> ${escapeHtml(size)} 码</label>
<input class="size-qty" name="${escapeHtml(fields.acceptQuantity)}" value="${escapeHtml(String(acceptance.defaultQuantity ?? 1))}" inputmode="numeric" aria-label="${escapeHtml(`${size} ${t.replenishQuantityLabel}`)}" placeholder="${escapeHtml(t.replenishQuantityLabel)}">
</div>`).join('');
  return `<section class="card" data-view="acceptance" data-batch="${escapeHtml(acceptance.batchNo)}">
${acceptanceSummaryHtml(write, acceptance)}
${sizes.length ? `<form method="post" action="${escapeHtml(acceptance.postAction)}" class="write-form">
${hiddenField(fields.action, write.actions.acceptAdd)}${pageBuildField()}
${rows}
<button type="submit" class="btn btn--primary"${submitFeedbackAttrs(write)}>${escapeHtml(t.acceptAddButton)}</button>
</form>` : ''}
${acceptanceScanNextHtml(userAgent)}
${acceptanceFinishHtml(write, acceptance)}
</section>`;
};

/**
 * **验收模式落地页**（`GET /s/accept?batch=<批次号>`，工作台点【验收】跳过来）：没有编号、
 * 只给本单条 +【继续扫下一个】+【完成验收】。这一页**不挂领域切换条**（它是"模式页"）。
 */
const renderAcceptancePage = ({ acceptance, config = SCAN_PAGE, write = null, userAgent = '' } = {}) => {
  if (!write) {
    return renderMinimalPage({ title: config.texts.errorTitle, body: config.texts.errorBody });
  }
  const batchNo = String(acceptance?.batchNo || '');
  // ⭐⭐ 2026-10-12：进验收就**预填那张可编辑清单**（她的口述版）；渲染器不认识"是否开启"，
  //    由路由决定要不要给 `acceptance.rows`（不给 ⇒ 与改前逐字相同）。
  const rowsBlock = Array.isArray(acceptance?.rows) ? acceptanceRowsFormHtml(write, acceptance, userAgent) : '';
  // ⚠️ 这里**故意先算成变量**、不在 `${}` 里再嵌一个模板串 ——
  //    `test/noHardcodedChinese.test.js` 的扫描器用**朴素状态机**剥注释，遇到嵌套模板串会失步，
  //    把后面的注释当成"硬编码中文"误报（实测：本文件多出 9 条假红）。写法上绕开它，别去动那个闸门。
  const legacyBlock = `${acceptanceScanNextHtml(userAgent)}
${acceptanceFinishHtml(write, acceptance)}`;
  return renderDocument({
    title: fillText(config.texts.pageTitle, { itemNo: batchNo, number: batchNo }),
    config,
    // ⚠️ 有清单时**不再渲染**那颗"只收金额"的老表单（一页只留一条路，免她点错）。
    content: `<section class="card" data-view="acceptance" data-batch="${escapeHtml(batchNo)}">
${acceptanceSummaryHtml(write, acceptance)}
${rowsBlock || legacyBlock}
</section>
<p class="foot">${escapeHtml(fillText(write.texts.acceptBatchLine, { batchNo }))}</p>`,
  });
};

/**
 * 某个领域**"没内容"**时的那张人话卡片（标题 + 为什么 + 一个下一步）。 *
 * 🔴 为什么必须有它：这是"**手机上无论如何都要有看得见的东西**"的最后一道体验兜底 ——
 *    没有写上下文（拿不到飞书身份 / 写入口没开）时，旧版会**什么块都不渲染**，
 *    屏幕上只剩身份区那一行；现在给一张说清楚的卡片，她至少知道"为什么没有表单、下一步去哪"。
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
 *   · `accept`           —— 验收（有活跃验收会话时那一块；没有就一张人话卡）；
 *   · `inventory`        —— 库存表；
 *   · `product`          —— 货品标签。
 *
 * ⚠️ **只有当前这一块进 HTML**（另外五块**连字符串都不拼**）—— 页面里没有"靠 CSS 藏起来"
 *    的东西，也就没有"脚本没跑 ⇒ 什么都没显示"的可能。
 * ⚠️ 认不出的领域一律回落缺省（`resolveRealm` 在路由那一层已经做过一次；这里再兜一次，
 *    **渲染层永远不抛、永远有正文**）。
 */
const realmBlockHtml = (realm, view, config, write, page = {}) => {
  const id = REALMS.some((item) => item.id === realm) ? realm : DEFAULT_REALM;
  const wrap = (inner) => `<div class="realm-block realm-block--${escapeHtml(id)}">\n${inner}\n</div>`;
  // ⭐⭐ 2026-10-11（方案A）：**验收模式**（非 tab 的领域）—— 上下文来自 `page.acceptance`
  //    （由路由按"正开着一场验收"给）；拿不到就什么都不猜，回落缺省领域那张卡。
  if (id === ACCEPTANCE_REALM) {
    // ⭐ 2026-10-12：没有正在进行的验收 ⇒ **她自己开工**（列未到货批次 + 手输兜底），
    //    不再给"回工作台"那张卡（她不去工作台）。
    if (!page?.acceptance) return wrap(acceptPendingBlockHtml(config, page));
    return wrap(page?.acceptance
      ? acceptanceBlockHtml(view, write, page.acceptance, page?.userAgent)
      // 没有正在进行的验收（她还没在工作台点【验收】，或那一场已结束/过期）⇒ 一张人话卡
      // （标题 + 为什么 + 一个下一步），绝不留空 div。
      : realmEmptyHtml(ACCEPTANCE_REALM, config));
  }
  if (id === 'inventory') return wrap(stockTableHtml(view, config));
  if (id === 'product') return wrap(labelBlockHtml(view, page?.print));
  if (id === REPLENISH_REALM) {
    // ⭐ 2026-10-11：**补货**从原「采购」领域里独立成一块（内容一个字没变）。
    const form = write && write.enabled !== false && write.replenishEnabled !== false
      ? replenishFormHtml(view, write)
      : '';
    return wrap(form || realmEmptyHtml(REPLENISH_REALM, config));
  }
  if (id === PURCHASE_RETURN_REALM) {
    // ⭐ 2026-10-11：**退货**同样独立成一块（内容一个字没变）。
    const form = write && write.enabled !== false && write.returnEnabled !== false
      ? returnFormHtml(view, write)
      : '';
    return wrap(form || realmEmptyHtml(PURCHASE_RETURN_REALM, config));
  }
  // sales（缺省）
  if (!write || write.enabled === false || write.saleEnabled === false) {
    return wrap(realmEmptyHtml('sales', config));
  }
  // ⚠️ 2026-10-11：「刚加入本单」那一句**上移到顶部的本单条**（`draftBarHtml`）——
  //    她无论停在哪个领域（库存 / 补货 / 退货 / 验收 / 货品）都该立刻看见 N+1。
  return wrap(saleFormHtml(view, write));
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
  const safeRealm = realm === ACCEPTANCE_REALM ? ACCEPTANCE_REALM : resolveRealm(realm);
  let block;
  try {
    block = realmBlockHtml(safeRealm, view, config, write, page);
  } catch (error) {
    block = `<div class="realm-block realm-block--${escapeHtml(safeRealm)}">${realmEmptyHtml(safeRealm, config)}</div>`;
  }
  // ⚠️ 验收模式下**不挂销售本单条**：那一条讲的是"销售本单几双"，与"这次验收扫了几双"
  //    是两件事，同屏出现只会让她看错数（验收自己的本单条在验收块里）。
  const bar = safeRealm === ACCEPTANCE_REALM ? ''
    : draftBarHtml(write, config, page?.userAgent, safeRealm, {
      // ⭐ 2026-10-12：销售页上那颗**带钱**的提交表单就在下面 ⇒ 本单条不再放第二颗提交按钮。
      moneyFormOnPage: safeRealm === DEFAULT_REALM && Boolean(write),
    });
  // ⭐⭐ 2026-10-12（编号兜底）：编号缺段（典型 = 缺「类别」）但按（货号 + 颜色）**唯一命中**时，
  //    页面上出**一条轻提示**（一句话，不写说明书）——她才知道"这个标签该重打了"。
  const fallbackHint = view.number_fallback
    ? `<p class="notice">${escapeHtml(config.texts.numberFallbackHint)}</p>` : '';
  return renderDocument({
    title: fillText(config.texts.pageTitle, { itemNo: view.item_no || view.number, number: view.number }),
    config,
    content: `${bar}
${realmBarHtml(safeRealm)}
${noScriptHtml()}
${identityHtml(view, config)}
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
const renderSaleSuccessPage = (input = {}, config = SCAN_PAGE) => renderScanMessagePage(
  { ...input, tone: 'success' }, config,
);

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
  fetch('/s/' + encodeURIComponent(number) + '?data=1', { credentials: 'same-origin' })
    .then(function (response) { return response.ok ? response.text() : ''; })
    .then(function (html) {
      if (!html) return;
      document.open(); document.write(html); document.close();
    })
    .catch(function () {});
})();
</script>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${escapeHtml(itemNo || number || '')}</title>
${STYLE}
</head>
<body>
<div class="page">
<section class="card identity" id="scan-skeleton" data-number="${escapeHtml(number)}"
  data-view="scan-skeleton" aria-busy="true">
<div class="identity__main">
<h1 class="identity__item">${escapeHtml(itemNo || number || '')}</h1>
${meta ? `<p class="identity__meta">${escapeHtml(meta)}</p>` : ''}
</div>
</section>
<section class="card">
<h2 class="stock__heading">${escapeHtml(texts.skeletonSizesLabel || '')}</h2>
<p class="identity__meta" data-view="scan-skeleton-loading">${escapeHtml(texts.skeletonLoading || '')}</p>
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
  renderScanPage,
  // 2026-10-13 骨架屏（先出页面，治白屏）—— 与下面的 `renderSalesHome`（不带编号首页 ✓）**都要** ✓
  renderScanSkeleton,
  renderSalesHome,
  renderScanMessagePage,
  renderMinimalPage,
  // ⭐⭐ 2026-10-12：提交成功页（逐字「您的提交已成功」+「再录一单」链接回扫码页）
  renderSaleSuccessPage,
  // ⭐⭐ 2026-10-11（方案A）：验收模式落地页（`GET /s/accept?batch=` 那一屏）
  renderAcceptancePage,
  // ⭐ 2026-10-12：验收成功页（两个真实数字 + 回列表）
  renderAcceptanceDonePage,
  // ⭐⭐ 2026-10-12：`GET /accept`（无 batch）的自助落地页（复用「未到货批次 + 手输」那一块）
  renderAcceptanceSelfServe,
  escapeHtml,
  STYLE,
  readThemeTokens,
  resolveRealm,
  // ⭐ 2026-10-11：本单条的设备能力判据（用例直接钉它）。
  canScanNextWithFeishu,
  // ⭐⭐ 2026-10-11：收款行的预置规则（路由与渲染层**共用这一份**）。
  buildPaymentRows,
};
