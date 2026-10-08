const express = require('express');
const crypto = require('node:crypto');
const { logInfo, logWarn } = require('../utils/logger');
const { SCAN_AUTH_REDIRECT } = require('../config/scanAuthRedirect');

const COOKIE_NAME = 'workbench_session';
const STATE_TTL_MS = 10 * 60 * 1000;
const states = new Map();

const enabled = () => process.env.LARK_WEB_AUTH_ENABLED === 'true';
const redirectUri = () => process.env.LARK_WEB_REDIRECT_URI || 'https://workbench.bamamei.online/api/auth/feishu/callback';
const sessionSecret = () => process.env.LARK_WEB_SESSION_SECRET || '';
const allowedOpenIds = () => new Set(String(process.env.WORKBENCH_ALLOWED_OPEN_IDS || '').split(',').map((value) => value.trim()).filter(Boolean));

const base64url = (value) => Buffer.from(value).toString('base64url');
const sign = (payload) => crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');

const encodeSession = (user) => {
  const payload = base64url(JSON.stringify({
    open_id: user.open_id,
    union_id: user.union_id,
    user_id: user.user_id,
    name: user.name || user.en_name || '',
    exp: Date.now() + 8 * 60 * 60 * 1000,
  }));
  return `${payload}.${sign(payload)}`;
};

const decodeSession = (value) => {
  if (!value || !sessionSecret()) return null;
  const [payload, signature] = String(value).split('.');
  const expected = payload ? sign(payload) : '';
  if (!payload || !signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const user = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!user.open_id || !user.exp || user.exp < Date.now()) return null;
    return user;
  } catch (_) {
    return null;
  }
};

// 只允许站内相对路径。
//
// 仅检查 `startsWith('/')` 是不够的：`/\evil.com` 能通过该检查，但 WHATWG URL
// 会把反斜杠当正斜杠处理，最终把用户送到 https://evil.com。所以这里显式拒绝
// 反斜杠，并用 URL 解析做一次最终的同源校验。
// 对应告警：CodeQL js/server-side-unvalidated-url-redirection。
const RETURN_TO_BASE = 'https://return-to.invalid';
const safeReturnTo = (value) => {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  try {
    if (new URL(value, RETURN_TO_BASE).origin !== RETURN_TO_BASE) return '/';
  } catch (_) {
    return '/';
  }
  return value;
};

/**
 * 扫码页的回跳目标（`next`）：在 `safeReturnTo` 之上再收一道**白名单** —— 只放行扫码页自己。
 *
 * 为什么不只用 `safeReturnTo`：它允许回**任意站内相对路径**（`/a//b` 也放行）。
 * 扫码页只会从 `/s/{编号}` 出发，所以这里把可回跳的范围收到 `/s/...`，
 * 别的（含路径穿越 `/s/../api/...`）一律**回落到默认落地页**。
 * ⚠️ 白名单按 `new URL()` **归一化后**的 pathname 判：`..` / `%2e%2e` / `//` 都逃不掉；
 *    但**返回值仍是 `safeReturnTo` 的产物**（不是这里拼出来的字符串），
 *    这样 `res.redirect` 的入口始终是那个被 CodeQL 认可的净化函数。
 */
const resolveScanNext = (value) => {
  const { defaultPath, allowedPrefixes, allowedExactPaths } = SCAN_AUTH_REDIRECT.returnPath;
  const safe = safeReturnTo(value);
  if (safe === defaultPath) return defaultPath;
  let pathname;
  try {
    // `safe` 已经过 safeReturnTo ⇒ 必是同源，这里只为拿到"浏览器最终会走到哪个 path"。
    pathname = new URL(safe, RETURN_TO_BASE).pathname;
  } catch (_) {
    return defaultPath;
  }
  const allowed = allowedExactPaths.includes(pathname)
    || allowedPrefixes.some((prefix) => pathname.startsWith(prefix));
  return allowed ? safe : defaultPath;
};

/**
 * `/start` 的回跳目标：`next`（扫码页在用）优先，`return_to`（工作台前端在用）兜底。
 *   · `next` ⇒ **白名单**（只放行 `/s/...`）；
 *   · `return_to` ⇒ 既有语义**逐字不变**（只过 `safeReturnTo`，可回工作台任意站内页）；
 *   · 两个都没有 ⇒ 工作台首页（与改动前一致）。
 * 返回值里的 `strict` 记下"这份目标要不要按白名单再验一次"，随 state 一起存（见 `/callback`）。
 */
const resolveReturnTo = (query = {}) => {
  const raw = query[SCAN_AUTH_REDIRECT.returnPath.paramName];
  if (raw !== undefined) return { path: resolveScanNext(raw), strict: true };
  return {
    path: safeReturnTo(query[SCAN_AUTH_REDIRECT.returnPath.legacyParamName]),
    strict: false,
  };
};

/**
 * `/callback` 成功后的重定向目标。
 *   · 调用方**直接在 callback 上带了 `next`**（`/start` 之外的走法）⇒ 仍按白名单校验；
 *   · 否则用 `/start` 时存进 state 记录的那一份（**生产上生效的就是这条**：
 *     飞书回跳只带 `code`/`state`，不会把我们自己的 query 带回来），并按存下的 policy **再验一遍**。
 * ⚠️ 无论走哪条，`state` 都是**先校验、先作废**（见 `/callback` 开头），CSRF 语义一个字没动。
 */
const resolveCallbackTarget = (query, record) => {
  const inline = query?.[SCAN_AUTH_REDIRECT.returnPath.paramName];
  if (inline !== undefined) return resolveScanNext(inline);
  return record.strict ? resolveScanNext(record.return_to) : safeReturnTo(record.return_to);
};

/** 未登录时 302 的目标：`{loginStartPath}?{paramName}=<encodeURIComponent(原 path + 原 query)>`。 */
const buildLoginStartUrl = (nextPath) => {
  const { startPath } = SCAN_AUTH_REDIRECT.login;
  const { paramName } = SCAN_AUTH_REDIRECT.returnPath;
  return `${startPath}?${paramName}=${encodeURIComponent(nextPath)}`;
};

const jsonFetch = async (url, options) => {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code) throw new Error(body.msg || body.message || `飞书接口请求失败（${response.status}）`);
  // Feishu auth endpoints are not completely uniform: some return the
  // payload at the top level while others wrap it in `data`.
  return body.data && typeof body.data === 'object' ? body.data : body;
};

const createFeishuWebAuthRouter = () => {
  const router = express.Router();
  router.get('/me', (req, res) => {
    const user = decodeSession(req.get('cookie')?.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1));
    if (!enabled()) return res.json({ success: true, enabled: false, authenticated: false });
    if (!user) return res.status(401).json({ success: false, enabled: true, authenticated: false, auth_required: true });
    const allowed = allowedOpenIds();
    if (allowed.size && !allowed.has(user.open_id)) return res.status(403).json({ success: false, error: '当前飞书账号未被授权使用工作台' });
    return res.json({ success: true, enabled: true, authenticated: true, user: { open_id: user.open_id, user_id: user.user_id, name: user.name } });
  });

  router.get('/start', (req, res) => {
    if (!enabled()) return res.status(404).send('Feishu web authentication is disabled');
    if (!process.env.LARK_AGENT_APP_ID || !process.env.LARK_AGENT_APP_SECRET || !sessionSecret()) return res.status(500).send('飞书网页身份认证配置不完整');
    const state = crypto.randomBytes(24).toString('hex');
    // 回跳目标**随 state 一起存在服务端**（不塞进 state 字符串里 ⇒ CSRF 用的随机串仍是纯随机）。
    const target = resolveReturnTo(req.query);
    states.set(state, { return_to: target.path, strict: target.strict, expires_at: Date.now() + STATE_TTL_MS });
    const params = new URLSearchParams({ app_id: process.env.LARK_AGENT_APP_ID, redirect_uri: redirectUri(), state });
    return res.redirect(`https://open.feishu.cn/open-apis/authen/v1/authorize?${params.toString()}`);
  });

  router.get('/callback', async (req, res) => {
    const record = states.get(req.query.state);
    states.delete(req.query.state);
    if (!record || record.expires_at < Date.now()) return res.status(400).send('飞书登录状态已过期，请重新打开工作台');
    // req.query.error 完全由调用方控制，这条分支在 state 有效时即可到达——攻击者
    // 可以自己先请求 /start 拿到合法 state，再构造链接诱导他人点击。
    //
    // 这里刻意不回显它：res.send(字符串) 默认 Content-Type 是 text/html，而 CodeQL
    // 也不把 `res.type('text/plain')` 认作净化（js/reflected-xss，实测仍会报）。
    // 与其和工具互相说服，不如让响应体里根本不出现用户输入——排查所需的原始错误
    // 写进结构化日志，按 request_id 查即可。
    if (req.query.error) {
      logWarn('workbench.auth.provider_error', {
        request_id: req.requestId,
        error: String(req.query.error).slice(0, 200),
      });
      return res.status(400).type('text/plain').send('飞书登录未完成，请重新打开工作台重试');
    }
    try {
      const appToken = await jsonFetch('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: process.env.LARK_AGENT_APP_ID, app_secret: process.env.LARK_AGENT_APP_SECRET }) });
      const token = await jsonFetch('https://open.feishu.cn/open-apis/authen/v1/access_token', { method: 'POST', headers: { Authorization: `Bearer ${appToken.app_access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', code: req.query.code }) });
      const info = await jsonFetch('https://open.feishu.cn/open-apis/authen/v1/user_info', { headers: { Authorization: `Bearer ${token.access_token}` } });
      const user = info;
      const allowed = allowedOpenIds();
      if (allowed.size && !allowed.has(user.open_id)) return res.status(403).send('当前飞书账号未被授权使用工作台');
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeSession(user)}; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax`);
      logInfo('workbench.auth.success', { request_id: req.requestId, operator_open_id: user.open_id });
      // 回跳目标：`next`（扫码页，走白名单）/ `return_to`（工作台前端，既有语义）——
      // 两者都没有时就是工作台首页（与改动前逐字一致）。
      return res.redirect(resolveCallbackTarget(req.query, record));
    } catch (error) {
      logWarn('workbench.auth.failed', { request_id: req.requestId, error: error.message });
      return res.status(502).send('飞书身份认证失败，请稍后重试');
    }
  });

  router.post('/logout', (req, res) => res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`).json({ success: true }));
  return router;
};

const getSessionUser = (req) => {
  const raw = req.get('cookie')?.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
  return decodeSession(raw);
};

module.exports = {
  createFeishuWebAuthRouter,
  enabled,
  getSessionUser,
  allowedOpenIds,
  safeReturnTo,
  // 扫码页（`routes/scanPage.js`）在"未登录 → 去登录"那一刻用的两个函数：
  // 一个把"刚才那一页"按回跳白名单校验，一个拼登录入口 URL。
  resolveScanNext,
  resolveReturnTo,
  buildLoginStartUrl,
};
