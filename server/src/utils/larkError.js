// 飞书 SDK / OpenAPI 抛错时，`error.message` 常常只有一句
// 「Request failed with status code 400」——真正能定位问题的 **code / msg / log_id / method_id**
// 在 `error.response.data` 里（`log_id` 也可能只在 HTTP 头 `x-tt-logid` 上）。
//
// 真机证据（2026-10-08 09:05 那次 9 点推送失败）：
//   · 推送失败日志只有 `error: "Request failed with status code 400"`；
//   · `lark.sdk.error` 只有 `detail: [["[object]","[object]"]]`（旧 describe 把普通对象一律
//     转成 '[object]'，而那正是 SDK `formatErrors` 传进来的形状）；
//   · 手动补发才拿到 `code 1254607 · msg "Data not ready, please try again later"`。
//
// ⇒ 本文件是这四项**唯一**的取用口：
//   · 日志（`lark.sdk.error` / 各条推送失败日志）只从这里拿字段；
//   · 🔴 **绝不** dump 整个 error / config —— `error.config.data` 里是 App Secret
//     （理由见 `utils/larkLogger` 顶部那段注释）。
//
// ⚠️ 只做**取值与白名单投影**，不做任何业务判断、不查表、不发请求。

const asText = (value) => (value === undefined || value === null ? '' : String(value));

/** HTTP 头（大小写不敏感）取值 —— `x-tt-logid` 是飞书放 log_id 的地方之一。 */
const headerValue = (headers, name) => {
  if (!headers || typeof headers !== 'object') return '';
  const wanted = String(name || '').toLowerCase();
  for (const key of Object.keys(headers)) {
    if (String(key).toLowerCase() === wanted) return asText(headers[key]);
  }
  return '';
};

/** 飞书返回体（`error.response.data` / 我们自己挂在 `error.larkData` 上的响应）。 */
const responseDataOf = (error) => {
  const fromResponse = error?.response?.data;
  if (fromResponse && typeof fromResponse === 'object') return fromResponse;
  const fromLarkData = error?.larkData;
  if (fromLarkData && typeof fromLarkData === 'object') return fromLarkData;
  // SDK 的 `formatErrors` 还会把 `response.data` **摊平之后**再传一份（见模块头注释）：
  // 那一份**自己就是**返回体（`{code, msg, log_id, error:{…}}`）⇒ 对象本身当返回体看。
  return error && typeof error === 'object' ? error : {};
};

/**
 * 那四个字段（拿不到就给空串；**不编**）。
 * @returns {{ code: string|number, msg: string, log_id: string, method_id: string }}
 */
const larkErrorFields = (error) => {
  const data = responseDataOf(error);
  // 有些接口把真实的错误嵌在 `data.error` 里，和顶层字段合并看。
  const inner = (data.error && typeof data.error === 'object') ? data.error : {};
  return {
    code: data.code ?? inner.code ?? error?.code ?? '',
    msg: asText(data.msg || data.message || inner.msg || inner.message || error?.message || ''),
    log_id: asText(data.log_id || data.logId || inner.log_id
      || headerValue(error?.response?.headers, 'x-tt-logid') || error?.log_id || ''),
    method_id: asText(data.method_id || data.methodId || inner.method_id || error?.method_id || ''),
  };
};

/** 一句话人话（保留仓库里既有那两处的形状：`msg (Code: code)`）。 */
const larkErrorText = (error) => {
  const { code, msg } = larkErrorFields(error);
  const message = msg || 'unknown';
  return code === '' || code === undefined ? message : `${message} (Code: ${code})`;
};

/**
 * 「响应里 code !== 0」那一条路（SDK 不抛、我们自己判）也要能带出这四项：
 * 把响应挂到 error 上，取值口一个（`larkErrorFields` 认得 `error.larkData`）。
 */
const larkResponseError = (prefix, response = {}) => Object.assign(
  new Error(`${prefix}: ${response.msg || 'unknown'} (Code: ${response.code})`),
  { larkData: response },
);

module.exports = { larkErrorFields, larkErrorText, larkResponseError, headerValue };
