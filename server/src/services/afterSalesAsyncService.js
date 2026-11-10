'use strict';

/**
 * 售后（衍生单）异步队列（2026-11-08；2026-11-11 改全异步）——
 * 表单 POST 只做：**本地形状校验 + 冻结 payload + 入队 + 303 统一 toast**（不读飞书）；
 * 后台 worker 串行执行 `AfterSalesReturnService.execute`（**飞书校验 + 写库都在这层**，
 * 写库仍走 gateway → `feishuWriteScheduler`，不在这里重写任何写表逻辑）。
 *
 * 业务负责人 2026-10-29 口径：
 *   · 用户点击后 toast「数据提交成功，后台自动写入」（见 `config/submitToast.js`，本队列不写文案）；
 *   · 「大不了 API 接口有问题，那么就重试呗」⇒ 临时失败自动重试 N 次；
 *     **次数 / 退避只读统一配置** `ASYNC_JOB_*`（`config/asyncJobs.js`）——
 *     旧 `AFTER_SALES_JOB_*` 已退场（业务负责人 2026-11-08：改成统一配置，不需要兼容兜底）。
 */
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { AFTER_SALES_DERIVED } = require('../config/afterSalesDerived');
const {
  ASYNC_JOBS, ASYNC_JOB_TYPES, classifyThrownError, retryDelayMs,
} = require('../config/asyncJobs');
const { jobIdFor } = require('./asyncJobStore');
const { logInfo, logWarn, logError } = require('../utils/logger');

const STATUS = Object.freeze({
  queued: 'queued', running: 'running', succeeded: 'succeeded', failed: 'failed',
});
/**
 * 售后 job id：**沿用既有形状**（`after_sales_job_<hash>`），并由统一层的 `jobIdFor` 派生 ⇒
 * 链路自己的 job 与统一 job 是**同一个 id**（排查 / 状态接口按一个键串起来）。
 */
const jobIdOf = (type, requestId) => jobIdFor(ASYNC_JOB_TYPES.AFTER_SALES, `${type}:${requestId}`);

/** 通知要用的"非敏感元数据"（拿不到就不写，**不编** —— 文档 6.3）。 */
const isExchange = (payload) => String(payload?.action || '') === 'exchange';
const unifiedType = (payload) => (isExchange(payload)
  ? ASYNC_JOB_TYPES.AFTER_SALES_EXCHANGE
  : ASYNC_JOB_TYPES.AFTER_SALES);
const unifiedMeta = ({ type, key, payload }) => ({
  request_id: key,
  action: String(type || ''),
  order_no: String(payload?.salesEntryOrderNo || ''),
  step: isExchange(payload)
    ? ASYNC_JOBS.texts.stepLabels.afterSalesExchange
    : ASYNC_JOBS.texts.stepLabels.afterSales,
});

/**
 * 临时错误才重试（#948 第 5 节）：分类器**只有一份**（`config/asyncJobs.classifyThrownError`）——
 * 400 / 字段不存在 / 权限 / 参数 / 业务拒绝 ⇒ 不重试；5xx / 超时 / 网络 / 限流 ⇒ 重试。
 */
const isRetryable = (error) => classifyThrownError(error, ASYNC_JOBS.retry).retryable;

const createAfterSalesAsyncService = ({
  execute, onSettled, dir, store: injectedStore, asyncJobs = null,
  logger = { logInfo, logWarn, logError },
} = {}) => {
  if (typeof execute !== 'function') throw new Error('AfterSalesAsyncService requires execute');
  const store = injectedStore || new JsonTaskStore({
    dir: dir || AFTER_SALES_DERIVED.jobsDir || path.join(__dirname, '..', '..', 'data', 'after_sales_jobs'),
    idField: 'job_id',
  });
  /**
   * 统一 job 的**镜像调用**：失败只 warn，绝不打断售后链路（统一层是旁路，不是主链路）。
   */
  const mirror = async (work) => {
    try {
      return await work();
    } catch (error) {
      logger.logWarn('async_job.mirror.failed', {
        reason: 'after_sales', error: String(error?.message || error).slice(0, 300),
      });
      return null;
    }
  };
  const pending = [];
  const queued = new Set();
  const running = new Set();
  let pumping = false;
  // 重试次数 / 退避 = **统一配置唯一来源**（`ASYNC_JOB_MAX_ATTEMPTS` / `ASYNC_JOB_RETRY_BASE_MS`）；
  // 旧 `AFTER_SALES_JOB_*`（`config/afterSalesDerived.job`）已删除，不再兜底。
  const retryAttempts = ASYNC_JOBS.retry.maxAttempts;
  const delayForAttempt = (attempt) => retryDelayMs(attempt, ASYNC_JOBS.retry);

  const queueMeta = () => ({ queue_depth: pending.length, queued_count: queued.size, running_count: running.size });
  const get = (jobId) => store.get(jobId);

  const process = async (jobId) => {
    if (running.has(jobId)) return null;
    running.add(jobId);
    const promise = (async () => {
      const job = await store.get(jobId);
      if (!job || [STATUS.succeeded, STATUS.failed].includes(job.status)) return job;
      const attemptsStart = Number(job.attempts || 0) + 1;
      await store.update(jobId, {
        status: STATUS.running, attempts: attemptsStart, started_at: new Date().toISOString(),
      });
      // #948：统一 job 镜像（同 id）—— 只读排查 / 状态接口 / 失败通知都认这一份
      await mirror(() => asyncJobs?.begin(jobId, attemptsStart));
      for (let attempt = attemptsStart; attempt <= retryAttempts; attempt += 1) {
        try {
          const result = await execute(job.payload || {}, { jobId, correlation: job.correlation });
          await store.update(jobId, {
            status: STATUS.succeeded, result: result || {}, last_error: '',
            attempts: attempt, finished_at: new Date().toISOString(),
          });
          await mirror(() => asyncJobs?.succeed({ jobId, result: result || {}, attempt }));
          logger.logInfo('workbench.orders.after_sales.completed', {
            job_id: jobId, request_id: job.request_id, type: job.type, attempts: attempt, ...queueMeta(),
          });
          if (onSettled) onSettled();
          return store.get(jobId);
        } catch (error) {
          const message = String(error?.message || error);
          const retryable = isRetryable(error) && attempt < retryAttempts;
          await store.update(jobId, {
            last_error: message, attempts: attempt,
            status: retryable ? STATUS.queued : STATUS.failed,
            ...(retryable ? {} : { finished_at: new Date().toISOString() }),
          });
          if (!retryable) {
            logger.logError('workbench.orders.after_sales.failed', {
              job_id: jobId, request_id: job.request_id, type: job.type,
              attempts: attempt, reason: 'job_failed', error: message,
            });
            await mirror(() => asyncJobs?.recordAttemptFailure({
              jobId, error: message, attempt, retryable: false,
            }));
            // #948 第 6 节：**最终失败**才通知（同一 job 只发一次；发送失败不改任务状态）
            await mirror(() => asyncJobs?.fail({ jobId, error: message, attempt }));
            if (onSettled) onSettled();
            return store.get(jobId);
          }
          await mirror(() => asyncJobs?.recordAttemptFailure({
            jobId, error: message, attempt, retryable: true,
          }));
          logger.logWarn('workbench.orders.after_sales.failed', {
            job_id: jobId, request_id: job.request_id, type: job.type,
            attempts: attempt, reason: 'retrying', error: message,
          });
          await new Promise((resolve) => setTimeout(resolve, delayForAttempt(attempt)));
        }
      }
      return store.get(jobId);
    })();
    try { return await promise; } finally { running.delete(jobId); }
  };

  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (pending.length) {
        const id = pending.shift();
        queued.delete(id);
        await process(id).catch((error) => logger.logError('workbench.orders.after_sales.failed', {
          job_id: id, reason: 'queue_failed', error: String(error?.message || error),
        }));
      }
    } finally {
      pumping = false;
      if (pending.length) setImmediate(() => { pump().catch(() => undefined); });
    }
  };
  const schedule = (jobId) => {
    const id = String(jobId || '').trim();
    if (!id || queued.has(id) || running.has(id)) return;
    queued.add(id);
    pending.push(id);
    setImmediate(() => { pump().catch(() => undefined); });
  };

  const enqueue = async ({
    type = 'return', requestId, payload, correlation, ownerOpenId = '', operatorName = '',
  } = {}) => {
    const key = String(requestId || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(key)) throw new Error('request_id invalid');
    const jobId = jobIdOf(type, key);
    const existing = await store.get(jobId);
    if (existing) {
      // 统一 job 若因升级前入队而不存在 ⇒ 补建（幂等；不覆盖任何已冻结字段）
      await mirror(() => asyncJobs?.enqueue({
        jobId, type: unifiedType(payload), payload, ownerOpenId, operatorName,
        meta: unifiedMeta({ type, key, payload }),
      }));
      return { job: existing, created: false };
    }
    const job = await store.create({
      job_id: jobId, type, request_id: key, status: STATUS.queued,
      payload, correlation: correlation || null, attempts: 0, last_error: '',
    });
    await mirror(() => asyncJobs?.enqueue({
      jobId, type: unifiedType(payload), payload, ownerOpenId, operatorName,
      meta: unifiedMeta({ type, key, payload }),
    }));
    schedule(jobId);
    return { job, created: true };
  };

  const start = async () => {
    const jobs = await store.list();
    for (const job of jobs) {
      if (job.status === STATUS.queued || job.status === STATUS.running) schedule(job.job_id);
    }
  };

  return { enqueue, get, start, STATUS };
};

module.exports = { createAfterSalesAsyncService, STATUS };
