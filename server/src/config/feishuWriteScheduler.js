'use strict';

/**
 * 全局飞书写入调度器配置（issue #879）。
 *
 * 为什么要有它：销售异步 worker / 工作台交付 / 售后各有自己的 FIFO，但**跨模块**仍会
 * 同时打飞书 ⇒ 撞上 `1254607 Data not ready` / 瞬时 400 / 限流，某一方失败。
 * 调度器把**所有写飞书的请求**收进同一个并发控制（`services/feishuWriteScheduler.js`），
 * 本文件只负责**取值与判据**（配置先行：并发 / 重试 / 退避 / 认哪些错误可重试全可配）。
 *
 * 三个边界（改这里之前先读一遍）：
 *   · **只调度写**：读请求（listAll / get / getBatch…）不进调度器 —— 写才是"撞车"的源头，
 *     把读也塞进去只会把页面拉慢。
 *   · **只重试"确定没写进去"的瞬时错误**：飞书 code 1254607 / 1254290 / 1254291（数据未就绪 /
 *     限流 / 写冲突）＋ HTTP 429 ＋ **瞬时 400**（飞书把 data-not-ready 那一类也走 HTTP 400）。
 *     5xx / 网络超时**不在这一层重试**（结果未知，重试可能写重）—— 那类交给上层 job 级重试
 *     （#948 的 `asyncJobs.run`：重试复用同一把 submitKey / operationKey，幂等由业务层兜）。
 *   · **重试不改任何业务键**：调度器只重放**同一个闭包**（同一份 payload / 同一个 correlation），
 *     不生成 job / submitKey / operationKey ⇒ 重试不会重复建单、不会重复扣库存。
 *
 * 取值规则沿用 `config/envValue`：没设 → 默认值；设了（含空串）→ 显式取值；认不出来 → 当场抛。
 */

const { readFlag, readInt, readList, readString } = require('./envValue');

/** 飞书"再试一次就可能好"的错误码（默认值）。1254607 是真机上抓到的那一个。 */
const DEFAULT_RETRYABLE_LARK_CODES = Object.freeze([1254607, 1254290, 1254291]);

/** HTTP 429（限流）＝请求被拒、确定没写入 ⇒ 可以安全重试。5xx / 网络超时**不在此列**。 */
const DEFAULT_RETRYABLE_HTTP_STATUSES = Object.freeze([429]);

// 「瞬时 400」的判据：飞书把 data-not-ready / 系统繁忙 / 限流这类也返回 HTTP 400，
// 但响应体里的 msg 是"再试一次"的说法。**只认这一小类**；其余 400（字段/参数/权限）是确定性拒绝。
const DEFAULT_TRANSIENT_400_PATTERN = [
  'data not ready', '数据未准备', 'please try again later', 'try again later',
  'system busy', '系统繁忙',
  '频率', '限流', 'too many requests', 'rate limit',
].join('|');

/**
 * 构造一份（可注入 env 的）调度器配置。
 * @param {object} [env] 环境变量表（用例传假 env ⇒ 不污染 `process.env`）
 */
const buildFeishuWriteSchedulerConfig = (env = process.env) => {
  const retryBaseMs = readInt(env, 'FEISHU_WRITE_RETRY_BASE_MS', 600, { min: 0, max: 60000 });
  const retryMaxDelayMs = readInt(env, 'FEISHU_WRITE_RETRY_MAX_DELAY_MS', 8000, { min: 0, max: 600000 });
  const codes = readList(env, 'FEISHU_WRITE_RETRY_LARK_CODES');
  return Object.freeze({
    enabled: readFlag(env, 'FEISHU_WRITE_SCHEDULER_ENABLED', true),
    // 不同组（表 + 操作类型）之间最多同时几个写入请求。默认 3：同表串行、跨表有限并发，
    // 既不把整条链路锁成一条（"不要全局锁死"），又给飞书留出并发余量。
    maxConcurrency: readInt(env, 'FEISHU_WRITE_MAX_CONCURRENCY', 3, { min: 1, max: 32 }),
    // 分组口径：默认「表 + 操作类型」；两个开关都能单独关掉（排查 / 灰度用）。
    groupByTable: readFlag(env, 'FEISHU_WRITE_GROUP_BY_TABLE', true),
    groupByOperation: readFlag(env, 'FEISHU_WRITE_GROUP_BY_OPERATION', true),
    retry: Object.freeze({
      maxAttempts: readInt(env, 'FEISHU_WRITE_RETRY_MAX_ATTEMPTS', 3, { min: 1, max: 10 }),
      baseMs: retryBaseMs,
      maxDelayMs: Math.max(retryBaseMs, retryMaxDelayMs),
      // 空串 = 一个都不认（显式关掉"按 code 重试"）。
      larkCodes: Object.freeze(codes === null
        ? [...DEFAULT_RETRYABLE_LARK_CODES]
        : codes.map((item) => Number(item)).filter((value) => Number.isFinite(value))),
      retryableHttpStatuses: Object.freeze([...DEFAULT_RETRYABLE_HTTP_STATUSES]),
      transient400Pattern: readString(env, 'FEISHU_WRITE_TRANSIENT_400_PATTERN', DEFAULT_TRANSIENT_400_PATTERN),
    }),
  });
};

/** 进程级默认那一份（跟 `process.env` 走；用例请 `buildFeishuWriteSchedulerConfig(fakeEnv)`）。 */
const FEISHU_WRITE_SCHEDULER = buildFeishuWriteSchedulerConfig();

const numericCode = (value) => {
  const text = String(value ?? '').trim();
  return /^\d+$/.test(text) ? Number(text) : 0;
};

const httpStatusOf = (error) => Number(
  error?.statusCode || error?.status || error?.response?.status || error?.response?.statusCode || 0,
);

const feishuCodeOf = (error) => numericCode(error?.bitableCode)
  || numericCode(error?.code)
  || numericCode(error?.response?.data?.code)
  || numericCode(error?.cause?.code);

const messageOf = (error) => {
  if (!error) return '';
  const parts = [
    typeof error === 'string' ? error : error.message,
    error?.msg,
    error?.response?.data?.msg,
    error?.response?.data?.message,
  ].filter(Boolean).map((item) => String(item));
  return parts.join(' ');
};

/**
 * 「这次写入失败了，能不能**在这一层**原地重试？」
 *
 * 判据顺序（⚠️ 飞书 code 要**先于** HTTP 400 判：真机上 data-not-ready 是 code=1254607 且
 * HTTP 400 的两层形状 —— 先看 400 会把可重试错误误判成永久错误）：
 *   ① 飞书 code ∈ 可重试清单（1254607 / 1254290 / 1254291 …）⇒ 重试；
 *   ② HTTP 429（限流）⇒ 重试；
 *   ③ HTTP 400 **且** msg 命中"瞬时"话术（data not ready / 系统繁忙 / 频率…）⇒ 重试；
 *   ④ 其余（含 5xx / 网络超时 / 权限 / 字段名 / 参数）⇒ **不重试**（结果未知的交给 job 级重试）。
 *
 * @returns {{retryable:boolean, kind:string, code:number|string, status:number, message:string}}
 */
const classifyFeishuWriteError = (error, retry = FEISHU_WRITE_SCHEDULER.retry) => {
  const resolved = retry || {};
  const code = feishuCodeOf(error);
  const status = httpStatusOf(error);
  const message = messageOf(error);
  if (code && Array.isArray(resolved.larkCodes) && resolved.larkCodes.includes(code)) {
    return { retryable: true, kind: 'feishu_code', code, status, message };
  }
  if (Array.isArray(resolved.retryableHttpStatuses) && resolved.retryableHttpStatuses.includes(status)) {
    return { retryable: true, kind: 'http_status', code, status, message };
  }
  const transientPattern = resolved.transient400Pattern
    ? new RegExp(resolved.transient400Pattern, 'i') : null;
  if (status === 400 && transientPattern && transientPattern.test(message)) {
    return { retryable: true, kind: 'transient_400', code, status, message };
  }
  // 没有 HTTP 状态时用文案兜底（SDK 有时把飞书应答压成一句话）：这类话术是"服务端没处理，
  // 稍后再试"⇒ 没写入 ⇒ 重试安全。其余未知错误**不重试**（结果未知交给 job 级重试）。
  if (!status && transientPattern && transientPattern.test(message)) {
    return { retryable: true, kind: 'transient_message', code, status, message };
  }
  return { retryable: false, kind: 'permanent', code, status, message };
};

/** 第 `attempt` 次失败后等多久（指数退避，封顶 `maxDelayMs`；`baseMs: 0` = 立即重试）。 */
const retryDelayMs = (attempt, retry = FEISHU_WRITE_SCHEDULER.retry) => {
  const base = Number(retry?.baseMs) || 0;
  if (!base) return 0;
  const delay = base * (2 ** Math.max(0, Number(attempt) - 1));
  return Math.min(delay, Number(retry?.maxDelayMs) || delay);
};

module.exports = {
  DEFAULT_RETRYABLE_LARK_CODES,
  DEFAULT_RETRYABLE_HTTP_STATUSES,
  buildFeishuWriteSchedulerConfig,
  FEISHU_WRITE_SCHEDULER,
  classifyFeishuWriteError,
  retryDelayMs,
};
