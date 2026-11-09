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
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

    // ⚠️ 解析失败**不能**当成空对象：否则"上游返回坏页（HTML 网关错误页）"会被
    //    读成"查询成功但没有数据"（review 指出：`{}` ⇒ 无 error_code ⇒ 默认 0 ⇒ ok:true）。
    //    这里单独回 `invalid_response`，并保留响应头 logid 供排查。
    let payload = null;
    let parseError = null;
    try {
      payload = await response.json();
    } catch (error) {
      parseError = error;
    }
    const logId = String(payload?.extra?.logid || response.headers?.get?.('x-tt-logid') || '').trim();
    if (parseError || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      logWarn('douyin.laike.request.failed', { label, reason: 'invalid_response', status: response.status, log_id: logId });
      return fail('invalid_response', config.texts.invalidResponse, { status: response.status, logId });
    }
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

    // 成功响应必须带 `data` 对象（抖音所有 goodlife 接口都是这个形状）；
    // 没有 `data` 说明"响应对不上契约"，不能当成功空数据返回。
    if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
      logWarn('douyin.laike.request.failed', { label, reason: 'invalid_response', status: response.status, log_id: logId });
      return fail('invalid_response', config.texts.invalidResponse, { status: response.status, logId });
    }

    return { ok: true, data: payload.data, logId };
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

  /**
   * 账单详情：按 `bill_date`（yyyy-MM-dd，结算单生成日/核销日）查。
   * 返回的每条 `ledger_records` 带 `ledger_id / sku_id / verify_id / settlement_time`，
   * `amount.goods` = 平台结算款（分）。
   */
  const settleBill = async ({ accountId, billDate, cursor = 0, size = 100 } = {}) => {
    if (!isNonEmptyString(accountId)) return fail('param_missing', config.texts.verifyAccountRequired);
    if (!DATE_RE.test(String(billDate || ''))) return fail('param_invalid', config.texts.settleBillInvalid);
    const authorized = await token();
    if (!authorized.ok) return authorized;
    return request({
      method: 'GET',
      path: config.endpoints.settleBill,
      query: { account_id: accountId, bill_date: billDate, cursor, size },
      token: authorized.token,
      label: 'settle_bill',
    });
  };

  /**
   * 提现记录：按日期区间查（yyyy-MM-dd）。
   * 每条带 `withdraw_id / amount / settle_account / withdraw_time / status`。
   */
  const settleWithdraw = async ({ accountId, startDate, endDate, cursor = 0, size = 100 } = {}) => {
    if (!isNonEmptyString(accountId)) return fail('param_missing', config.texts.verifyAccountRequired);
    if (!DATE_RE.test(String(startDate || '')) || !DATE_RE.test(String(endDate || ''))) {
      return fail('param_invalid', config.texts.settleWithdrawInvalid);
    }
    const authorized = await token();
    if (!authorized.ok) return authorized;
    return request({
      method: 'GET',
      path: config.endpoints.settleWithdraw,
      query: { account_id: accountId, start_date: startDate, end_date: endDate, cursor, size },
      token: authorized.token,
      label: 'settle_withdraw',
    });
  };

  /** 商品（券）线上列表：目录字段（名称/状态/上架时间/图片/适用规则）。 */
  // ⚠️ `count` 实测 >50 会**静默返回空列表**（count=100 ⇒ 0 条）；默认 50、上限 50。
  const fetchProductList = async ({ accountId, count = 50, cursor = 0, status } = {}) => {
    if (!isNonEmptyString(accountId)) return fail('param_missing', config.texts.verifyAccountRequired);
    const authorized = await token();
    if (!authorized.ok) return authorized;
    return request({
      method: 'GET',
      path: config.endpoints.goodsOnlineList,
      query: { account_id: accountId, count, cursor, status },
      token: authorized.token,
      label: 'goods_list',
    });
  };

  /**
   * 商品（券）单品详情：**佣金费率只在这里准**（列表接口的 `platform_take_rate` 实测为 0）。
   * 返回 `commission_info.platform_take_rate`（万分比：500 = 5%）。
   */
  const fetchProduct = async ({ accountId, productIds } = {}) => {
    if (!isNonEmptyString(accountId)) return fail('param_missing', config.texts.verifyAccountRequired);
    const ids = Array.isArray(productIds) ? productIds.filter(Boolean) : [productIds].filter(Boolean);
    if (!ids.length) return fail('param_missing', config.texts.orderIdRequired);
    const authorized = await token();
    if (!authorized.ok) return authorized;
    return request({
      method: 'GET',
      path: config.endpoints.goodsOnlineGet,
      query: { account_id: accountId, product_ids: ids },
      token: authorized.token,
      label: 'goods_get',
    });
  };

  /** 批量查 SKU：售价 `actual_amount` / 面值 `origin_amount`（单位：分）。 */
  const fetchSkus = async ({ accountId, productId } = {}) => {
    if (!isNonEmptyString(accountId)) return fail('param_missing', config.texts.verifyAccountRequired);
    if (!isNonEmptyString(productId)) return fail('param_missing', config.texts.orderIdRequired);
    const authorized = await token();
    if (!authorized.ok) return authorized;
    return request({
      method: 'GET',
      path: config.endpoints.goodsSkuGet,
      query: { account_id: accountId, product_id: productId },
      token: authorized.token,
      label: 'goods_skus',
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
    settleBill,
    settleWithdraw,
    fetchProductList,
    fetchProduct,
    fetchSkus,
    orderDetail,
    tokenCacheOf: () => ({ ...tokenCache }),
  };
};

module.exports = { createLaikeClient, buildQuery, fail };
