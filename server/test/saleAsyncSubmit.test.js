'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { enqueueSaleAsync } = require('../src/services/scanWrite/saleAsyncSubmit');

const line = (overrides = {}) => ({
  productRecordId: 'prod_1',
  size: 40,
  tradeTypeCode: 'SALE_CASH',
  actualAmount: 0,
  number: '6606-373|黑色|女',
  itemNo: '6606-373',
  color: '黑色',
  kind: 'shoe',
  ...overrides,
});

test('AC-ZERO-ASYNC1 0 元单入队：payments=[]、completeSale 轮换键、不写收款', async () => {
  const calls = [];
  const complete = [];
  const salesAsync = {
    async enqueue(input) {
      calls.push(input);
      return { ok: true, created: true, job: { job_id: 'sale_job_zero_1' } };
    },
  };
  const writeService = {
    sessions: {
      async completeSale(openId, input) { complete.push({ openId, input }); },
    },
  };
  const out = await enqueueSaleAsync({
    salesAsync, writeService, openId: 'ou_test', submitKey: 'scan_sale:test:1',
    orderNo: 'XSD-20261118-0009', gift: '', lines: [line()], payments: [],
    printProducts: [], requestId: 'req_zero_1',
  });
  assert.equal(out.ok, true);
  assert.equal(out.jobId, 'sale_job_zero_1');
  assert.equal(out.printPromptUrl, '');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].payload.payments, [], '0 元单不写任何收款明细');
  assert.equal(calls[0].payload.lines.length, 1);
  assert.equal(calls[0].payload.lines[0].actual_amount, 0);
  assert.equal(calls[0].payload.derived.total_amount, 0);
  assert.equal(calls[0].payload.derived.owed_amount, 0);
  assert.deepEqual(complete, [{ openId: 'ou_test', input: { key: 'scan_sale:test:1', result: { job_id: 'sale_job_zero_1', order_no: 'XSD-20261118-0009' } } }]);
});

test('AC-ZERO-ASYNC2 入队失败 ⇒ 如实返回失败，不假装成功', async () => {
  const out = await enqueueSaleAsync({
    salesAsync: { async enqueue() { return { ok: false, errors: [{ code: 'queue_full' }] }; } },
    writeService: { sessions: { async completeSale() { throw new Error('不该走到这里'); } } },
    openId: 'ou_test', submitKey: 'scan_sale:test:2', orderNo: 'XSD-20261118-0010',
    lines: [line()], payments: [], printProducts: [], requestId: 'req_zero_2',
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 500);
  assert.equal(out.code, 'enqueue_failed');
});
