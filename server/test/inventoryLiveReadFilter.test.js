'use strict';

/**
 * 售后写库提速（2026-11-11）：实时库存**按货品记录 ID 条件读**，不再整表拉 1300+ 行。
 *
 * AC-LR1 有 `recordID` 列 + `listByFilter` ⇒ 只按条件读（不整表读）；
 * AC-LR2 条件读失败 / 没有该列 / 记录 id 非法 ⇒ **回退整表读**（慢一次但对，不静默丢库存）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { readLiveInventoryForProduct } = require('../src/services/inventory/liveStock');

const makeCtx = (overrides = {}) => {
  const calls = { filter: [], all: [] };
  const gateway = {
    table: (key) => ({ fields: { recordId: 'recordID' } }),
    listByFilter: async (key, filter) => {
      calls.filter.push({ key, filter });
      if (overrides.filterError) throw new Error('filter_not_supported');
      return overrides.rows || [{ record_id: 'live_1', fields: {} }];
    },
    listAll: async (key) => {
      calls.all.push(key);
      return [{ record_id: 'live_all', fields: {} }];
    },
    ...(overrides.gateway || {}),
  };
  return { ctx: { gateway }, calls };
};

test('AC-LR1 按货品 recordID 条件读（不整表读）', async () => {
  const { ctx, calls } = makeCtx();
  const rows = await readLiveInventoryForProduct.call(ctx, 'recProd1');
  assert.equal(rows.length, 1);
  assert.equal(calls.filter.length, 1, '走条件读');
  assert.equal(calls.all.length, 0, '不整表读');
  assert.match(calls.filter[0].filter, /CurrentValue\.\[recordID\]="recProd1"/);
});

test('AC-LR2 条件读失败 ⇒ 回退整表读', async () => {
  const { ctx, calls } = makeCtx({ filterError: true });
  await readLiveInventoryForProduct.call(ctx, 'recProd1');
  assert.equal(calls.filter.length, 1);
  assert.equal(calls.all.length, 1, '失败必须回退整表读，不静默返回空库存');
});

test('AC-LR3 没有 recordID 列 / id 含非法字符 ⇒ 直接整表读', async () => {
  const noField = makeCtx({ gateway: { table: () => ({ fields: {} }) } });
  await readLiveInventoryForProduct.call(noField.ctx, 'recProd1');
  assert.equal(noField.calls.all.length, 1);

  const badId = makeCtx();
  await readLiveInventoryForProduct.call(badId.ctx, 'rec" or "1');
  assert.equal(badId.calls.all.length, 1, '非法 id 不拼进 filter');
});
