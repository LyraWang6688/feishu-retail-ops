'use strict';

/** 交割单异步 FIFO：入队立即返回、串行执行、幂等、失败落状态。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSalesDeliveryAsyncService } = require('../src/services/salesDeliveryAsyncService');

const waitFor = async (fn, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  throw new Error('waitFor timeout');
};
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('AC-DA1 入队立即返回；FIFO 串行；成功后 job=succeeded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-jobs-'));
  const calls = [];
  let running = 0;
  let maxRunning = 0;
  const service = createSalesDeliveryAsyncService({
    dir,
    deliver: async (payload) => { running += 1; maxRunning = Math.max(maxRunning, running); calls.push(['deliver', payload]); await new Promise((resolve) => { setTimeout(resolve, 10); }); running -= 1; },
    pay: async (payload) => { calls.push(['pay', payload]); },
  });
  const first = await service.enqueue({ type: 'delivery', requestId: uuid(1), payload: { detailRecordIds: ['d1'] } });
  const second = await service.enqueue({ type: 'payment', requestId: uuid(2), payload: { amount: 10 } });
  assert.equal(first.created, true);
  assert.equal(second.created, true);
  assert.ok(first.job.job_id && second.job.job_id);
  await waitFor(async () => (await service.get(first.job.job_id))?.status === 'succeeded' && (await service.get(second.job.job_id))?.status === 'succeeded');
  assert.equal(maxRunning, 1, '同一时刻只跑一个 job');
  assert.deepEqual(calls.map((call) => call[0]), ['deliver', 'pay']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC-DA2 同一 request_id 幂等：返回同一个 job，不重复执行', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-jobs-'));
  let count = 0;
  const service = createSalesDeliveryAsyncService({
    dir, deliver: async () => { count += 1; }, pay: async () => {},
  });
  const key = uuid(3);
  const a = await service.enqueue({ type: 'delivery', requestId: key, payload: {} });
  const b = await service.enqueue({ type: 'delivery', requestId: key, payload: {} });
  assert.equal(a.job.job_id, b.job.job_id);
  assert.equal(b.created, false);
  await waitFor(async () => (await service.get(a.job.job_id))?.status === 'succeeded');
  assert.equal(count, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC-DA4 交付部分失败：job 落 partial_failed + failures 明细，不再假 succeeded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-jobs-'));
  const service = createSalesDeliveryAsyncService({
    dir,
    deliver: async () => ({
      results: [{ detailRecordId: 'd-ok' }],
      failures: [{ detailRecordId: 'd-bad', error: '库存不足' }],
    }),
    pay: async () => {},
  });
  const { job } = await service.enqueue({ type: 'delivery', requestId: uuid(5), payload: {} });
  await waitFor(async () => (await service.get(job.job_id))?.status === 'partial_failed');
  const partial = await service.get(job.job_id);
  assert.equal(partial.status, 'partial_failed');
  assert.equal(partial.last_error, '库存不足');
  assert.equal(partial.failures.length, 1);
  assert.equal(partial.failures[0].detailRecordId, 'd-bad');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC-DA5 交付全部失败：job 落 failed + 失败明细', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-jobs-'));
  const service = createSalesDeliveryAsyncService({
    dir,
    deliver: async () => ({ results: [], failures: [{ detailRecordId: 'd-bad', error: '库存不足' }] }),
    pay: async () => {},
  });
  const { job } = await service.enqueue({ type: 'delivery', requestId: uuid(6), payload: {} });
  await waitFor(async () => (await service.get(job.job_id))?.status === 'failed');
  const failed = await service.get(job.job_id);
  assert.equal(failed.last_error, '库存不足');
  assert.equal(failed.failures[0].error, '库存不足');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC-DA3 写失败：job 落 failed + last_error；不吞', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-jobs-'));
  const service = createSalesDeliveryAsyncService({
    dir, deliver: async () => { throw new Error('库存不足'); }, pay: async () => {},
  });
  const { job } = await service.enqueue({ type: 'delivery', requestId: uuid(4), payload: {} });
  await waitFor(async () => (await service.get(job.job_id))?.status === 'failed');
  const failed = await service.get(job.job_id);
  assert.equal(failed.last_error, '库存不足');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC-DA6 生命周期日志：enqueued / started / finished 可串起 job，且不记 payload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-jobs-'));
  const logs = [];
  const logger = {
    logInfo: (event, meta) => logs.push({ level: 'info', event, meta }),
    logWarn: (event, meta) => logs.push({ level: 'warn', event, meta }),
    logError: (event, meta) => logs.push({ level: 'error', event, meta }),
  };
  const service = createSalesDeliveryAsyncService({
    dir,
    logger,
    deliver: async () => ({ results: [{ detailRecordId: 'd1' }], failures: [], deliveredQuantity: 1 }),
    pay: async () => ({}),
  });
  const { job } = await service.enqueue({ type: 'delivery', requestId: uuid(7), payload: { detailRecordIds: ['d1'] } });
  await waitFor(async () => (await service.get(job.job_id))?.status === 'succeeded');

  const lifecycle = logs.filter((item) => item.event.startsWith('workbench.sales.delivery.job_'));
  assert.deepEqual(lifecycle.map((item) => item.event), [
    'workbench.sales.delivery.job_enqueued',
    'workbench.sales.delivery.job_started',
    'workbench.sales.delivery.job_finished',
  ]);
  assert.equal(lifecycle[0].meta.job_id, job.job_id);
  assert.equal(lifecycle[2].meta.job_id, job.job_id);
  assert.equal(lifecycle[2].meta.status, 'succeeded');
  assert.equal(lifecycle[2].meta.failed_count, 0);
  assert.equal(lifecycle[2].meta.delivered_count, 1);
  assert.equal(typeof lifecycle[2].meta.duration_ms, 'number');
  assert.equal(typeof lifecycle[2].meta.queue_wait_ms, 'number');
  assert.equal(lifecycle.some((item) => 'payload' in item.meta), false, '日志不能带完整 payload');
  fs.rmSync(dir, { recursive: true, force: true });
});
