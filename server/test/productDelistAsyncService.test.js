'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProductDelistAsyncService } = require('../src/services/productDelistAsyncService');
const { ASYNC_JOB_TYPES } = require('../src/config/asyncJobs');
const { SUBMIT_TOAST } = require('../src/config/submitToast');

test('货品下架异步入口：只 enqueue，返回统一 toast 和 job_id', async () => {
  const calls = { enqueued: [], run: null };
  const asyncJobs = {
    jobIdFor: (type, key) => `${type}_job_${key}`,
    enqueue: async (input) => {
      calls.enqueued.push(input);
      return { job: { status: 'queued' }, created: true };
    },
    run: async (input) => { calls.run = input; },
  };
  const service = createProductDelistAsyncService({
    gateway: { drive: {} },
    asyncJobs,
  });
  const result = await service.submit({
    recordId: 'rec_1', allowNoSample: true, operatorOpenId: 'ou_1', submitKey: 'key_1',
  });
  assert.equal(result.jobId, `product_delist_job_key_1`);
  assert.equal(result.toast, SUBMIT_TOAST.text);
  assert.equal(calls.enqueued.length, 1);
  assert.equal(calls.enqueued[0].type, ASYNC_JOB_TYPES.PRODUCT_DELIST);
  assert.deepEqual(calls.enqueued[0].payload, {
    recordId: 'rec_1', allowNoSample: true, operatorOpenId: 'ou_1', correlation: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.run, 'created=true 时必须在后台启动 worker');
});
