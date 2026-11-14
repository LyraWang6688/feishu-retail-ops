'use strict';

/**
 * 安全中间件（2026-11-14，#51）：**来源校验 + IP 限流**。
 *
 * 为什么要有：
 *   · POST `/r/*` 原来是"同源表单 + 飞书会话"，没有任何 Origin / Sec-Fetch-Site 校验
 *     （cookie 又是 `SameSite=None` ⇒ CSRF 兜底失效）；
 *   · CodeQL 一直报 `js/missing-rate-limiting`（6 处 high）—— 公网入口没有配额。
 *
 * ⚠️ 都是"保守拒绝"：**没有 Origin 的请求照常放行**（curl/服务端调用/老 WebView），
 *   只在"明确说了来自别处"（Origin 不匹配 或 Sec-Fetch-Site: cross-site）时拒。
 */
const { SECURITY } = require('../config/security');

// ⚠️ 不用 `/\/+$/`（CodeQL ReDoS：用户可控 Origin 里塞大量 '/' 会拖慢正则）——
//   手动从尾部剥斜杠是线性；再限长 300 兜底。
const normalize = (origin) => {
  const value = String(origin || '').trim().toLowerCase().slice(0, 300);
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
};

/** 扫码页 **写请求**（POST/PUT/PATCH/DELETE）的来源校验；GET/HEAD/OPTIONS 不拦。 */
const createOriginGuard = ({ allowedOrigins = SECURITY.scanPostAllowedOrigins } = {}) => {
  const allowed = new Set((allowedOrigins || []).map(normalize).filter(Boolean));
  return (req, res, next) => {
    const method = String(req.method || '').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    const origin = normalize(req.headers?.origin);
    const fetchSite = String(req.headers?.['sec-fetch-site'] || '').trim().toLowerCase();
    if (origin) {
      if (allowed.has(origin)) return next();
      return res.status(403).json({ success: false, error: '来源校验失败' });
    }
    // 没有 Origin，但浏览器明确标了 cross-site ⇒ 拒（服务端/curl 不会带这个头）
    if (fetchSite === 'cross-site') {
      return res.status(403).json({ success: false, error: '来源校验失败' });
    }
    return next();
  };
};

/**
 * 内存滑动窗口限流（按"真实客户端 IP"）。
 * 反向代理后 `req.ip` 恒为 127.0.0.1 ⇒ 优先取 `x-forwarded-for` 第一跳。
 */
const createRateLimit = ({
  windowMs = SECURITY.rateLimit.windowMs,
  max = SECURITY.rateLimit.scanMax,
  name = '',
  enabled = SECURITY.rateLimit.enabled,
  now = () => Date.now(),
} = {}) => {
  const hits = new Map();
  return (req, res, next) => {
    if (!enabled) return next();
    const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    const key = forwarded || req.socket?.remoteAddress || 'unknown';
    const at = now();
    let entry = hits.get(key);
    if (!entry || at - entry.start >= windowMs) {
      entry = { start: at, count: 0 };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('retry-after', String(Math.max(1, Math.ceil((entry.start + windowMs - at) / 1000))));
      return res.status(429).json({ success: false, error: '请求过于频繁，请稍后再试' });
    }
    // 大 Map 兜底：顺手清掉过期窗口，避免长期运行内存膨胀
    if (hits.size > 5000) {
      for (const [ip, value] of hits) {
        if (at - value.start >= windowMs) hits.delete(ip);
      }
    }
    return next();
  };
};

module.exports = { createOriginGuard, createRateLimit };
