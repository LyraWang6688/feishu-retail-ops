'use strict';

const { withTransientRetry } = require('../config/pushRetry');
const { resolveGatewayReadRetryConfig } = require('../config/gatewayReadRetry');
const { logWarn } = require('../utils/logger');

/** 网关只读请求的统一瞬时重试；options.retry === false 供旧链路显式关闭。 */
const readWithRetry = async (operation, work, options = {}) => {
  if (options?.retry === false) return work();
  const override = options?.retry && typeof options.retry === 'object' ? options.retry : {};
  const config = { ...resolveGatewayReadRetryConfig(), ...override };
  return withTransientRetry(work, {
    operation,
    config,
    onRetry: ({ attempt, delayMs, error }) => logWarn('feishu.read.retry', {
      operation,
      attempt,
      delay_ms: delayMs,
      error: String(error?.message || ''),
    }),
  });
};

module.exports = { readWithRetry };
