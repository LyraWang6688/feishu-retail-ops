'use strict';

/**
 * 库存调整 / 验收 → 标签打印的**后端打印意图**（issue #1210，2026-11-14；2026-11-17 扩到验收）。
 *
 * 背景：旧链路是浏览器「轮询库存 job → 成功后再建打印任务」——
 *   页面一进后台/一关，打印任务就永远建不出来（2026-11-14 09:58 真实现场）。
 *
 * 现在：她点「打印」只发**一次**请求（`request`），后端把意图写进 job；
 *   job 成功时 `flush` 自动入队打印任务；进程重启后 `recover` 补做。
 *
 * 🔴 边界：
 *   · 只认**指定类型 + 本人**的 job（别人的 / 不存在的都回 not_found）；
 *   · **只有 succeeded 才打印**（failed / partial_failed 都不打）；
 *   · 幂等：`submit_key = <prefix>_<jobId>`（多货品时再拼 `:<productRecordId>`），队列按它去重；
 *   · 打印入队失败**不回滚库存/验收**（业务已经成功的事实不能被抹掉），只记日志 + 意图状态。
 *
 * 2026-11-17 扩展：
 *   · 支持 `product_record_ids`（验收一次多款）；
 *   · `source` 由调用方给（库存调整 / 验收），打印请求记录据此写「来源」；
 *   · 旧库存调整（单款 `payload.productRecordId`）逐字兼容。
 */
const { logInfo, logWarn } = require('../utils/logger');
const { ASYNC_JOB_TYPES, ASYNC_JOB_STATUS } = require('../config/asyncJobs');
const { SOURCES } = require('../config/labelPrintQueue');

/** 打印任务的幂等键：同一笔库存调整/验收永远只有一条（队列按 submit_key 去重）。 */
const submitKeyOf = (jobId, prefix = 'inventory_print') => (prefix ? prefix : 'inventory_print') + '_' + String(jobId || '').trim();

const uniqueIds = (values) => [...new Set((Array.isArray(values) ? values : []).map((item) => String(item || '').trim()).filter(Boolean))];

const productIdsOf = (job, intent = {}) => {
  const explicit = uniqueIds(intent.product_record_ids);
  if (explicit.length) return explicit;
  const single = String(job?.payload?.productRecordId || '').trim();
  return single ? [single] : [];
};

const jobIdsOf = (job) => {
  const map = job?.print_job_ids && typeof job.print_job_ids === 'object' ? { ...job.print_job_ids } : {};
  // 旧单款记录只有 print_job_id；迁移成 map 但保留旧字段。
  const legacy = String(job?.print_job_id || '').trim();
  const ids = productIdsOf(job, job?.print_intent || {});
  if (legacy && ids.length === 1 && !map[ids[0]]) map[ids[0]] = legacy;
  return map;
};

const missingIdsOf = (job, intent = {}) => {
  const ids = productIdsOf(job, intent);
  const done = jobIdsOf(job);
  return ids.filter((id) => !done[id]);
};

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
   * @returns {Promise<{queued:boolean, print_job_id?:string, print_job_ids?:object, reused?:boolean, reason?:string}>}
   */
  const flush = async (jobId) => {
    const job = await jobs.get(jobId);
    if (!job) return { queued: false, reason: 'not_found' };
    const intent = job.print_intent && typeof job.print_intent === 'object' ? job.print_intent : null;
    if (!intent || !intent.submit_key) return { queued: false, reason: 'no_intent' };
    const ids = productIdsOf(job, intent);
    if (!ids.length) {
      logger.logWarn('inventory.print.intent.missing_product', { job_id: jobId });
      return { queued: false, reason: 'missing_product' };
    }
    const already = jobIdsOf(job);
    const missing = ids.filter((id) => !already[id]);
    if (!missing.length) {
      return {
        queued: true,
        print_job_id: String(job.print_job_id || already[ids[0]] || ''),
        print_job_ids: already,
        reused: true,
      };
    }
    if (job.status !== ASYNC_JOB_STATUS.SUCCEEDED) {
      return { queued: false, reason: 'status:' + (job.status || 'unknown') };
    }

    const source = intent.source || SOURCES.inventory;
    const actor = String(job.owner_open_id || intent.requested_by || '');
    // 验收：即使这次只勾了一款，也**按货品拼键** —— 同一验收 job 以后再加另一款时，
    // 不能复用上一款的 submit_key（否则队列会把第二款当成"重复提交"而不打）。
    // 库存调整：单款保持老键（兼容既有任务/测试）。
    const perProductKey = source === SOURCES.acceptance || source === SOURCES.sale || ids.length > 1;
    const queued = { ...already };
    let firstJobId = String(job.print_job_id || '');
    let firstError = '';
    let failed = 0;
    for (const recordId of missing) {
      try {
        const result = await queue.enqueueSingle({
          recordId,
          actor,
          // 库存单款保持老键；验收/多款按货品各一把键。
          submitKey: perProductKey ? intent.submit_key + ':' + recordId : intent.submit_key,
          source,
        });
        const printJobId = String(result?.job_id || result?.job?.job_id || '').trim();
        if (printJobId) queued[recordId] = printJobId;
        if (!firstJobId && printJobId) firstJobId = printJobId;
      } catch (error) {
        failed += 1;
        firstError = String(error?.message || error).slice(0, 300);
        logger.logWarn('inventory.print.intent.item_failed', {
          job_id: jobId, product_record_id: recordId, error: firstError,
        });
      }
    }

    const anyQueued = Object.keys(queued).length > 0;
    await updateJob(jobId, {
      print_job_id: firstJobId,
      print_job_ids: queued,
      print_intent: {
        ...intent,
        status: failed ? 'failed' : 'queued',
        queued_at: anyQueued ? iso() : intent.queued_at || '',
        print_job_id: firstJobId,
        print_job_ids: queued,
        last_error: firstError,
      },
    });
    if (anyQueued) {
      logger.logInfo('inventory.print.intent.queued', {
        job_id: jobId,
        print_job_id: firstJobId,
        product_record_ids: Object.keys(queued),
        source,
      });
    }
    if (failed) {
      logger.logWarn('inventory.print.intent.failed', {
        job_id: jobId, failed, total: ids.length, error: firstError,
      });
    }
    return {
      queued: anyQueued,
      print_job_id: firstJobId,
      print_job_ids: queued,
      failed,
    };
  };

  /**
   * 她点「打印」：写意图；已成功就立即入队，否则等 job 成功时 `flush`。
   * @returns {Promise<{ok:boolean, reason?:string, deferred?:boolean, queued?:boolean, print_job_id?:string}>}
   */
  const request = async ({
    jobId, ownerOpenId, productRecordIds,
    source = SOURCES.inventory,
    expectedType = ASYNC_JOB_TYPES.INVENTORY_ADJUSTMENT,
    submitKeyPrefix = 'inventory_print',
  } = {}) => {
    const job = await jobs.get(jobId);
    if (!job || job.type !== expectedType) return { ok: false, reason: 'not_found' };
    if (!job.owner_open_id || String(job.owner_open_id) !== String(ownerOpenId || '')) {
      return { ok: false, reason: 'not_found' };
    }
    if ([ASYNC_JOB_STATUS.FAILED, ASYNC_JOB_STATUS.PARTIAL_FAILED].includes(job.status)) {
      return { ok: false, reason: 'job_failed' };
    }
    const ids = uniqueIds(productRecordIds && productRecordIds.length
      ? productRecordIds
      : [job.payload?.productRecordId]);
    if (!ids.length) return { ok: false, reason: 'missing_product' };
    await updateJob(jobId, {
      print_intent: {
        submit_key: submitKeyOf(jobId, submitKeyPrefix),
        requested_at: iso(),
        requested_by: String(ownerOpenId || ''),
        product_record_ids: ids,
        source,
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

  /** 启动补做：已成功、有意图、还有货品没建打印任务的 job（进程重启/部署后）。 */
  const recover = async () => {
    const all = await jobs.store.list();
    const pending = (Array.isArray(all) ? all : []).filter((job) => (
      job?.print_intent?.submit_key
      && job.status === ASYNC_JOB_STATUS.SUCCEEDED
      && missingIdsOf(job, job.print_intent).length > 0
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
