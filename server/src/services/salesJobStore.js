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
    // 2026-11-10（真实 E2E 发现）：扫码页的提交键只带 session_id + 序号（如 :1），
    // 同一台设备/同一个 page token 下，旧会话的 :1 会跨天残留；若只按 submitKey 建 job，
    // 新订单会被昨天那笔同键 job 当成“重复提交”直接复用，页面成功但一张表都没写。
    // ⇒ 新订单（order_no 不同）必须换一把唯一键，同一订单重提仍复用。
    const requestedKey = String(submitKey || '');
    const orderNo = String(payload?.order_no || '').trim();
    let key = requestedKey;
    let jobId = jobIdOf(key);
    const existing = await store.get(jobId);
    if (existing && orderNo && String(existing.order_no || '').trim() !== orderNo) {
      key = `${requestedKey}|order:${orderNo}`;
      jobId = jobIdOf(key);
    }
    const { created, record } = await store.createIfAbsent({
      job_id: jobId,
      submit_key: key,
      status: STATUS.queued,
      payload,
      tap_id: String(meta.tapId || '').slice(0, 64),
      attempts: 0,
      last_error: '',
      main_record_id: '',
      order_no: String(payload?.order_no || ''),
    });
    let job = record;
    if (!created && !job.tap_id && meta.tapId) {
      // 旧 job 可能没有 tap_id（升级前入队）；补一次元数据，不动已经冻结的 payload。
      job = await store.update(jobId, { tap_id: String(meta.tapId).slice(0, 64) });
    }
    return { job, created };
  };

  const get = (jobId) => store.get(jobId);
  const update = (jobId, patchOrMutator) => store.update(jobId, patchOrMutator);
  const listByStatus = (status) => store.list({ status });

  return { store, createIfAbsent, get, update, listByStatus, STATUS, jobIdOf };
};

module.exports = { createSalesJobStore, STATUS, jobIdOf };
