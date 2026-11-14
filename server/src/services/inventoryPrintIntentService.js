'use strict';

/**
 * 库存调整 → 标签打印的**后端打印意图**（issue #1210，2026-11-14）。
 *
 * 背景：旧链路是浏览器「轮询库存 job → 成功后再建打印任务」——
 *   页面一进后台/一关，打印任务就永远建不出来（2026-11-14 09:58 真实现场）。
 *
 * 现在：她点「打印」只发**一次**请求（`request`），后端把意图写进 job；
 *   job 成功时 `flush` 自动入队打印任务；进程重启后 `recover` 补做。
 *
 * 🔴 边界：
 *   · 只认 `inventory_adjustment` + **本人**的 job（别人的 / 不存在的都回 not_found）；
 *   · **只有 succeeded 才打印**（failed / partial_failed 都不打）；
 *   · 幂等：`submit_key = inventory_print_<jobId>`，打印队列本身按它去重；
 *   · 打印入队失败**不回滚库存**（库存已成功的事实不能被抹掉），只记日志 + 意图状态。
 */
const { logInfo, logWarn } = require('../utils/logger');
const { ASYNC_JOB_TYPES, ASYNC_JOB_STATUS } = require('../config/asyncJobs');
const { SOURCES } = require('../config/labelPrintQueue');

/** 打印任务的幂等键：同一笔库存调整永远只有一条（队列按 submit_key 去重）。 */
const submitKeyOf = (jobId) => `inventory_print_${String(jobId || '').trim()}`;

/**
 * @param {object} deps
 * @param {object} deps.jobs  统一异步任务服务（`getAsyncJobService()`）
 * @param {object} deps.queue 打印队列（`getLabelPrintQueue()`）
 * @param {object} [deps.logger]
 * @param {Function} [deps.now]
 */
const createInventoryPrintIntentService = ({
  jobs, queue, logger = { logInfo, logWarn }, now = () => Date.now(),
} = {}) => {
  if (!jobs) throw new Error('缺少统一异步任务服务');
  if (!queue || typeof queue.enqueueSingle !== 'function') throw new Error('缺少打印队列');

  const iso = () => new Date(now()).toISOString();
  const updateJob = (jobId, patch) => jobs.store.update(jobId, patch);

  /**
   * 把已成功的 job 的打印意图落成打印任务（幂等）。
   * @returns {Promise<{queued:boolean, print_job_id?:string, reused?:boolean, reason?:string}>}
   */
  const flush = async (jobId) => {
    const job = await jobs.get(jobId);
    if (!job) return { queued: false, reason: 'not_found' };
    const intent = job.print_intent && typeof job.print_intent === 'object' ? job.print_intent : null;
    if (!intent || !intent.submit_key) return { queued: false, reason: 'no_intent' };
    if (job.print_job_id) return { queued: true, print_job_id: String(job.print_job_id), reused: true };
    if (job.status !== ASYNC_JOB_STATUS.SUCCEEDED) {
      return { queued: false, reason: `status:${job.status || 'unknown'}` };
    }
    const recordId = String(job.payload?.productRecordId || '').trim();
    if (!recordId) {
      logger.logWarn('inventory.print.intent.missing_product', { job_id: jobId });
      return { queued: false, reason: 'missing_product' };
    }
    try {
      const result = await queue.enqueueSingle({
        recordId,
        actor: String(job.owner_open_id || intent.requested_by || ''),
        submitKey: intent.submit_key,
        source: SOURCES.workbench,
      });
      const printJobId = String(result?.job_id || result?.job?.job_id || '').trim();
      await updateJob(jobId, {
        print_job_id: printJobId,
        print_intent: {
          ...intent, status: 'queued', queued_at: iso(), print_job_id: printJobId, last_error: '',
        },
      });
      logger.logInfo('inventory.print.intent.queued', {
        job_id: jobId, print_job_id: printJobId, product_record_id: recordId,
      });
      return { queued: true, print_job_id: printJobId };
    } catch (error) {
      const message = String(error?.message || error).slice(0, 300);
      await updateJob(jobId, {
        print_intent: { ...intent, status: 'failed', last_error: message },
      });
      logger.logWarn('inventory.print.intent.failed', { job_id: jobId, error: message });
      return { queued: false, reason: 'enqueue_failed' };
    }
  };

  /**
   * 她点「打印」：写意图；已成功就立即入队，否则等 job 成功时 `flush`。
   * @returns {Promise<{ok:boolean, reason?:string, deferred?:boolean, queued?:boolean, print_job_id?:string}>}
   */
  const request = async ({ jobId, ownerOpenId } = {}) => {
    const job = await jobs.get(jobId);
    if (!job || job.type !== ASYNC_JOB_TYPES.INVENTORY_ADJUSTMENT) return { ok: false, reason: 'not_found' };
    if (!job.owner_open_id || String(job.owner_open_id) !== String(ownerOpenId || '')) {
      return { ok: false, reason: 'not_found' };
    }
    if ([ASYNC_JOB_STATUS.FAILED, ASYNC_JOB_STATUS.PARTIAL_FAILED].includes(job.status)) {
      return { ok: false, reason: 'job_failed' };
    }
    await updateJob(jobId, {
      print_intent: {
        submit_key: submitKeyOf(jobId),
        requested_at: iso(),
        requested_by: String(ownerOpenId || ''),
        status: 'pending',
        last_error: '',
      },
    });
    if (job.status === ASYNC_JOB_STATUS.SUCCEEDED) {
      const flushed = await flush(jobId);
      return { ok: true, deferred: false, ...flushed };
    }
    return { ok: true, deferred: true };
  };

  /** 启动补做：已成功、有意图、还没建打印任务的 job（进程重启/部署后）。 */
  const recover = async () => {
    const all = await jobs.store.list();
    const pending = (Array.isArray(all) ? all : []).filter((job) => (
      job?.print_intent?.submit_key
      && !job.print_job_id
      && job.status === ASYNC_JOB_STATUS.SUCCEEDED
    ));
    let queued = 0;
    let failed = 0;
    for (const job of pending) {
      const outcome = await flush(job.job_id);
      if (outcome.queued) queued += 1;
      else failed += 1;
    }
    return { pending: pending.length, queued, failed };
  };

  return { request, flush, recover, submitKeyOf };
};

module.exports = { createInventoryPrintIntentService, submitKeyOf };
