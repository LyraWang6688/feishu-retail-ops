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

const resolveGatewayReadRetryConfig = (env = process.env) => ({
  ...resolveTransientRetryConfig(env),
  maxRetries: readInt(env, 'FEISHU_READ_RETRY_MAX_RETRIES', DEFAULT_READ_MAX_RETRIES, { min: 0, max: 5 }),
  baseDelayMs: readInt(env, 'FEISHU_READ_RETRY_BASE_DELAY_MS', DEFAULT_READ_BASE_DELAY_MS, { min: 0, max: 5_000 }),
  factor: 2,
  maxDelayMs: readInt(env, 'FEISHU_READ_RETRY_MAX_DELAY_MS', DEFAULT_READ_MAX_DELAY_MS, { min: 0, max: 10_000 }),
});

module.exports = {
  resolveGatewayReadRetryConfig,
  DEFAULT_READ_MAX_RETRIES,
  DEFAULT_READ_BASE_DELAY_MS,
  DEFAULT_READ_MAX_DELAY_MS,
};
