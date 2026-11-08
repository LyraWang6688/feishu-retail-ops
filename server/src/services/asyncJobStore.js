'use strict';

/**
 * 统一异步任务存储（#948 第 3 节）。
 *
 * 一条任务一个 JSON 文件（底层复用 `infrastructure/jsonTaskStore` ⇒ 原子写 + 同 id 写互斥），
 * 目录默认 `server/data/async_jobs/`（`ASYNC_JOBS_DIR` 可覆盖）。
 *
 * 为什么要有它（而不是继续每链接一份 store）：#948 要的是**一套**状态机与**一次**失败通知；
 * 五条链路各自的 store 继续存在（业务细节 / 断点续做 / 既有用例都靠它），
 * 本 store 存的是**跨链路同形**的那些字段 ⇒ 状态接口 + 通知去重只认这一份。
 *
 * 🔴 不存敏感凭证（payload 由各链路给"可排查但不含 secret"的那一小份）；
 * 🔴 重试只更新同一条任务（`job_id` 由幂等键稳定派生），不新建任务。
 */
const crypto = require('node:crypto');
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const {
  ASYNC_JOBS, ASYNC_JOB_STATUS, TERMINAL_STATUSES, JOB_ID_PREFIX,
} = require('../config/asyncJobs');

/** `job_id` 只允许这些字符（`JsonTaskStore` 也按这个形状落文件名）。 */
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * 由**幂等键**派生稳定 `job_id` —— 同一把键永远得到同一个 id ⇒ 重试/并发不会造第二条任务。
 *
 * ⚠️ 销售 / 售后**刻意沿用既有形状**（`sale_job_<hash>` / `after_sales_job_<hash>`），
 *   这样"链路自己的 job" 与"统一 job" 是**同一个 id**，排查时按一个键就能串起来。
 */
const jobIdFor = (type, key) => {
  const prefix = JOB_ID_PREFIX[type] || `${String(type || 'async')}_job`;
  const digest = crypto.createHash('sha256').update(String(key ?? '')).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
};

const isTerminalStatus = (status) => TERMINAL_STATUSES.includes(String(status || ''));

const createAsyncJobStore = ({ dir } = {}) => {
  const store = new JsonTaskStore({
    dir: dir || ASYNC_JOBS.jobsDir,
    idField: 'job_id',
  });

  const get = async (jobId) => {
    const id = String(jobId ?? '').trim();
    if (!JOB_ID_PATTERN.test(id)) return null;
    return store.get(id);
  };

  /**
   * 建一条任务；**已存在就原样返回**（幂等：绝不覆盖已冻结的 payload / 结果）。
   * @returns {{job: object, created: boolean}}
   */
  const createIfAbsent = async (job = {}) => {
    const jobId = String(job.job_id ?? '').trim();
    if (!JOB_ID_PATTERN.test(jobId)) throw new Error(`invalid async job id: ${job.job_id}`);
    const { created, record } = await store.createIfAbsent({
      job_id: jobId,
      type: String(job.type || ''),
      status: String(job.status || ASYNC_JOB_STATUS.QUEUED),
      attempts: Number(job.attempts || 0),
      last_error: String(job.last_error || ''),
      payload: job.payload == null ? null : job.payload,
      result: job.result == null ? null : job.result,
      owner_open_id: String(job.owner_open_id || ''),
      operator_name: String(job.operator_name || ''),
      meta: job.meta && typeof job.meta === 'object' ? { ...job.meta } : {},
      notified_at: '',
      notify: { attempts: 0, last_error: '', reason: '' },
    });
    return { job: record, created };
  };

  const update = (jobId, patch) => {
    const id = String(jobId ?? '').trim();
    if (!JOB_ID_PATTERN.test(id)) throw new Error(`invalid async job id: ${jobId}`);
    return store.update(id, patch);
  };

  const list = (filter = {}) => store.list(filter);

  return { store, get, createIfAbsent, update, list, dir: store.dir };
};

module.exports = { createAsyncJobStore, jobIdFor, isTerminalStatus, JOB_ID_PATTERN };
