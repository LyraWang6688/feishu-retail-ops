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
    // 新订单会被昨天那笔同键 job 当成"重复提交"直接复用，页面成功但一张表都没写。
    //
    // ⭐⭐ 2026-11-14（#45）：**订单号必须在"派生 jobId"时就带上，不能在原子创建锁外先 get 再分流**。
    //   旧实现两个不同订单并发时都先 get 不到、都选基础键，底层原子创建让后者返回前者订单 ⇒ 跨订单合并。
    //   新实现：有 order_no ⇒ jobId 一律由 `submitKey|order:<order_no>` 派生（同订单稳定复用，
    //   不同订单天然隔离）；只有**没有 order_no** 才退回基础键。
    const requestedKey = String(submitKey || '');
    const orderNo = String(payload?.order_no || '').trim();
    const tapPatch = async (jobId) => {
      const current = await store.get(jobId);
      if (!current || current.tap_id || !meta.tapId) return current;
      // 旧 job 可能没有 tap_id（升级前入队）；补一次元数据，不动已经冻结的 payload。
      return store.update(jobId, { tap_id: String(meta.tapId).slice(0, 64) });
    };
    const create = async (jobId, key) => {
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
      if (!created) return { job: await tapPatch(jobId) || record, created };
      return { job: record, created };
    };

    if (!orderNo) return create(jobIdOf(requestedKey), requestedKey);

    const orderKey = `${requestedKey}|order:${orderNo}`;
    const orderJobId = jobIdOf(orderKey);
    const existingOrder = await store.get(orderJobId);
    if (existingOrder) return { job: (await tapPatch(orderJobId)) || existingOrder, created: false };

    // 兼容迁移：2026-11-10～11-13 的 old job 用的是**基础键**。同订单重提仍要复用，不能新建。
    const baseJobId = jobIdOf(requestedKey);
    const legacy = await store.get(baseJobId);
    if (legacy && String(legacy.order_no || '').trim() === orderNo) {
      return { job: (await tapPatch(baseJobId)) || legacy, created: false };
    }

    return create(orderJobId, orderKey);
  };

  const get = (jobId) => store.get(jobId);
  const update = (jobId, patchOrMutator) => store.update(jobId, patchOrMutator);
  const listByStatus = (status) => store.list({ status });

  return { store, createIfAbsent, get, update, listByStatus, STATUS, jobIdOf };
};

module.exports = { createSalesJobStore, STATUS, jobIdOf };
