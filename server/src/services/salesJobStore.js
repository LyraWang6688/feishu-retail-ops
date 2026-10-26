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

  const createIfAbsent = async (submitKey, payload) => {
    const jobId = jobIdOf(submitKey);
    const existing = await store.get(jobId);
    if (existing) return { job: existing, created: false };
    const job = await store.create({
      job_id: jobId,
      submit_key: String(submitKey || ''),
      status: STATUS.queued,
      payload,
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
