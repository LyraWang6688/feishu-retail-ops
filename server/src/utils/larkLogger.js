const { logError, logInfo, logWarn } = require('./logger');
const { larkErrorFields } = require('./larkError');

// 飞书 SDK 自带一个默认 logger，出错时会把整个 axios error 打印出来，
// 而这个 error 的 config.data 就是原始请求体：
//
//   data: '{"app_id":"cli_xxx","app_secret":"<真实密钥>"}'
//
// 于是任何一次与飞书之间的网络抖动（ECONNREFUSED / ECONNRESET / TLS 失败）都会把
// App Secret 写进 PM2 日志——这个项目的日志又是长期留存、供人和 agent 翻阅的。
// scripts/validate_v1_schema.js 早已记录了这个担忧并用空 logger 屏蔽，但生产服务
// 没有应用；这里是生产路径的对应实现。
//
// 做法是「不转发原始对象，只转发提炼过的字段」：
// 1. Error 只取 message / code / method / url，绝不取 config.data；
// 2. 其它对象一律不序列化（序列化本身就可能把整个 config 带出来）；
// 3. 对最终字符串再做一次密钥值替换兜底，防止 message 里已经拼进了密钥。
// 4. debug / trace 是 SDK 最可能倾倒完整请求体的级别，生产环境直接丢弃。
//
// ── 2026-10-08 修复（业务负责人点名的 ①）────────────────────────────────────
// 旧实现对**普通对象**一律返回 `'[object]'`，而 SDK 打印错误的形状恰恰是两个普通对象：
//   `@larksuiteoapi/node-sdk` 的 `formatErrors(e)` 返回
//   `[ {message, config:{data,url,params,method}, request, response:{data,status,statusText}},
//      {…response.data 摊平后的那份（含真实 code / msg / log_id）} ]`
// ⇒ 真机日志只剩 `lark.sdk.error detail: [["[object]","[object]"]]`，一个可用信息都没有。
// 现在普通对象也走**白名单投影**（与 Error 同一套字段，取自 utils/larkError）：
//   `{message, code, msg, log_id, method_id, status, method, url}` —— 仍然**绝不**带 config.data。
const SECRET_VALUE_PATTERN = /((?:app_secret|appSecret|tenant_access_token|app_access_token|access_token|authorization)["']?\s*[:=]\s*["']?(?:Bearer\s+)?)([^"',\s}]{4,})/gi;

const redact = (value) => String(value ?? '').replace(SECRET_VALUE_PATTERN, '$1***');

const compact = (object) => Object.fromEntries(
  Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== ''),
);

/** Error：只取能排查的那几个字段 + 飞书返回体里的真实四项。 */
const describeError = (error) => {
  const config = error.config || {};
  const fields = larkErrorFields(error);
  return compact({
    name: error.name,
    // 飞书真实 code 优先（网络错误时它就是 Node 的 ECONNREFUSED）。
    code: fields.code,
    // 飞书真实 msg 优先；拿不到才退回 axios 那句 "Request failed with status code 400"。
    msg: redact(fields.msg),
    message: redact(error.message),
    log_id: fields.log_id,
    method_id: fields.method_id,
    method: config.method,
    url: redact(config.url),
  });
};

/**
 * 普通对象（SDK 那两个形状）：白名单投影，**绝不整对象序列化**。
 * 什么字段都对不上时，只给属性名清单（属性名是静态的，不可能带出密钥值）。
 */
const describeObject = (value) => {
  const fields = larkErrorFields(value);
  const projected = compact({
    name: value.name,
    message: redact(value.message),
    code: fields.code,
    msg: redact(fields.msg),
    log_id: fields.log_id,
    method_id: fields.method_id,
    // 这两个只在 SDK 的第一份对象上有意义（HTTP 层的事实）。
    status: value.response?.status,
    method: value.config?.method,
    url: redact(value.config?.url),
  });
  if (Object.keys(projected).length) return projected;
  return { kind: 'object', keys: Object.keys(value).slice(0, 12) };
};

const describe = (arg) => {
  if (Array.isArray(arg)) return arg.map(describe);
  if (arg instanceof Error) return describeError(arg);
  if (typeof arg === 'string') return redact(arg);
  if (arg === null || typeof arg !== 'object') return arg;
  return describeObject(arg);
};

// SDK 传入的不是裸参数，而是「一个数组」，例如 info(['client ready']) 或
// error([axiosError]) / error([objA, objB])，所以这里要先摊平一层再提炼字段。
const toDetail = (args) => args
  .flatMap((arg) => (Array.isArray(arg) ? arg : [arg]))
  .map(describe);

const larkLogger = {
  error: (...args) => logError('lark.sdk.error', { detail: toDetail(args) }),
  warn: (...args) => logWarn('lark.sdk.warn', { detail: toDetail(args) }),
  info: (...args) => logInfo('lark.sdk.info', { detail: toDetail(args) }),
  debug: () => {},
  trace: () => {},
};

module.exports = { larkLogger, redact, describe, toDetail };
