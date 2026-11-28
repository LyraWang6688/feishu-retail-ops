'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSalesCorrectionAsyncService } = require('../src/services/salesCorrectionAsyncService');
const { ASYNC_JOB_TYPES } = require('../src/config/asyncJobs');

test('确认单异步：入队后由 worker 调用 correct，并返回统一回执跳转', async () => {
  const calls = { enqueued: [], ran: [], corrected: [] };
  const asyncJobs = {
    jobIdFor: (type, key) => `${type}_job_${key}`,
    enqueue: async (input) => { calls.enqueued.push(input); return { job: { status: 'queued' }, created: true }; },
    run: async (input) => { calls.ran.push(input); await input.run(); },
  };
  const correctionService = {
    correct: async (payload, options) => {
      calls.corrected.push({ payload, options });
      return { task_id: 'corr_1', applied: true };
    },
  };
  const service = createSalesCorrectionAsyncService({ correctionService, asyncJobs });
  const result = await service.submit({
    payload: { submitKey: 'key_1', salesEntryRecordId: 'e1', details: [{ recordId: 'd1' }] },
    actor: { openId: 'ou_1' },
    operatorOpenId: 'ou_1',
    operatorName: '赵瑞玲',
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.enqueued.length, 1);
  assert.equal(calls.enqueued[0].type, ASYNC_JOB_TYPES.SALES_CORRECTION);
  assert.equal(calls.enqueued[0].jobId, 'sales_correction_job_key_1');
  assert.equal(calls.ran.length, 1);
  assert.equal(calls.corrected.length, 1);
  assert.equal(calls.corrected[0].options.actor.openId, 'ou_1');
  assert.equal(result.jobId, 'sales_correction_job_key_1');
  assert.match(result.redirect_url, /\/workbench/);
});

test('确认单异步：缺少 submitKey / details 时不入队', async () => {
  const service = createSalesCorrectionAsyncService({
    correctionService: { correct: async () => ({}) },
    asyncJobs: { enqueue: async () => ({ job: {}, created: true }), run: async () => {}, jobIdFor: () => 'j' },
  });
  await assert.rejects(service.submit({ payload: { details: [{ recordId: 'd1' }] } }), /submitKey/);
  await assert.rejects(service.submit({ payload: { submitKey: 'k', details: [] } }), /details/);
});
