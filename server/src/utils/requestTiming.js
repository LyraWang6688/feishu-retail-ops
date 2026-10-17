'use strict';

/** 请求耗时中间件：只对 `config/timing.js` 登记的 5 条链路打一条 `perf.request.completed`。 */
const { REQUEST_TIMING, resolveTimingChain } = require('../config/timing');
const { logInfo } = require('./logger');

const requestTiming = () => (req, res, next) => {
  if (!REQUEST_TIMING.enabled) return next();
  const chain = resolveTimingChain({ method: req.method, path: req.path || req.originalUrl, body: req.body });
  if (!chain) return next();
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
    logInfo('perf.request.completed', {
      chain,
      method: req.method,
      status: res.statusCode,
      duration_ms: durationMs,
      slow: durationMs >= REQUEST_TIMING.slowMs,
    });
  });
  return next();
};

module.exports = { requestTiming };
