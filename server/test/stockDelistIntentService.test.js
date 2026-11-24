'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStockDelistIntentService } = require('../src/services/stockDelistIntentService');
const { ASYNC_JOB_STATUS } = require('../src/config/asyncJobs');

const makeJobs = (job) => {
  const store = {
    value: { ...job },
    async get(id) { return id === this.value.job_id ? this.value : null; },
    async update(id, patch) { assert.equal(id, this.value.job_id); this.value = { ...this.value, ...patch }; return this.value; },
    async list() { return [this.value]; },
  };
  return { store, get: (id) => store.get(id) };
};

test('下架意图：库存成功后才执行，失败不执行', async () => {
  const calls = [];
  const jobs = makeJobs({
    job_id: 'job_1', type: 'inventory_adjustment', owner_open_id: 'ou_1',
    status: ASYNC_JOB_STATUS.RUNNING, delist_results: {},
  });
  const service = createStockDelistIntentService({
    jobs,
    delist: async (input) => { calls.push(input); return { ok: true }; },
  });
  const requested = await service.request({
    jobId: 'job_1', ownerOpenId: 'ou_1', productRecordIds: ['p1'], expectedType: 'inventory_adjustment',
  });
  assert.equal(requested.deferred, true);
  assert.equal(calls.length, 0, '库存没成功前不下架');
  jobs.store.value.status = ASYNC_JOB_STATUS.SUCCEEDED;
  const flushed = await service.flush('job_1');
  assert.equal(flushed.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].recordId, 'p1');
  assert.equal(calls[0].allowNoSample, true);

  // 重放：已成功的货品不再下架
  await service.flush('job_1');
  assert.equal(calls.length, 1);
});

test('下架意图：库存失败 / 别人任务 / 多货品逐个执行', async () => {
  const jobs = makeJobs({
    job_id: 'job_2', type: 'inventory_adjustment', owner_open_id: 'ou_1',
    status: ASYNC_JOB_STATUS.FAILED, delist_results: {},
  });
  const service = createStockDelistIntentService({ jobs, delist: async () => ({ ok: true }) });
  assert.equal((await service.request({
    jobId: 'job_2', ownerOpenId: 'ou_1', productRecordIds: ['p1'], expectedType: 'inventory_adjustment',
  })).reason, 'job_failed');
  assert.equal((await service.request({
    jobId: 'job_2', ownerOpenId: 'ou_other', productRecordIds: ['p1'], expectedType: 'inventory_adjustment',
  })).reason, 'not_found');
  jobs.store.value.status = ASYNC_JOB_STATUS.SUCCEEDED;
  const calls = [];
  const multi = createStockDelistIntentService({ jobs, delist: async (input) => { calls.push(input.recordId); return { ok: true }; } });
  await multi.request({ jobId: 'job_2', ownerOpenId: 'ou_1', productRecordIds: ['p1', 'p2'] });
  const out = await multi.flush('job_2');
  assert.equal(out.ok, true);
  assert.deepEqual(calls.sort(), ['p1', 'p2']);
});
