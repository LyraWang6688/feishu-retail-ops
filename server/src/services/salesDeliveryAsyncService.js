'use strict';

/**
 * 交割单页异步写队列（交付 / 付款共用一条 FIFO，串行写飞书）。
 *
 * 浏览器请求只做：校验 + 冻结 payload + 入队 + 返回 job_id；
 * worker 串行执行既有交付 / 付款服务；重启后重新排 queued/running。
 * 🔴 业务写表逻辑不在这里重写：只调用注入的 deliver/pay 函数。
 */
const crypto = require('node:crypto');
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { logInfo, logWarn, logError } = require('../utils/logger');

const STATUS = Object.freeze({ queued: 'queued', running: 'running', succeeded: 'succeeded', partialFailed: 'partial_failed', failed: 'failed' });
const jobIdOf = (type, requestId) => `delivery_job_${crypto.createHash('sha256').update(`${type}:${requestId}`).digest('hex').slice(0, 24)}`;

const createSalesDeliveryAsyncService = ({ deliver, pay, onSettled, dir, logger = { logInfo, logWarn, logError } } = {}) => {
  if (typeof deliver !== 'function' || typeof pay !== 'function') throw new Error('SalesDeliveryAsyncService requires deliver/pay');
  const store = new JsonTaskStore({
    dir: dir || path.join(__dirname, '..', '..', 'data', 'sales_delivery_jobs'), idField: 'job_id',
  });
  const pendingQueue = [];
  const queued = new Set();
  const running = new Set();
  let pumping = false;

  const queueMeta = () => ({ queue_depth: pendingQueue.length, queued_count: queued.size, running_count: running.size });
  const jobMeta = (job) => ({
    job_id: job.job_id, type: job.type, request_id: job.request_id, attempt: Number(job.attempts || 0) + 1,
  });

  const get = (jobId) => store.get(jobId);

  const process = async (jobId) => {
    if (running.has(jobId)) return null;
    running.add(jobId);
    const promise = (async () => {
      const job = await store.get(jobId);
      if (!job || [STATUS.succeeded, STATUS.partialFailed, STATUS.failed].includes(job.status)) return job;
      const startedAt = Date.now();
      const queueWaitMs = Math.max(0, startedAt - Date.parse(job.created_at || job.updated_at || startedAt));
      const attempt = Number(job.attempts || 0) + 1;
      await store.update(jobId, { status: STATUS.running, attempts: attempt, started_at: new Date(startedAt).toISOString() });
      logger.logInfo('workbench.sales.delivery.job_started', {
        ...jobMeta({ ...job, attempts: attempt - 1 }), queue_wait_ms: queueWaitMs, ...queueMeta(),
      });
      try {
        const payload = job.payload || {};
        const result = job.type === 'delivery'
          ? await deliver(payload, { task_id: jobId })
          : await pay(payload, { task_id: jobId });
        const failures = Array.isArray(result?.failures) ? result.failures : [];
        const succeeded = failures.length === 0;
        const partial = failures.length > 0 && Array.isArray(result?.results) && result.results.length > 0;
        const status = succeeded ? STATUS.succeeded : (partial ? STATUS.partialFailed : STATUS.failed);
        const lastError = failures.length ? String(failures[0]?.error || failures[0]?.message || 'write_failed') : '';
        await store.update(jobId, {
          status, result: result || {}, failures, last_error: lastError,
          finished_at: new Date().toISOString(),
        });
        const deliveredCount = Number(result?.deliveredQuantity ?? (Array.isArray(result?.results) ? result.results.length : 0));
        logger.logInfo('workbench.sales.delivery.job_finished', {
          ...jobMeta({ ...job, attempts: attempt - 1 }),
          status,
          duration_ms: Date.now() - startedAt,
          queue_wait_ms: queueWaitMs,
          delivered_count: Number.isFinite(deliveredCount) ? deliveredCount : null,
          failed_count: failures.length,
          failure_codes: [...new Set(failures.map((item) => String(item?.error || item?.message || 'write_failed').slice(0, 120)))],
          ...queueMeta(),
        });
        if (failures.length) {
          logger.logError(job.type === 'payment' ? 'workbench.sales.payment.failed' : 'workbench.sales.delivery.failed', {
            job_id: jobId, reason: 'async_job_failed_lines', failed_count: failures.length, error: lastError,
          });
        }
      } catch (error) {
        await store.update(jobId, {
          status: STATUS.failed, last_error: String(error?.message || error), finished_at: new Date().toISOString(),
        });
        logger.logInfo('workbench.sales.delivery.job_finished', {
          ...jobMeta({ ...job, attempts: attempt - 1 }),
          status: STATUS.failed,
          duration_ms: Date.now() - startedAt,
          queue_wait_ms: queueWaitMs,
          delivered_count: 0,
          failed_count: 1,
          failure_codes: [String(error?.message || error).slice(0, 120)],
          ...queueMeta(),
        });
        logger.logError(job.type === 'payment' ? 'workbench.sales.payment.failed' : 'workbench.sales.delivery.failed', {
          job_id: jobId, reason: 'async_job', error: String(error?.message || error),
        });
      }
      if (onSettled) onSettled();
      return store.get(jobId);
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
        await process(id).catch((error) => logger.logError('workbench.sales.delivery.failed', { job_id: id, reason: 'queue_failed', error: String(error?.message || error) }));
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
    if (!['delivery', 'payment'].includes(type)) throw new Error('job type invalid');
    const key = String(requestId || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(key)) throw new Error('request_id invalid');
    const jobId = jobIdOf(type, key);
    const existing = await store.get(jobId);
    if (existing) return { job: existing, created: false };
    const job = await store.create({ job_id: jobId, type, request_id: key, status: STATUS.queued, payload, attempts: 0, last_error: '' });
    logger.logInfo('workbench.sales.delivery.job_enqueued', { job_id: jobId, type, request_id: key, ...queueMeta() });
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

module.exports = { createSalesDeliveryAsyncService, STATUS };
