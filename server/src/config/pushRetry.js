// 「两条每日推送的**可靠性旋钮**」——失败重试的间隔与上限、瞬时错误的小退避、
// 失败告警的开关与文案，全在这一处（配置先行）。
//
// 服务的两条链路（两条各有各的"按天认领"记录）：
//   · `services/pendingDealPushService.js` —— 每天 9 点的**待处理单推送**；
//   · `services/secondDeliveryService.js`  —— 每天 9 点的**二次交付提醒卡**。
// 2026-10-08 真机伤口（两条链路都在 09:0x 掉过，`Request failed with status code 400`）：
//   · 当天失败即落 `failed`、当天不再重试 ⇒ **一整天不发**；
//   · 且只写日志、**没有任何人知道**；
//   · 早上 9:00 两条链路并发读多张表 ⇒ 更容易撞上飞书瞬时错误（1254607 / 5xx / 429）。
//
// ── 两层重试的**分工**（别把两层搞混）────────────────────────────────────────
//   · **瞬时层**（`transient`，秒级）：一次读 / 一次发**内部**的小退避，2~3 次；
//     只对**瞬时**错误重试（飞书 code 1254607 "Data not ready" / HTTP 429 / 5xx /
//     网络中断），**确定性错误**（权限、参数错、缺配置）一次都不重试，只留一条清晰日志。
//   · **按天层**（`daily`，分钟级）：整个 tick 失败之后，隔 `retryIntervalMs` 再来一次，
//     最多 `maxRetries` 次；**成功一次即停**；次数用完 ⇒ 往群里回一句人话（**不静默**）。
//
// ── 为什么两条链路共用这一个文件 ──────────────────────────────────────────────
//   "当天失败 ≠ 今天跑过""瞬时错误就地重试""重试用完要告警"这三条**语义是同一条**；
//   两处各写一遍，迟早一处改了另一处没改（本仓最怕的静默漂移）。
//   ⚠️ 下面那两个纯件（`isTransientLarkError` / `withTransientRetry` 与 `resolveDailyAttempt`）
//      也放在这里，是为了"判据与状态机**只有一处实现**"——比复制到两个 service 里更安全。
//
// 取值规则沿用 `config/envValue`：**没设 → 默认值**；**设了（含空串）→ 显式取值**；
// 认不出来的值**当场抛错**（不猜）。单测直接传 env 进来（不碰全局 process.env）。

const { readString, readFlag, readInt, readList } = require('./envValue');
const { logWarn } = require('../utils/logger');
const { larkErrorFields } = require('../utils/larkError');

// ── 瞬时层（秒级）─────────────────────────────────────────────────────────────
const PUSH_TRANSIENT_RETRY_MAX_RETRIES_ENV_KEY = 'PUSH_TRANSIENT_RETRY_MAX_RETRIES';
const PUSH_TRANSIENT_RETRY_BASE_DELAY_MS_ENV_KEY = 'PUSH_TRANSIENT_RETRY_BASE_DELAY_MS';
const PUSH_TRANSIENT_RETRY_FACTOR_ENV_KEY = 'PUSH_TRANSIENT_RETRY_FACTOR';
const PUSH_TRANSIENT_RETRY_MAX_DELAY_MS_ENV_KEY = 'PUSH_TRANSIENT_RETRY_MAX_DELAY_MS';
const PUSH_TRANSIENT_RETRY_LARK_CODES_ENV_KEY = 'PUSH_TRANSIENT_RETRY_LARK_CODES';

// ── 按天层（分钟级）───────────────────────────────────────────────────────────
const PUSH_DAILY_RETRY_INTERVAL_MS_ENV_KEY = 'PUSH_DAILY_RETRY_INTERVAL_MS';
const PUSH_DAILY_RETRY_MAX_RETRIES_ENV_KEY = 'PUSH_DAILY_RETRY_MAX_RETRIES';

// ── 失败告警（往群里回一句人话）──────────────────────────────────────────────
const PUSH_RETRY_ALERT_ENABLED_ENV_KEY = 'PUSH_RETRY_ALERT_ENABLED';
const PUSH_RETRY_ALERT_CHAT_ID_ENV_KEY = 'PUSH_RETRY_ALERT_CHAT_ID';
const PUSH_RETRY_ALERT_TEMPLATE_ENV_KEY = 'PUSH_RETRY_ALERT_TEMPLATE';
// 两条推送各自的名字（`{push}` 占位符的值）——"哪条推送失败了"必须说清楚。
const PENDING_DEAL_PUSH_ALERT_NAME_ENV_KEY = 'PENDING_DEAL_PUSH_ALERT_NAME';
const SECOND_DELIVERY_ALERT_NAME_ENV_KEY = 'SECOND_DELIVERY_ALERT_NAME';

const HOUR_MS = 60 * 60 * 1000;

// 瞬时层默认：**重试 2 次**（共 3 次尝试），1s → 2s（指数，封顶 5s）。
// 业务负责人 2026-10-08 点名的口径：「小退避重试（2~3 次，指数或固定 1~2 秒）」。
const DEFAULT_TRANSIENT_MAX_RETRIES = 2;
const DEFAULT_TRANSIENT_BASE_DELAY_MS = 1_000;
const DEFAULT_TRANSIENT_FACTOR = 2;
const DEFAULT_TRANSIENT_MAX_DELAY_MS = 5_000;
// 飞书「再等一下」类错误码（默认只认这个：真机上抓到的那一个）。
// ⚠️ 明确**不是**这个集合的错误码 = 确定性错误 ⇒ **一次都不重试**。
const DEFAULT_TRANSIENT_LARK_CODES = Object.freeze(['1254607']);

// 按天层默认：**每 10 分钟一次、最多重试 6 次**（= 一天最多 7 次尝试，首次失败后约 1 小时内）。
// ⚠️ 这一条**改了 2026-10-08 上午那版**（5 分钟 / 15 分钟各一次 = 只有 2 次重试）：
//    P0 的口径是"直到当天成功一次，上限 6 次"——2 次（都在 20 分钟内）挡不住那次
//    "09:05 失败 ⇒ 一整天不发"。老节奏仍可用 `PENDING_DEAL_PUSH_RETRY_DELAYS_MS` 显式写回。
const DEFAULT_DAILY_RETRY_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_DAILY_RETRY_MAX_RETRIES = 6;

// 告警默认模板：**哪条推送 · 哪天 · 什么原因 · 今天不会再试**（业务负责人要的四样）。
const DEFAULT_ALERT_TEMPLATE = '⚠️【{push}】{day} 推送失败，今天不会再自动重试。'
  + '原因：{reason}（已试 {attempt}/{maxAttempts} 次）';
const DEFAULT_PENDING_DEAL_PUSH_ALERT_NAME = '9 点待处理单推送';
const DEFAULT_SECOND_DELIVERY_ALERT_NAME = '二次交付每日提醒';

// 告警模板认得的占位符（写错名字**启动时**就抛错——不认识的占位符会被渲染成空串，
// 那等于悄悄少告诉她一段信息，属于最难查的一类）。
const ALERT_TEMPLATE_PLACEHOLDERS = Object.freeze([
  'push', 'day', 'attempt', 'maxAttempts', 'reason', 'code', 'msg',
]);

// 「没有飞书 code」时用来判瞬时的 HTTP 状态（429 限流 + 5xx 服务端错）。
const RETRYABLE_HTTP_STATUSES = Object.freeze([429]);
// 网络层错误码（axios / node）：这些是"请求根本没被处理"，重试是安全的。
const NETWORK_ERROR_CODES = Object.freeze([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH',
]);
// 没有 code 时按**人话**兜底判瞬时（真机上抓到的那句就在这里）。
// ⚠️ 只放"再试一次就可能好"的说法；不确定的一律不放（宁可只留一条日志）。
const TRANSIENT_MESSAGE_PATTERNS = Object.freeze([
  /data not ready/i,
  /数据未准备/,
  /please try again later/i,
  /try again later/i,
  /system busy/i,
  /系统繁忙/,
  /internal error/i,
  /服务内部错误/,
  /socket hang up/i,
  /timed? ?out/i,
  /network error/i,
  /ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|ENOTFOUND|ECONNREFUSED/,
]);

const DEFAULT_SLEEP = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

const asText = (value) => (value === undefined || value === null ? '' : String(value));

// ─────────────────────────────────────────────────────────────────────────────
// 取值
// ─────────────────────────────────────────────────────────────────────────────

/** 瞬时层配置（次数 / 间隔 / 倍率 / 封顶 / 认哪些飞书码是瞬时）。 */
const resolveTransientRetryConfig = (env = process.env) => {
  const codes = readList(env, PUSH_TRANSIENT_RETRY_LARK_CODES_ENV_KEY);
  return {
    // ⚠️ `readInt` 的规矩：**没设 / 空串 → 默认值**；要"不重试"就显式写 `0`。
    maxRetries: readInt(env, PUSH_TRANSIENT_RETRY_MAX_RETRIES_ENV_KEY, DEFAULT_TRANSIENT_MAX_RETRIES,
      { min: 0, max: 10 }),
    baseDelayMs: readInt(env, PUSH_TRANSIENT_RETRY_BASE_DELAY_MS_ENV_KEY, DEFAULT_TRANSIENT_BASE_DELAY_MS,
      { min: 0, max: 60_000 }),
    factor: readInt(env, PUSH_TRANSIENT_RETRY_FACTOR_ENV_KEY, DEFAULT_TRANSIENT_FACTOR, { min: 1, max: 10 }),
    maxDelayMs: readInt(env, PUSH_TRANSIENT_RETRY_MAX_DELAY_MS_ENV_KEY, DEFAULT_TRANSIENT_MAX_DELAY_MS,
      { min: 0, max: 60_000 }),
    // 空串 = 一个都不认（显式关掉"按 code 判瞬时"这条路）。
    larkCodes: codes === null ? [...DEFAULT_TRANSIENT_LARK_CODES] : codes,
    networkCodes: [...NETWORK_ERROR_CODES],
    messagePatterns: [...TRANSIENT_MESSAGE_PATTERNS],
  };
};

/**
 * 按天层配置（间隔 + 上限，并派生出"相对首次失败"的偏移表）。
 *
 * ⚠️ 派生出的 `retryDelaysMs` = `[interval × 1, interval × 2, …, interval × maxRetries]`
 *    —— 与 `pendingDealPush` 既有那个显式偏移表**同一种含义**（相对**首次失败**的偏移），
 *    所以既有的状态机（`resolveDailyAttempt`）一个字都不用改。
 * ⚠️ 总跨度**不许超过一天**（超过就不是"当天重试"了）：超了**启动时抛错**。
 */
const resolveDailyRetryConfig = (env = process.env) => {
  const retryIntervalMs = readInt(env, PUSH_DAILY_RETRY_INTERVAL_MS_ENV_KEY, DEFAULT_DAILY_RETRY_INTERVAL_MS,
    { min: 1_000, max: 24 * HOUR_MS });
  const maxRetries = readInt(env, PUSH_DAILY_RETRY_MAX_RETRIES_ENV_KEY, DEFAULT_DAILY_RETRY_MAX_RETRIES,
    { min: 0, max: 24 });
  const span = retryIntervalMs * maxRetries;
  if (maxRetries > 0 && span > 24 * HOUR_MS) {
    throw new Error(`${PUSH_DAILY_RETRY_INTERVAL_MS_ENV_KEY} × ${PUSH_DAILY_RETRY_MAX_RETRIES_ENV_KEY}`
      + ` 不能超过一天（当前 ${span} ms）—— 那是"第二天"的事，不是当天的重试`);
  }
  return {
    retryIntervalMs,
    maxRetries,
    retryDelaysMs: Array.from({ length: maxRetries }, (_, index) => retryIntervalMs * (index + 1)),
  };
};

const assertAlertTemplate = (template) => {
  const text = String(template ?? '');
  if (!text.trim()) {
    throw new Error(`${PUSH_RETRY_ALERT_TEMPLATE_ENV_KEY} 不能是空的`
      + '（推送失败必须有人看得见；实在不想发就设 PUSH_RETRY_ALERT_ENABLED=false）');
  }
  for (const match of text.matchAll(/\{([^{}]*)\}/g)) {
    if (!ALERT_TEMPLATE_PLACEHOLDERS.includes(match[1])) {
      throw new Error(`${PUSH_RETRY_ALERT_TEMPLATE_ENV_KEY} 里有无法识别的占位符 {${match[1]}}`
        + `（可用：${ALERT_TEMPLATE_PLACEHOLDERS.map((name) => `{${name}}`).join(' ')}）`);
    }
  }
  if (text.replace(/\{[^{}]*\}/g, '').includes('{') || text.replace(/\{[^{}]*\}/g, '').includes('}')) {
    throw new Error(`${PUSH_RETRY_ALERT_TEMPLATE_ENV_KEY} 里的占位符没有闭合（大括号必须成对，形如 {push}）`);
  }
  // 「哪条推送」必须说清楚 —— 两条链路共用同一个群时，不说名字等于没说。
  if (!/\{push\}/.test(text)) {
    throw new Error(`${PUSH_RETRY_ALERT_TEMPLATE_ENV_KEY} 必须带 {push}`
      + '（同一个群里可能有两条推送失败，不说清是哪条等于没说）');
  }
  return text;
};

/** 告警配置（开关 / 群 / 文案 / 两条推送的名字）。 */
const resolvePushAlertConfig = (env = process.env) => ({
  // 显式布尔：**默认开**（"不静默"是这次的 P0 目标本身）；空串 = 关。
  enabled: readFlag(env, PUSH_RETRY_ALERT_ENABLED_ENV_KEY, true),
  // 空串 = **用该条推送自己的群**（两条链路各自知道自己发哪儿）；设了就往这里发。
  chatId: readString(env, PUSH_RETRY_ALERT_CHAT_ID_ENV_KEY, ''),
  template: assertAlertTemplate(
    readString(env, PUSH_RETRY_ALERT_TEMPLATE_ENV_KEY, DEFAULT_ALERT_TEMPLATE),
  ),
  names: {
    pendingDealPush: readString(env, PENDING_DEAL_PUSH_ALERT_NAME_ENV_KEY,
      DEFAULT_PENDING_DEAL_PUSH_ALERT_NAME),
    secondDelivery: readString(env, SECOND_DELIVERY_ALERT_NAME_ENV_KEY,
      DEFAULT_SECOND_DELIVERY_ALERT_NAME),
  },
});

/** 一次性读出整份策略（两条推送共用）。 */
const resolvePushRetryConfig = (env = process.env) => ({
  transient: resolveTransientRetryConfig(env),
  daily: resolveDailyRetryConfig(env),
  alert: resolvePushAlertConfig(env),
});

// ─────────────────────────────────────────────────────────────────────────────
// 纯件①：瞬时错误判据
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 飞书错误的真实 code —— 三个来源都认（网关 `assertSuccess` 走 `bitableCode`；
 * SDK 抛的 HTTP 错在 `response.data`；我们自己 `larkResponseError` 挂在 `larkData`）。
 * ⚠️ 顶层 `error.code` 只在**是数字**时当飞书 code；`ECONNRESET` 这种要留给网络层判据。
 */
const larkCodeOf = (error) => {
  const data = error?.response?.data ?? error?.larkData;
  const inner = (data && typeof data === 'object' && data.error && typeof data.error === 'object')
    ? data.error : {};
  const topLevel = error?.code;
  const candidates = [
    data?.code,
    inner?.code,
    error?.bitableCode,
    (typeof topLevel === 'number' || /^\d+$/.test(asText(topLevel).trim())) ? topLevel : undefined,
  ];
  for (const candidate of candidates) {
    const text = asText(candidate).trim();
    if (text !== '') return text;
  }
  return '';
};

/**
 * 这个错误**是不是瞬时的**（瞬时 ⇒ 可以就地小退避重试）。
 *
 * 判据顺序（有飞书 code 就只认 code —— 那是飞书对请求的结构化应答，比人话可靠）：
 *   ① 有飞书 code → code 在 `larkCodes` 里才是瞬时（**权限 / 参数 / 缺配置一律不是**）；
 *   ② 没有 code → HTTP 429 / 5xx、网络错误码、或人话里出现"再试一次就可能好"的说法。
 */
const isTransientLarkError = (error, config = resolveTransientRetryConfig()) => {
  const resolved = config || {};
  const codes = resolved.larkCodes || [];
  const patterns = resolved.messagePatterns || [];
  const networkCodes = resolved.networkCodes || [];
  const code = larkCodeOf(error);
  if (code) return codes.includes(code);
  const status = Number(error?.response?.status ?? error?.status);
  if (Number.isFinite(status)) {
    if (RETRYABLE_HTTP_STATUSES.includes(status)) return true;
    if (status >= 500 && status <= 599) return true;
  }
  const nodeCode = asText(error?.code).trim();
  if (nodeCode && !/^\d+$/.test(nodeCode) && networkCodes.includes(nodeCode)) return true;
  const text = `${asText(error?.message)} ${asText(error?.response?.data?.msg)}`;
  return patterns.some((pattern) => pattern.test(text));
};

/** 一句话说清"为什么失败"（告警文案与日志共用，别两处各拼一遍）。 */
const pushFailureReason = (error) => {
  const fields = larkErrorFields(error);
  const code = fields.code !== '' && fields.code !== undefined ? fields.code : larkCodeOf(error);
  const message = fields.msg || asText(error?.message) || 'unknown';
  return code === '' || code === undefined ? message : `${message} (Code: ${code})`;
};

// ─────────────────────────────────────────────────────────────────────────────
// 纯件②：小退避执行器（读 / 发都用它；确定性错误不重试）
// ─────────────────────────────────────────────────────────────────────────────

/** 指数退避的等待表：`[base, base×factor, …]`，共 `maxRetries` 个（封顶 `maxDelayMs`）。 */
const transientRetryDelays = (config) => {
  const delays = [];
  for (let index = 0; index < (config.maxRetries || 0); index += 1) {
    const raw = config.baseDelayMs * (config.factor ** index);
    delays.push(Math.min(Math.round(raw), config.maxDelayMs));
  }
  return delays;
};

/**
 * 把一次**读**或一次**发**包进小退避重试。
 *
 *   · 瞬时错误 → 等 `delays[n]` 再来一次，用完还不行就抛出（交给按天层）；
 *   · **确定性错误 → 一次都不重试**，只留一条 `retryable:false` 的日志然后抛出；
 *   · `operation` 只进日志（例 `pending_deal_push.candidates`），服务里不重新拼日志字段。
 *
 * ⚠️ **发消息**也走它（业务负责人点名的口径）：飞书的 429 / 5xx 与"Data not ready"这类
 *    应答表示请求没被处理；同一张卡重发一次的风险（极小概率的重复消息）与"整天不发"
 *    相比，前者可接受 —— 按天层的"成功一次即停 / 跨天不重复"一点没变。
 */
const withTransientRetry = async (fn, options = {}) => {
  const {
    operation = '', config, sleep = DEFAULT_SLEEP, onRetry,
  } = options;
  const resolved = config || resolveTransientRetryConfig();
  const delays = transientRetryDelays(resolved);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const fields = larkErrorFields(error);
      const code = larkCodeOf(error);
      const meta = {
        operation,
        attempt: attempt + 1,
        max_attempts: delays.length + 1,
        code: code === '' ? fields.code : code,
        msg: fields.msg,
        log_id: fields.log_id,
        method_id: fields.method_id,
        error: asText(error?.message),
      };
      if (!isTransientLarkError(error, resolved)) {
        // 确定性错误：重试也没用（权限 / 参数 / 缺配置）—— 只留这一条清晰日志。
        logWarn('push.transient_retry.skipped', { ...meta, retryable: false });
        throw error;
      }
      if (attempt >= delays.length) {
        logWarn('push.transient_retry.exhausted', { ...meta, retryable: true });
        throw error;
      }
      const delayMs = delays[attempt];
      logWarn('push.transient_retry.waiting', { ...meta, retryable: true, delay_ms: delayMs });
      if (typeof onRetry === 'function') onRetry({ attempt: attempt + 1, delayMs, error });
      if (delayMs > 0) await sleep(delayMs);
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 纯件③：按天重试状态机（"今天这一次调用该不该真发"）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 唯一的判据（两条推送共用；定时器 tick 与重试回调都走它）。
 *
 *   · 没有记录                → 第一次尝试
 *   · `sent:true` / completed → `already_ran_today`（**幂等的根据**）
 *   · `running`               → `in_progress`（进程崩在两次写之间：当天不再发，
 *                               第二天照常进候选；宁可少推一天，也绝不重复发）
 *   · `failed`                → 按 `retryDelaysMs` 判：没到点 `retry_waiting`、
 *                               次数用完 `retries_exhausted` / `retry_disabled`、到点则**重试**
 */
const resolveDailyAttempt = ({ record, nowMs, retryDelaysMs = [] } = {}) => {
  if (!record) return { attempt: true, attemptNumber: 1, reason: '' };
  if (record.sent || record.status === 'completed') return { attempt: false, reason: 'already_ran_today' };
  if (record.status === 'running') return { attempt: false, reason: 'in_progress' };
  if (!retryDelaysMs.length) return { attempt: false, reason: 'retry_disabled' };
  const attempts = Number(record.attempts) || 1;
  if (attempts > retryDelaysMs.length) return { attempt: false, reason: 'retries_exhausted' };
  const delay = retryDelaysMs[attempts - 1];
  const failedAtMs = Date.parse(record.first_failed_at || record.failed_at || '');
  const dueAtMs = Number.isFinite(failedAtMs) ? failedAtMs + delay : NaN;
  if (Number.isFinite(dueAtMs) && nowMs < dueAtMs) {
    return { attempt: false, reason: 'retry_waiting', nextRetryAt: new Date(dueAtMs).toISOString() };
  }
  return { attempt: true, attemptNumber: attempts + 1, reason: '' };
};

/** 这一天**该不该再发一次告警**：开关开着、且这一天还没试过（一天最多一句）。 */
const shouldSendFailureAlert = (record, alertConfig) => (
  Boolean(alertConfig?.enabled) && record?.alert_attempted !== true
);

/** 告警文案（占位符认不出来在启动时已拦下；这里只做替换）。 */
const formatPushAlertText = (template, values = {}) => String(template ?? '')
  .replace(/\{([^{}]*)\}/g, (whole, key) => (
    values[key] === undefined || values[key] === null ? '' : String(values[key])));

module.exports = {
  PUSH_TRANSIENT_RETRY_MAX_RETRIES_ENV_KEY,
  PUSH_TRANSIENT_RETRY_BASE_DELAY_MS_ENV_KEY,
  PUSH_TRANSIENT_RETRY_FACTOR_ENV_KEY,
  PUSH_TRANSIENT_RETRY_MAX_DELAY_MS_ENV_KEY,
  PUSH_TRANSIENT_RETRY_LARK_CODES_ENV_KEY,
  PUSH_DAILY_RETRY_INTERVAL_MS_ENV_KEY,
  PUSH_DAILY_RETRY_MAX_RETRIES_ENV_KEY,
  PUSH_RETRY_ALERT_ENABLED_ENV_KEY,
  PUSH_RETRY_ALERT_CHAT_ID_ENV_KEY,
  PUSH_RETRY_ALERT_TEMPLATE_ENV_KEY,
  PENDING_DEAL_PUSH_ALERT_NAME_ENV_KEY,
  SECOND_DELIVERY_ALERT_NAME_ENV_KEY,
  DEFAULT_TRANSIENT_MAX_RETRIES,
  DEFAULT_TRANSIENT_BASE_DELAY_MS,
  DEFAULT_TRANSIENT_FACTOR,
  DEFAULT_TRANSIENT_MAX_DELAY_MS,
  DEFAULT_TRANSIENT_LARK_CODES,
  DEFAULT_DAILY_RETRY_INTERVAL_MS,
  DEFAULT_DAILY_RETRY_MAX_RETRIES,
  DEFAULT_ALERT_TEMPLATE,
  DEFAULT_PENDING_DEAL_PUSH_ALERT_NAME,
  DEFAULT_SECOND_DELIVERY_ALERT_NAME,
  ALERT_TEMPLATE_PLACEHOLDERS,
  RETRYABLE_HTTP_STATUSES,
  NETWORK_ERROR_CODES,
  TRANSIENT_MESSAGE_PATTERNS,
  DEFAULT_SLEEP,
  larkCodeOf,
  isTransientLarkError,
  pushFailureReason,
  transientRetryDelays,
  withTransientRetry,
  resolveDailyAttempt,
  shouldSendFailureAlert,
  formatPushAlertText,
  resolveTransientRetryConfig,
  resolveDailyRetryConfig,
  resolvePushAlertConfig,
  resolvePushRetryConfig,
};
