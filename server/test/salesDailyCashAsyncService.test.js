'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSalesDailyCashAsyncService } = require('../src/services/salesDailyCashAsyncService');
const { ASYNC_JOB_TYPES } = require('../src/config/asyncJobs');
const { SUBMIT_TOAST } = require('../src/config/submitToast');

test('每日现金异步入口：只 enqueue，返回统一 toast 和 job_id', async () => {
  const calls = { enqueued: [], run: null };
  const asyncJobs = {
    jobIdFor: (type, key) => `${type}_job_${key}`,
    enqueue: async (input) => {
      calls.enqueued.push(input);
      return { job: { status: 'queued' }, created: true };
    },
    run: async (input) => { calls.run = input; },
  };
  const service = createSalesDailyCashAsyncService({ gateway: {}, asyncJobs });
  const result = await service.submit({ openingAmount: '500', submitKey: 'key_1' });
  assert.equal(result.jobId, 'sales_daily_cash_job_key_1');
  assert.equal(result.toast, SUBMIT_TOAST.text);
  assert.equal(calls.enqueued[0].type, ASYNC_JOB_TYPES.SALES_DAILY_CASH);
  assert.deepEqual(calls.enqueued[0].payload, { openingAmount: '500', withdrawalAmount: undefined });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.run, 'created=true 时必须在后台启动 worker');
});

test('每日现金异步入口：没有金额时直接 400', async () => {
  const service = createSalesDailyCashAsyncService({ gateway: {}, asyncJobs: {} });
  await assert.rejects(() => service.submit({}), (error) => error.statusCode === 400);
});
