'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { INVENTORY_READ_RETRY } = require('../src/config/inventoryReadRetry');
const { readLiveInventoryForProduct } = require('../src/services/inventory/liveStock');
const { findLedger } = require('../src/services/inventory/ledger');

test('INV-RETRY1 库存读重试配置：最多 6 次，1s 起，封顶 15s', () => {
  assert.deepEqual(INVENTORY_READ_RETRY, {
    maxRetries: 5, baseDelayMs: 1000, factor: 2, maxDelayMs: 15000,
  });
});

test('INV-RETRY2 按货品读实时库存：带统一 retry，不再整表读', async () => {
  const calls = [];
  const gateway = {
    table: () => ({ fields: { recordId: 'recordID' } }),
    listByFilter: async (table, filter, options) => {
      calls.push({ table, filter, options });
      return [{ record_id: 'r1' }];
    },
    listAll: async () => { throw new Error('should not fallback'); },
  };
  const rows = await readLiveInventoryForProduct.call({ gateway }, 'reczz123');
  assert.deepEqual(rows, [{ record_id: 'r1' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].table, 'liveInventory');
  assert.match(calls[0].filter, /reczz123/);
  assert.deepEqual(calls[0].options, { retry: INVENTORY_READ_RETRY });
});

test('INV-RETRY3 库存流水按来源精确读；条件读失败才回退整表', async () => {
  const calls = [];
  const fields = { salesDetail: '关联销售', behavior: '库存行为' };
  const gateway = {
    table: () => ({ fields }),
    listByFilter: async (table, filter, options) => {
      calls.push({ table, filter, options });
      return [{
        record_id: 'ledger_1',
        fields: { 关联销售: [{ record_ids: ['detail_1'] }], 库存行为: [{ record_ids: ['behavior_1'] }] },
      }];
    },
    listAll: async () => { throw new Error('should not fallback'); },
  };
  const found = await findLedger.call({ gateway }, 'salesDetail', 'detail_1', 'behavior_1');
  assert.equal(found.record_id, 'ledger_1');
  assert.equal(calls.length, 1);
  assert.match(calls[0].filter, /CurrentValue\.\[关联销售\]="detail_1"/);
  assert.deepEqual(calls[0].options, { retry: INVENTORY_READ_RETRY });

  const failing = {
    table: () => ({ fields }),
    listByFilter: async () => { throw new Error('filter unsupported'); },
    listAll: async () => [{
      record_id: 'ledger_2',
      fields: { 关联销售: [{ record_ids: ['detail_2'] }], 库存行为: [{ record_ids: ['behavior_1'] }] },
    }],
  };
  const fallback = await findLedger.call({ gateway: failing }, 'salesDetail', 'detail_2', 'behavior_1');
  assert.equal(fallback.record_id, 'ledger_2');
});
