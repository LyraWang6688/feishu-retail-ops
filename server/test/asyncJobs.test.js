'use strict';

/**
 * #948 统一异步任务：**存储 / 状态机 / 重试 / 失败通知 / 只读视图**（单测，不碰网络、不写仓库 data/）。
 *
 * 覆盖（对照 `docs/async-job-status-and-failure-notification-2026-11-08.md` 第 11 节）：
 *   AC-J1 状态流转 queued → running → succeeded / failed（attempts / finished_at 落盘）
 *   AC-J2 重试：临时错误重试；永久错误（400 / 字段不存在 / 权限 / 参数 / 业务拒绝）不重试
 *   AC-J3 幂等：同一把键重放 = **同一条 job**（不新建任务）；重试复用同一条
 *   AC-J4 通知：最终失败发一次；同 job 不重复发；发送失败可重试（`notified_at` 只在成功时写）
 *   AC-J5 群未配置 ⇒ 记 `async_job.notify.chat_missing`（**不静默成功**）
 *   AC-J6 文案：类型/单号/操作人/失败步骤/错误/任务ID/时间（上海时间），**不发 payload**
 *   AC-J7 只读视图：只能查自己的；不返回 payload
 *   AC-J8 partial_failed 是终态但**不**发群（文档 6.1 只认 failed）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ASYNC_JOB_STATUS, ASYNC_JOB_TYPES, buildAsyncJobsConfig,
} = require('../src/config/asyncJobs');
const { createAsyncJobStore, jobIdFor } = require('../src/services/asyncJobStore');
const { createAsyncJobNotifier, renderAsyncJobFailureMessage, formatShanghaiTime } = require('../src/services/asyncJobNotifier');
const { createAsyncJobService, publicJobView } = require('../src/services/asyncJobService');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'async-jobs-test-'));

/** 收集日志（不依赖全局 logger；用例并行/串行都不会互相污染）。 */
const collectLogs = () => {
  const logs = [];
  const logger = {
    logInfo: (event, fields) => logs.push({ level: 'info', event, fields: fields || {} }),
    logWarn: (event, fields) => logs.push({ level: 'warn', event, fields: fields || {} }),
  };
  return { logs, logger, events: () => logs.map((entry) => entry.event) };
};

const makeConfig = (over = {}) => buildAsyncJobsConfig({
  ASYNC_JOBS_DIR: tmpDir(),
  ASYNC_JOB_MAX_ATTEMPTS: '3',
  ASYNC_JOB_RETRY_BASE_MS: '0',
  ASYNC_JOB_NOTIFY_ENABLED: 'true',
  ...over,
});

const makeService = ({ over = {}, notificationService, senderLog } = {}) => {
  const config = makeConfig(over);
  const { logs, logger } = collectLogs();
  const sent = [];
  const cards = notificationService || {
    send: async (event, data) => {
      sent.push({ event, ...data });
      if (senderLog) senderLog.push({ event, ...data });
      return { ok: true, cardId: 'card_1', messageId: 'msg_1' };
    },
  };
  const notifier = createAsyncJobNotifier({ config, logger, notificationService: cards });
  const store = createAsyncJobStore({ dir: config.jobsDir });
  const sleeps = [];
  const service = createAsyncJobService({
    config,
    store,
    notifier,
    logger,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  return { config, store, service, notifier, sent, logs, logger, sleeps };
};

const enqueueJob = async (h, { key = 'key_1', type = ASYNC_JOB_TYPES.PURCHASE_REPLENISH, owner = 'ou_owner', meta = {} } = {}) => {
  const jobId = h.service.jobIdFor(type, key);
  const out = await h.service.enqueue({
    jobId,
    type,
    payload: { note: 'frozen payload' },
    ownerOpenId: owner,
    operatorName: '王颖',
    meta: { order_no: 'CGD-20261108-0001', step: '采购补货写库', ...meta },
  });
  return { jobId, ...out };
};

// ── AC-J1 状态流转 ─────────────────────────────────────────────────────────
test('AC-J1 成功：queued → running → succeeded（attempts / finished_at 落盘，重试不新建任务）', async () => {
  const h = makeService();
  const { jobId, job } = await enqueueJob(h);
  assert.equal(job.status, ASYNC_JOB_STATUS.QUEUED);
  const done = await h.service.run({ jobId, run: async () => ({ ok: true, order_no: 'CGD-1' }) });
  assert.equal(done.status, ASYNC_JOB_STATUS.SUCCEEDED);
  assert.equal(done.attempts, 1);
  assert.ok(done.started_at && done.finished_at, 'started_at / finished_at 都要有');
  assert.deepEqual(done.result, { ok: true, order_no: 'CGD-1' });
  assert.equal((await h.store.list()).length, 1, '同一条 job（没有新建第二条）');
});

test('AC-J1b 失败：queued → running → failed（attempts = 用尽次数，last_error 保留）', async () => {
  const h = makeService();
  const { jobId } = await enqueueJob(h);
  const done = await h.service.run({ jobId, run: async () => { throw new Error('飞书 500'); } });
  assert.equal(done.status, ASYNC_JOB_STATUS.FAILED);
  assert.equal(done.attempts, 3, '次数 = ASYNC_JOB_MAX_ATTEMPTS');
  assert.match(done.last_error, /飞书 500/);
  assert.ok(done.finished_at);
});

// ── AC-J2 临时 / 永久错误 ─────────────────────────────────────────────────
test('AC-J2 临时错误（飞书 502）自动重试；重试复用同一条 job，成功后 attempts=2', async () => {
  const h = makeService();
  const { jobId } = await enqueueJob(h);
  let calls = 0;
  const done = await h.service.run({
    jobId,
    run: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('Request failed with status code 502'), { statusCode: 502 });
      return { ok: true };
    },
  });
  assert.equal(calls, 2, '临时错误重试了一次');
  assert.equal(done.status, ASYNC_JOB_STATUS.SUCCEEDED);
  assert.equal(done.attempts, 2);
  assert.equal((await h.store.list()).length, 1);
});

test('AC-J2b 永久错误（400 / 字段不存在 / 权限 / 参数）**不重试**', async () => {
  const cases = [
    Object.assign(new Error('Invalid request'), { statusCode: 400 }),
    new Error('飞书字段不存在：收款时间'),
    Object.assign(new Error('Access denied (Code: 99991672)'), { code: 99991672 }),
    new Error('参数错误：尺码不合法'),
  ];
  for (const error of cases) {
    const h = makeService();
    const { jobId } = await enqueueJob(h);
    let calls = 0;
    const done = await h.service.run({ jobId, run: async () => { calls += 1; throw error; } });
    assert.equal(calls, 1, `${error.message} ⇒ 只跑一次（不重试）`);
    assert.equal(done.status, ASYNC_JOB_STATUS.FAILED);
  }
});

test('AC-J2b2 飞书 400 + code=1254607（Data not ready）⇒ 属临时错误，必须重试', async () => {
  const h = makeService();
  const { jobId } = await enqueueJob(h);
  let calls = 0;
  const done = await h.service.run({
    jobId,
    run: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('Request failed with status code 400');
        error.statusCode = 400;
        error.code = 1254607;
        error.response = { status: 400, data: { code: 1254607, msg: 'Data not ready, please try again later' } };
        throw error;
      }
      return { ok: true };
    },
  });
  assert.equal(calls, 2, '400 但 code=1254607 是临时错误 ⇒ 要重试一次');
  assert.equal(done.status, ASYNC_JOB_STATUS.SUCCEEDED);
  assert.equal(done.attempts, 2);
});

test('AC-J2c 链路返回 {ok:false, code} 的业务拒绝**不重试**；返回 5xx 字样才重试', async () => {
  const permanent = makeService();
  const p = await enqueueJob(permanent);
  let permanentCalls = 0;
  await permanent.service.run({
    jobId: p.jobId,
    run: async () => { permanentCalls += 1; return { ok: false, code: 'item_invalid', message: '有一件货品读不到' }; },
  });
  assert.equal(permanentCalls, 1, '业务拒绝 ⇒ 不重试');
  assert.equal(permanent.sent.length, 1, '永久失败 ⇒ 发一次通知');

  const transient = makeService();
  const t = await enqueueJob(transient);
  let transientCalls = 0;
  const done = await transient.service.run({
    jobId: t.jobId,
    run: async () => {
      transientCalls += 1;
      return transientCalls === 1
        ? { ok: false, message: '飞书 503' }
        : { ok: true };
    },
  });
  assert.equal(transientCalls, 2, '带临时特征的失败重试');
  assert.equal(done.status, ASYNC_JOB_STATUS.SUCCEEDED);
});

test('AC-J2d partial_failed：分类为"部分失败" ⇒ 终态、不重试、发一次群通知', async () => {
  const h = makeService();
  const { jobId } = await enqueueJob(h);
  let calls = 0;
  const done = await h.service.run({
    jobId,
    run: async () => { calls += 1; return { ok: false, partial: true }; },
    classifyResult: (outcome) => ({ ok: false, retryable: false, partial: true, message: outcome.message }),
  });
  assert.equal(calls, 1, 'partial 不重试');
  assert.equal(done.status, ASYNC_JOB_STATUS.PARTIAL_FAILED);
  assert.equal(h.sent.length, 1, 'partial_failed 也要发群通知');
  assert.equal(h.sent[0].event, 'async_job_failed');
  assert.ok(done.finished_at);
});


test('AC-J2e 退避：base=800 ⇒ 等待 800 / 1600（配置化，不写死）', async () => {
  const h = makeService({ over: { ASYNC_JOB_RETRY_BASE_MS: '800' } });
  const { jobId } = await enqueueJob(h);
  await h.service.run({ jobId, run: async () => { throw new Error('timeout'); } });
  assert.deepEqual(h.sleeps, [800, 1600]);
});

// ── AC-J3 幂等 ────────────────────────────────────────────────────────────
test('AC-J3 同一把键重放 ⇒ 同一条 job；重跑只更新它（不新建）', async () => {
  const h = makeService();
  const first = await enqueueJob(h, { key: 'submit_key_A' });
  const second = await enqueueJob(h, { key: 'submit_key_A' });
  assert.equal(second.created, false);
  assert.equal(second.jobId, first.jobId);
  await h.service.run({ jobId: first.jobId, run: async () => ({ ok: true }) });
  await h.service.run({ jobId: first.jobId, run: async () => ({ ok: true }) });
  const jobs = await h.store.list();
  assert.equal(jobs.length, 1, '重跑只更新同一条 job');
  assert.equal(jobIdFor(ASYNC_JOB_TYPES.SALES, 'k'), jobIdFor(ASYNC_JOB_TYPES.SALES, 'k'), '稳定派生');
  assert.notEqual(jobIdFor(ASYNC_JOB_TYPES.SALES, 'k'), jobIdFor(ASYNC_JOB_TYPES.PURCHASE_RETURN, 'k'));
});

// ── AC-J4 通知去重 / 失败可重试 ───────────────────────────────────────────
test('AC-J4 最终失败只发一次群；同 job 再次通知/服务重启都不重发', async () => {
  const h = makeService();
  const { jobId } = await enqueueJob(h);
  await h.service.run({ jobId, run: async () => { throw new Error('飞书 500'); } });
  assert.equal(h.sent.length, 1, '发送一次');
  const first = await h.store.get(jobId);
  assert.ok(first.notified_at, '发送成功才写 notified_at');
  await h.service.notifyIfNeeded(jobId);
  await h.service.start();
  assert.equal(h.sent.length, 1, '同一 job 绝不重复发');
});

test('AC-J4b 发送失败：记 async_job.notify.failed，**不写 notified_at**、任务状态不变；后续可重试成功', async () => {
  const sent = [];
  let failNext = true;
  const h = makeService({
    notificationService: {
      send: async (event, data) => {
        if (failNext) return { ok: false, reason: 'send_failed', error: 'network down' };
        sent.push({ event, ...data });
        return { ok: true, cardId: 'card_1', messageId: 'msg_1' };
      },
    },
  });
  const { jobId } = await enqueueJob(h);
  const failed = await h.service.run({ jobId, run: async () => { throw new Error('飞书 500'); } });
  assert.equal(failed.status, ASYNC_JOB_STATUS.FAILED, '通知失败**不许**改变业务任务状态');
  assert.equal(failed.notified_at, '', '发送失败 ⇒ 不写 notified_at');
  assert.equal(failed.notify.attempts, 1);
  assert.ok(h.logs.some((entry) => entry.event === 'async_job.notify.failed'), '必须有 async_job.notify.failed');

  failNext = false;
  await h.service.start(); // 重启收尾：补发
  const after = await h.store.get(jobId);
  assert.ok(after.notified_at, '后续重试成功才写 notified_at');
  assert.equal(sent.length, 1);
  assert.equal(after.status, ASYNC_JOB_STATUS.FAILED, '状态仍是失败（通知不改状态）');
});

// ── AC-J5 群未配置 ────────────────────────────────────────────────────────
test('AC-J5 群未配置 ⇒ 记 async_job.notify.chat_missing，**不静默成功**、不写 notified_at', async () => {
  const h = makeService({ notificationService: { send: async () => ({ ok: false, reason: 'target_missing' }) } });
  const { jobId } = await enqueueJob(h);
  const done = await h.service.run({ jobId, run: async () => { throw new Error('飞书 500'); } });
  assert.equal(h.sent.length, 0);
  assert.equal(done.notified_at, '');
  const missing = h.logs.find((entry) => entry.event === 'async_job.notify.chat_missing');
  assert.ok(missing, '必须记 chat_missing');
  assert.match(String(missing.fields.env), /NOTIFY_GROUP_CHAT_ID/);
});

test('AC-J5b 通知关闭（ASYNC_JOB_NOTIFY_ENABLED=false）⇒ 记 async_job.notify.disabled', async () => {
  const h = makeService({ over: { ASYNC_JOB_NOTIFY_ENABLED: 'false' } });
  const { jobId } = await enqueueJob(h);
  await h.service.run({ jobId, run: async () => { throw new Error('飞书 500'); } });
  assert.equal(h.sent.length, 0);
  assert.ok(h.logs.some((entry) => entry.event === 'async_job.notify.disabled'));
});

// ── AC-J6 文案 ────────────────────────────────────────────────────────────
test('AC-J6 群文案：类型/单号/操作人/失败步骤/错误/任务ID/时间（上海），**不发 payload**', () => {
  const config = makeConfig();
  const job = {
    job_id: 'after_sales_job_abc123',
    type: ASYNC_JOB_TYPES.AFTER_SALES,
    status: ASYNC_JOB_STATUS.FAILED,
    last_error: '飞书字段不存在：收款时间',
    operator_name: '王颖',
    finished_at: '2026-11-08T04:34:56.000Z', // 上海 = 12:34:56
    payload: { secret_note: '这行绝不能出现在群消息里' },
    meta: { order_no: 'XSD-20261108-0012', step: '写交易明细' },
  };
  const text = renderAsyncJobFailureMessage(job, config);
  assert.match(text, /【异步写入失败】/);
  assert.match(text, /类型：售后退货/);
  assert.match(text, /单号\/批次：XSD-20261108-0012/);
  assert.match(text, /操作人：王颖/);
  assert.match(text, /失败步骤：写交易明细/);
  assert.match(text, /错误：飞书字段不存在：收款时间/);
  assert.match(text, /任务ID：after_sales_job_abc123/);
  assert.match(text, /时间：2026-11-08 12:34:56/, '群消息时间是上海时间');
  assert.equal(text.includes('secret_note'), false, '不发 payload');
  assert.equal(text.includes('@'), false, '默认不 @人');
});

test('AC-J6b 拿不到的字段（单号 / 操作人）不写；错误超长截断', () => {
  const config = makeConfig({ ASYNC_JOB_NOTIFY_MAX_ERROR_LENGTH: '40' });
  const text = renderAsyncJobFailureMessage({
    job_id: 'j1', type: ASYNC_JOB_TYPES.SALES, status: 'failed',
    last_error: 'x'.repeat(120),
    meta: {},
    created_at: '2026-11-08T00:00:00.000Z',
  }, config);
  assert.equal(text.includes('单号/批次'), false, '拿不到单号就不写（不编）');
  assert.equal(text.includes('操作人'), false, '拿不到操作人就不写');
  const errorLine = text.split('\n').find((line) => line.startsWith('错误：'));
  assert.ok(errorLine.length <= '错误：'.length + 40, '错误信息截断到配置上限');
  assert.equal(formatShanghaiTime('2026-11-08T00:00:00.000Z'), '2026-11-08 08:00:00');
});

// ── AC-J7 只读视图（store 层）─────────────────────────────────────────────
test('AC-J7 视图：只能查自己的；不返回 payload / 敏感字段', async () => {
  const h = makeService();
  const { jobId } = await enqueueJob(h, { owner: 'ou_me' });
  await h.service.run({ jobId, run: async () => ({ ok: true }) });
  const mine = await h.service.view(jobId, 'ou_me');
  assert.equal(mine.ok, true);
  const keys = Object.keys(mine.job);
  for (const forbidden of ['payload', 'meta', 'owner_open_id', 'operator_name', 'notify', 'result']) {
    assert.equal(keys.includes(forbidden), false, `视图不许返回 ${forbidden}`);
  }
  assert.deepEqual(keys.sort(), [
    'attempts', 'created_at', 'finished_at', 'job_id', 'last_error', 'notified_at', 'started_at', 'status', 'type',
  ].sort());
  assert.equal((await h.service.view(jobId, 'ou_other')).ok, false, '不是自己的 ⇒ not_found');
  assert.equal((await h.service.view(jobId, '')).ok, false, '没登录 ⇒ not_found');
  assert.deepEqual(publicJobView({ payload: { x: 1 }, job_id: 'j' }).payload, undefined);
});

// ── store 边界 ────────────────────────────────────────────────────────────
test('AC-J9 store：job_id 非法不落盘（get=null / create 抛错）；createIfAbsent 不覆盖已冻结 payload', async () => {
  const dir = tmpDir();
  const store = createAsyncJobStore({ dir });
  assert.equal(await store.get('../evil'), null);
  await assert.rejects(() => store.createIfAbsent({ job_id: 'bad id', type: 'sales' }), /invalid async job id/);
  const first = await store.createIfAbsent({ job_id: 'sale_job_aaaaaaaaaaaaaaaaaaaaaaaa', type: 'sales', payload: { a: 1 } });
  assert.equal(first.created, true);
  const second = await store.createIfAbsent({ job_id: 'sale_job_aaaaaaaaaaaaaaaaaaaaaaaa', type: 'sales', payload: { a: 2 } });
  assert.equal(second.created, false);
  assert.deepEqual(second.job.payload, { a: 1 }, '已冻结的 payload 不许被覆盖');
});

test('AC-AJ-DELIVERY 交割单交付/付款纳入统一任务类型配置', () => {
  const { ASYNC_JOBS } = require('../src/config/asyncJobs');
  assert.equal(ASYNC_JOB_TYPES.SALES_DELIVERY, 'sales_delivery');
  assert.equal(ASYNC_JOB_TYPES.SALES_PAYMENT, 'sales_payment');
  assert.equal(ASYNC_JOBS.texts.typeLabels[ASYNC_JOB_TYPES.SALES_DELIVERY], '交割单交付');
  assert.equal(ASYNC_JOBS.texts.typeLabels[ASYNC_JOB_TYPES.SALES_PAYMENT], '交割单付款');
});


test('AC-J10 统一通知服务：发 async_job_failed 卡片并保存 card_id / message_id', async () => {
  const calls = [];
  const h = makeService({
    notificationService: {
      send: async (event, data) => { calls.push({ event, data }); return { ok: true, cardId: 'card_1', messageId: 'msg_1' }; },
    },
  });
  const { jobId } = await enqueueJob(h);
  await h.service.run({ jobId, run: async () => { throw new Error('boom'); } });
  const job = await h.store.get(jobId);
  assert.equal(job.status, ASYNC_JOB_STATUS.FAILED);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].event, 'async_job_failed');
  assert.equal(calls[0].data.title, '【异步写入失败】');
  assert.equal(job.notification_card_id, 'card_1');
  assert.equal(job.notification_message_id, 'msg_1');
});
