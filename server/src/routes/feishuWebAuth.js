const express = require('express');
const crypto = require('node:crypto');
const { logInfo, logWarn } = require('../utils/logger');

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
    states.set(state, { return_to: safeReturnTo(req.query.return_to), expires_at: Date.now() + STATE_TTL_MS });
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
      return res.redirect(record.return_to);
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

module.exports = { createFeishuWebAuthRouter, enabled, getSessionUser, allowedOpenIds, safeReturnTo };
