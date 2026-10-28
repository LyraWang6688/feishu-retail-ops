'use strict';

/** 交割单 job 路由：交付失败明细要能通过 GET /jobs/:id 返回（前端 toast 的真实原因来源）。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { createWorkbenchSalesDeliveryRoutes } = require('../src/routes/workbenchSalesDelivery');

const waitFor = async (fn) => {
  for (let i = 0; i < 100; i += 1) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  throw new Error('waitFor timeout');
};

test('AC-JOBROUTE 失败明细经 /jobs/:id 返回（不是只有 succeeded/failed 空壳）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-job-route-'));
  const gateway = { table: () => ({ fields: {} }), listAll: async () => [] };
  const followup = {
    gateway,
    delivery: { deliver: async () => ({ results: [{ detailRecordId: 'd-ok' }], failures: [{ detailRecordId: 'd-bad', error: '库存不足' }] }) },
    payments: {}, store: { get: async () => null },
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.workbenchUser = { open_id: 'u1' }; next(); });
  app.use(createWorkbenchSalesDeliveryRoutes({
    options: { gateway, paymentMethodsService: { listWithVouchers: async () => ({ ok: true, items: [] }) }, salesDeliveryJobsDir: dir },
    followup,
  }));
  const server = http.createServer(app);
  server.keepAliveTimeout = 1;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const queued = await fetch(`${base}/sales/delivery/deliveries`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ salesEntryRecordId: 'se-1', detailRecordIds: ['d-bad'], requestId: '00000000-0000-4000-8000-000000000099' }),
    }).then((res) => res.json());
    assert.equal(queued.success, true);
    const job = await waitFor(async () => {
      const data = await fetch(`${base}/sales/delivery/jobs/${queued.jobId}`).then((res) => res.json());
      return data.status === 'partial_failed' ? data : null;
    });
    assert.equal(job.failures.length, 1);
    assert.equal(job.failures[0].error, '库存不足');
    assert.equal(job.error, '库存不足');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
