'use strict';

/**
 * 售后（衍生单）异步队列（2026-11-08）—— 表单 POST 只做：校验 + 冻结 payload + 入队 + 303 统一 toast；
 * 后台 worker 串行执行 `AfterSalesReturnService.execute`（不在这里重写任何写表逻辑）。
 *
 * 业务负责人 2026-10-29 口径：
 *   · 用户点击后 toast「数据提交成功，后台自动写入」（见 `config/submitToast.js`，本队列不写文案）；
 *   · 「大不了 API 接口有问题，那么就重试呗」⇒ 临时失败自动重试 N 次（配置在 afterSalesDerived.job）。
 */
const crypto = require('node:crypto');
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { AFTER_SALES_DERIVED } = require('../config/afterSalesDerived');
const { logInfo, logWarn, logError } = require('../utils/logger');

const STATUS = Object.freeze({
  queued: 'queued', running: 'running', succeeded: 'succeeded', failed: 'failed',
});
const jobIdOf = (type, requestId) => `after_sales_job_${crypto.createHash('sha256')
  .update(`${type}:${requestId}`).digest('hex').slice(0, 24)}`;

const isRetryable = (error) => {
  const status = Number(error?.statusCode || error?.status || 0);
  if (status === 400) return false; // 她填错 ⇒ 不重试
  return true; // 其余（飞书 5xx / 超时 / 限流）交给重试
};

const createAfterSalesAsyncService = ({ execute, onSettled, dir, store: injectedStore, logger = { logInfo, logWarn, logError } } = {}) => {
  if (typeof execute !== 'function') throw new Error('AfterSalesAsyncService requires execute');
  const store = injectedStore || new JsonTaskStore({
    dir: dir || AFTER_SALES_DERIVED.jobsDir || path.join(__dirname, '..', '..', 'data', 'after_sales_jobs'),
    idField: 'job_id',
  });
  const pending = [];
  const queued = new Set();
  const running = new Set();
  let pumping = false;
  const { retryAttempts, retryBaseMs } = AFTER_SALES_DERIVED.job;

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
      for (let attempt = attemptsStart; attempt <= retryAttempts; attempt += 1) {
        try {
          const result = await execute(job.payload || {}, { jobId, correlation: job.correlation });
          await store.update(jobId, {
            status: STATUS.succeeded, result: result || {}, last_error: '',
            attempts: attempt, finished_at: new Date().toISOString(),
          });
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
            if (onSettled) onSettled();
            return store.get(jobId);
          }
          logger.logWarn('workbench.orders.after_sales.failed', {
            job_id: jobId, request_id: job.request_id, type: job.type,
            attempts: attempt, reason: 'retrying', error: message,
          });
          await new Promise((resolve) => setTimeout(resolve, retryBaseMs * attempt));
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

  const enqueue = async ({ type = 'return', requestId, payload, correlation } = {}) => {
    const key = String(requestId || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(key)) throw new Error('request_id invalid');
    const jobId = jobIdOf(type, key);
    const existing = await store.get(jobId);
    if (existing) return { job: existing, created: false };
    const job = await store.create({
      job_id: jobId, type, request_id: key, status: STATUS.queued,
      payload, correlation: correlation || null, attempts: 0, last_error: '',
    });
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
