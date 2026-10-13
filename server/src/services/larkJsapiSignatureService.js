/**
 * 飞书 JSAPI 签名服务（扫码用）—— **新增**，不改任何既有业务服务 ✓
 *
 * 链路：`tenant_access_token`（缓存）⇒ `jsapi_ticket`（缓存）⇒ `signature = sha1(jsapi_ticket=..&noncestr=..&timestamp=..&url=..)`
 * ⚠️ 返回给前端的**只有四项**（appId / timestamp / nonceStr / signature）⇒
 *    **绝不回显 secret 或 ticket 原文** ✗（有逐字哨兵 AC ✓）
 * ⚠️ 一切可注入（`fetchImpl` / `now` / `credentials`）⇒ 测试用**假 ticket** 验签，零网络 ✓
 */
const crypto = require('node:crypto');
const { getLarkAgentCredentials } = require('../config/larkAgent');
const { TICKET_TTL_MS, TICKET_SAFETY_MS } = require('../config/jsapiSignature');

const TENANT_TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const JSAPI_TICKET_URL = 'https://open.feishu.cn/open-apis/jssdk/ticket/get';

/** 飞书口径：`sha1(jsapi_ticket=…&noncestr=…&timestamp=…&url=…)`（字段名按官方文档，全小写） */
function signJsapiTicket({ ticket, nonceStr, timestamp, url }) {
  const raw = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`;
  return crypto.createHash('sha1').update(raw, 'utf8').digest('hex');
}

function createLarkJsapiSignatureService(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || (() => Date.now());
  const credentials = options.credentials || getLarkAgentCredentials;
  const ticketTtlMs = options.ticketTtlMs ?? TICKET_TTL_MS;
  const safetyMs = options.safetyMs ?? TICKET_SAFETY_MS;
  const makeNonce = options.makeNonce || (() => crypto.randomBytes(8).toString('hex'));

  const calls = { tenantToken: 0, ticket: 0 }; // ⭐ 计数 ⇒ 测试用它钉"命中缓存不再请求" ✓
  let tokenCache = null; // { value, expiresAt }
  let ticketCache = null;

  async function postJson(url, body) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (payload.code !== 0) {
      // ⚠️ 只报 code/msg，**不带**任何 secret 或 token 原文 ✗
      const error = new Error(`飞书接口失败：code=${payload.code}`);
      error.larkCode = payload.code;
      throw error;
    }
    return payload;
  }

  async function tenantToken() {
    if (tokenCache && now() < tokenCache.expiresAt - safetyMs) return tokenCache.value;
    const { appId, appSecret } = credentials();
    calls.tenantToken += 1;
    const payload = await postJson(TENANT_TOKEN_URL, { app_id: appId, app_secret: appSecret });
    const tokenExpire = Number.isFinite(payload.expire) ? payload.expire : 7200;
    tokenCache = { value: payload.tenant_access_token, expiresAt: now() + tokenExpire * 1000 };
    return tokenCache.value;
  }

  async function jsapiTicket() {
    if (ticketCache && now() < ticketCache.expiresAt - safetyMs) return ticketCache.value;
    const token = await tenantToken();
    calls.ticket += 1;
    const payload = await postJson(JSAPI_TICKET_URL, { type: 'url', token });
    // 飞书两种形状都见过：`data.ticket`（新版）/ `ticket`（旧版）⇒ 取到就认，取不到就报错
    const ticket = payload?.data?.ticket || payload?.ticket;
    if (!ticket) throw new Error('飞书没有返回 jsapi_ticket');
    // ⚠️ 不能用 `||`：假票据返回 `expires_in: 0`（立刻过期）时 `0 || 7200` 会**错误地缓存 2 小时** ✗
    const rawTtl = payload?.data?.expires_in ?? payload?.expires_in;
    const ttlSeconds = Number.isFinite(rawTtl) ? rawTtl : ticketTtlMs / 1000;
    ticketCache = { value: ticket, expiresAt: now() + ttlSeconds * 1000 };
    return ticketCache.value;
  }

  return {
    calls,
    /** 页面（当前 URL）的签名四项 —— **不含 ticket/secret** ✓ */
    async getSignature(url) {
      const ticket = await jsapiTicket();
      const timestamp = Math.floor(now() / 1000);
      const nonceStr = makeNonce();
      const signature = signJsapiTicket({ ticket, nonceStr, timestamp, url });
      return { appId: credentials().appId, timestamp, nonceStr, signature };
    },
    /** 测试/排查用：只回报"缓存状态"，**不含票据原文** ✓ */
    cacheState() {
      return { tokenCached: Boolean(tokenCache), ticketCached: Boolean(ticketCache) };
    },
  };
}

module.exports = { createLarkJsapiSignatureService, signJsapiTicket, TENANT_TOKEN_URL, JSAPI_TICKET_URL };
