'use strict';

/**
 * 飞书 **JSAPI 签名**（给网页里的扫一扫用）。
 *
 * 链路（官方）：
 *   ① `tenant_access_token` ← app_id + app_secret
 *   ② `jsapi_ticket`        ← 上一步的 token
 *   ③ `signature = sha1("jsapi_ticket=<t>&noncestr=<n>&timestamp=<ts>&url=<页面URL去#>)")`
 *
 * 🔴 三条硬约束：
 *   · **密钥只从环境变量读** ✓（本文件不落任何密钥 ✗）
 *   · **不许无限等** ✗（每一步都有超时 ⇒ 页面点了必须有反应 ✓）
 *   · **只签允许的域名** ✓（`config.allowedHosts` ⇒ 防被拿去签别人的页 ✗）
 *
 * ⚠️ **本文件不写任何业务表**、也不认识"打印"这个词 ✗ —— 它只回答"给我一个能用的签名" ✓
 */

const crypto = require('node:crypto');
const { createLarkJsapiConfig } = require('../config/larkJsapi');
const { withTransientRetry } = require('../config/pushRetry');

// 与既有代码同一套取凭证口径（`config/larkAgent.js` 只读这两个变量名 ✓ 不回退旧租户 ✗）
const readCreds = (env = process.env) => ({
  appId: String(env.LARK_AGENT_APP_ID || '').trim(),
  appSecret: String(env.LARK_AGENT_APP_SECRET || '').trim(),
});

/** 页面 URL 参与签名前**必须去掉 #fragment** ✓（官方要求；否则签名对不上 ✗）。 */
const normalizeUrl = (raw) => String(raw || '').trim().split('#')[0];

const hostOf = (url) => {
  try { return new URL(url).host; } catch { return ''; }
};

const sign = ({ ticket, nonceStr, timestamp, url }) => crypto
  .createHash('sha1')
  .update(`jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`)
  .digest('hex');

const createLarkJsapiService = (options = {}) => {
  const config = options.config || createLarkJsapiConfig();
  const env = options.env || process.env;
  const now = options.now || (() => Date.now());
  const randomNonce = options.randomNonce || (() => crypto.randomBytes(8).toString('hex'));
  // ⚠️ 可注入（测试用假 fetch ✓ 真跑时用全局 fetch ✓）
  const fetchImpl = options.fetch || globalThis.fetch;

  let tokenCache = { value: null, at: 0 };
  let ticketCache = { value: null, at: 0 };

  const withTimeout = async (fn, label) => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), config.timeoutMs);
    try {
      return await fn(controller?.signal);
    } catch (error) {
      // ⭐ 超时/网络错一律当成"上游不可用" ⇒ 调用方给**人话** ✓ 绝不静默 ✗
      // ⚠️ 保留 HTTP status / 飞书 code / response：重试判据（withTransientRetry）要用，
      //    日志也要能看出是 429、5xx 还是 1254607。
      const wrapped = Object.assign(new Error(`${label}_failed: ${error?.message || 'unknown'}`), {
        reason: label,
      });
      for (const key of ['status', 'code', 'response']) {
        if (error?.[key] !== undefined) wrapped[key] = error[key];
      }
      throw wrapped;
    } finally {
      clearTimeout(timer);
    }
  };

  const postJson = async (url, body, signal) => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal,
    });
    const payload = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, payload };
  };

  /** HTTP 非 2xx 或飞书 code 非 0：保留 status/code/response 供瞬时重试判据使用。 */
  const upstreamError = (reason, result) => {
    const payload = result?.payload || {};
    const code = payload?.code ?? payload?.data?.code;
    const error = Object.assign(new Error(reason), {
      reason,
      status: Number(result?.status || 0) || undefined,
      response: { status: result?.status, data: payload },
    });
    if (code !== undefined && code !== null && code !== '') error.code = code;
    return error;
  };

  const tenantToken = async () => {
    const cached = tokenCache.value && now() - tokenCache.at < config.tokenTtlMs;
    if (cached) return tokenCache.value;
    const { appId, appSecret } = readCreds(env);
    if (!appId || !appSecret) {
      throw Object.assign(new Error('creds_missing'), { reason: 'creds_missing' });
    }
    const payload = await withTransientRetry(async () => {
      const result = await withTimeout(
        (signal) => postJson(config.endpoints.tenantAccessToken, { app_id: appId, app_secret: appSecret }, signal),
        'tenant_token',
      );
      if (!result.ok) throw upstreamError('tenant_token_http', result);
      if (result.payload?.code && result.payload.code !== 0) throw upstreamError('tenant_token_http', result);
      const token = String(result.payload?.tenant_access_token || '').trim();
      if (!token) throw Object.assign(new Error('tenant_token_empty'), {
        reason: 'tenant_token_empty', code: result.payload?.code,
      });
      return result.payload;
    }, { operation: 'lark_jsapi_tenant_token', config: config.retry });
    const token = String(payload?.tenant_access_token || '').trim();
    tokenCache = { value: token, at: now() };
    return token;
  };

  const jsapiTicket = async () => {
    // ⭐⭐ 2026-10-15：TTL **以飞书回的 `expire_in` 为准**（实测线上只有 **3844 秒 ≈ 64 分钟**，
    //   而我们原来写死 **110 分钟** ⇒ 后 46 分钟里算出来的签名都建在**已过期**的 ticket 上 ✗）。
    //   这里用「`expire_in` − 5 分钟安全余量」；飞书没回该字段才退回配置那个保守值 ✓。
    const ttl = ticketCache.ttlMs || config.ticketTtlMs;
    const cached = ticketCache.value && now() - ticketCache.at < ttl;
    if (cached) return ticketCache.value;
    const token = await tenantToken();
    const payload = await withTransientRetry(async () => {
      const result = await withTimeout(async (signal) => {
        const response = await fetchImpl(config.endpoints.jsapiTicket, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ type: 'jsapi' }),
          signal,
        });
        return { ok: response.ok, status: response.status, payload: await response.json().catch(() => ({})) };
      }, 'jsapi_ticket');
      if (!result.ok) throw upstreamError('jsapi_ticket_http', result);
      if (result.payload?.code && result.payload.code !== 0) throw upstreamError('jsapi_ticket_http', result);
      const nextTicket = String(result.payload?.data?.ticket || result.payload?.ticket || '').trim();
      if (!nextTicket) throw Object.assign(new Error('jsapi_ticket_empty'), {
        reason: 'jsapi_ticket_empty', code: result.payload?.code,
      });
      return result.payload;
    }, { operation: 'lark_jsapi_ticket', config: config.retry });
    const ticket = String(payload?.data?.ticket || payload?.ticket || '').trim();
    const expireInSec = Number(payload?.data?.expire_in || payload?.expire_in || 0);
    const ttlMs = expireInSec > 0
      ? Math.max(60 * 1000, (expireInSec - 300) * 1000)
      : config.ticketTtlMs;
    ticketCache = { value: ticket, at: now(), ttlMs };
    return ticket;
  };

  /** ⭐ 对外只这一个方法：给页面 URL ⇒ 返回 `h5sdk.config` 要的四样（**不含任何密钥** ✗）。 */
  const signatureFor = async (pageUrl = '') => {
    const url = normalizeUrl(pageUrl);
    const host = hostOf(url);
    if (!url || !host) {
      return { ok: false, reason: 'url_invalid', message: config.texts.hostNotAllowed };
    }
    if (config.allowedHosts.length && !config.allowedHosts.includes(host)) {
      return { ok: false, reason: 'host_not_allowed', message: config.texts.hostNotAllowed };
    }
    const { appId } = readCreds(env);
    if (!appId) return { ok: false, reason: 'not_configured', message: config.texts.notConfigured };
    try {
      const ticket = await jsapiTicket();
      // 🔴🔴 2026-10-15（真机实测 + 官方文档）：`h5sdk.config` 的 `timestamp` 必须是
      //   **毫秒级**时间戳 —— 官方《h5sdk.config》参数表逐字：「生成签名的**毫秒级**时间戳」。
      //   改前用的是**秒**（`Math.floor(now()/1000)`）⇒ 飞书按毫秒解读 ⇒ 时间落在 1970 年
      //   ⇒ 每次都被判 **`333444 签名过期`**（真机 raw：`{"errorMessage":"signature is expired",
      //     "errno":"2601002","errorCode":"333444"}`）✗ —— 而时钟 / URL / appId / 签名算法全都正确。
      //   ⚠️ 签名串里用的 `timestamp` **必须与 config 里发出去的一致**（官方 333441 排查项逐字）
      //     ⇒ 这里一并改成同一个**毫秒值** ✓。
      const timestamp = now();
      const nonceStr = randomNonce();
      return { ok: true, appId, timestamp, nonceStr, signature: sign({ ticket, nonceStr, timestamp, url }), url };
    } catch (error) {
      const reason = String(error?.reason || 'upstream_failed');
      const message = reason === 'creds_missing' ? config.texts.notConfigured : config.texts.upstreamFailed;
      return {
        ok: false,
        reason,
        message,
        // 只用于排障；不含 token / ticket / 密钥。
        upstream_status: error?.status,
        upstream_code: error?.code,
      };
    }
  };

  return { signatureFor, config, sign, normalizeUrl, tenantToken, jsapiTicket, tokenCacheOf: () => tokenCache, ticketCacheOf: () => ticketCache };
};

module.exports = { createLarkJsapiService, sign, normalizeUrl };
