/**
 * 扫码页「未登录 → 先飞书登录 → 自动回到刚才那一页」的全部可配参数 —— **配置先行**。
 *
 * 背景（业务负责人在手机飞书上扫标签二维码）：
 *   她扫开 `https://hm.bamamei.online/s/{编号}` 时，手机浏览器里**还没有** `hm.bamamei.online`
 *   的登录 cookie，于是看到的是工作台那套 401 JSON
 *   （`{"success":false,"error":"请先通过飞书身份登录工作台","auth_required":true}`）。
 *   她要的是「**扫码即用**」—— 所以扫码页在未登录时应当 **302 去飞书登录**，
 *   登录成功后**自动回到刚才那一页**（而不是给人看一段 JSON）。
 *
 * 放在这里的：回跳参数名 / 回跳路径白名单 / 默认落地页 / 登录入口路径 / 跳转日志事件名。
 * 判定逻辑在 `routes/feishuWebAuth.js`（`resolveScanNext` / `buildLoginStartUrl`），
 * 扫码页只在未登录那一刻用它 —— 逻辑里**一个路径、一个参数名都不写死**。
 *
 * ⚠️ 与 `config/scanPage.js` 刻意**不合并**：那一份是"扫码页展示什么 / 怎么取数"，
 *   这一份是"没登录时怎么把这个人送去登录、再从哪儿接回来"（工作台身份认证的语义）。
 *   两者唯一的耦合是**回跳白名单要跟着扫码页的挂载点走** —— 所以这里 require 它的 basePath，
 *   而不是把 `/s` 再抄一遍（换挂载点两边不会漂）。
 */

const { SCAN_PAGE } = require('./scanPage');

/**
 * 回跳路径（`next`）的规则。
 *
 * 🔴 两道防线，缺一不可：
 *   ① `safeReturnTo`（既有，在 `routes/feishuWebAuth.js`）：只接受**站内相对路径** ——
 *      必须以单个 `/` 开头、不能是 `//host`、不能含协议、不能含反斜杠、不能是绝对 URL
 *      （防开放重定向 / `js/server-side-unvalidated-url-redirection`）；
 *   ② **白名单**（本文件）：在 ① 之上再收一道 —— `next` **只放行扫码页自己**（`/s/...`），
 *      别的一律回落到默认落地页。`/a//b`、`/s/../api/...` 这类都由这一道挡住
 *      （白名单按**归一化后**的 pathname 判，见 `resolveScanNext`）。
 *
 * ⚠️ `return_to`（工作台前端 `public/workbench/core/auth.js` 在用的那个参数名）**不走白名单**：
 *   它要能回工作台的任意站内页（例：`/workbench/index.html?tab=sales`），
 *   语义**逐字不变**（只过 ①）。白名单只服务于扫码页新加的 `next`。
 */
const RETURN_PATH = Object.freeze({
  // 扫码页把"刚才那一页"带过去的参数名：`/api/auth/feishu/start?next=<encodeURIComponent(原 path + 原 query)>`
  paramName: 'next',
  // 工作台前端在用的等价参数名。**逐字不动**（既有用例钉着它）。
  legacyParamName: 'return_to',
  // `next` 缺失 / 非法时落到哪：**工作台首页**。
  // `app.js` 里 `GET /` 就是工作台 `index.html`，所以 `/` 既是站内根、也是工作台首页。
  defaultPath: '/',
  // 白名单（前缀 / 精确值）：直接取自扫码页路由的挂载点，不抄第二份 `/s`。
  allowedPrefixes: Object.freeze([`${SCAN_PAGE.route.basePath}/`]),
  allowedExactPaths: Object.freeze([SCAN_PAGE.route.basePath]),
});

/** 未登录时 302 的登录入口（`app.js` 挂在 `/api/auth/feishu`，**在 `API_KEY` 之前**，手机能直接打开）。 */
const LOGIN = Object.freeze({
  startPath: '/api/auth/feishu/start',
});

/** 结构化日志事件名（扫码页整条链路**只读**，这是唯一的跳转事件）。 */
const EVENTS = Object.freeze({
  loginRedirect: 'scan.page.login_redirect',
});

const SCAN_AUTH_REDIRECT = Object.freeze({
  returnPath: RETURN_PATH,
  login: LOGIN,
  events: EVENTS,
});

module.exports = {
  SCAN_AUTH_REDIRECT,
  RETURN_PATH,
  LOGIN,
  EVENTS,
};
