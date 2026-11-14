'use strict';

/**
 * 团购券结算 · 对账进度存储（2026-11-14）。
 * 关键判据：save → get → markDone → list(done) 全部可用；重启后（新 store 实例）仍能读到。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createVoucherSettlementBatchStore } = require('../src/services/voucherSettlementBatches');

test('AC-VSB-1 落盘 store：save / get / markDone / list，且换实例仍读得到', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voucher-settlement-batches-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = createVoucherSettlementBatchStore({ dir });
  await store.save({
    batch_id: '2026-11-06',
    settleDay: '2026-11-06',
    creation_days: ['2026-11-01'],
    skus: ['sku-v1'],
    unknown_sku: false,
    record_amounts: { rec_a: 8540, rec_b: 4740 },
    approved_at: '2026-11-06T06:00:00.000Z',
    done: false,
  });

  const saved = await store.get('2026-11-06');
  assert.equal(saved.batch_id, '2026-11-06');
  assert.deepEqual(saved.record_amounts, { rec_a: 8540, rec_b: 4740 });

  // 模拟进程重启：新的 store 实例（同目录）必须读得到同一批进度。
  const reopened = createVoucherSettlementBatchStore({ dir });
  const reloaded = await reopened.get('2026-11-06');
  assert.deepEqual(reloaded.record_amounts, { rec_a: 8540, rec_b: 4740 });

  await reopened.markDone('2026-11-06', '2026-11-06T07:00:00.000Z');
  const done = await reopened.get('2026-11-06');
  assert.equal(done.done, true);
  assert.equal(done.done_at, '2026-11-06T07:00:00.000Z');

  const all = await reopened.list();
  assert.equal(all.length, 1);
});

test('AC-VSB-2 不传 dir ⇒ 进程内 store（单测不写真实 data 目录）', async () => {
  const store = createVoucherSettlementBatchStore();
  await store.save({ batch_id: '2026-11-06', settleDay: '2026-11-06', record_amounts: { rec_a: 1 }, done: false });
  assert.equal((await store.get('2026-11-06')).record_amounts.rec_a, 1);
  await store.markDone('2026-11-06', 'now');
  assert.equal((await store.get('2026-11-06')).done, true);
});
