'use strict';

/**
 * 抖音来客（生活服务）OpenAPI 的**配置**（配置先行：地址/超时/凭证/文案都由这里给）。
 *
 * 🔴 三条边界：
 *   · **凭证只从环境变量读**（`DOUYIN_LAIKE_CLIENT_KEY/SECRET`），本文件不落任何密钥；
 *   · 接口地址**集中登记**（`ENDPOINTS`）—— 调哪个接口、什么路径，只在这里改；
 *   · **用户可见文案也在这里**（`TEXTS`）—— `services/**` 不许再写死中文
 *     （`test/noHardcodedChinese.test.js` 会拦）。
 *
 * ⚠️ `batchVerify` 是**写**接口（核销），**只登记位置、不调用**（第一版只读）。
 */

const { readInt, readString } = require('./envValue');

const DEFAULT_BASE_URL = 'https://open.douyin.com';

// client_token 官方有效期 7200 秒；拿不到 `expires_in` 时退回「7200 - 300」的保守值。
const TOKEN_EXPIRES_FALLBACK_MS = (7200 - 300) * 1000;
// 提前 5 分钟刷新：宁可早刷一次，也不要拿着快过期的 token 去撞 2190002。
const TOKEN_SAFETY_MS = 5 * 60 * 1000;

const ENDPOINTS = Object.freeze({
  // 应用级凭证：client_credential ⇒ client_token
  clientToken: '/oauth/client_token/',
  // 订单查询（按 order_id 查详情；列表口径不可靠，见 laikeClient 文件头）
  orderQuery: '/goodlife/v1/hermes/trade/order/query/',
  // 验券历史（按时间区间 + 游标分页）
  verifyRecords: '/goodlife/v1/fulfilment/certificate/verify_record/query/',
  // 分账明细（按 certificate_id 查）
  settleLedger: '/goodlife/v1/settle/ledger/query_record_by_cert/',
  // ⛔ 写接口：跨订单验券（会真的核销），**登记位置、不调用**
  batchVerify: '/goodlife/v1/fulfilment/certificate/batch_verify/',
});

const TEXTS = Object.freeze({
  notConfigured: '抖音来客应用未配置：需要 DOUYIN_LAIKE_CLIENT_KEY / DOUYIN_LAIKE_CLIENT_SECRET',
  upstreamFailed: '抖音来客接口暂时不可用（网络/超时/5xx），稍后重试',
  tokenEmpty: '抖音来客返回了空 token',
  invalidResponse: '抖音来客返回的内容无法解析（可能是网关错误页），请重试或凭 logid 排查',
  verifyAccountRequired: '验券历史必须给 accountId',
  verifyTimeInvalid: '验券历史的 startTime / endTime 必须是 int 秒级时间戳，且 startTime < endTime',
  settleCertificateRequired: '分账明细必须给 certificateIds（券 ID）',
  orderIdRequired: '订单详情必须给 orderId',
});

/** 错误码 → 排查用的 reason + 给业务看的人话（认不出的不猜，走兜底）。 */
const ERROR_GUIDES = Object.freeze({
  10013: { reason: 'creds_error', message: 'client_key 或 client_secret 错误（去控制台核对/重置 AppSecret）' },
  2190002: { reason: 'token_invalid', message: 'access_token 无效（token 过期或未生效）' },
  4000001: { reason: 'param_missing', message: '缺少 account_id / poi_id / third_id 之一' },
  2100005: { reason: 'param_invalid', message: '参数不合法（时间必须是 int 秒级时间戳）' },
});

const describeErrorCode = (errorCode) => {
  const guide = ERROR_GUIDES[Number(errorCode)];
  if (guide) return { ...guide };
  return { reason: 'business_error', message: `抖音来客接口返回错误 ${errorCode}` };
};

const createDouyinLaikeConfig = (env = process.env) => {
  const clientKey = String(readString(env, 'DOUYIN_LAIKE_CLIENT_KEY', '')).trim();
  const clientSecret = String(readString(env, 'DOUYIN_LAIKE_CLIENT_SECRET', '')).trim();
  return {
    baseUrl: readString(env, 'DOUYIN_LAIKE_BASE_URL', DEFAULT_BASE_URL).replace(/\/+$/, ''),
    clientKey,
    clientSecret,
    timeoutMs: readInt(env, 'DOUYIN_LAIKE_TIMEOUT_MS', 10000, { min: 1000, max: 60000 }),
    tokenSafetyMs: TOKEN_SAFETY_MS,
    tokenFallbackTtlMs: TOKEN_EXPIRES_FALLBACK_MS,
    endpoints: ENDPOINTS,
    texts: TEXTS,
  };
};

module.exports = {
  createDouyinLaikeConfig,
  describeErrorCode,
  ENDPOINTS,
  TEXTS,
  DEFAULT_BASE_URL,
  TOKEN_SAFETY_MS,
  TOKEN_EXPIRES_FALLBACK_MS,
};
