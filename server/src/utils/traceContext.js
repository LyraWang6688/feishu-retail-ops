'use strict';

/**
 * 请求级追踪上下文（AsyncLocalStorage）。
 *
 * ⚠️ 只用于**日志附加字段**（trace_id / entry / role），**不参与任何业务判定**；
 *   与 `correlationFields` 那套"显式传参"互相独立（那套是写入类日志的关联键，禁 ALS）。
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

const runWithTrace = (store, fn) => storage.run(store, fn);

const setTraceFields = (fields) => {
  const current = storage.getStore();
  if (!current || !fields) return;
  Object.assign(current, fields);
};

/** logger 用：有上下文才返回字段（没有 ⇒ {}，不会改变既有日志形状）。 */
const traceLogFields = () => {
  const current = storage.getStore();
  if (!current) return {};
  const out = {};
  if (current.traceId) out.trace_id = current.traceId;
  if (current.entry) out.entry = current.entry;
  if (current.role) out.role = current.role;
  return out;
};

module.exports = { runWithTrace, setTraceFields, traceLogFields };
