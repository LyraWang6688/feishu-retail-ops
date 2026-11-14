'use strict';

/**
 * #891：本地任务 createIfAbsent 必须是**原子**的“查 + 建”。
 * 并发同一 jobId 时只能有一个 created=true，磁盘保留先创建者的 payload，后写不得覆盖。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { createSalesJobStore } = require('../src/services/salesJobStore');
const { createAsyncJobStore } = require('../src/services/asyncJobStore');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('JsonTaskStore.createIfAbsent：同 id 并发只建一次，先创建 payload 不被覆盖', async () => {
  const dir = tmp('json-atomic-');
  try {
    const store = new JsonTaskStore({ dir, idField: 'job_id' });
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      store.createIfAbsent({ job_id: 'same_job', payload: { index } })));
    assert.equal(results.filter((item) => item.created).length, 1, '只能有一个创建成功');
    const winner = results.find((item) => item.created).record;
    const persisted = await store.get('same_job');
    assert.deepEqual(persisted.payload, winner.payload, '磁盘保留先创建者的 payload');
    assert.equal(new Set(results.map((item) => item.record.payload.index)).size, 1,
      '所有并发调用都返回同一份已存在记录');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('salesJobStore.createIfAbsent：同 submitKey 同订单并发只有 created=true 一次，payload 不被后写覆盖', async () => {
  const dir = tmp('sales-job-atomic-');
  // ⚠️ 2026-11-14（#45）：这里是**同一订单**的并发重提；不同订单现在会派生不同 job
  //   （跨订单隔离见 test/salesJobStoreOrderIsolation.test.js）。
  const orderNo = 'XSD-SAME-ORDER';
  try {
    const store = createSalesJobStore({ dir });
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      store.createIfAbsent('scan_sale:same:1', { order_no: orderNo, lines: [] })));
    assert.equal(results.filter((item) => item.created).length, 1);
    const persisted = await store.get(store.jobIdOf(`scan_sale:same:1|order:${orderNo}`));
    const winner = results.find((item) => item.created).job;
    assert.equal(persisted.payload.order_no, winner.payload.order_no);
    assert.equal(persisted.order_no, orderNo);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('asyncJobStore.createIfAbsent：同 job_id 并发只有 created=true 一次，payload 不被后写覆盖', async () => {
  const dir = tmp('async-job-atomic-');
  try {
    const store = createAsyncJobStore({ dir });
    const jobId = 'sale_job_atomic0000000000000000';
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      store.createIfAbsent({ job_id: jobId, type: 'sales', payload: { index } })));
    assert.equal(results.filter((item) => item.created).length, 1);
    const persisted = await store.get(jobId);
    const winner = results.find((item) => item.created).job;
    assert.deepEqual(persisted.payload, winner.payload);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
