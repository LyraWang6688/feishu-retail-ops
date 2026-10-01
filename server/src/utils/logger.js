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
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitizeMeta(meta),
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
    return;
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
  redactValue,
  sanitizeMeta,
};
