'use strict';

const crypto = require('node:crypto');
const { TRACE, entryOfPath } = require('../config/trace');
const { runWithTrace } = require('./traceContext');

/**
 * 每个请求一个 trace 上下文：
 *   - `x-trace-id` 头优先（跨服务/手工重放可串起来）；否则用 `x-request-id`；都没有就生成。
 *   - `entry` 按路径枚举（scan / workbench / lark / api）。
 *   - 角色的 open_id 由身份中间件后面补（`setTraceFields({role})`）。
 * ⚠️ 必须排在 `requestId` 中间件**之后**（要用 `req.requestId`），但要在业务路由**之前**。
 */
const traceMiddleware = () => (req, res, next) => {
  if (!TRACE.enabled) return next();
  const traceId = String(req.get(TRACE.header) || req.get('x-request-id') || req.requestId || '').trim()
    || crypto.randomUUID();
  req.traceId = traceId;
  res.set(TRACE.header, traceId);
  return runWithTrace({ traceId, entry: entryOfPath(req.path || req.originalUrl) }, next);
};

module.exports = { traceMiddleware };
