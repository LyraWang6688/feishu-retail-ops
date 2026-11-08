'use strict';

/**
 * 统一异步任务（#948）：**类型 / 状态 / 重试 / 失败通知 / 文案** 的唯一配置源。
 *
 * 口径来源：`docs/async-job-status-and-failure-notification-2026-11-08.md`
 * （业务负责人 2026-11-08 定稿；对应 issue #948 / #950 / #947）。
 *
 * 三个边界（改这里之前先读一遍）：
 *   · **页面不显示失败提示** —— 失败只发「邯美皮鞋运营群」（复用 `PURCHASE_CHAT_ID`，
 *     目标统一由 config/notifications.js 的 group 目标决定；本文件只管"发什么"，不管页面。
 *   · **临时错误才重试** —— 5xx / 超时 / 网络 / 限流；400 / 字段不存在 / 权限 / 参数 /
 *     业务拒绝**不重试**（分类见 `classifyThrownError` / `classifyResultOutcome`）。
 *   · **重试复用原幂等键** —— 本文件不生成业务键；各链路把自己的 `submitKey` / `requestId`
 *     原样传进统一层（统一层只按它派生**同一个** `job_id`，不新建任务）。
 *
 * 配置先行：次数 / 退避 / 群 / 文案 / 错误分类都能用环境变量覆盖，代码里不写死。
 */
const path = require('node:path');
const { readFlag, readInt, readList, readString } = require('./envValue');

/** 覆盖范围（#948 第 1 节）：既有五条异步链路 + 工作台交割单交付/付款。 */
const ASYNC_JOB_TYPES = Object.freeze({
  SALES: 'sales',
  AFTER_SALES: 'after_sales',
  PURCHASE_REPLENISH: 'purchase_replenish',
  PURCHASE_RETURN: 'purchase_return',
  PURCHASE_ACCEPTANCE: 'purchase_acceptance',
  SALES_DELIVERY: 'sales_delivery',
  SALES_PAYMENT: 'sales_payment',
});

/** 状态值域（#948 第 3.1 节）。`failed` 是唯一会触发群通知的终态（文档 6.1）。 */
const ASYNC_JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  PARTIAL_FAILED: 'partial_failed',
  FAILED: 'failed',
});

const TERMINAL_STATUSES = Object.freeze([
  ASYNC_JOB_STATUS.SUCCEEDED,
  ASYNC_JOB_STATUS.PARTIAL_FAILED,
  ASYNC_JOB_STATUS.FAILED,
]);

/** `job_id` 前缀：**沿用各链路既有形状**（销售 / 售后已有 `sale_job_` / `after_sales_job_`）。 */
const JOB_ID_PREFIX = Object.freeze({
  [ASYNC_JOB_TYPES.SALES]: 'sale_job',
  [ASYNC_JOB_TYPES.AFTER_SALES]: 'after_sales_job',
  [ASYNC_JOB_TYPES.PURCHASE_REPLENISH]: 'purchase_replenish_job',
  [ASYNC_JOB_TYPES.PURCHASE_RETURN]: 'purchase_return_job',
  [ASYNC_JOB_TYPES.PURCHASE_ACCEPTANCE]: 'purchase_acceptance_job',
  [ASYNC_JOB_TYPES.SALES_DELIVERY]: 'delivery_job',
  [ASYNC_JOB_TYPES.SALES_PAYMENT]: 'payment_job',
});

const DEFAULT_TEXTS = Object.freeze({
  groupTitle: '【异步写入失败】',
  // 每行一个占位符模板（service / notifier 里不写中文）
  lineOf: Object.freeze({
    type: '类型：{value}',
    orderNo: '单号/批次：{value}',
    operator: '操作人：{value}',
    step: '失败步骤：{value}',
    error: '错误：{value}',
    jobId: '任务ID：{value}',
    time: '时间：{value}',
  }),
  typeLabels: Object.freeze({
    [ASYNC_JOB_TYPES.SALES]: '销售提交',
    [ASYNC_JOB_TYPES.AFTER_SALES]: '售后退货',
    [ASYNC_JOB_TYPES.PURCHASE_REPLENISH]: '采购补货',
    [ASYNC_JOB_TYPES.PURCHASE_RETURN]: '采购退货',
    [ASYNC_JOB_TYPES.PURCHASE_ACCEPTANCE]: '采购验收',
    [ASYNC_JOB_TYPES.SALES_DELIVERY]: '交割单交付',
    [ASYNC_JOB_TYPES.SALES_PAYMENT]: '交割单付款',
  }),
  unknownType: '未知任务',
  defaultStep: '后台写库',
  unknownError: '未知错误',
  // 各链路的「失败步骤」标签（通知里那一行；链路代码不许自己写中文 ✗）
  stepLabels: Object.freeze({
    afterSales: '售后退货写库',
    sales: '销售写库',
    scanPurchaseReplenish: '扫码补货写库',
    scanPurchaseReturn: '扫码采购退货写库',
    procurementPageReplenish: '采购页补货写库',
    purchaseAcceptance: '采购验收写库',
    purchaseBackgroundDefault: '采购后台写库',
    salesDelivery: '交割单交付写库',
    salesPayment: '交割单付款写库',
  }),
  // 排查提示（日志字段，不是群消息正文；同样不许散写在 service 里 ✗）
  hints: Object.freeze({
    chatMissing: '群没配 ⇒ 失败通知发不出去（不是发送成功）',
    notifyRetry: '通知没发出去 ⇒ 保持未通知，后续可重试',
    orphanedRunning: '进程重启时还在跑；是否真写成由各链路自己的幂等/断点记录判定（本层不猜）',
    backgroundFailedNotified: '后台写入没成功 ⇒ 状态可查、可点重试（最终失败已进统一失败通知）',
  }),
  // 默认发送器抛错的原文（内部日志用）
  sendFailed: '发送异步失败通知失败',
  // 通知里省略空字段（拿不到单号 / 操作人就**不写**，绝不编，文档 6.3）
  omitEmpty: true,
});

/** 所有钉在文案里的关键字（分类器用；改这里不用改逻辑）。 */
const DEFAULT_RETRYABLE_PATTERN = [
  'status code 5\\d\\d', 'http 5\\d\\d', '飞书 5\\d\\d', '\\b50[234]\\b',
  'timeout', 'timed out', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN',
  'socket hang up', 'network', 'fetch failed', 'aborted',
  'too many requests', 'too many request', 'rate limit', '频率', '限流', '服务繁忙',
  'try again later', 'retry later', 'please try again', '系统繁忙',
].join('|');

const DEFAULT_PERMANENT_PATTERN = [
  'fieldname ?not ?found', 'field ?not ?found', '字段不存在', '字段名不存在',
  'permission', 'access denied', 'forbidden', '权限不足', '无权限', '没有权限',
  'invalid (param|parameter|request|field|operator|argument)',
  '参数(错误|不合法|无效|缺失)', '业务拒绝', 'not allowed', 'business_rejected',
].join('|');

/** 链路显式返回 `{ok:false, code}` 时，这些 code = **业务拒绝 / 参数问题 ⇒ 不重试**。 */
const DEFAULT_PERMANENT_RESULT_CODES = [
  'write_disabled', 'unknown_chain', 'not_in_batch', 'size_invalid', 'amount_invalid',
  'item_invalid', 'submit_key_invalid', 'empty_items', 'too_many_items', 'not_authenticated',
  'business_rejected', 'rejected', 'already_posted_mismatch',
];

/** 飞书错误码：这些**重试有意义**（限流 / 写冲突 / 数据未就绪）。 */
const DEFAULT_RETRYABLE_FEISHU_CODES = [1254290, 1254291, 1254607];

/** 飞书错误码：这些**重试也没用**（凭证 / 权限 / 字段名）。 */
const DEFAULT_PERMANENT_FEISHU_CODES = [99991663, 99991664, 99991668, 99991672, 1254045];

const RETRYABLE_HTTP_STATUS = Object.freeze([408, 425, 429, 500, 502, 503, 504]);
const PERMANENT_HTTP_STATUS = Object.freeze([400, 401, 403, 404, 405, 409, 422]);

const toNumberList = (list, fallback) => {
  if (!Array.isArray(list)) return [...fallback];
  const out = list.map((item) => Number(item)).filter((value) => Number.isFinite(value));
  return out.length ? out : [...fallback];
};

/**
 * 构造一份（可注入 env 的）统一异步任务配置。
 * @param {object} [env] 环境变量表（用例传假 env ⇒ 不污染 `process.env`）
 */
const buildAsyncJobsConfig = (env = process.env) => {
  const retryBaseMs = readInt(env, 'ASYNC_JOB_RETRY_BASE_MS', 800, { min: 0, max: 60000 });
  const retryMaxDelayMs = readInt(env, 'ASYNC_JOB_RETRY_MAX_DELAY_MS', 10000, { min: 0, max: 600000 });
  return Object.freeze({
    enabled: readFlag(env, 'ASYNC_JOB_ENABLED', true),
    jobsDir: readString(env, 'ASYNC_JOBS_DIR', path.join(__dirname, '..', '..', 'data', 'async_jobs')),
    retry: Object.freeze({
      maxAttempts: readInt(env, 'ASYNC_JOB_MAX_ATTEMPTS', 3, { min: 1, max: 10 }),
      baseMs: retryBaseMs,
      maxDelayMs: Math.max(retryBaseMs, retryMaxDelayMs),
      retryablePattern: readString(env, 'ASYNC_JOB_RETRYABLE_PATTERN', DEFAULT_RETRYABLE_PATTERN),
      permanentPattern: readString(env, 'ASYNC_JOB_PERMANENT_PATTERN', DEFAULT_PERMANENT_PATTERN),
      retryableHttpStatus: Object.freeze([...RETRYABLE_HTTP_STATUS]),
      permanentHttpStatus: Object.freeze([...PERMANENT_HTTP_STATUS]),
      retryableFeishuCodes: Object.freeze(toNumberList(
        readList(env, 'ASYNC_JOB_RETRYABLE_FEISHU_CODES'), DEFAULT_RETRYABLE_FEISHU_CODES,
      )),
      permanentFeishuCodes: Object.freeze(toNumberList(
        readList(env, 'ASYNC_JOB_PERMANENT_FEISHU_CODES'), DEFAULT_PERMANENT_FEISHU_CODES,
      )),
      permanentResultCodes: Object.freeze(readList(env, 'ASYNC_JOB_PERMANENT_RESULT_CODES')
        ?? [...DEFAULT_PERMANENT_RESULT_CODES]),
    }),
    notify: Object.freeze({
      enabled: readFlag(env, 'ASYNC_JOB_NOTIFY_ENABLED', true),
      // failed / partial_failed 都是需要人看的终态，**都发群通知**（没有额外状态开关）。
      maxErrorLength: readInt(env, 'ASYNC_JOB_NOTIFY_MAX_ERROR_LENGTH', 200, { min: 20, max: 2000 }),
      dedupeHours: readInt(env, 'ASYNC_JOB_NOTIFY_DEDUPE_HOURS', 24 * 7, { min: 1, max: 24 * 90 }),
    }),
    // 页面轮询（#947 原方案）已由"发运营群"取代；这里保留只读轮询参数给排查脚本/未来页面用。
    poll: Object.freeze({
      intervalMs: readInt(env, 'ASYNC_JOB_POLL_INTERVAL_MS', 2000, { min: 500, max: 60000 }),
      // 交割单页真实飞书写库可能 >60s；该值与页面共用，超时只提示「仍在写入」。
      maxMs: readInt(env, 'ASYNC_JOB_POLL_MAX_MS', 120000, { min: 5000, max: 600000 }),
    }),
    texts: Object.freeze({
      ...DEFAULT_TEXTS,
      groupTitle: readString(env, 'ASYNC_JOB_ALERT_TITLE', DEFAULT_TEXTS.groupTitle),
    }),
  });
};

/** 进程级默认那一份（跟 `process.env` 走；用例请 `buildAsyncJobsConfig(fakeEnv)`）。 */
const ASYNC_JOBS = buildAsyncJobsConfig();

const numericCode = (value) => {
  const text = String(value ?? '').trim();
  return /^\d+$/.test(text) ? Number(text) : 0;
};

const httpStatusOf = (error) => Number(
  error?.statusCode || error?.status || error?.response?.status || error?.response?.statusCode || 0,
);

const feishuCodeOf = (error) => numericCode(error?.code)
  || numericCode(error?.response?.data?.code)
  || numericCode(error?.cause?.code);

const messageOf = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return String(value.message || value.msg || value.error || '');
};

/**
 * **抛出来的异常**怎么归类（默认重试；明确是永久错误才不重试）。
 *
 * 顺序：先看"临时"关键字（5xx / 超时 / 限流），再看"永久"关键字（权限 / 字段 / 参数），
 * 然后看 HTTP 状态与飞书错误码，最后兜底**重试** —— 与售后既有口径一致
 * （`afterSalesAsyncService` 原来就是"除 400 外都重试"，这里把 400 扩成整类永久错误）。
 *
 * @returns {{retryable: boolean, message: string}}
 */
const classifyThrownError = (error, retry = ASYNC_JOBS.retry) => {
  const message = messageOf(error) || String(error || '');
  const retryablePattern = new RegExp(retry.retryablePattern, 'i');
  const permanentPattern = new RegExp(retry.permanentPattern, 'i');
  if (retryablePattern.test(message)) return { retryable: true, message };
  if (permanentPattern.test(message)) return { retryable: false, message };
  const status = httpStatusOf(error);
  if (retry.retryableHttpStatus.includes(status)) return { retryable: true, message };
  if (retry.permanentHttpStatus.includes(status)) return { retryable: false, message };
  const code = feishuCodeOf(error);
  if (code && retry.retryableFeishuCodes.includes(code)) return { retryable: true, message };
  if (code && retry.permanentFeishuCodes.includes(code)) return { retryable: false, message };
  // 未知异常：按"临时"处理（重试是安全的 —— 各链路重试都复用同一把幂等键）
  return { retryable: true, message };
};

/**
 * **链路显式返回的失败结果**怎么归类（默认**不重试**）。
 *
 * 为什么与抛异常相反：`{ok:false, code}` 是业务层**主动**判的
 * （"这批里没有这一款" / "金额不合法" / "写库开关关着"）⇒ 重试 N 次只会白等；
 * 只有结果里带着**明显的临时错误特征**（5xx / 超时 / 限流）才重试。
 *
 * @returns {{ok: boolean, retryable: boolean, message: string, code: string}}
 */
const classifyResultOutcome = (result, retry = ASYNC_JOBS.retry) => {
  if (result && result.ok === true) return { ok: true, retryable: false, message: '', code: '' };
  const code = String(result?.code || result?.error || '').trim();
  const message = String(result?.message || result?.error || result?.hint || '').trim();
  if (code && retry.permanentResultCodes.includes(code)) {
    return { ok: false, retryable: false, message, code };
  }
  const retryablePattern = new RegExp(retry.retryablePattern, 'i');
  if (retryablePattern.test(message)) return { ok: false, retryable: true, message, code };
  const permanentPattern = new RegExp(retry.permanentPattern, 'i');
  if (permanentPattern.test(message)) return { ok: false, retryable: false, message, code };
  const status = httpStatusOf(result);
  if (retry.retryableHttpStatus.includes(status)) return { ok: false, retryable: true, message, code };
  if (retry.permanentHttpStatus.includes(status)) return { ok: false, retryable: false, message, code };
  // ⚠️ 显式 `ok:false` 但没给原因：按**永久**处理（宁可少重试，也不要把业务拒绝重试 N 次）
  return { ok: false, retryable: false, message, code };
};

/** 第 `attempt` 次失败后该等多久（指数退避，封顶 `maxDelayMs`；`baseMs: 0` = 不等）。 */
const retryDelayMs = (attempt, retry = ASYNC_JOBS.retry) => {
  if (!retry.baseMs) return 0;
  const delay = retry.baseMs * (2 ** Math.max(0, Number(attempt) - 1));
  return Math.min(delay, retry.maxDelayMs);
};

module.exports = {
  ASYNC_JOB_TYPES,
  ASYNC_JOB_STATUS,
  TERMINAL_STATUSES,
  JOB_ID_PREFIX,
  ASYNC_JOBS,
  buildAsyncJobsConfig,
  classifyThrownError,
  classifyResultOutcome,
  retryDelayMs,
};
