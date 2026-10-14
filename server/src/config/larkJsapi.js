'use strict';

/**
 * 飞书 **JSAPI 签名**的配置（配置先行 ✓ 不散写 if-else ✗）。
 *
 * 背景（业务负责人 2026-10-14 选了「扫码 ⇒ 直接打印这一张」）：
 *   网页里要调飞书的**扫一扫** ⇒ 必须先 `h5sdk.config({ appId, timestamp, nonceStr, signature })` ✓
 *   而 `signature` 要服务端用 **app 凭证**换 `jsapi_ticket` 现算 ✓
 *   ⇒ 于是有了这一份配置（阈值/缓存/接口路径全部可配 ✓）。
 *
 * 🔴 **密钥一律从环境变量读**（`LARK_AGENT_APP_ID` / `LARK_AGENT_APP_SECRET` ✓）
 *    它俩与机器人同源 ✓ **不许把任何密钥硬编码进源码** ✗（本文件只读 env 的名字 ✓）。
 */

const readInt = (env, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const raw = String(env[key] ?? '').trim();
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return fallback;
  return Math.trunc(value);
};

const createLarkJsapiConfig = (env = process.env) => Object.freeze({
  // 飞书 JSAPI 签名接口（v1）
  endpoints: Object.freeze({
    tenantAccessToken: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    jsapiTicket: 'https://open.feishu.cn/open-apis/jssdk/ticket/get',
  }),
  // ⭐ ticket 官方有效期 2h ⇒ 缓存留 5 分钟余量（可配 ✓）
  ticketTtlMs: readInt(env, 'LARK_JSAPI_TICKET_TTL_MS', 110 * 60 * 1000, { min: 1000 }),
  tokenTtlMs: readInt(env, 'LARK_JSAPI_TOKEN_TTL_MS', 110 * 60 * 1000, { min: 1000 }),
  // 取票/换 token 的网络超时（**不许无限等** ✗ —— 页面点了没反应是最坏的结果 ✓）
  timeoutMs: readInt(env, 'LARK_JSAPI_TIMEOUT_MS', 5000, { min: 500 }),
  // 允许签名的页面地址（**只签我们自己的域名** ✓ 防被拿去签别人的页 ✗）
  allowedHosts: Object.freeze(String(env.LARK_JSAPI_ALLOWED_HOSTS || 'hm.bamamei.online')
    .split(',').map((s) => s.trim()).filter(Boolean)),
  // 文案（配置先行 ✓ 渲染层不许写死中文 ✗）
  texts: Object.freeze({
    notConfigured: '扫码打印暂时不可用（服务端还没配应用凭证），先用"选择编号打印"。',
    hostNotAllowed: '这个页面地址不在允许签名的范围内，扫码打印用不了。',
    upstreamFailed: '扫码服务暂时不可用，稍后再试。',
  }),
});

module.exports = { createLarkJsapiConfig };
