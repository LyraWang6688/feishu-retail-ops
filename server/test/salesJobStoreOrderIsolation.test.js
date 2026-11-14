'use strict';

/**
 * #45：销售 job 的**跨订单隔离**（2026-11-14）。
 *
 * 旧实现：先在锁外 `get(基础键)`，只有发现"已有不同 order_no"才换键 ⇒ 两个不同订单**并发**
 * 都 get 不到、都选基础键，原子创建让后者返回前者订单 ⇒ **跨订单合并**（写库落到错误订单）。
 *
 *   AC-SJO-1 不同 order_no 并发 ⇒ 两条 job（不合并）
 *   AC-SJO-2 同一 order_no 并发/重提 ⇒ 同一条 job（不新建）
 *   AC-SJO-3 旧版基础键 job（同订单）仍复用，不因升级多出一条
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSalesJobStore, jobIdOf } = require('../src/services/salesJobStore');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sales-job-order-'));

test('AC-SJO-1 不同订单并发 ⇒ 两条 job，各自 order_no 正确', async () => {
  const { createIfAbsent, store } = createSalesJobStore({ dir: tmpDir() });
  const [a, b] = await Promise.all([
    createIfAbsent('session:1', { order_no: 'XSD-20261114-0001' }, { tapId: 'tap_a' }),
    createIfAbsent('session:1', { order_no: 'XSD-20261114-0002' }, { tapId: 'tap_b' }),
  ]);
  assert.notEqual(a.job.job_id, b.job.job_id, '不同订单不许合并到同一条 job');
  assert.equal(a.job.order_no, 'XSD-20261114-0001');
  assert.equal(b.job.order_no, 'XSD-20261114-0002');
  const list = await store.list();
  assert.equal(list.length, 2);
});

test('AC-SJO-2 同一订单重提/并发 ⇒ 同一条 job，只有一次 created', async () => {
  const { createIfAbsent, store } = createSalesJobStore({ dir: tmpDir() });
  const [a, b] = await Promise.all([
    createIfAbsent('session:2', { order_no: 'XSD-20261114-0003' }, { tapId: 'tap_a' }),
    createIfAbsent('session:2', { order_no: 'XSD-20261114-0003' }, { tapId: 'tap_b' }),
  ]);
  assert.equal(a.job.job_id, b.job.job_id);
  assert.equal([a.created, b.created].filter(Boolean).length, 1, '并发只允许一个真创建');
  assert.equal((await store.list()).length, 1);
});

test('AC-SJO-3 旧版基础键 job（同订单）继续复用，不因升级多出一条', async () => {
  const { createIfAbsent, store } = createSalesJobStore({ dir: tmpDir() });
  const key = 'session:3';
  const legacyId = jobIdOf(key);
  await store.create({
    job_id: legacyId,
    submit_key: key,
    status: 'queued',
    payload: { order_no: 'XSD-20261114-0004' },
    order_no: 'XSD-20261114-0004',
    tap_id: '',
  });
  const out = await createIfAbsent(key, { order_no: 'XSD-20261114-0004' }, { tapId: 'tap_c' });
  assert.equal(out.job.job_id, legacyId);
  assert.equal(out.created, false);
  assert.equal((await store.list()).length, 1);
});
