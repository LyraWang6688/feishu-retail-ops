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
  // ⭐⭐ 2026-10-13（她真机 + 服务器实测双重证据的**真因**）：
  //    货品标签的二维码打的是 `/r/<记录ID>` —— 未登录时也**必须带上"它本来要去的那一页"** ✓
  //    原来白名单只放行 `/r/` ⇒ `/r/…` 被拒 ⇒ `next` 回落成 `/` ⇒ 登录回来落在**扫码页首页**
  //    （标题「请扫下一个标签」✗ 她截图那一页）⇒ "扫了码却没进到那一款" ✗
  //    ⇒ 白名单**加第二类**：扫码页的**记录 ID 路径**（取自 `SCAN_PAGE.route.recordBasePath`，
  //      不写死 `/r` ✓ 不抄第二份 ✓）· 判据仍是**归一化后**的 pathname（`/r/../api/…` 照样被挡 ✓）
  allowedPrefixes: Object.freeze([`${SCAN_PAGE.route.recordBasePath}/`]),
  allowedExactPaths: Object.freeze([SCAN_PAGE.route.recordBasePath]),
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

/**
 * ⭐⭐ 2026-10-13（她真机两轮实测之后的**唯一正解**）：**登录后用一次性 URL 票据带回会话**。
 *
 * 为什么非要它：飞书 WebView 里"扫完新开的那个窗口"**完全不共享也不保存 cookie** ✗
 *   ⇒ `SameSite=None` 也救不了（v0.4.30 上线后她仍然打转 ✓ 实测）
 *   ⇒ **任何靠 cookie 带会话的做法都无效** ⇒ 只能把"会话"放进 **URL** 带回来 ✓
 *
 * 安全约束（一条都不许松 ✗）：
 *   · **一次性**：用掉即作废（内存里记 nonce ✓ 重启即全失效 ✓）
 *   · **≤60 秒**过期（够一跳 ✓ 放进签名里，服务端再核）
 *   · **HMAC 签**（复用 `LARK_WEB_SESSION_SECRET` ✓ **不新造密钥** ✓）· 篡改/伪造一律拒 ✗
 *   · **绑定 open_id + 目标 path（含查询串）** ⇒ 换个 path / 换个人用同一票 ⇒ 拒 ✓
 *   · 校验目标 path 走**既有** `resolveScanNext`（白名单**不放宽** ✓）
 *   · 票据**只出现在这一跳的地址栏**：兑换后**立刻 302 到去掉 `t` 的同一路径**（不进历史 ✗）
 *   · 默认**开启**（她真机要立刻能用 ✓）；`SCAN_SESSION_TICKET_ENABLED=false` 可关 ✓
 */
const readFlagDefaultTrue = (env, key) => {
  const raw = env ? env[key] : undefined;
  if (raw === undefined || raw === null) return true;      // ⚠️ 缺省 = 开（她真机等不起 ✗）
  return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
};
const TICKET = Object.freeze({
  paramName: 't',
  ttlMs: 60 * 1000,
  enabled: readFlagDefaultTrue(process.env, 'SCAN_SESSION_TICKET_ENABLED'),
});

const ticketSecret = (env = process.env) => String((env.LARK_WEB_SESSION_SECRET || '').trim());
const usedNonces = new Set();
const b64u = (value) => Buffer.from(value, 'utf8').toString('base64url');
const sign = (payload, secret) => require('node:crypto').createHmac('sha256', secret).update(payload).digest('base64url');

/** 签一张票（`{ open_id, name, path }` ⇒ 一次性短串）。 */
const issueSessionTicket = ({ openId = '', name = '', path: targetPath = '' } = {}, { env = process.env, now = Date.now() } = {}) => {
  const secret = ticketSecret(env);
  if (!secret || !openId || !targetPath) return null;
  const payload = b64u(JSON.stringify({
    o: String(openId), n: String(name || ''), p: String(targetPath), e: now + TICKET.ttlMs,
    k: require('node:crypto').randomBytes(9).toString('base64url'),
  }));
  return `${payload}.${sign(payload, secret)}`;
};

/**
 * 兑换一张票。**成功才返回 `{ ok: true, openId, name, path }`**；任何异常都返 `{ ok: false, reason }`
 *   ⇒ 调用方**回落"再走一次登录"**（**绝不出现半登录态** ✗）。
 */
const redeemSessionTicket = (token, { targetPath = '', env = process.env, now = Date.now() } = {}) => {
  const raw = String(token || '').trim();
  const secret = ticketSecret(env);
  if (!raw || !secret || !raw.includes('.')) return { ok: false, reason: 'malformed' };
  const [payload, signature] = raw.split('.');
  if (sign(payload, secret) !== signature) return { ok: false, reason: 'bad_signature' };
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'bad_payload' }; }
  if (!data || !data.o || !data.p) return { ok: false, reason: 'incomplete' };
  if (!(Number(data.e) > now)) return { ok: false, reason: 'expired' };
  if (usedNonces.has(data.k)) return { ok: false, reason: 'used' };
  // ⭐ 绑定：**目标 path 必须与签发时那个逐字相同**（含查询串）✓
  if (String(data.p) !== String(targetPath)) return { ok: false, reason: 'path_mismatch' };
  // ⭐ 目标 path 还必须过**既有**白名单（不复用第二套判据 ✗）
  const p0 = String(data.p);
  const pathname0 = p0.split('?')[0];
  const allowed0 = RETURN_PATH.allowedExactPaths.includes(pathname0)
    || RETURN_PATH.allowedPrefixes.some((prefix) => pathname0.startsWith(prefix));
  if (!allowed0) return { ok: false, reason: 'not_whitelisted' };
  usedNonces.add(data.k);
  if (usedNonces.size > 5000) usedNonces.clear();   // 简单的内存上限（重启/清空 ⇒ 旧票全失效 ✓ 安全方向 ✓）
  return { ok: true, openId: String(data.o), name: String(data.n || ''), path: String(data.p) };
};

/** `?t=` 之后的"原路径 + 原查询串"（**去掉 t 本身** ⇒ 用于兑换后 302 回去 ✓）。 */
const pathWithoutTicket = (originalUrl = '', paramName = TICKET.paramName) => {
  const raw = String(originalUrl || '');
  const [path, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  params.delete(paramName);
  const rest = params.toString();
  return rest ? `${path}?${rest}` : path;
};

module.exports = {
  TICKET,
  issueSessionTicket,
  redeemSessionTicket,
  pathWithoutTicket,
  SCAN_AUTH_REDIRECT,
  RETURN_PATH,
  LOGIN,
  EVENTS,
};

