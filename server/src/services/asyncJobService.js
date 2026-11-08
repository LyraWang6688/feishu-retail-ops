'use strict';

/**
 * 统一异步任务服务（#948 第 3 / 5 / 6 / 7 节）—— **状态流转 + 重试 + 失败通知 + 只读视图**。
 *
 * 分工（一个模块只干一件事）：
 *   · `asyncJobStore.js`   —— 落盘（统一 job 模型）
 *   · `asyncJobNotifier.js`—— 发群 / 去重 / 失败留痕
 *   · 本文件              —— 把两者串成状态机：`queued → running → succeeded / partial_failed / failed`
 *
 * 各业务链路怎么接：
 *   · **有自己重试循环的**（售后）—— 每跑一次调 `begin` / `succeed` / `recordAttemptFailure`，
 *     最后一次失败调 `fail`（内部自动走通知）；重试分类用 `classifyThrownError` 统一口径。
 *   · **没有重试循环的**（销售 / 采购三条）—— 直接调 `run({ jobId, run, classifyResult })`，
 *     重试次数 / 退避 / 分类 / 通知全在这里（业务层只管"跑一次"）。
 *
 * 🔴 本层**永远不改业务写入语义**：它只读取 `run` 的结果判断成败，不重写表、不拼幂等键。
 * 🔴 任何一次统一层自身的落盘/通知异常都**不许打断业务链路**（catch + warn，返回 null）。
 */
const {
  ASYNC_JOBS, ASYNC_JOB_STATUS,
  classifyThrownError, classifyResultOutcome, retryDelayMs,
} = require('../config/asyncJobs');
const { createAsyncJobStore, jobIdFor, isTerminalStatus } = require('./asyncJobStore');
const { createAsyncJobNotifier } = require('./asyncJobNotifier');
const { logInfo, logWarn } = require('../utils/logger');

/** 状态接口只回这些字段（**不返回 payload / 敏感字段**，文档第 7 节）。 */
const PUBLIC_JOB_FIELDS = Object.freeze([
  'job_id', 'type', 'status', 'attempts', 'last_error',
  'created_at', 'started_at', 'finished_at', 'notified_at',
]);

const publicJobView = (job = {}) => {
  const view = {};
  for (const key of PUBLIC_JOB_FIELDS) view[key] = job[key] ?? '';
  view.attempts = Number(job.attempts || 0);
  return view;
};

const emptyAttempts = () => ({ attempts: 0, last_error: '', reason: '' });

/** 只有明确给了 attempt 才写 `attempts`（patch 里不许出现 `undefined` —— 展开会把它覆盖进去）。 */
const attemptPatch = (attempt) => (Number(attempt || 0) > 0 ? { attempts: Number(attempt) } : {});

/**
 * @param {object} deps
 * @param {object} [deps.config]    `ASYNCE_JOBS` 形状配置（用例注入）
 * @param {object} [deps.store]     `createAsyncJobStore()` 的实例（用例注入临时目录）
 * @param {object} [deps.notifier]  `createAsyncJobNotifier()` 的实例（用例注入假发送器）
 * @param {object} [deps.logger]    `{logInfo, logWarn}`
 * @param {Function} [deps.sleep]   `(ms) => Promise`（用例注入 0 延迟）
 */
const createAsyncJobService = ({
  config = ASYNC_JOBS,
  store,
  notifier,
  logger = { logInfo, logWarn },
  sleep,
  now = () => new Date(),
} = {}) => {
  const jobStore = store || createAsyncJobStore();
  const notify = notifier || createAsyncJobNotifier({ config });
  const sleepFn = typeof sleep === 'function' ? sleep : ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const info = typeof logger.logInfo === 'function' ? logger.logInfo : () => {};
  const warn = typeof logger.logWarn === 'function' ? logger.logWarn : () => {};
  const nowIso = () => now().toISOString();

  /** 统一层自己的异常**只留痕**：绝不让"记 job 状态失败"把业务链路带崩。 */
  const safe = async (label, work) => {
    try {
      return await work();
    } catch (error) {
      warn('async_job.store.failed', {
        phase: label, error: String(error?.message || error).slice(0, 300),
      });
      return null;
    }
  };

  const get = (jobId) => safe('get', () => jobStore.get(jobId));

  /**
   * 入队（幂等）。`jobId` 由调用方用**自己的幂等键**经 `jobIdFor(type, key)` 派生 ——
   * 同一把键重放 ⇒ 同一个 job，**不会新建第二条**。
   */
  const enqueue = async ({
    jobId, type, payload = null, ownerOpenId = '', operatorName = '', meta = {},
  } = {}) => {
    const id = String(jobId || '').trim();
    if (!id) return null;
    return safe('enqueue', async () => {
      const { job, created } = await jobStore.createIfAbsent({
        job_id: id,
        type,
        status: ASYNC_JOB_STATUS.QUEUED,
        attempts: 0,
        last_error: '',
        payload,
        owner_open_id: String(ownerOpenId || ''),
        operator_name: String(operatorName || ''),
        meta,
      });
      if (created) info('async_job.enqueued', { job_id: id, type });
      return { job, created };
    });
  };

  /** 开始一次尝试：`running` + `attempts = attempt` + 首次 `started_at`。 */
  const begin = async (jobId, attempt) => safe('begin', async () => {
    const job = await jobStore.get(jobId);
    if (!job) return job;
    return jobStore.update(jobId, {
      status: ASYNC_JOB_STATUS.RUNNING,
      ...(Number(attempt || 0) > 0
        ? { attempts: Number(attempt) }
        : { attempts: Number(job.attempts || 0) }),
      ...(job.started_at ? {} : { started_at: nowIso() }),
    });
  });

  const succeed = async ({ jobId, result = null, attempt } = {}) => safe('succeed', async () => {
    const job = await jobStore.update(jobId, {
      status: ASYNC_JOB_STATUS.SUCCEEDED,
      ...attemptPatch(attempt),
      result,
      last_error: '',
      finished_at: nowIso(),
    });
    info('async_job.succeeded', {
      job_id: jobId, type: job?.type || '', attempts: Number(job?.attempts || 0),
    });
    return job;
  });

  const markPartialFailed = async ({ jobId, error = '', result = null, attempt } = {}) => safe('partial_failed', async () => {
    const job = await jobStore.update(jobId, {
      status: ASYNC_JOB_STATUS.PARTIAL_FAILED,
      ...attemptPatch(attempt),
      result,
      last_error: String(error || ''),
      finished_at: nowIso(),
    });
    warn('async_job.partial_failed', {
      job_id: jobId, type: job?.type || '', error: String(error || ''), attempts: Number(job?.attempts || 0),
    });
    return job;
  });

  /**
   * 一次尝试失败：可重试 ⇒ 回到 `queued` 等下一跑；不可重试 / 次数用尽 ⇒ `failed` + 通知。
   * （供**自己管重试循环**的链路逐次调用；统一循环 `run()` 内部也用它。）
   */
  const recordAttemptFailure = async ({
    jobId, error = '', attempt, retryable = false,
  } = {}) => safe('attempt_failed', () => jobStore.update(jobId, {
    status: retryable ? ASYNC_JOB_STATUS.QUEUED : ASYNC_JOB_STATUS.FAILED,
    ...attemptPatch(attempt),
    last_error: String(error || ''),
  }));

  /** 终态失败：先落 `failed`，再**尝试通知一次**（通知失败不改任务状态）。 */
  const fail = async ({ jobId, error = '', result = null, attempt } = {}) => {
    const job = await safe('fail', () => jobStore.update(jobId, {
      status: ASYNC_JOB_STATUS.FAILED,
      ...attemptPatch(attempt),
      result,
      last_error: String(error || ''),
      finished_at: nowIso(),
    }));
    warn('async_job.failed', {
      job_id: jobId, type: job?.type || '', attempts: Number(job?.attempts || 0), error: String(error || ''),
    });
    await notifyIfNeeded(jobId);
    return get(jobId);
  };

  /**
   * 发失败通知（同一 job 只发一次）。**发送成功才写 `notified_at`**；
   * 失败只累计 `notify` 字段 + 日志，任务状态不变（文档 6.4 / 6.5）。
   */
  const notifyIfNeeded = async (jobId) => {
    const job = await get(jobId);
    if (!job) return { sent: false, reason: 'not_found' };
    const outcome = await safe('notify', () => notify.notify(job));
    if (!outcome) return { sent: false, reason: 'notify_error' };
    return safe('notify_record', async () => {
      if (outcome.sent) {
        await jobStore.update(jobId, { notified_at: nowIso() });
        return outcome;
      }
      const previous = job.notify || emptyAttempts();
      await jobStore.update(jobId, {
        notify: {
          attempts: Number(previous.attempts || 0) + (outcome.reason === 'send_failed' ? 1 : 0),
          last_error: String(outcome.error || ''),
          reason: String(outcome.reason || ''),
        },
      });
      return outcome;
    });
  };

  /**
   * **通用重试循环**（销售 / 采购三条链路用）：跑一次 → 分类 → 可重试就退避重跑。
   * 🔴 重试复用**同一把幂等键**（各链路自己的 `run` 闭包里就是原键）；
   * 🔴 最后一次失败 ⇒ `failed` + 通知。
   *
   * @param {object} input
   * @param {string} input.jobId
   * @param {Function} input.run       `({attempt, job}) => Promise<结果>`
   * @param {Function} [input.classifyResult] 结果分类器（默认 `classifyResultOutcome`）
   */
  const run = async ({ jobId, run: runFn, classifyResult } = {}) => {
    const job = await get(jobId);
    if (!job) return null;
    // ⚠️ 刻意**不**因"job 已是终态"而跳过执行：同一个 submitKey 重放（页面重提 / 崩溃后续跑）
    //   仍要走一次**写入口**，由各链路自己的幂等键保证"不重复写"（这与改前行为一致；
    //   统一层只负责"同一条 job 上记状态/重试/通知"，不改变写库语义）。
    //   通知去重不依赖这里：它只认 `notified_at`（一次失败只发一次群消息）。
    const maxAttempts = Number(config.retry?.maxAttempts || 1);
    let attempt = 0;
    let lastError = '';
    while (attempt < maxAttempts) {
      attempt += 1;
      await begin(jobId, attempt);
      let outcome;
      let rawResult = null;
      try {
        rawResult = await runFn({ attempt, job });
        outcome = typeof classifyResult === 'function'
          ? classifyResult(rawResult, attempt)
          : classifyResultOutcome(rawResult, config.retry);
        if (outcome?.ok === true) return succeed({ jobId, result: rawResult ?? null, attempt });
        // "部分写入成功，部分失败" = 终态，**不重试**、也**不是**给群发通知的那种 failed
        // （状态口径见文档 3.1 / 6.1：通知只认 failed）
        if (outcome?.partial === true) {
          const message = String(outcome.message || '').trim();
          return markPartialFailed({ jobId, error: message, result: rawResult, attempt });
        }
      } catch (error) {
        const classified = classifyThrownError(error, config.retry);
        outcome = { ok: false, retryable: classified.retryable, message: classified.message };
      }
      lastError = String(outcome?.message || outcome?.error || '').trim() || 'unknown error';
      const retryable = outcome?.retryable === true && attempt < maxAttempts;
      await recordAttemptFailure({ jobId, error: lastError, attempt, retryable });
      if (!retryable) return fail({ jobId, error: lastError, attempt });
      const delay = retryDelayMs(attempt, config.retry);
      warn('async_job.retrying', {
        job_id: jobId, type: job.type, attempt, max_attempts: maxAttempts,
        delay_ms: delay, error: lastError,
      });
      if (delay > 0) await sleepFn(delay);
    }
    return fail({ jobId, error: lastError || 'retry exhausted', attempt: maxAttempts });
  };

  /**
   * 只读视图（状态接口用）：只能查**自己的**任务。
   * 不是自己的 / 没有 owner ⇒ 一律 `not_found`（不泄露"这条任务存在"）。
   */
  const view = async (jobId, viewerOpenId) => {
    const job = await get(jobId);
    const viewer = String(viewerOpenId || '').trim();
    if (!job) return { ok: false, reason: 'not_found' };
    if (!job.owner_open_id || !viewer || String(job.owner_open_id) !== viewer) {
      return { ok: false, reason: 'not_found' };
    }
    return { ok: true, job: publicJobView(job) };
  };

  /**
   * 启动时的收尾：
   *   ① **补发**未通知的终态失败（上一次进程里 "落 failed 了但通知没发出去 / 发送失败"）；
   *   ② 统计 `running` 残留任务并**如实记一条**（不猜它到底写没写成 —— 猜错会误报成功/失败）。
   */
  const start = async () => {
    const jobs = await safe('start_list', () => jobStore.list());
    if (!jobs) return { notified: 0, pending: 0, running: 0 };
    const pending = jobs.filter((job) => job.status === ASYNC_JOB_STATUS.FAILED
      && !job.notified_at && String(job.type || ''));
    let notified = 0;
    for (const job of pending) {
      const outcome = await notifyIfNeeded(job.job_id);
      if (outcome?.sent) notified += 1;
    }
    const running = jobs.filter((job) => job.status === ASYNC_JOB_STATUS.RUNNING);
    if (running.length) {
      warn('async_job.recover.running_orphaned', {
        count: running.length,
        job_ids: running.slice(0, 10).map((job) => job.job_id),
        hint: config.texts?.hints?.orphanedRunning || '',
      });
    }
    if (pending.length) info('async_job.recover.notified', { pending: pending.length, notified });
    return { notified, pending: pending.length, running: running.length };
  };

  return {
    enqueue, begin, succeed, markPartialFailed, recordAttemptFailure, fail,
    notifyIfNeeded, run, view, get, start,
    store: jobStore,
    jobIdFor,
  };
};

module.exports = { createAsyncJobService, publicJobView, PUBLIC_JOB_FIELDS };
