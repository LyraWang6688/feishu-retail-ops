'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSalesDailyCashAsyncService } = require('../src/services/salesDailyCashAsyncService');
const { ASYNC_JOB_TYPES } = require('../src/config/asyncJobs');
const { SUBMIT_TOAST } = require('../src/config/submitToast');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

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

test('每日现金异步 worker 的业务结果必须带 ok:true（否则会被判失败）', async () => {
  const calls = { enqueued: [], run: null };
  const gateway = {
    table: () => V1_BITABLE_SCHEMA.tables.salesSummary,
    listAll: async () => [],
    create: async () => ({ recordId: 'dc_1' }),
    get: async () => ({ record_id: 'dc_1', fields: { [V1_BITABLE_SCHEMA.tables.salesSummary.fields.openingCash]: 500 } }),
  };
  const asyncJobs = {
    jobIdFor: (type, key) => `${type}_job_${key}`,
    enqueue: async (input) => { calls.enqueued.push(input); return { job: { status: 'queued' }, created: true }; },
    run: async (input) => { calls.run = input; },
  };
  const service = createSalesDailyCashAsyncService({ gateway, asyncJobs });
  await service.submit({ openingAmount: '500', submitKey: 'key_ok' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.run);
  const result = await calls.run.run({ attempt: 1, job: {} });
  assert.equal(result.ok, true);
  assert.equal(result.record.opening_amount, 500);
});

test('每日现金异步入口：没有金额时直接 400', async () => {
  const service = createSalesDailyCashAsyncService({ gateway: {}, asyncJobs: {} });
  await assert.rejects(() => service.submit({}), (error) => error.statusCode === 400);
});
