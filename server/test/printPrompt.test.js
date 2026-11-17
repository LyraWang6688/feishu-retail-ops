'use strict';

/**
 * ⭐ 2026-11-17：「是否打印」轻页（销售资金页 / 验收提交后共用）。
 *
 * 钉住：
 *   · 一次性令牌：默认全勾选、提交后不能再用、过期失效；
 *   · 销售 ⇒ 勾中的每款各建一个打印任务（来源=销售录单打印，幂等键按单+款）；
 *   · 验收 ⇒ 写打印意图（来源=验收录单打印），库存 job 成功后再入队；
 *   · 不打印/空选 ⇒ 直接回工作台。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createPrintPromptService } = require('../src/services/printPromptService');
const { createPrintPromptRouter } = require('../src/routes/printPrompt');
const { SOURCES } = require('../src/config/labelPrintQueue');
const { ASYNC_JOB_TYPES } = require('../src/config/asyncJobs');

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const i = app.listen(0, '127.0.0.1', () => resolve(i)); });
  server.keepAliveTimeout = 1;
  const base = 'http://127.0.0.1:' + server.address().port;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const appFor = ({ prompts, queue, intentService }) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use('/print-prompt', createPrintPromptRouter({ promptService: prompts, queue, intentService }));
  return app;
};

const product = (recordId, itemNo, color) => ({ recordId, itemNo, color, number: itemNo + '|' + color + '|男' });

test('AC-PP1 令牌：默认全勾、只接受令牌里的货品、提交后一次性', () => {
  let clock = 1_000_000;
  const prompts = createPrintPromptService({ now: () => clock, ttlMs: 1000, idFactory: () => 'tok_1' });
  const prompt = prompts.create({
    kind: 'sale', source: SOURCES.sale, operationId: 'sale_1', ownerOpenId: 'ou_1',
    products: [product('p1', 'A', '黑'), product('p2', 'B', '棕')], returnUrl: '/workbench/',
  });
  assert.equal(prompt.token, 'tok_1');
  assert.equal(prompts.get('tok_1').products.length, 2);
  const consumed = prompts.consume('tok_1', ['p2', 'rec_not_in_prompt']);
  assert.deepEqual(consumed.selected.map((item) => item.recordId), ['p2']);
  assert.equal(prompts.get('tok_1'), null, '一次性：消费后失效');
  assert.equal(prompts.consume('tok_1', ['p1']), null);
});

test('AC-PP2 令牌过期 ⇒ 失效', () => {
  let clock = 1_000_000;
  const prompts = createPrintPromptService({ now: () => clock, ttlMs: 1000, idFactory: () => 'tok_2' });
  prompts.create({ kind: 'sale', source: SOURCES.sale, operationId: 'sale_1', products: [product('p1', 'A', '黑')] });
  clock += 1001;
  assert.equal(prompts.get('tok_2'), null);
});

test('AC-PP3 页面：默认全勾选 + 有「不打印」回工作台', async () => {
  const prompts = createPrintPromptService({ idFactory: () => 'tok_page' });
  const prompt = prompts.create({
    kind: 'sale', source: SOURCES.sale, operationId: 'sale_1', ownerOpenId: 'ou_1',
    products: [product('p1', 'A', '黑'), product('p2', 'B', '棕')], returnUrl: '/workbench/?toast=ok',
  });
  const app = appFor({ prompts });
  await withServer(app, async (base) => {
    const res = await fetch(base + '/print-prompt?token=' + prompt.token);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.equal((html.match(/name="product"/g) || []).length, 2, '两款各一个复选框');
    assert.equal((html.match(/checked/g) || []).length, 2, '默认全勾');
    assert.match(html, /打印选中/);
    assert.match(html, /href="\/workbench\/\?toast=ok"/);
  });
});

test('AC-PP4 销售：勾中的每款各记一条打印意图（来源=销售录单打印），等销售 job 成功再入队', async () => {
  const prompts = createPrintPromptService({ idFactory: () => 'tok_sale' });
  const prompt = prompts.create({
    kind: 'sale', source: SOURCES.sale, operationId: 'sale_job_1', ownerOpenId: 'ou_1',
    products: [product('p1', 'A', '黑'), product('p2', 'B', '棕')], returnUrl: '/workbench/',
  });
  const requests = [];
  const intentService = {
    request: async (input) => { requests.push(input); return { ok: true, deferred: true, failed: 0 }; },
  };
  const app = appFor({ prompts, intentService });
  await withServer(app, async (base) => {
    const body = new URLSearchParams();
    body.append('product', 'p1');
    body.append('product', 'p2');
    const res = await fetch(base + '/print-prompt?token=' + prompt.token, { method: 'POST', body });
    assert.equal(res.status, 200);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].jobId, 'sale_job_1');
    assert.deepEqual(requests[0].productRecordIds, ['p1', 'p2']);
    assert.equal(requests[0].source, SOURCES.sale);
    assert.equal(requests[0].expectedType, ASYNC_JOB_TYPES.SALES);
    assert.equal(requests[0].submitKeyPrefix, 'sale_print');
    assert.match(await res.text(), /库存写入完成后自动打印/);
  });
});

test('AC-PP5 验收：只写打印意图（来源=验收录单打印），等库存 job 成功再打', async () => {
  const prompts = createPrintPromptService({ idFactory: () => 'tok_acc' });
  const prompt = prompts.create({
    kind: 'acceptance', source: SOURCES.acceptance, operationId: 'job_accept', ownerOpenId: 'ou_1',
    products: [product('p1', 'A', '黑'), product('p2', 'B', '棕')], returnUrl: '/workbench/',
  });
  const requests = [];
  const intentService = {
    request: async (input) => { requests.push(input); return { ok: true, deferred: true, failed: 0 }; },
  };
  const app = appFor({ prompts, intentService });
  await withServer(app, async (base) => {
    const body = new URLSearchParams();
    body.append('product', 'p1');
    const res = await fetch(base + '/print-prompt?token=' + prompt.token, { method: 'POST', body });
    assert.equal(res.status, 200);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].jobId, 'job_accept');
    assert.deepEqual(requests[0].productRecordIds, ['p1']);
    assert.equal(requests[0].source, SOURCES.acceptance);
    assert.equal(requests[0].expectedType, ASYNC_JOB_TYPES.PURCHASE_ACCEPTANCE);
    assert.equal(requests[0].submitKeyPrefix, 'acceptance_print');
  });
});

test('AC-PP6 坏令牌 / 用过一次 ⇒ 410；空选 ⇒ 直接回工作台', async () => {
  const prompts = createPrintPromptService({ idFactory: () => 'tok_empty' });
  const prompt = prompts.create({
    kind: 'sale', source: SOURCES.sale, operationId: 'sale_1', ownerOpenId: 'ou_1',
    products: [product('p1', 'A', '黑')], returnUrl: '/workbench/',
  });
  const app = appFor({ prompts });
  await withServer(app, async (base) => {
    assert.equal((await fetch(base + '/print-prompt?token=nope')).status, 410);
    const empty = await fetch(base + '/print-prompt?token=' + prompt.token, {
      method: 'POST', body: new URLSearchParams(), redirect: 'manual',
    });
    assert.equal(empty.status, 303);
    assert.equal(empty.headers.get('location'), '/workbench/');
    assert.equal((await fetch(base + '/print-prompt?token=' + prompt.token)).status, 410, '已消费');
  });
});
