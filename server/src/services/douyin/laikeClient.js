'use strict';

/**
 * 抖音来客（生活服务）OpenAPI 的**只读客户端**。
 *
 * 链路（官方）：`client_key + client_secret` ⇒ `POST /oauth/client_token/` ⇒ `access-token` 头。
 * 三个只读接口（第一版只碰这三个，**不调任何写接口**）：
 *   · 验券历史   `GET /goodlife/v1/fulfilment/certificate/verify_record/query/`
 *   · 分账明细   `GET /goodlife/v1/settle/ledger/query_record_by_cert/`
 *   · 订单详情   `GET /goodlife/v1/hermes/trade/order/query/`
 *
 * 两条踩过的坑（都写进实现里）：
 *   · **时间参数必须是 int 秒级时间戳**（传字符串回 `2100005 参数不合法`）；
 *   · **订单列表按时间查会回 0**，但按 `order_id` 能查到完整订单 ⇒ 拉数走
 *     「验券历史 ⇒ 分账明细（拿 order_id）⇒ 订单详情」，不依赖订单列表。
 *
 * 🔴 安全：token / secret **绝不进日志、绝不进返回值**；只打错误码与 logid。
 * 🔴 文案：**用户可见中文一律在 `config/douyinLaike.js`**（本文件不许硬编码，守门测试会拦）。
 */

const { logWarn } = require('../../utils/logger');
const { createDouyinLaikeConfig, describeErrorCode } = require('../../config/douyinLaike');

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

/** 统一失败形状：调用方只判 `ok`，人话在 `message`，排查靠 `errorCode` / `logId`。 */
const fail = (reason, message, extra = {}) => ({
  ok: false,
  reason,
  message,
  ...extra,
});

/** 查询串：跳过空值；数组按英文逗号拼接（`certificate_ids=a,b`）。 */
const buildQuery = (query = {}) => {
  const search = new URLSearchParams();
  Object.keys(query).forEach((key) => {
    const value = query[key];
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      if (!value.length) return;
      search.append(key, value.map((item) => String(item)).join(','));
      return;
    }
    search.append(key, String(value));
  });
  const text = search.toString();
  return text ? `?${text}` : '';
};

const isEpochSeconds = (value) => Number.isInteger(value) && value > 0;

const createLaikeClient = (options = {}) => {
  const env = options.env || process.env;
  const config = options.config || createDouyinLaikeConfig(env);
  const fetchImpl = options.fetch || globalThis.fetch;
  const now = options.now || (() => Date.now());

  /** 2h 有效期里提前 5 分钟换新的；`expires_in` 优先于配置里的保守值。 */
  let tokenCache = { value: '', at: 0, ttlMs: 0 };

  const withTimeout = async (fn, label) => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), config.timeoutMs);
    try {
      return await fn(controller?.signal);
    } catch (error) {
      throw Object.assign(new Error(`${label}_failed: ${error?.message || 'unknown'}`), { reason: label });
    } finally {
      clearTimeout(timer);
    }
  };

  const request = async ({ method, path, query, body, token, label }) => {
    const url = `${config.baseUrl}${path}${buildQuery(query)}`;
    const headers = { Accept: 'application/json' };
    // ⚠️ 必须**不带 `charset`**：`application/json; charset=utf-8` 会被抖音网关判成
    //    `10002 参数错误`（实测：同一 body，A/B 不带 charset 通、带 charset 必错）。
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['access-token'] = token;

    let response;
    try {
      response = await withTimeout(
        (signal) => fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        }),
        label,
      );
    } catch (error) {
      logWarn('douyin.laike.request.failed', { label, reason: 'upstream_failed', detail: String(error?.message || '').slice(0, 120) });
      return fail('upstream_failed', config.texts.upstreamFailed);
    }

    const payload = await response.json().catch(() => ({}));
    const logId = String(payload?.extra?.logid || response.headers?.get?.('x-tt-logid') || '').trim();
    if (!response.ok) {
      logWarn('douyin.laike.request.failed', { label, reason: 'http_error', status: response.status, log_id: logId });
      return fail('upstream_failed', config.texts.upstreamFailed, { status: response.status, logId });
    }

    const rawCode = payload?.data?.error_code ?? payload?.extra?.error_code;
    const errorCode = Number(rawCode === undefined || rawCode === null ? 0 : rawCode);
    if (errorCode !== 0) {
      const described = describeErrorCode(errorCode);
      logWarn('douyin.laike.request.failed', { label, reason: described.reason, error_code: errorCode, log_id: logId });
      return fail(described.reason, described.message, { errorCode, logId });
    }

    return { ok: true, data: payload?.data ?? {}, logId };
  };

  /** 应用级 token：TTL 内复用，绝不重复换；失败不缓存。 */
  const token = async () => {
    const cached = tokenCache.value && now() - tokenCache.at < tokenCache.ttlMs;
    if (cached) return { ok: true, token: tokenCache.value, cached: true };

    if (!isNonEmptyString(config.clientKey) || !isNonEmptyString(config.clientSecret)) {
      return fail('not_configured', config.texts.notConfigured);
    }

    const result = await request({
      method: 'POST',
      path: config.endpoints.clientToken,
      body: {
        client_key: config.clientKey,
        client_secret: config.clientSecret,
        grant_type: 'client_credential',
      },
      label: 'client_token',
    });
    if (!result.ok) return result;

    const accessToken = String(result.data?.access_token || '').trim();
    if (!accessToken) {
      logWarn('douyin.laike.token.failed', { reason: 'token_empty', log_id: result.logId });
      return fail('token_empty', config.texts.tokenEmpty, { logId: result.logId });
    }
    const expiresInSec = Number(result.data?.expires_in || 0);
    const ttlMs = expiresInSec > 0
      ? Math.max(config.tokenSafetyMs, (expiresInSec * 1000) - config.tokenSafetyMs)
      : config.tokenFallbackTtlMs;
    tokenCache = { value: accessToken, at: now(), ttlMs };
    return { ok: true, token: accessToken, cached: false };
  };

  /**
   * 验券历史。`startTime` / `endTime` 必须是 **int 秒级时间戳**（传字符串会 2100005）。
   * 分页是**游标**：返回里的 `cursor` 交给下一次调用。
   */
  const verifyRecords = async ({ accountId, startTime, endTime, cursor = 0, size = 20, poiIds } = {}) => {
    if (!isNonEmptyString(accountId)) return fail('param_missing', config.texts.verifyAccountRequired);
    if (!isEpochSeconds(startTime) || !isEpochSeconds(endTime) || startTime >= endTime) {
      return fail('param_invalid', config.texts.verifyTimeInvalid);
    }
    const authorized = await token();
    if (!authorized.ok) return authorized;
    return request({
      method: 'GET',
      path: config.endpoints.verifyRecords,
      query: {
        account_id: accountId,
        start_time: startTime,
        end_time: endTime,
        cursor,
        size,
        poi_ids: poiIds,
      },
      token: authorized.token,
      label: 'verify_records',
    });
  };

  /** 分账明细：**必填** certificateIds（一个或多个），返回 `ledger_total` / `order_id` 等。 */
  const settleLedger = async ({ certificateIds } = {}) => {
    const ids = Array.isArray(certificateIds)
      ? certificateIds.map((item) => String(item).trim()).filter(Boolean)
      : [];
    if (!ids.length) return fail('param_missing', config.texts.settleCertificateRequired);
    const authorized = await token();
    if (!authorized.ok) return authorized;
    return request({
      method: 'GET',
      path: config.endpoints.settleLedger,
      query: { certificate_ids: ids },
      token: authorized.token,
      label: 'settle_ledger',
    });
  };

  /** 订单详情：按 `order_id` 查（列表口径不可靠，见文件头注释）。 */
  const orderDetail = async ({ accountId, orderId } = {}) => {
    if (!isNonEmptyString(orderId)) return fail('param_missing', config.texts.orderIdRequired);
    const authorized = await token();
    if (!authorized.ok) return authorized;
    return request({
      method: 'GET',
      path: config.endpoints.orderQuery,
      query: { account_id: accountId, order_id: orderId },
      token: authorized.token,
      label: 'order_detail',
    });
  };

  return {
    config,
    token,
    verifyRecords,
    settleLedger,
    orderDetail,
    tokenCacheOf: () => ({ ...tokenCache }),
  };
};

module.exports = { createLaikeClient, buildQuery, fail };
