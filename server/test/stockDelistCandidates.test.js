'use strict';

// 「卖完 → 下架候选」唯一判据：剩余 = 快照 − 前端数量（不查库存表）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { soldOutCandidates, remainingOf } = require('../src/services/stockDelistCandidates');

test('AC-DC1 快照 − 数量 == 0 ⇒ 卖完；>0 ⇒ 不提示', () => {
  assert.deepEqual(soldOutCandidates([{ productRecordId: 'p1', snapshotCount: 1, qty: 1 }]), [
    { productRecordId: 'p1', snapshotCount: 1, qty: 1, remaining: 0 },
  ]);
  assert.deepEqual(soldOutCandidates([{ productRecordId: 'p1', snapshotCount: 2, qty: 1 }]), []);
});

test('AC-DC2 同 recordId 多行合并成一条（数量相加，弹窗只出一行）', () => {
  const out = soldOutCandidates([
    { productRecordId: 'p1', snapshotCount: 2, qty: 1 },
    { productRecordId: 'p1', snapshotCount: 2, qty: 1 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].qty, 2);
});

test('AC-DC3 样品也算库存记录：快照 2、卖 1 ⇒ 剩余 1 ⇒ 不提示', () => {
  assert.deepEqual(soldOutCandidates([{ productRecordId: 'p1', snapshotCount: 2, qty: 1 }]), []);
  assert.equal(remainingOf(2, 1), 1);
});

test('AC-DC4 快照本来就是 0 / 缺字段 ⇒ 不提示、不瞎猜', () => {
  assert.deepEqual(soldOutCandidates([{ productRecordId: 'p1', snapshotCount: 0, qty: 1 }]), []);
  assert.deepEqual(soldOutCandidates([{ productRecordId: '', snapshotCount: 1, qty: 1 }]), []);
  assert.deepEqual(soldOutCandidates([{ productRecordId: 'p1', snapshotCount: NaN, qty: 1 }]), []);
  assert.deepEqual(soldOutCandidates([{ productRecordId: 'p1', snapshotCount: 1, qty: 0 }]), []);
  assert.deepEqual(soldOutCandidates([]), []);
  assert.deepEqual(soldOutCandidates(null), []);
});

test('AC-DC5 超卖（数量 > 快照）也按卖完处理（剩余 0）', () => {
  const out = soldOutCandidates([{ productRecordId: 'p1', snapshotCount: 1, qty: 2 }]);
  assert.equal(out.length, 1);
});

test('AC-DC6 不同 recordId 各判各的（同货号但两条记录不合并）', () => {
  const out = soldOutCandidates([
    { productRecordId: 'recA', snapshotCount: 1, qty: 1 },
    { productRecordId: 'recB', snapshotCount: 3, qty: 1 },
  ]);
  assert.deepEqual(out.map((c) => c.productRecordId), ['recA']);
});
