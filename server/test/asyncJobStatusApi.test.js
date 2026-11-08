'use strict';

/**
 * #948 第 7 节：只读状态接口 `GET /api/workbench/async-jobs/:jobId`。
 *
 * AC-API1 未登录 ⇒ 401（沿用工作台**既有**鉴权，不新开一套）
 * AC-API2 自己的任务 ⇒ 200，只回状态机字段（**不返回 payload / 敏感字段**）
 * AC-API3 别人的任务 ⇒ 404（不泄露"这条任务存在"）；不存在的 ⇒ 404
 * AC-API4 job_id 非法 ⇒ 400（不拿它拼文件路径）
 * AC-API5 源码：路由挂在 `requireWorkbenchAccess` **之后**（不是裸的 / 不新开鉴权）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const SESSION_SECRET = 'async-job-status-test-secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_async_job_status_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'async_job_status_test_secret';

const { buildAsyncJobsConfig, ASYNC_JOB_TYPES } = require('../src/config/asyncJobs');
const { createAsyncJobStore } = require('../src/services/asyncJobStore');
const { createAsyncJobService } = require('../src/services/asyncJobService');
const { createWorkbenchRouter } = require('../src/routes/workbench');

const SERVER_DIR = path.join(__dirname, '..');
const cookieFor = (openId) => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};

const makeService = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'async-job-api-'));
  const config = buildAsyncJobsConfig({ ASYNC_JOBS_DIR: dir, ASYNC_JOB_RETRY_BASE_MS: '0' });
  const store = createAsyncJobStore({ dir });
  return createAsyncJobService({
    config,
    store,
    notifier: { notify: async () => ({ sent: false, reason: 'stub' }) },
    logger: { logInfo() {}, logWarn() {} },
    sleep: async () => undefined,
  });
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  server.keepAliveTimeout = 1;
  try { return await run(`http://127.0.0.1:${server.address().port}`); } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const appFor = (service) => {
  const app = express();
  app.use(express.json());
  app.use('/api/workbench', createWorkbenchRouter({ gateway: {}, asyncJobs: service }));
  return app;
};

const getJson = async (base, url, cookie) => {
  const response = await fetch(`${base}${url}`, { headers: cookie ? { cookie } : {} });
  return { status: response.status, body: await response.json() };
};

test('AC-API1 未登录 ⇒ 401（沿用工作台既有鉴权）', async () => {
  const service = makeService();
  await withServer(appFor(service), async (base) => {
    const out = await getJson(base, '/api/workbench/async-jobs/sale_job_aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(out.status, 401);
    assert.equal(out.body.success, false);
  });
});

test('AC-API2 自己的任务 ⇒ 200，只回状态机字段（不返回 payload / 敏感字段）', async () => {
  const service = makeService();
  const jobId = service.jobIdFor(ASYNC_JOB_TYPES.AFTER_SALES, 'return:11111111-2222-4333-8444-555555555555');
  await service.enqueue({
    jobId,
    type: ASYNC_JOB_TYPES.AFTER_SALES,
    payload: { secret_note: '绝不能出现在接口返回里', salesEntryRecordId: 'rec_1' },
    ownerOpenId: 'ou_me',
    operatorName: '王颖',
    meta: { order_no: 'XSD-20261108-0012', step: '写交易明细' },
  });
  await service.succeed({ jobId, result: { ok: true }, attempt: 1 });
  await withServer(appFor(service), async (base) => {
    const out = await getJson(base, `/api/workbench/async-jobs/${jobId}`, cookieFor('ou_me'));
    assert.equal(out.status, 200);
    assert.equal(out.body.success, true);
    assert.equal(out.body.job.job_id, jobId);
    assert.equal(out.body.job.type, ASYNC_JOB_TYPES.AFTER_SALES);
    assert.equal(out.body.job.status, 'succeeded');
    assert.equal(out.body.job.attempts, 1);
    assert.equal(out.body.job.order_no, undefined, '不返回 meta 里的单号（文档只要求状态机字段）');
    const raw = JSON.stringify(out.body);
    assert.equal(raw.includes('secret_note'), false, '🔴 不返回 payload');
    assert.equal(raw.includes('ou_me'), false, '🔴 不返回 owner open_id');
    for (const forbidden of ['payload', 'meta', 'owner_open_id', 'operator_name', 'result']) {
      assert.equal(forbidden in out.body.job, false, `接口不许返回 ${forbidden}`);
    }
  });
});

test('AC-API3 别人的任务 / 不存在的任务 ⇒ 404（不区分，不泄露存在性）', async () => {
  const service = makeService();
  const jobId = service.jobIdFor(ASYNC_JOB_TYPES.SALES, 'submit_key_1');
  await service.enqueue({ jobId, type: ASYNC_JOB_TYPES.SALES, ownerOpenId: 'ou_owner' });
  await withServer(appFor(service), async (base) => {
    const other = await getJson(base, `/api/workbench/async-jobs/${jobId}`, cookieFor('ou_other'));
    assert.equal(other.status, 404);
    const missing = await getJson(base, '/api/workbench/async-jobs/sale_job_bbbbbbbbbbbbbbbbbbbbbbbb', cookieFor('ou_owner'));
    assert.equal(missing.status, 404);
    const mine = await getJson(base, `/api/workbench/async-jobs/${jobId}`, cookieFor('ou_owner'));
    assert.equal(mine.status, 200);
  });
});

test('AC-API4 job_id 非法 ⇒ 400（不拿它去拼文件路径）', async () => {
  const service = makeService();
  await withServer(appFor(service), async (base) => {
    const bad = await getJson(base, '/api/workbench/async-jobs/..%2F..%2Fetc%2Fpasswd', cookieFor('ou_me'));
    assert.equal(bad.status, 400);
  });
});

test('AC-API5 源码：状态路由挂在 `requireWorkbenchAccess` 之后（不新开鉴权）', () => {
  const source = fs.readFileSync(path.join(SERVER_DIR, 'src', 'routes', 'workbench.js'), 'utf8');
  const gate = source.indexOf('router.use(requireWorkbenchAccess)');
  const mount = source.indexOf('createWorkbenchAsyncJobRoutes(');
  assert.ok(gate > 0 && mount > gate, '状态路由必须挂在工作台准入闸门之后');
  const route = fs.readFileSync(path.join(SERVER_DIR, 'src', 'routes', 'workbench', 'asyncJobs.js'), 'utf8');
  assert.equal(/requireWorkbenchAccess\s*\(/.test(route), false, '子路由不自己判鉴权（父 router 统一加）');
  assert.match(route, /viewerOpenId/, '必须按当前登录人做 owner 校验');
});
