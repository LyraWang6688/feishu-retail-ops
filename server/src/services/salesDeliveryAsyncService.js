'use strict';

/**
 * 交割单页异步写队列（交付 / 付款共用 FIFO）。
 *
 * 业务写表逻辑不在这里重写：只调用注入的 deliver/pay。
 * 状态 / 重试 / 失败通知 / job 存储统一走 `asyncJobService`（#948）；
 * 这里的 FIFO 只负责**页面级串行**（先点先跑），全局写冲突由飞书写调度器兜底。
 */
const fs = require('node:fs');
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { ASYNC_JOBS, ASYNC_JOB_TYPES, ASYNC_JOB_STATUS } = require('../config/asyncJobs');
const { logInfo, logWarn, logError } = require('../utils/logger');

const STATUS = Object.freeze({
  queued: ASYNC_JOB_STATUS.QUEUED,
  running: ASYNC_JOB_STATUS.RUNNING,
  succeeded: ASYNC_JOB_STATUS.SUCCEEDED,
  partialFailed: ASYNC_JOB_STATUS.PARTIAL_FAILED,
  failed: ASYNC_JOB_STATUS.FAILED,
});
const TYPE_OF = Object.freeze({
  delivery: ASYNC_JOB_TYPES.SALES_DELIVERY,
  payment: ASYNC_JOB_TYPES.SALES_PAYMENT,
});
const TERMINAL = new Set([STATUS.succeeded, STATUS.partialFailed, STATUS.failed]);

const firstFailure = (result) => {
  const failures = Array.isArray(result?.failures) ? result.failures : [];
  return failures.length ? String(failures[0]?.error || failures[0]?.message || 'write_failed') : '';
};
const classifyDelivery = (result) => {
  const failures = Array.isArray(result?.failures) ? result.failures : [];
  if (!failures.length) return { ok: true };
  const partial = Array.isArray(result?.results) && result.results.length > 0;
  return { ok: false, partial, retryable: false, message: firstFailure(result) };
};
const classifyPayment = () => ({ ok: true });
const classifyError = (error) => ({ retryable: false, message: String(error?.message || error) });

const createSalesDeliveryAsyncService = ({
  deliver, pay, jobs, onSettled, legacyDir, logger = { logInfo, logWarn, logError },
} = {}) => {
  if (typeof deliver !== 'function' || typeof pay !== 'function') throw new Error('SalesDeliveryAsyncService requires deliver/pay');
  if (!jobs) throw new Error('SalesDeliveryAsyncService requires jobs (asyncJobService)');
  const pendingQueue = [];
  const queued = new Set();
  const running = new Set();
  let pumping = false;

  const queueMeta = () => ({ queue_depth: pendingQueue.length, queued_count: queued.size, running_count: running.size });
  const get = (jobId) => jobs.get(jobId);
  const stepOf = (type) => (type === TYPE_OF.delivery
    ? ASYNC_JOBS.texts?.stepLabels?.salesDelivery
    : ASYNC_JOBS.texts?.stepLabels?.salesPayment);

  const process = async (jobId) => {
    if (running.has(jobId)) return null;
    running.add(jobId);
    const startedAt = Date.now();
    const promise = (async () => {
      const job = await jobs.get(jobId);
      if (!job || TERMINAL.has(job.status)) return job;
      const queueWaitMs = Math.max(0, Date.now() - Date.parse(job.created_at || job.updated_at || Date.now()));
      logger.logInfo('workbench.sales.delivery.job_started', {
        job_id: jobId, type: job.type, queue_wait_ms: queueWaitMs, ...queueMeta(),
      });
      const result = await jobs.run({
        jobId,
        run: async () => {
          const payload = job.payload || {};
          return job.type === TYPE_OF.delivery
            ? deliver(payload, { task_id: jobId })
            : pay(payload, { task_id: jobId });
        },
        classifyResult: job.type === TYPE_OF.delivery ? classifyDelivery : classifyPayment,
        classifyError,
      });
      logger.logInfo('workbench.sales.delivery.job_finished', {
        job_id: jobId,
        type: job.type,
        status: result?.status || '',
        duration_ms: Date.now() - startedAt,
        queue_wait_ms: queueWaitMs,
        delivered_count: Number(result?.result?.deliveredQuantity ?? (Array.isArray(result?.result?.results) ? result.result.results.length : 0)),
        failed_count: Array.isArray(result?.result?.failures) ? result.result.failures.length : 0,
        ...queueMeta(),
      });
      if (result?.status === STATUS.failed || result?.status === STATUS.partialFailed) {
        logger.logError(job.type === TYPE_OF.payment ? 'workbench.sales.payment.failed' : 'workbench.sales.delivery.failed', {
          job_id: jobId, reason: 'async_job', error: result?.last_error || '',
        });
      }
      if (onSettled) onSettled();
      return result;
    })();
    try { return await promise; } finally { running.delete(jobId); }
  };

  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (pendingQueue.length) {
        const id = pendingQueue.shift();
        queued.delete(id);
        await process(id).catch((error) => logger.logError(
          'workbench.sales.delivery.failed',
          { job_id: id, reason: 'queue_failed', error: String(error?.message || error) },
        ));
      }
    } finally {
      pumping = false;
      if (pendingQueue.length) setImmediate(() => { pump().catch(() => undefined); });
    }
  };
  const schedule = (jobId) => {
    const id = String(jobId || '').trim();
    if (!id || queued.has(id) || running.has(id)) return;
    queued.add(id);
    pendingQueue.push(id);
    setImmediate(() => { pump().catch(() => undefined); });
  };

  const enqueue = async ({ type, requestId, payload } = {}) => {
    const jobType = TYPE_OF[type];
    if (!jobType) throw new Error('job type invalid');
    const key = String(requestId || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(key)) throw new Error('request_id invalid');
    const jobId = jobs.jobIdFor(jobType, key);
    const { job, created } = await jobs.enqueue({
      jobId,
      type: jobType,
      payload,
      ownerOpenId: payload?.operatorOpenId || '',
      operatorName: payload?.operatorName || '',
      meta: { step: stepOf(jobType) || '', request_id: key },
    });
    if (!job) throw new Error('async job enqueue failed');
    if (!TERMINAL.has(job.status)) schedule(jobId);
    logger.logInfo('workbench.sales.delivery.job_enqueued', { job_id: jobId, type: jobType, ...queueMeta() });
    return { job, created };
  };

  const migrateLegacy = async () => {
    if (legacyDir === false) return;
    const dir = legacyDir || path.join(__dirname, '..', '..', 'data', 'sales_delivery_jobs');
    if (!fs.existsSync(dir)) return;
    try {
      const legacy = new JsonTaskStore({ dir, idField: 'job_id' });
      for (const job of await legacy.list()) {
        const type = TYPE_OF[job.type];
        if (!type || ![STATUS.queued, STATUS.running].includes(job.status)) continue;
        await jobs.enqueue({
          jobId: job.job_id,
          type,
          payload: job.payload || {},
          ownerOpenId: job.payload?.operatorOpenId || '',
          operatorName: job.payload?.operatorName || '',
          meta: { step: stepOf(type) || '', request_id: job.request_id || '', legacy: true },
        });
      }
    } catch (error) {
      logger.logWarn('workbench.sales.delivery.legacy_migration_failed', { error: String(error?.message || error) });
    }
  };

  const start = async () => {
    await migrateLegacy();
    const all = await jobs.store.list();
    for (const job of all) {
      if (Object.values(TYPE_OF).includes(job.type) && !TERMINAL.has(job.status)) schedule(job.job_id);
    }
  };

  return { enqueue, get, start, STATUS };
};

module.exports = { createSalesDeliveryAsyncService, STATUS };
