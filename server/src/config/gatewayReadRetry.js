'use strict';

/**
 * 飞书**读**请求的统一瞬时重试配置。
 * 判据与推送/写调度器同一份（`config/pushRetry` 的 `isTransientLarkError`），
 * 只是默认节奏更轻：页面读表不能因为重试把人拖住。
 */
const { readInt } = require('./envValue');
const { resolveTransientRetryConfig } = require('./pushRetry');

const DEFAULT_READ_MAX_RETRIES = 1;
const DEFAULT_READ_BASE_DELAY_MS = 300;
const DEFAULT_READ_MAX_DELAY_MS = 2_000;

/**
 * 关键读的统一重试：库存 / 采购明细 / 销售货品 / 标签二维码。
 * 与普通页面读分开：普通读仍用上面的轻量默认，关键读允许更长的退避。
 * 这是唯一一份关键读节奏；改这里即可，不再按业务域各放一份。
 */
const CRITICAL_READ_RETRY = Object.freeze({
  ...resolveTransientRetryConfig(),
  maxRetries: 5,
  baseDelayMs: 1000,
  factor: 2,
  maxDelayMs: 15000,
});

const resolveGatewayReadRetryConfig = (env = process.env) => ({
  ...resolveTransientRetryConfig(env),
  maxRetries: readInt(env, 'FEISHU_READ_RETRY_MAX_RETRIES', DEFAULT_READ_MAX_RETRIES, { min: 0, max: 5 }),
  baseDelayMs: readInt(env, 'FEISHU_READ_RETRY_BASE_DELAY_MS', DEFAULT_READ_BASE_DELAY_MS, { min: 0, max: 5_000 }),
  factor: 2,
  maxDelayMs: readInt(env, 'FEISHU_READ_RETRY_MAX_DELAY_MS', DEFAULT_READ_MAX_DELAY_MS, { min: 0, max: 10_000 }),
});

module.exports = {
  CRITICAL_READ_RETRY,
  resolveGatewayReadRetryConfig,
  DEFAULT_READ_MAX_RETRIES,
  DEFAULT_READ_BASE_DELAY_MS,
  DEFAULT_READ_MAX_DELAY_MS,
};
