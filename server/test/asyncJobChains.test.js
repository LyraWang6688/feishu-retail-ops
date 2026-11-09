'use strict';

/**
 * #948 **五条链路接入**判据（售后 / 销售 / 采购补货·退货·验收）。
 *
 * 每个用例都走**真实**的链路服务，只把"写库那一步"和"飞书发送"换成替身：
 *   AC-W1 售后：临时错误重试后成功（同一条 job）；永久错误不重试、最终失败**发一次**运营群
 *   AC-W2 销售：抛出 5xx 自动重试（**同一把 submitKey / 同一条 job**），重试**不重复加行**；
 *          永久错误只跑一次；partial_failed 也发群
 *   AC-W3 采购（补货/退货/验收共用件）：临时失败重试后成功（同一条 job、同一把幂等键）；
 *          业务拒绝不重试；最终失败发群（带批次号）
 */
// ⚠️ 必须在 require 业务模块**之前**设：`config/asyncJobs` 在模块加载时读 env。
process.env.ASYNC_JOB_RETRY_BASE_MS = '0';
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_async_job_chain_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'async_job_chain_test_secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ASYNC_JOB_TYPES, ASYNC_JOB_STATUS, buildAsyncJobsConfig,
} = require('../src/config/asyncJobs');
const { createAsyncJobStore } = require('../src/services/asyncJobStore');
const { createAsyncJobNotifier } = require('../src/services/asyncJobNotifier');
const { createAsyncJobService } = require('../src/services/asyncJobService');
const { createAfterSalesAsyncService } = require('../src/services/afterSalesAsyncService');
const { createSalesAsyncWorker } = require('../src/services/salesAsyncWorker');
const { createSalesJobStore } = require('../src/services/salesJobStore');
const { createAsyncJobPurchaseRunner } = require('../src/services/asyncJobPurchaseRunner');
const { createPurchaseWriteBackgroundService, waitForPendingPurchaseBackgrounds } = require('../src/services/purchaseWriteBackgroundService');

const tmpDir = (prefix = 'async-job-chain-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** 真统一层（临时目录 + 假发送器）；返回 `{ service, sent, logs }`。 */
const makeJobStack = ({ notifyEnabled = 'true', failNotify = false } = {}) => {
  const dir = tmpDir();
  const config = buildAsyncJobsConfig({
    ASYNC_JOBS_DIR: dir,
    ASYNC_JOB_RETRY_BASE_MS: '0',
    ASYNC_JOB_MAX_ATTEMPTS: '3',
    ASYNC_JOB_NOTIFY_ENABLED: notifyEnabled,
  });
  const sent = [];
  const logs = [];
  const logger = {
    logInfo: (event, fields) => logs.push({ level: 'info', event, fields: fields || {} }),
    logWarn: (event, fields) => logs.push({ level: 'warn', event, fields: fields || {} }),
    logError: (event, fields) => logs.push({ level: 'error', event, fields: fields || {} }),
  };
  const notifier = createAsyncJobNotifier({
    config,
    logger,
    notificationService: {
      send: async (event, data) => {
        if (failNotify) return { ok: false, reason: 'send_failed', error: 'network down' };
        sent.push({ event, data });
        return { ok: true, cardId: 'card_1', messageId: 'msg_1' };
      },
    },
  });
  const store = createAsyncJobStore({ dir });
  const service = createAsyncJobService({ config, store, notifier, logger, sleep: async () => undefined });
  return { service, store, sent, logs, logger, config };
};

const waitFor = async (fn, { timeoutMs = 3000, intervalMs = 5 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timeout');
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-W1 售后（#943 / #947）：重试 + 最终失败发运营群
// ═══════════════════════════════════════════════════════════════════════════

const makeAfterSales = ({ execute, stack }) => {
  const dir = tmpDir('after-sales-chain-');
  return createAfterSalesAsyncService({
    dir,
    execute,
    asyncJobs: stack.service,
    logger: stack.logger,
  });
};

test('AC-W1a 售后：临时错误（飞书 502）自动重试后成功 —— 同一条 job、不发群', async () => {
  const stack = makeJobStack();
  let calls = 0;
  const jobs = makeAfterSales({
    stack,
    execute: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('飞书 502'), { statusCode: 502 });
      return { ok: true, orderNo: 'XSD-1' };
    },
  });
  const requestId = crypto.randomUUID();
  const { job } = await jobs.enqueue({
    type: 'return', requestId, payload: { salesEntryOrderNo: 'XSD-20261108-0001' },
    ownerOpenId: 'ou_me', operatorName: '王颖',
  });
  const jobId = stack.service.jobIdFor(ASYNC_JOB_TYPES.AFTER_SALES, `return:${requestId}`);
  assert.equal(job.job_id, jobId, '售后 job 与统一 job **同一个 id**');
  await waitFor(async () => (await stack.service.get(jobId))?.status === ASYNC_JOB_STATUS.SUCCEEDED);
  const unified = await stack.service.get(jobId);
  assert.equal(unified.attempts, 2, '第 2 次尝试成功');
  assert.equal(stack.sent.length, 0, '成功不发群');
});

test('AC-W1b 售后：永久错误（400）不重试 ⇒ 最终失败**发一次**运营群（#947 的替代方案）', async () => {
  const stack = makeJobStack();
  let calls = 0;
  const jobs = makeAfterSales({
    stack,
    execute: async () => { calls += 1; throw Object.assign(new Error('这条明细当前状态不能退货'), { statusCode: 400 }); },
  });
  const requestId = crypto.randomUUID();
  await jobs.enqueue({
    type: 'return', requestId, payload: { salesEntryOrderNo: 'XSD-20261108-0002' },
    ownerOpenId: 'ou_me', operatorName: '王颖',
  });
  const jobId = stack.service.jobIdFor(ASYNC_JOB_TYPES.AFTER_SALES, `return:${requestId}`);
  await waitFor(async () => (await stack.service.get(jobId))?.status === ASYNC_JOB_STATUS.FAILED);
  // 状态先落 failed、通知随后才发；等通知完成再断言（避免 CI 负载下抢跑）
  await waitFor(() => stack.sent.length === 1);
  assert.equal(calls, 1, '永久错误不重试');
  assert.equal(stack.sent.length, 1, '最终失败发一次运营群');
  const text = stack.sent[0].data.lines.join('\n');
  assert.match(stack.sent[0].data.title, /异步写入失败/);
  assert.match(text, /售后退货/);
  assert.match(text, /XSD-20261108-0002/);
  assert.match(text, /操作人：王颖/);
  assert.match(text, /不能退货/);
});

test('AC-W1c 售后：通知发送失败 ⇒ 任务仍是 failed、notified_at 空、日志留痕（可后续重试）', async () => {
  // 真 notifier + "发送必失败"的 sender：验证通知失败**不改变业务任务状态**
  const stack = makeJobStack({ failNotify: true });
  const service = stack.service;
  const jobs = makeAfterSales({ stack, execute: async () => { throw new Error('飞书 500'); } });
  const requestId = crypto.randomUUID();
  await jobs.enqueue({ type: 'return', requestId, payload: {}, ownerOpenId: 'ou_me' });
  const jobId = service.jobIdFor(ASYNC_JOB_TYPES.AFTER_SALES, `return:${requestId}`);
  await waitFor(async () => (await service.get(jobId))?.status === ASYNC_JOB_STATUS.FAILED);
  // 通知失败日志同样在 failed 之后异步落；等日志出现再断言
  await waitFor(() => stack.logs.some((entry) => entry.event === 'async_job.notify.failed'));
  const job = await service.get(jobId);
  assert.equal(job.status, ASYNC_JOB_STATUS.FAILED);
  assert.equal(job.notified_at, '');
  assert.ok(stack.logs.some((entry) => entry.event === 'async_job.notify.failed'));
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-W2 销售：重试（同一把 submitKey）+ 重试不重复加行 + partial 不发群
// ═══════════════════════════════════════════════════════════════════════════

const salePayload = () => ({
  open_id: 'ou_scan_user', order_no: 'XSD-20261108-0003', gift: '',
  lines: [
    { product_record_id: 'p1', size: 41, trade_type: 'SALE_CASH', actual_amount: 99, number: 'p1|黑|男', item_no: 'p1', color: '黑' },
    { product_record_id: 'p2', size: 42, trade_type: 'SALE_CASH', actual_amount: 88, number: 'p2|黑|男', item_no: 'p2', color: '黑' },
  ],
  payments: [{ method: '微信扫码', amount: 187 }],
  ...{ derived: { paid_amount: 187, owed_amount: 0 } },
});

const makeSalesWorker = ({ stack, submitSale }) => {
  const dir = tmpDir('sales-chain-');
  const jobStore = createSalesJobStore({ dir });
  const adds = [];
  const submits = [];
  const sessions = {
    clearSale: async () => { adds.length = 0; return { ok: true }; },
    addLine: async (_openId, line) => { adds.push(line); return { ok: true }; },
    saveSaleProgress: async () => undefined,
  };
  const gateway = {
    table: () => ({ fields: { orderNo: '销售单号' } }),
    listByFilter: async () => [],
    create: async () => ({ recordId: 'main_1' }),
  };
  const writeService = {
    sessions,
    submitSale: async (input) => {
      submits.push(input);
      return submitSale(input, submits.length);
    },
  };
  const worker = createSalesAsyncWorker({
    gateway, writeService, jobStore, asyncJobs: stack.service, logger: stack.logger,
  });
  return { worker, jobStore, adds, submits, writeService };
};

test('AC-W2a 销售：飞书 502 自动重试（同一把 submitKey / 同一条 job），重试不重复加行', async () => {
  const stack = makeJobStack();
  const h = makeSalesWorker({
    stack,
    submitSale: async (_input, attempt) => {
      if (attempt === 1) throw Object.assign(new Error('Request failed with status code 502'), { statusCode: 502 });
      return { ok: true, order_no: 'XSD-20261108-0003', stock: { failed: 0 } };
    },
  });
  const { job } = await h.worker.enqueue({ submitKey: 'scan_sale:sess:1', payload: salePayload() });
  await h.worker.process(job.job_id);
  const chainJob = await h.jobStore.get(job.job_id);
  assert.equal(chainJob.status, 'succeeded');
  assert.equal(h.submits.length, 2, '重试了一次');
  assert.equal(new Set(h.submits.map((input) => input.submitKey)).size, 1, '🔴 重试复用同一把 submitKey');
  assert.equal(h.adds.length, 2, '重试不重复加行（先清空再按冻结 payload 重加）');
  const unified = await stack.service.get(job.job_id);
  assert.equal(unified.type, ASYNC_JOB_TYPES.SALES);
  assert.equal(unified.status, ASYNC_JOB_STATUS.SUCCEEDED);
  assert.equal(unified.owner_open_id, 'ou_scan_user', 'owner = 扫码人（状态接口"只能查自己的"）');
  assert.equal(stack.sent.length, 0);
});

test('AC-W2b 销售：永久错误（400）只跑一次 ⇒ failed + 发一次群', async () => {
  const stack = makeJobStack();
  const h = makeSalesWorker({
    stack,
    submitSale: async () => { throw Object.assign(new Error('参数错误：金额不合法'), { statusCode: 400 }); },
  });
  const { job } = await h.worker.enqueue({ submitKey: 'scan_sale:sess:2', payload: salePayload() });
  await h.worker.process(job.job_id);
  assert.equal(h.submits.length, 1, '永久错误不重试');
  assert.equal((await h.jobStore.get(job.job_id)).status, 'failed');
  assert.equal(stack.sent.length, 1, '最终失败发群');
  assert.match(stack.sent[0].data.lines.join('\n'), /销售提交/);
  assert.match(stack.sent[0].data.lines.join('\n'), /XSD-20261108-0003/);
});

test('AC-W2c 销售：partial_failed ⇒ 终态、也发群', async () => {
  const stack = makeJobStack();
  const h = makeSalesWorker({
    stack,
    submitSale: async () => ({ ok: true, order_no: 'XSD-20261108-0004', stock: { failed: 1 }, message: '库存没扣成' }),
  });
  const { job } = await h.worker.enqueue({ submitKey: 'scan_sale:sess:3', payload: salePayload() });
  await h.worker.process(job.job_id);
  assert.equal((await h.jobStore.get(job.job_id)).status, 'partial_failed');
  const unified = await stack.service.get(job.job_id);
  assert.equal(unified.status, ASYNC_JOB_STATUS.PARTIAL_FAILED);
  assert.equal(stack.sent.length, 1, 'partial_failed 也发群');
  assert.equal(stack.sent[0].event, 'async_job_failed');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-W3 采购三条链路（补货 / 退货 / 验收）—— 同一个后台件 + 适配器
// ═══════════════════════════════════════════════════════════════════════════

const makePurchase = ({ stack, runRest }) => {
  const marks = [];
  const calls = [];
  const jobRunner = createAsyncJobPurchaseRunner({ asyncJob: stack.service });
  const background = createPurchaseWriteBackgroundService({
    runRest: async (input) => { calls.push(input); return runRest(input, calls.length); },
    markFailed: async (input) => { marks.push(input); },
    config: { events: {} },
    jobRunner,
  });
  return { background, marks, calls };
};

test('AC-W3a 采购：临时失败（5xx）自动重试后成功 —— 同一条 job、同一把 submitKey、发群 0 次', async () => {
  const stack = makeJobStack();
  const h = makePurchase({
    stack,
    runRest: async (_input, attempt) => (attempt === 1
      ? { ok: false, message: 'Request failed with status code 503' }
      : { ok: true, batch_no: 'CGD-20261108-1000' }),
  });
  await h.background.schedulePurchaseRest({
    chain: 'accept', requestId: 'req_accept_1', submitKey: 'accept:sess:1',
    context: { openId: 'ou_ops' },
    jobMeta: { ownerOpenId: 'ou_ops', operatorName: '王颖', batchNo: 'CGD-20261108-1000', step: '采购验收写库' },
  });
  assert.equal(h.calls.length, 2, '重试了一次');
  assert.deepEqual(h.calls.map((call) => call.submitKey), ['accept:sess:1', 'accept:sess:1'], '幂等键原样复用');
  const jobs = await stack.store.list();
  assert.equal(jobs.length, 1, '同一条统一 job');
  assert.equal(jobs[0].type, ASYNC_JOB_TYPES.PURCHASE_ACCEPTANCE);
  assert.equal(jobs[0].status, ASYNC_JOB_STATUS.SUCCEEDED);
  assert.equal(jobs[0].owner_open_id, 'ou_ops');
  assert.equal(stack.sent.length, 0, '成功不发群');
});

test('AC-W3b 采购：业务拒绝不重试 ⇒ 只跑一次 + failed + 发群（带批次号 / 类型）', async () => {
  const stack = makeJobStack();
  const h = makePurchase({ stack, runRest: async () => ({ ok: false, code: 'not_in_batch', message: '这批里没有这一款' }) });
  await h.background.schedulePurchaseRest({
    chain: 'purchase_return', requestId: 'req_return_1', submitKey: 'purchase_return:sess:1',
    context: { openId: 'ou_ops' },
    jobMeta: {
      ownerOpenId: 'ou_ops', operatorName: '王颖', batchNo: 'CGD-20261108-1001', step: '扫码采购退货写库',
    },
  });
  assert.equal(h.calls.length, 1, '业务拒绝不重试');
  assert.equal(h.marks.length, 1, 'markFailed 仍被调用（会话可查可重试）');
  const jobs = await stack.store.list();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].type, ASYNC_JOB_TYPES.PURCHASE_RETURN);
  assert.equal(jobs[0].status, ASYNC_JOB_STATUS.FAILED);
  assert.equal(stack.sent.length, 1, '最终失败发一次群');
  assert.match(stack.sent[0].data.lines.join('\n'), /采购退货/);
  assert.match(stack.sent[0].data.lines.join('\n'), /CGD-20261108-1001/);
  assert.match(stack.sent[0].data.lines.join('\n'), /操作人：王颖/);
});

test('AC-W3c 采购：补货链同样接入（三条链路同一个适配器/后台件）', async () => {
  const stack = makeJobStack();
  const h = makePurchase({ stack, runRest: async () => ({ ok: true }) });
  await h.background.schedulePurchaseRest({
    chain: 'replenish', requestId: 'req_rep_1', submitKey: 'replenish:sess:1',
    context: { openId: 'ou_ops' }, jobMeta: { ownerOpenId: 'ou_ops', step: '扫码补货写库' },
  });
  await waitForPendingPurchaseBackgrounds();
  const jobs = await stack.store.list();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].type, ASYNC_JOB_TYPES.PURCHASE_REPLENISH);
  assert.equal(jobs[0].status, ASYNC_JOB_STATUS.SUCCEEDED);
});

test('AC-W3d 采购：没有稳定键（submitKey / requestId 都空）⇒ 不建统一 job，但写库照跑一次（不吞）', async () => {
  const stack = makeJobStack();
  const h = makePurchase({ stack, runRest: async () => ({ ok: true }) });
  await h.background.schedulePurchaseRest({ chain: 'accept', requestId: '', submitKey: '', context: {} });
  assert.equal(h.calls.length, 1);
  assert.equal((await stack.store.list()).length, 0, '没有稳定键 ⇒ 不建 job（避免重试变成新任务）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-W4 工作台【确认到货】路由真的接上了统一任务（#944 F3：后台失败 → 发运营群）
//   —— 与 AC-W3 的区别：这里打的是**真实路由**（含 owner / batch_no / 操作人 的接线）。
// ═══════════════════════════════════════════════════════════════════════════

test('AC-W4 工作台验收路由：后台失败 ⇒ 统一 job(type=purchase_acceptance) + 发群（批次/操作人）', async () => {
  const cryptoMod = require('node:crypto');
  const express = require('express');
  const SESSION_SECRET = 'async-job-chains-workbench-secret';
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
  const { createWorkbenchRouter } = require('../src/routes/workbench');
  const arrivalTab = require('../src/config/workbenchArrival');

  const stack = makeJobStack();
  const stackService = stack.service;
  const session = {
    session_id: 'sess-1', batch_no: 'CGD-20261108-1002', status: 'open', submit_round: 1,
    scans: [{ product_record_id: 'p1', size: 40, quantity: 1 }], last_error: '',
  };
  const arrival = {
    start: async () => ({ ok: true, session }),
    setScans: async () => ({ ok: true, session }),
    get: async () => session,
    submitKeyOf: (value) => `accept:${value?.session_id}:${Number(value?.submit_round || 0)}`,
    store: { update: async () => ({}) },
    // 后台写库失败（业务拒绝）⇒ 必须进统一失败通知，而不是"页面看不见"
    finish: async () => ({ ok: false, code: 'not_in_batch', message: '这批里没有这一款' }),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/workbench', createWorkbenchRouter({
    gateway: {}, purchaseQuery: { listPurchaseRequests: async () => [{ report_behavior: 'purchase_request' }] },
    arrival, asyncJobs: stackService,
  }));
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  server.keepAliveTimeout = 1;
  try {
    const payload = Buffer.from(JSON.stringify({
      open_id: 'ou_accept', name: '验收员', exp: Date.now() + 3600 * 1000,
    })).toString('base64url');
    const cookie = `workbench_session=${payload}.${cryptoMod.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')}`;
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/workbench${arrivalTab.api.accept}`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batchNo: 'CGD-20261108-1002',
        actualAmount: '300',
        lines: [{ productRecordId: 'p1', size: 40, quantity: 1 }],
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, '先回成功回执（后台写库是异步的）');
    assert.equal(body.accepted, true);
    await waitForPendingPurchaseBackgrounds();
    const jobs = await stack.store.list();
    assert.equal(jobs.length, 1, '验收链路也建统一 job');
    assert.equal(jobs[0].type, ASYNC_JOB_TYPES.PURCHASE_ACCEPTANCE);
    assert.equal(jobs[0].owner_open_id, 'ou_accept', 'owner = 当前登录人（状态接口只能查自己的）');
    assert.equal(jobs[0].meta.batch_no, 'CGD-20261108-1002');
    assert.equal(jobs[0].meta.order_no, '');
    assert.equal(jobs[0].status, ASYNC_JOB_STATUS.FAILED);
    assert.equal(stack.sent.length, 1, '后台失败 ⇒ 发一次运营群');
    assert.match(stack.sent[0].data.lines.join('\n'), /采购验收/);
    assert.match(stack.sent[0].data.lines.join('\n'), /CGD-20261108-1002/);
    assert.match(stack.sent[0].data.lines.join('\n'), /操作人：验收员/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
