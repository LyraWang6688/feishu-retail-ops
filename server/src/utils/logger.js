const { isRegisteredEvent } = require('../config/events');
const { traceLogFields } = require('./traceContext');

// 已登记事件表见 config/events.js（由 scripts/observability-events.mjs 生成）。
// 未登记事件：默认**只打 `unregistered: true` 标记**（可用日志查询发现），不阻断业务；
// `LOG_EVENT_STRICT=true` 时另打一条 `log.event.unregistered` warn（同名只打一次，避免刷屏）。
const unregisteredWarned = new Set();
// 观测监听器（告警等）：只读副本、**异常绝不影响业务日志**；返回取消订阅函数。
const listeners = new Set();
const addLogListener = (listener) => {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

const redactValue = (value) => {
  if (value == null) return value;
  const str = String(value);
  if (!str) return str;
  if (str.length <= 10) return `${str.slice(0, 2)}***${str.slice(-2)}`;
  return `${str.slice(0, 4)}***${str.slice(-4)}`;
};

const isSecretField = (key) =>
  /(^|_)(token|secret|password|authorization|api_key|encrypt_key)$/i.test(String(key));

const isIdentityField = (key) => /(^|_)(open_id|user_id|union_id)$/i.test(String(key));

const sanitizeMeta = (meta = {}) => {
  const out = {};
  Object.keys(meta).forEach((key) => {
    const value = meta[key];
    if (value === undefined) return;
    if (isSecretField(key) || isIdentityField(key)) {
      out[key] = redactValue(value);
      return;
    }
    out[key] = value;
  });
  return out;
};

const writeLog = (level, event, meta = {}) => {
  const unregistered = Boolean(event) && !isRegisteredEvent(event);
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(unregistered ? { unregistered: true } : {}),
    ...traceLogFields(),
    ...sanitizeMeta(meta),
  };
  if (listeners.size) {
    for (const listener of listeners) {
      try { listener({ ...payload }); } catch { /* 监听器失败不许影响业务日志 */ }
    }
  }
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
    return;
  }
  if (unregistered && process.env.LOG_EVENT_STRICT === 'true' && !unregisteredWarned.has(event)) {
    unregisteredWarned.add(event);
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), level: 'warn', event: 'log.event.unregistered', name: event,
    }));
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.log(line);
};

const logInfo = (event, meta) => writeLog('info', event, meta);
const logWarn = (event, meta) => writeLog('warn', event, meta);
const logError = (event, meta) => writeLog('error', event, meta);

module.exports = {
  logInfo,
  logWarn,
  logError,
  addLogListener,
  redactValue,
  sanitizeMeta,
};
