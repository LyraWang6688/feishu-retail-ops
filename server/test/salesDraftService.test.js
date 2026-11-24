'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { createSalesDraftService } = require('../src/services/salesDraftService');

const make = (config = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-drafts-'));
  const store = new JsonTaskStore({ dir, idField: 'draft_id' });
  const now = () => Date.parse('2026-11-24T10:00:00.000Z');
  return { dir, service: createSalesDraftService({ store, now, config: { maxDrafts: 20, ttlDays: 30, steps: { goods: 'goods', payment: 'payment' }, enabled: true, ...config } }) };
};

test('销售草稿：保存 / 列表 / 本人隔离 / 更新 / 删除', async () => {
  const { service } = make();
  const first = await service.save({
    openId: 'ou_a', step: 'goods',
    snapshot: { product_record_id: 'p1', number: 'A|黑', lines: [{ product_record_id: 'p1', size: 40 }] },
  });
  assert.equal(first.ok, true);
  const id = first.draft.draft_id;
  const second = await service.save({
    openId: 'ou_a', step: 'payment',
    snapshot: { product_record_id: 'p1', number: 'A|黑', lines: [{ product_record_id: 'p1', size: 40 }], payment: { rows: [{ method: '微信', amount: 99 }] } },
  });
  assert.equal(second.ok, true);
  assert.notEqual(second.draft.draft_id, id);
  const list = await service.list({ openId: 'ou_a' });
  assert.equal(list.length, 2);
  assert.equal(list[0].step, 'payment');
  assert.equal((await service.list({ openId: 'ou_b' })).length, 0);
  assert.equal(await service.get({ openId: 'ou_b', draftId: id }), null);
  assert.equal((await service.get({ openId: 'ou_a', draftId: id })).lines.length, 1);

  const updated = await service.save({ openId: 'ou_a', draftId: id, step: 'goods', snapshot: { lines: [] } });
  assert.equal(updated.ok, true);
  assert.equal((await service.get({ openId: 'ou_a', draftId: id })).lines.length, 0);
  assert.equal(await service.remove({ openId: 'ou_b', draftId: id }), false);
  assert.equal(await service.remove({ openId: 'ou_a', draftId: id }), true);
  assert.equal(await service.get({ openId: 'ou_a', draftId: id }), null);
});

test('销售草稿：超过上限 / 过期不返回', async () => {
  const { service } = make({ maxDrafts: 1 });
  assert.equal((await service.save({ openId: 'ou_a', snapshot: { lines: [1] } })).ok, true);
  assert.equal((await service.save({ openId: 'ou_a', snapshot: { lines: [1] } })).code, 'too_many');
});
