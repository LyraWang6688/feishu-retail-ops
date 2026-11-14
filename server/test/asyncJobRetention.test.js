'use strict';

/**
 * #1203 / #57：异步 job 终态文件的保留期清理（2026-11-14）。
 *   AC-AJRET-1 超期**终态**删除；近期终态 / queued / running 一律不动
 *   AC-AJRET-2 retentionDays<=0 ⇒ 不清理
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildAsyncJobsConfig } = require('../src/config/asyncJobs');
const { createAsyncJobStore } = require('../src/services/asyncJobStore');
const { createAsyncJobService } = require('../src/services/asyncJobService');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'async-job-retention-'));
const isoAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const seed = async (store, jobId, status, patch = {}) => {
  await store.createIfAbsent({ job_id: jobId, type: 'sales', status, meta: {} });
  await store.update(jobId, patch);
};

const makeService = (store) => createAsyncJobService({
  config: buildAsyncJobsConfig({}),
  store,
  notifier: { notify: async () => ({ sent: true }) },
  logger: { logInfo: () => {}, logWarn: () => {} },
});

test('AC-AJRET-1 只删超期终态', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createAsyncJobStore({ dir });
  await seed(store, 'sale_job_old_done', 'succeeded', { finished_at: isoAgo(60) });
  await seed(store, 'sale_job_old_failed', 'failed', { finished_at: isoAgo(60) });
  await seed(store, 'sale_job_recent', 'succeeded', { finished_at: isoAgo(1) });
  await seed(store, 'sale_job_queued_old', 'queued', { created_at: isoAgo(60) });
  await seed(store, 'sale_job_running_old', 'running', { started_at: isoAgo(60) });

  const service = makeService(store);
  const out = await service.cleanupOldJobs({ retentionDays: 30 });
  assert.equal(out.deleted, 2, JSON.stringify(out));
  assert.equal(await store.get('sale_job_old_done'), null);
  assert.equal(await store.get('sale_job_old_failed'), null);
  assert.ok(await store.get('sale_job_recent'));
  assert.ok(await store.get('sale_job_queued_old'), 'queued 绝不清');
  assert.ok(await store.get('sale_job_running_old'), 'running 绝不清');
});

test('AC-AJRET-2 retentionDays<=0 ⇒ 不清理', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createAsyncJobStore({ dir });
  await seed(store, 'sale_job_keep', 'failed', { finished_at: isoAgo(999) });
  const service = makeService(store);
  const out = await service.cleanupOldJobs({ retentionDays: 0 });
  assert.equal(out.skipped, 'disabled');
  assert.ok(await store.get('sale_job_keep'));
});
