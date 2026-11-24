'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { createProcurementDraftService } = require('../src/services/procurementDraftService');

const makeService = (now = () => Date.parse('2026-11-25T02:00:00.000Z')) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-draft-'));
  const store = new JsonTaskStore({ dir, idField: 'draft_id' });
  return createProcurementDraftService({ store, config: { enabled: true, dir, ttlDays: 30 }, now });
};

const snapshot = (qty = 2) => ({ submitKey: 'sk_1', products: { rec_a: { productRecordId: 'rec_a', entries: { 39: qty } } }, customSizes: {} });

test('采购草稿：同一用户只有一份，重复保存是更新', async () => {
  const service = makeService();
  const first = await service.save({ openId: 'ou_a', snapshot: snapshot(2) });
  assert.equal(first.ok, true);
  const second = await service.save({ openId: 'ou_a', snapshot: snapshot(5) });
  assert.equal(second.draft.draft_id, first.draft.draft_id);
  const got = await service.get({ openId: 'ou_a' });
  assert.equal(got.snapshot.products.rec_a.entries['39'], 5);
});

test('采购草稿：按 open_id 隔离，删不到别人的', async () => {
  const service = makeService();
  await service.save({ openId: 'ou_a', snapshot: snapshot(2) });
  assert.equal(await service.get({ openId: 'ou_b' }), null);
  assert.equal(await service.remove({ openId: 'ou_b' }), false);
  assert.ok(await service.get({ openId: 'ou_a' }));
});

test('采购草稿：非法快照不落盘', async () => {
  const service = makeService();
  assert.equal((await service.save({ openId: 'ou_a', snapshot: {} })).code, 'invalid_snapshot');
  assert.equal((await service.save({ openId: '', snapshot: snapshot() })).code, 'disabled');
});
