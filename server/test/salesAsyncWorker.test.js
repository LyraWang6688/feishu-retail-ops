'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSalesAsyncWorker } = require('../src/services/salesAsyncWorker');
const { createSalesJobStore, STATUS } = require('../src/services/salesJobStore');

const make = ({ fail = false } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-async-'));
  const calls = { create: 0, submit: 0, lines: [] };
  const gateway = {
    table: () => ({ fields: { orderNo: '销售单号' } }),
    listByFilter: async () => [],
    create: async () => { calls.create += 1; return { recordId: 'main_1' }; },
  };
  const sessions = {
    addLine: async (openId, line) => { calls.lines.push({ openId, ...line }); return { ok: true, session: { sale: { lines: calls.lines } } }; },
    saveSaleProgress: async () => undefined,
  };
  const writeService = {
    sessions,
    submitSale: async (input) => {
      calls.submit += 1;
      if (fail) throw new Error('boom');
      return { ok: true, order_no: input.openId ? 'XSD-20261026-0001' : '', stock: { failed: 0 } };
    },
  };
  const jobStore = createSalesJobStore({ dir });
  const worker = createSalesAsyncWorker({ gateway, writeService, jobStore, logger: { logInfo() {}, logWarn() {}, logError() {} } });
  return { dir, worker, jobStore, calls, writeService, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

const payload = (over = {}) => ({
  open_id: 'ou_1', order_no: 'XSD-20261026-0001', gift: '',
  lines: [{ product_record_id: 'p1', size: 41, trade_type: 'SALE_CASH', actual_amount: 99, number: 'p|黑|A', item_no: 'p', color: '黑' }],
  payments: [{ method: '微信扫码', amount: 99 }],
  ...over,
});

test('同一 submit_key 只建一个 job；worker 写成功后状态 succeeded', async () => {
  const h = make();
  try {
    const a = await h.worker.enqueue({ submitKey: 'scan_sale:s:1', payload: payload() });
    const b = await h.worker.enqueue({ submitKey: 'scan_sale:s:1', payload: payload() });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.job.job_id, b.job.job_id);
    const done = await h.worker.process(a.job.job_id);
    assert.equal(done.status, STATUS.succeeded);
    assert.equal(h.calls.create, 1);
    assert.equal(h.calls.submit, 1);
    assert.equal(h.calls.lines.length, 1);
    assert.equal(h.calls.lines[0].trade_type_code, 'SALE_CASH');
  } finally { h.cleanup(); }
});

test('worker 写失败 ⇒ 状态 failed，并保留错误', async () => {
  const h = make({ fail: true });
  try {
    const a = await h.worker.enqueue({ submitKey: 'scan_sale:s:2', payload: payload() });
    const done = await h.worker.process(a.job.job_id);
    assert.equal(done.status, STATUS.failed);
    assert.match(done.last_error, /boom/);
  } finally { h.cleanup(); }
});

test('新 worker 启动后能续跑同一个 queued job，不重复写', async () => {
  const h = make();
  try {
    // 直接写一条 queued job（模拟进程在入队后、worker 启动前退出）
    await h.jobStore.store.create({
      job_id: 'sale_job_restart_1',
      submit_key: 'scan_sale:s:3',
      status: STATUS.queued,
      payload: payload(),
      attempts: 0,
      last_error: '',
      main_record_id: '',
      order_no: 'XSD-20261026-0001',
    });
    // 新进程：同一个 job store，新 worker
    const gateway2 = {
      table: () => ({ fields: { orderNo: '销售单号' } }),
      listByFilter: async () => [],
      create: async () => ({ recordId: 'main_1' }),
    };
    const worker2 = createSalesAsyncWorker({
      gateway: gateway2,
      writeService: h.writeService,
      jobStore: h.jobStore,
      logger: { logInfo() {}, logWarn() {}, logError() {} },
    });
    await worker2.start();
    for (let i = 0; i < 50; i += 1) {
      const current = await h.jobStore.get('sale_job_restart_1');
      if (current.status === STATUS.succeeded) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const done = await h.jobStore.get('sale_job_restart_1');
    assert.equal(done.status, STATUS.succeeded);
    assert.equal(h.calls.submit, 1);
  } finally { h.cleanup(); }
});
