'use strict';

/**
 * 售后「退货」表单提交入口（2026-11-08）：
 * AC-SUB1 合法提交 ⇒ 同步校验 + 入队 + **303 回售后页并带统一 toast**（文案来自 config/submitToast.js）。
 * AC-SUB2 她填错（缺退款方式等）⇒ 303 回售后页带 `err=` 人话，**不入队、零写入**。
 * AC-SUB3 退款方式候选 ⇒ 只读接口返回「支付方式管理」里的方式（不写死）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createWorkbenchOrderActionsRouter } = require('../src/routes/workbenchOrderActions');
const { DEFAULT_SUBMIT_TOAST_TEXT, DEFAULT_SUBMIT_TOAST_PATH } = require('../src/config/submitToast');

const buildApp = ({ returnService, methods } = {}) => {
  const calls = { enqueue: [] };
  const router = createWorkbenchOrderActionsRouter({
    gateway: {},
    scanService: { listCandidates: async () => ({ candidates: [] }) },
    scanPageService: { lookup: async () => ({ rows: [], found: true }) },
    paymentMethodsService: {
      list: async () => ({ ok: true, items: methods || [] }),
      listRefundable: async () => ({ ok: true, items: (methods || []).filter((m) => m !== '微信转账') }),
    },
    afterSalesReturn: returnService || {
      prepare: async (payload) => ({ requestId: payload.requestId, orderNo: 'XSD-20261028-0005' }),
    },
    afterSalesJobs: {
      enqueue: async (job) => { calls.enqueue.push(job); return { job: { job_id: 'job_1', status: 'queued' } }; },
      get: async () => null,
      start: async () => {},
    },
  });
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/api/workbench', router);
  return { app, calls };
};

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  server.keepAliveTimeout = 1;
});

const submit = async (port, body) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/workbench/sales/after-sales/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
  return { status: response.status, location: response.headers.get('location') || '' };
};

const requestId = () => '11111111-2222-4333-8444-555555555555';

test('AC-SUB1 合法提交 ⇒ 入队 + 303 回工作台 + 统一 toast（业务负责人 2026-11-09：与销售/采购一致）', async () => {
  const { app, calls } = buildApp();
  const { server, port } = await listen(app);
  try {
    const out = await submit(port, {
      requestId: requestId(),
      salesEntryRecordId: 'entry_1',
      detailRecordId: 'detail_1',
      moneyMode: 'refund',
      paymentMethod: '现金',
      productRecordId: 'prod_1',
    });
    assert.equal(out.status, 303);
    const url = new URL(out.location, 'http://x');
    assert.equal(url.pathname, DEFAULT_SUBMIT_TOAST_PATH, '成功必须回工作台（统一落点）');
    assert.equal(url.searchParams.get('toast'), DEFAULT_SUBMIT_TOAST_TEXT);
    assert.equal(url.searchParams.get('done'), 'XSD-20261028-0005');
    assert.equal(url.searchParams.get('productRecordId'), null, '成功不再回售后页 ⇒ 不带 productRecordId');
    assert.equal(url.searchParams.get('submitted'), null, '旧 submitted 标记已退场');
    assert.equal(calls.enqueue.length, 1);
    assert.deepEqual(calls.enqueue[0].correlation, {}); // 无 tap_id 时只给空对象、不编
  } finally { server.close(); }
});

test('AC-SUB2 她填错 ⇒ 303 回页面带 err= 人话，不入队（零写入）', async () => {
  const prepare = async () => { throw Object.assign(new Error('直接退款时要选退款方式'), { statusCode: 400 }); };
  const { app, calls } = buildApp({ returnService: { prepare } });
  const { server, port } = await listen(app);
  try {
    const out = await submit(port, {
      requestId: requestId(), salesEntryRecordId: 'entry_1', detailRecordId: 'detail_1',
      moneyMode: 'refund', productRecordId: 'prod_1',
    });
    assert.equal(out.status, 303);
    const url = new URL(out.location, 'http://x');
    assert.equal(url.searchParams.get('err'), '直接退款时要选退款方式');
    assert.equal(url.searchParams.get('toast'), null, '失败时不许弹成功 toast');
    assert.equal(calls.enqueue.length, 0);
  } finally { server.close(); }
});

test('AC-SUB4 ?use=refund ⇒ 只回「可用于退款」的方式（未勾的不出现）', async () => {
  const { app } = buildApp({ methods: ['现金', '微信转账', '微信扫码'] });
  const { server, port } = await listen(app);
  try {
    const all = await (await fetch(`http://127.0.0.1:${port}/api/workbench/sales/after-sales/payment-methods`)).json();
    assert.deepEqual(all.items, ['现金', '微信转账', '微信扫码'], '不带 use ⇒ 全部（形状不变）');
    const refund = await (await fetch(`http://127.0.0.1:${port}/api/workbench/sales/after-sales/payment-methods?use=refund`)).json();
    assert.deepEqual(refund.items, ['现金', '微信扫码'], '未勾「可用于退款」的方式不出现');
  } finally { server.close(); }
});

test('AC-SUB3 退款方式候选：来自「支付方式管理」的统一配置（不写死）', async () => {
  const { app } = buildApp({ methods: ['现金', '微信扫码'] });
  const { server, port } = await listen(app);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/workbench/sales/after-sales/payment-methods`);
    const body = await response.json();
    assert.deepEqual(body.items, ['现金', '微信扫码']);
  } finally { server.close(); }
});
