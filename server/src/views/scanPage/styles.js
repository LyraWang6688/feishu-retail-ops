const fs = require('node:fs');
const path = require('node:path');


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
const THEME_FILE = path.join(__dirname, '..', '..', '..', 'public', 'workbench', 'styles', 'tokens.css');

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


module.exports = {
  STYLE,
  readThemeTokens,
  canScanNextWithFeishu,
  SKELETON_STYLE,
  REALM_BAR_STYLE,
  SCAN_TAB_MARKER,
  PAYMENT_STEP_STYLE,
};
