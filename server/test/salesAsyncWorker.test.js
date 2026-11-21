'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSalesAsyncWorker } = require('../src/services/salesAsyncWorker');
const { createSalesJobStore, STATUS } = require('../src/services/salesJobStore');
const waitFor = async (fn, { timeoutMs = 2000, intervalMs = 10 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await fn()) return true; await new Promise((r) => setTimeout(r, intervalMs)); }
  throw new Error('waitFor timeout');
};

const make = ({ fail = false, onSettled = null, samplePromotion = null, stock = null } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-async-'));
  const calls = { create: 0, submit: 0, lines: [], createOptions: null, submitOptions: null, submitInput: null };
  const gateway = {
    table: () => ({ fields: { orderNo: '销售单号' } }),
    listByFilter: async () => [],
    create: async (_table, _fields, options) => { calls.create += 1; calls.createOptions = options; return { recordId: 'main_1' }; },
  };
  const sessions = {
    addLine: async (openId, line) => { calls.lines.push({ openId, ...line }); return { ok: true, session: { sale: { lines: calls.lines } } }; },
    saveSaleProgress: async () => undefined,
  };
  const writeService = {
    sessions,
    submitSale: async (input, options) => {
      calls.submit += 1;
      calls.submitInput = input;
      calls.submitOptions = options;
      if (fail) throw new Error('boom');
      return { ok: true, order_no: input.openId ? 'XSD-20261026-0001' : '', stock: stock || { failed: 0 } };
    },
  };
  const jobStore = createSalesJobStore({ dir });
  const worker = createSalesAsyncWorker({
    gateway, writeService, jobStore, onSettled, samplePromotion,
    logger: { logInfo() {}, logWarn() {}, logError() {} },
  });
  return { dir, worker, jobStore, gateway, calls, writeService, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

const payload = (over = {}) => ({
  open_id: 'ou_1', order_no: 'XSD-20261026-0001', gift: '',
  lines: [{ product_record_id: 'p1', size: 41, trade_type: 'SALE_CASH', actual_amount: 99, number: 'p|黑|男', item_no: 'p', color: '黑' }],
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

test('配品透传：worker 调 submitSale 时带上配品文本 / 金额', async () => {
  const h = make();
  try {
    const a = await h.worker.enqueue({
      submitKey: 'scan_sale:s:accessory',
      payload: payload({
        accessory: '39元腰带×2',
        accessory_total: 87.9,
        payments: [{ method: '微信扫码', amount: 186.9 }],
      }),
    });
    await h.worker.process(a.job.job_id);
    assert.equal(h.calls.submitInput.orderAccessory, '39元腰带×2');
    assert.equal(h.calls.submitInput.orderAccessoryTotalCents, 8790);
  } finally { h.cleanup(); }
});

test('⭐ 2026-11-17：销售成功收口后调用 onSettled（打印意图 flush 的挂点）；失败不调用', async () => {
  const seen = [];
  const h = make({ onSettled: async (input) => { seen.push(input); } });
  try {
    const ok = await h.worker.enqueue({ submitKey: 'scan_sale:s:settled', payload: payload() });
    await h.worker.process(ok.job.job_id);
    assert.equal(seen.length, 1, '成功后调用一次');
    assert.equal(seen[0].jobId, ok.job.job_id);

    const bad = make({ fail: true, onSettled: async (input) => { seen.push(input); } });
    try {
      const failed = await bad.worker.enqueue({ submitKey: 'scan_sale:s:failed', payload: payload() });
      await bad.worker.process(failed.job.job_id);
      assert.equal(seen.length, 1, '失败不调用 onSettled');
    } finally { bad.cleanup(); }
  } finally { h.cleanup(); }
});

test('异步任务保存 tap_id，建主表 / submitSale 都带 correlation', async () => {
  const h = make();
  try {
    const a = await h.worker.enqueue({ submitKey: 'scan_sale:s:tap', payload: payload(), tapId: 'tap-e2e-1' });
    assert.equal(a.job.tap_id, 'tap-e2e-1');
    await h.worker.process(a.job.job_id);
    assert.deepEqual(h.calls.submitOptions.correlation, { task_id: a.job.job_id, tap_id: 'tap-e2e-1' });
    assert.deepEqual(h.calls.createOptions.correlation, { task_id: a.job.job_id, tap_id: 'tap-e2e-1' });
  } finally { h.cleanup(); }
});

test('AC-JOB-KEY ⭐ 同 submit_key 但订单号不同 ⇒ 建新 job，不复用旧 job', async () => {
  const h = make();
  try {
    const first = await h.worker.enqueue({ submitKey: 'scan_sale:s:1', payload: payload({ order_no: 'XSD-20261109-0004' }) });
    await h.worker.process(first.job.job_id);
    const second = await h.worker.enqueue({ submitKey: 'scan_sale:s:1', payload: payload({ order_no: 'XSD-20261110-0001' }) });
    assert.equal(second.created, true, '新订单必须建新 job');
    assert.notEqual(second.job.job_id, first.job.job_id, 'job id 不能撞旧订单');
    assert.equal(second.job.payload.order_no, 'XSD-20261110-0001');
  } finally { h.cleanup(); }
});

test('升级前旧 job 没 tap_id：入队同键时补元数据，不覆盖 payload', async () => {
  const h = make();
  try {
    const legacyId = h.jobStore.jobIdOf('scan_sale:s:legacy');
    await h.jobStore.store.create({
      job_id: legacyId, submit_key: 'scan_sale:s:legacy', status: STATUS.queued,
      payload: payload(), attempts: 0, last_error: '', main_record_id: '', order_no: 'XSD-20261026-0001',
    });
    const out = await h.worker.enqueue({ submitKey: 'scan_sale:s:legacy', payload: payload(), tapId: 'tap-legacy' });
    assert.equal(out.created, false);
    assert.equal(out.job.job_id, legacyId);
    assert.equal(out.job.tap_id, 'tap-legacy');
    assert.equal(out.job.payload.order_no, 'XSD-20261026-0001');
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

test('worker 全局队列：连续入队 3 个 job，同时只跑 1 个，按 FIFO 完成', async () => {
  const h = make();
  try {
    let active = 0;
    let maxActive = 0;
    const order = [];
    h.writeService.submitSale = async (input) => {
      active += 1; maxActive = Math.max(maxActive, active);
      order.push(input.openId);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { ok: true, order_no: 'XSD-20261026-0001', stock: { failed: 0 } };
    };
    const jobs = [];
    for (const key of ['scan_sale:s:q1', 'scan_sale:s:q2', 'scan_sale:s:q3']) {
      jobs.push((await h.worker.enqueue({ submitKey: key, payload: payload() })).job);
    }
    await waitFor(async () => {
      const rows = await Promise.all(jobs.map((job) => h.jobStore.get(job.job_id)));
      return rows.every((row) => row.status === STATUS.succeeded);
    }, { timeoutMs: 5000 });
    assert.equal(maxActive, 1, '同一时间只能有一个 worker 任务写飞书');
    assert.equal(order.length, 3);
  } finally { h.cleanup(); }
});

test('#891 主表查询失败 ⇒ 不得新建主表，job 记 failed（不把失败当“没有”）', async () => {
  const h = make();
  try {
    h.gateway.listByFilter = async () => { throw new Error('listByFilter timeout'); };
    const a = await h.worker.enqueue({ submitKey: 'scan_sale:query-fail:1', payload: payload() });
    const done = await h.worker.process(a.job.job_id);
    assert.equal(done.status, STATUS.failed);
    assert.match(done.last_error, /listByFilter timeout/);
    assert.equal(h.calls.create, 0, '查询失败不得调用 create');
    assert.equal(h.calls.submit, 0, '不得继续提交');
  } finally { h.cleanup(); }
});
test('2026-11-18：销售成功后按 sampleReplacements 补样品；补样品失败不影响销售', async () => {
  const promoted = [];
  const samplePromotion = {
    async promote(input) { promoted.push(input); return { ok: true }; },
  };
  const h = make({
    samplePromotion,
    stock: {
      failed: 0,
      sampleReplacements: [{
        salesDetailRecordId: 'd1', salesEntryRecordId: 's1', productRecordId: 'p1', sampleConsumedQuantity: 1,
        samplePromotionSize: '41',
      }],
    },
  });
  try {
    const samplePayload = payload();
    samplePayload.lines[0].samplePromotionSize = '41';
    const a = await h.worker.enqueue({ submitKey: 'scan_sale:s:sample', payload: samplePayload });
    const done = await h.worker.process(a.job.job_id);
    assert.equal(done.status, STATUS.succeeded);
    assert.equal(h.calls.lines[0].sample_promotion_size, '41',
      'payload 里的选择要按会话行字段 sample_promotion_size 落盘');
    assert.equal(h.calls.lines[0].samplePromotionSize, undefined,
      '不再写驼峰字段（写驼峰会让交付侧读不到，补样品静默跳过）');
    assert.deepEqual(promoted, [{
      productRecordId: 'p1', size: '41', salesDetailRecordId: 'd1', salesEntryRecordId: 's1',
      operatorOpenId: 'ou_1', requestId: a.job.job_id,
    }]);

    const failing = make({
      samplePromotion: { async promote() { throw new Error('promotion boom'); } },
      stock: { failed: 0, sampleReplacements: [{ salesDetailRecordId: 'd1', productRecordId: 'p1', samplePromotionSize: '41' }] },
    });
    try {
      const b = await failing.worker.enqueue({ submitKey: 'scan_sale:s:sample-fail', payload: payload() });
      const result = await failing.worker.process(b.job.job_id);
      assert.equal(result.status, STATUS.succeeded, '补样品失败不能把销售改成失败');
    } finally { failing.cleanup(); }
  } finally { h.cleanup(); }
});
