'use strict';

/** #1210：库存调整 → 后端打印意图（成功才打、幂等、可补做）。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInventoryPrintIntentService, submitKeyOf } = require('../src/services/inventoryPrintIntentService');

const silent = { logInfo() {}, logWarn() {} };

const makeJob = (overrides = {}) => ({
  job_id: 'inventory_adjustment_job_1',
  type: 'inventory_adjustment',
  status: 'succeeded',
  owner_open_id: 'ou_owner',
  payload: { productRecordId: 'rec_product' },
  ...overrides,
});

const makeJobs = (initial) => {
  const state = { jobs: [initial] };
  return {
    state,
    get: async (id) => {
      const job = state.jobs.find((item) => item.job_id === id);
      return job ? { ...job } : null;
    },
    store: {
      update: async (id, patch) => {
        const job = state.jobs.find((item) => item.job_id === id);
        assert.ok(job, 'job 必须存在');
        Object.assign(job, patch);
        return { ...job };
      },
      list: async () => state.jobs.map((job) => ({ ...job })),
    },
  };
};

const makeQueue = (behavior = 'ok') => {
  const calls = [];
  return {
    calls,
    enqueueSingle: async (input) => {
      calls.push(input);
      if (behavior === 'throw') throw new Error('queue down');
      return { job_id: 'print_job_1' };
    },
  };
};

test('AC-PI1 已成功的 job：点打印 → 立即按记录 ID 入队（submit_key 固定）', async () => {
  const jobs = makeJobs(makeJob());
  const queue = makeQueue();
  const service = createInventoryPrintIntentService({ jobs, queue, logger: silent });

  const outcome = await service.request({ jobId: 'inventory_adjustment_job_1', ownerOpenId: 'ou_owner' });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.queued, true);
  assert.equal(outcome.print_job_id, 'print_job_1');
  assert.deepEqual(queue.calls[0], {
    recordId: 'rec_product', actor: 'ou_owner', submitKey: submitKeyOf('inventory_adjustment_job_1'), source: 'workbench',
  });
  assert.equal(jobs.state.jobs[0].print_job_id, 'print_job_1');
  assert.equal(jobs.state.jobs[0].print_intent.status, 'queued');
});

test('AC-PI2 幂等：再点一次不会重复入队', async () => {
  const jobs = makeJobs(makeJob());
  const queue = makeQueue();
  const service = createInventoryPrintIntentService({ jobs, queue, logger: silent });

  await service.request({ jobId: 'inventory_adjustment_job_1', ownerOpenId: 'ou_owner' });
  const second = await service.request({ jobId: 'inventory_adjustment_job_1', ownerOpenId: 'ou_owner' });

  assert.equal(queue.calls.length, 1);
  assert.equal(second.print_job_id, 'print_job_1');
  assert.equal(second.reused, true);
});

test('AC-PI3 还在跑：先记意图（202），job 成功后 flush 才入队', async () => {
  const jobs = makeJobs(makeJob({ status: 'running' }));
  const queue = makeQueue();
  const service = createInventoryPrintIntentService({ jobs, queue, logger: silent });

  const requested = await service.request({ jobId: 'inventory_adjustment_job_1', ownerOpenId: 'ou_owner' });
  assert.equal(requested.ok, true);
  assert.equal(requested.deferred, true);
  assert.equal(queue.calls.length, 0, '库存还没成功，不能建打印任务');

  jobs.state.jobs[0].status = 'succeeded';
  const flushed = await service.flush('inventory_adjustment_job_1');
  assert.equal(flushed.queued, true);
  assert.equal(queue.calls.length, 1);
});

test('AC-PI4 库存失败：不打印（409 语义）', async () => {
  const jobs = makeJobs(makeJob({ status: 'failed' }));
  const queue = makeQueue();
  const service = createInventoryPrintIntentService({ jobs, queue, logger: silent });

  const outcome = await service.request({ jobId: 'inventory_adjustment_job_1', ownerOpenId: 'ou_owner' });
  assert.deepEqual(outcome, { ok: false, reason: 'job_failed' });
  assert.equal(queue.calls.length, 0);
});

test('AC-PI5 不是本人 / 不是库存调整 job ⇒ not_found', async () => {
  const jobs = makeJobs(makeJob());
  const queue = makeQueue();
  const service = createInventoryPrintIntentService({ jobs, queue, logger: silent });

  assert.deepEqual(await service.request({ jobId: 'inventory_adjustment_job_1', ownerOpenId: 'ou_other' }), { ok: false, reason: 'not_found' });
  jobs.state.jobs[0].type = 'sales';
  assert.deepEqual(await service.request({ jobId: 'inventory_adjustment_job_1', ownerOpenId: 'ou_owner' }), { ok: false, reason: 'not_found' });
});

test('AC-PI6 打印入队失败：意图标 failed、不回滚库存、不抛', async () => {
  const jobs = makeJobs(makeJob());
  const queue = makeQueue('throw');
  const service = createInventoryPrintIntentService({ jobs, queue, logger: silent });

  const outcome = await service.request({ jobId: 'inventory_adjustment_job_1', ownerOpenId: 'ou_owner' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.queued, false);
  assert.equal(jobs.state.jobs[0].print_intent.status, 'failed');
  assert.match(jobs.state.jobs[0].print_intent.last_error, /queue down/);
});

test('AC-PI7 启动补做：已成功 + 有意图 + 没打印任务 ⇒ 补建', async () => {
  const job = makeJob({
    status: 'succeeded',
    print_intent: { submit_key: 'inventory_print_inventory_adjustment_job_1', status: 'pending' },
  });
  const jobs = makeJobs(job);
  const queue = makeQueue();
  const service = createInventoryPrintIntentService({ jobs, queue, logger: silent });

  const summary = await service.recover();
  assert.deepEqual(summary, { pending: 1, queued: 1, failed: 0 });
  assert.equal(queue.calls.length, 1);
});
