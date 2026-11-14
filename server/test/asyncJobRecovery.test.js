'use strict';

/**
 * #50 / #44：进程重启后 `running` 残留收敛 + 全部需通知终态补发（2026-11-14）。
 *
 *   AC-AJR-1 超龄 running ⇒ failed + 通知（不再只 warn）；新鲜 running 不动
 *   AC-AJR-2 启动补发覆盖 **failed + partial_failed**（不只 failed）
 *   AC-AJR-3 已通知的不重复发（notified_at 去重）；二次 start 不再 reaped
 *   AC-AJR-4 shutdown 会等正在跑的 run() 收尾（最多 timeoutMs）
 *   AC-AJR-5 告警清单包含 running 收敛 / 审计落盘失败事件
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildAsyncJobsConfig } = require('../src/config/asyncJobs');
const { createAsyncJobStore } = require('../src/services/asyncJobStore');
const { createAsyncJobService } = require('../src/services/asyncJobService');
const { DEFAULT_CRITICAL_EVENTS } = require('../src/config/alerts');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'async-job-recovery-'));
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();

const makeConfig = () => buildAsyncJobsConfig({
  ASYNC_JOBS_DIR: tmpDir(),
  ASYNC_JOB_MAX_ATTEMPTS: '1',
  ASYNC_JOB_RETRY_BASE_MS: '0',
  ASYNC_JOB_NOTIFY_ENABLED: 'true',
  ASYNC_JOB_RUNNING_STALE_MINUTES: '30',
});

const makeService = ({ store, logs = [], sent = [] }) => {
  const logger = {
    logInfo: (event, fields) => logs.push({ level: 'info', event, fields: fields || {} }),
    logWarn: (event, fields) => logs.push({ level: 'warn', event, fields: fields || {} }),
  };
  const notifier = {
    notify: async (job) => { sent.push(job.job_id); return { sent: true, cardId: 'card_1' }; },
  };
  return createAsyncJobService({ config: makeConfig(), store, notifier, logger });
};

const seed = async (store, job) => {
  const { job: created } = await store.createIfAbsent({
    job_id: job.job_id,
    type: job.type || 'sales',
    status: job.status,
    meta: {},
  });
  // asyncJobStore.createIfAbsent 只固化跨链路同形字段；started_at 由 begin() 后来写。
  if (job.started_at) await store.update(job.job_id, { started_at: job.started_at });
  return created;
};

test('AC-AJR-1/2/3 ⭐ 超龄 running 收敛 + failed/partial_failed 都补发 + 去重', async () => {
  const store = createAsyncJobStore({ dir: tmpDir() });
  await seed(store, { job_id: 'sale_job_old', status: 'running', started_at: isoAgo(60 * 60 * 1000) });
  await seed(store, { job_id: 'sale_job_fresh', status: 'running', started_at: new Date().toISOString() });
  await seed(store, { job_id: 'sale_job_failed', status: 'failed', started_at: isoAgo(5 * 60 * 1000) });
  await seed(store, { job_id: 'sale_job_partial', status: 'partial_failed', started_at: isoAgo(5 * 60 * 1000) });

  const logs = [];
  const sent = [];
  const service = makeService({ store, logs, sent });
  const out = await service.start();

  assert.equal(out.reaped, 1, JSON.stringify(out));
  assert.equal((await store.get('sale_job_old')).status, 'failed');
  assert.match(String((await store.get('sale_job_old')).last_error), /running|核对/);
  assert.equal((await store.get('sale_job_fresh')).status, 'running', '新鲜 running 不许动');

  const notifiedIds = new Set(sent);
  assert.ok(notifiedIds.has('sale_job_failed'), 'failed 要补发');
  assert.ok(notifiedIds.has('sale_job_partial'), 'partial_failed 也要补发（#44）');
  assert.ok(notifiedIds.has('sale_job_old'), 'reaped 后要发失败通知');
  assert.ok((await store.get('sale_job_partial')).notified_at, 'partial_failed 发送成功后要写 notified_at');
  assert.ok(logs.some((entry) => entry.event === 'async_job.recover.running_reaped'));

  // 第二次 start：没有可收敛/可补发的了
  const again = await service.start();
  assert.equal(again.reaped, 0);
  assert.equal(again.notified, 0);
});

test('AC-AJR-4 ⭐ shutdown 等正在跑的 run() 收尾', async () => {
  const store = createAsyncJobStore({ dir: tmpDir() });
  const service = makeService({ store });
  await store.createIfAbsent({ job_id: 'sale_job_slow', type: 'sales', status: 'queued' });
  const running = service.run({
    jobId: 'sale_job_slow',
    run: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return { ok: true }; },
  });
  const stopped = await service.shutdown({ timeoutMs: 2000 });
  await running;
  assert.equal(stopped.drained, true, JSON.stringify(stopped));
  assert.equal((await store.get('sale_job_slow')).status, 'succeeded');
});

test('AC-AJR-5 告警清单包含 running 收敛与审计落盘失败事件', () => {
  assert.ok(DEFAULT_CRITICAL_EVENTS.includes('async_job.recover.running_reaped'));
  assert.ok(DEFAULT_CRITICAL_EVENTS.includes('async_job.recover.running_orphaned'));
  assert.ok(DEFAULT_CRITICAL_EVENTS.includes('write_audit.append_failed'));
});
