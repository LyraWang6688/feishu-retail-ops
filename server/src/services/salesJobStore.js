'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');

const STATUS = Object.freeze({
  queued: 'queued',
  running: 'running',
  succeeded: 'succeeded',
  partialFailed: 'partial_failed',
  failed: 'failed',
});

const jobIdOf = (submitKey) => `sale_job_${crypto.createHash('sha256').update(String(submitKey || '')).digest('hex').slice(0, 24)}`;

/**
 * 销售异步任务存储。job_id 由 submit_key 稳定哈希 ⇒ 同一个键重复提交只会得到同一个 job。
 */
const createSalesJobStore = ({ dir } = {}) => {
  const store = new JsonTaskStore({
    dir: dir || path.join(__dirname, '..', '..', 'data', 'sales_jobs'),
    idField: 'job_id',
  });

  const createIfAbsent = async (submitKey, payload, meta = {}) => {
    const jobId = jobIdOf(submitKey);
    let existing = await store.get(jobId);
    if (existing) {
      // 旧 job 可能没有 tap_id（升级前入队）；补一次元数据，不动已经冻结的 payload。
      if (!existing.tap_id && meta.tapId) {
        existing = await store.update(jobId, { tap_id: String(meta.tapId).slice(0, 64) });
      }
      return { job: existing, created: false };
    }
    const job = await store.create({
      job_id: jobId,
      submit_key: String(submitKey || ''),
      status: STATUS.queued,
      payload,
      tap_id: String(meta.tapId || '').slice(0, 64),
      attempts: 0,
      last_error: '',
      main_record_id: '',
      order_no: String(payload?.order_no || ''),
    });
    return { job, created: true };
  };

  const get = (jobId) => store.get(jobId);
  const update = (jobId, patchOrMutator) => store.update(jobId, patchOrMutator);
  const listByStatus = (status) => store.list({ status });

  return { store, createIfAbsent, get, update, listByStatus, STATUS, jobIdOf };
};

module.exports = { createSalesJobStore, STATUS, jobIdOf };
