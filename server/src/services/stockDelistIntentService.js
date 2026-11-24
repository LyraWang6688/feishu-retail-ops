'use strict';

/**
 * 库存任务成功后的「下架意图」。
 *
 * 与 print intent 同一套形态：
 *   · 提交库存时把下架意图写进同一条 async job；
 *   · 库存 job 成功后才执行既有 ProductDelistService；
 *   · 库存失败 / 意图失败不回滚库存事实。
 */
const { logInfo, logWarn } = require('../utils/logger');
const { ASYNC_JOB_STATUS } = require('../config/asyncJobs');
const { STOCK_DELIST } = require('../config/stockDelist');

const uniqueIds = (values) => [...new Set((Array.isArray(values) ? values : [])
  .map((item) => String(item || '').trim()).filter(Boolean))];

const resultMapOf = (job) => (job?.delist_results && typeof job.delist_results === 'object'
  ? { ...job.delist_results } : {});

const createStockDelistIntentService = ({
  jobs, delist, logger = { logInfo, logWarn }, now = () => Date.now(),
} = {}) => {
  if (!jobs) throw new Error('StockDelistIntentService requires jobs');
  if (typeof delist !== 'function') throw new Error('StockDelistIntentService requires delist');

  const iso = () => new Date(now()).toISOString();
  const updateJob = (jobId, patch) => jobs.store.update(jobId, patch);

  /**
   * 把已成功 job 的下架意图执行掉。幂等：已成功的货品不重复下架。
   */
  const flush = async (jobId) => {
    const job = await jobs.get(jobId);
    if (!job) return { ok: false, reason: 'not_found' };
    const intent = job.delist_intent && typeof job.delist_intent === 'object' ? job.delist_intent : null;
    if (!intent || !intent.submit_key) return { ok: false, reason: 'no_intent' };
    const ids = uniqueIds(intent.product_record_ids);
    if (!ids.length) return { ok: false, reason: 'missing_product' };
    if (job.status !== ASYNC_JOB_STATUS.SUCCEEDED) {
      return { ok: false, reason: 'status:' + (job.status || 'unknown') };
    }
    const results = resultMapOf(job);
    const pending = ids.filter((id) => !results[id]?.ok);
    if (!pending.length) return { ok: true, skipped: true, results };
    let failed = 0;
    let lastError = '';
    for (const recordId of pending) {
      try {
        const result = await delist({
          recordId,
          allowNoSample: intent.allow_no_sample === true,
          operatorOpenId: job.owner_open_id || '',
          correlation: { job_id: jobId },
        });
        if (result?.ok) {
          results[recordId] = { ok: true, already_delisted: result.already_delisted === true };
        } else {
          failed += 1;
          lastError = String(result?.reason || 'delist_failed');
          results[recordId] = { ok: false, reason: lastError };
          logger.logWarn('stock.delist.intent.item_failed', {
            job_id: jobId, record_id: recordId, reason: lastError,
          });
        }
      } catch (error) {
        failed += 1;
        lastError = String(error?.message || error).slice(0, 300);
        results[recordId] = { ok: false, reason: lastError };
        logger.logWarn('stock.delist.intent.item_failed', {
          job_id: jobId, record_id: recordId, error: lastError,
        });
      }
    }
    await updateJob(jobId, {
      delist_results: results,
      delist_intent: {
        ...intent,
        status: failed ? 'failed' : 'done',
        finished_at: iso(),
        last_error: lastError,
      },
    });
    if (!failed) {
      logger.logInfo('stock.delist.intent.done', { job_id: jobId, product_record_ids: ids });
    }
    return { ok: failed === 0, failed, results };
  };

  /**
   * 记录下架意图。job 必须存在、属于本人、类型匹配；已成功则立即执行。
   */
  const request = async ({
    jobId, ownerOpenId, productRecordIds, expectedType, allowNoSample,
  } = {}) => {
    if (!STOCK_DELIST.enabled) return { ok: false, reason: 'disabled' };
    const job = await jobs.get(jobId);
    if (!job || (expectedType && job.type !== expectedType)) return { ok: false, reason: 'not_found' };
    if (!job.owner_open_id || String(job.owner_open_id) !== String(ownerOpenId || '')) {
      return { ok: false, reason: 'not_found' };
    }
    if ([ASYNC_JOB_STATUS.FAILED, ASYNC_JOB_STATUS.PARTIAL_FAILED].includes(job.status)) {
      return { ok: false, reason: 'job_failed' };
    }
    const ids = uniqueIds(productRecordIds);
    if (!ids.length) return { ok: false, reason: 'missing_product' };
    await updateJob(jobId, {
      delist_intent: {
        submit_key: 'stock_delist_' + String(jobId || '').trim(),
        requested_at: iso(),
        requested_by: String(ownerOpenId || ''),
        product_record_ids: ids,
        allow_no_sample: allowNoSample === undefined ? STOCK_DELIST.allowNoSample : allowNoSample === true,
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

  const recover = async () => {
    const all = await jobs.store.list();
    const pending = (Array.isArray(all) ? all : []).filter((job) => (
      job?.delist_intent?.submit_key
      && job.status === ASYNC_JOB_STATUS.SUCCEEDED
      && uniqueIds(job.delist_intent.product_record_ids)
        .some((id) => !resultMapOf(job)[id]?.ok)
    ));
    let done = 0;
    let failed = 0;
    for (const job of pending) {
      const outcome = await flush(job.job_id);
      if (outcome.ok) done += 1; else failed += 1;
    }
    return { pending: pending.length, done, failed };
  };

  return { request, flush, recover };
};

module.exports = { createStockDelistIntentService };
