'use strict';

/**
 * 售后重试**只读统一配置**（业务负责人 2026-11-08：「改成统一配置，不需要兼容兜底」）。
 *
 * AC-RU1 统一 `ASYNC_JOB_MAX_ATTEMPTS` 决定售后重试次数（本例 2 次 ⇒ 失败两次后停）。
 * AC-RU2 旧 `AFTER_SALES_JOB_MAX_ATTEMPTS` **不再有任何作用**（本例设 5，仍只 2 次）。
 * AC-RU3 退避取统一 `ASYNC_JOB_RETRY_BASE_MS`（本例 0 ⇒ 不等待，测试快）。
 *
 * ⚠️ env 必须在 require 业务模块**之前**设：`config/asyncJobs` 在模块加载时读 env。
 */
process.env.ASYNC_JOB_MAX_ATTEMPTS = '2';
process.env.ASYNC_JOB_RETRY_BASE_MS = '0';
process.env.AFTER_SALES_JOB_MAX_ATTEMPTS = '5'; // 旧配置：必须**无效**

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { ASYNC_JOBS, ASYNC_JOB_TYPES } = require('../src/config/asyncJobs');
const { jobIdFor } = require('../src/services/asyncJobStore');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { createAfterSalesAsyncService } = require('../src/services/afterSalesAsyncService');

const waitFor = async (predicate, timeoutMs = 5000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  throw new Error('waitFor timeout');
};

test('AC-RU1..3 售后重试次数/退避 = 统一配置（旧 AFTER_SALES_JOB_* 已退场）', async () => {
  assert.equal(ASYNC_JOBS.retry.maxAttempts, 2, '统一配置读到了 2 次');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'after-sales-retry-unified-'));
  const store = new JsonTaskStore({ dir, idField: 'job_id' });
  let calls = 0;
  const jobs = createAfterSalesAsyncService({
    store,
    execute: async () => { calls += 1; throw Object.assign(new Error('飞书 502'), { statusCode: 502 }); },
  });
  const requestId = crypto.randomUUID();
  const { job } = await jobs.enqueue({ type: 'return', requestId, payload: { salesEntryOrderNo: 'XSD-RETRY-1' } });
  const expectedId = jobIdFor(ASYNC_JOB_TYPES.AFTER_SALES, `return:${requestId}`);
  assert.equal(job.job_id, expectedId, '售后 job 与统一 job 同一个 id');
  await waitFor(async () => (await store.get(expectedId))?.status === 'failed');
  const final = await store.get(expectedId);
  assert.equal(final.attempts, 2, '统一配置 2 次 ⇒ 只跑 2 次（旧 env=5 不生效）');
  assert.equal(calls, 2);
});
