const { logError, logInfo, logWarn } = require('./logger');

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
const SECRET_VALUE_PATTERN = /((?:app_secret|appSecret|tenant_access_token|app_access_token|access_token|authorization)["']?\s*[:=]\s*["']?(?:Bearer\s+)?)([^"',\s}]{4,})/gi;

const redact = (value) => String(value ?? '').replace(SECRET_VALUE_PATTERN, '$1***');

const describe = (arg) => {
  if (Array.isArray(arg)) return arg.map(describe);
  if (arg instanceof Error) {
    const config = arg.config || {};
    return {
      name: arg.name,
      code: arg.code,
      message: redact(arg.message),
      method: config.method,
      url: redact(config.url),
    };
  }
  if (typeof arg === 'string') return redact(arg);
  if (arg === null || typeof arg !== 'object') return arg;
  return '[object]';
};

// SDK 传入的不是裸参数，而是「一个数组」，例如 info(['client ready']) 或
// error([axiosError])，所以这里要先摊平一层再提炼字段。
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

module.exports = { larkLogger, redact, describe };
