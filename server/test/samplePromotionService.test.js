'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSamplePromotionService } = require('../src/services/samplePromotionService');

const make = (records) => {
  const updates = [];
  const ledgers = [];
  const inventory = {
    gateway: {
      table: () => ({ fields: { size: '尺码', state: '所属状态' } }),
      update: async (table, id, fields, options) => { updates.push({ table, id, fields, options }); },
      createBatch: async (table, rows, options) => { ledgers.push({ table, rows, options }); return rows.map((_, i) => ({ recordId: 'ledger_' + i })); },
    },
    sizeReferences: {
      resolveLinkedCell: async () => ({ size: 41 }),
    },
    readLiveInventoryForProduct: async () => records,
    resolveStockBehavior: async () => ({ recordId: 'behavior_sample' }),
  };
  const service = createSamplePromotionService({
    inventory,
    logger: { logInfo() {}, logWarn() {} },
  });
  return { service, updates, ledgers };
};

const rec = (id, state) => ({ record_id: id, fields: { 尺码: [{ record_ids: ['size_41'] }], 所属状态: state } });

test('AC-SAMPLE-SVC1 门盒 ⇒ 改样品 + 写 STOCK_TO_SAMPLE 流水', async () => {
  const { service, updates, ledgers } = make([rec('live_1', '门盒')]);
  const out = await service.promote({ productRecordId: 'p1', size: 41, salesDetailRecordId: 'd1', requestId: 'req1' });
  assert.equal(out.ok, true);
  assert.equal(out.fromState, '门盒');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].fields, { state: '样品' });
  assert.equal(ledgers.length, 1);
  assert.equal(ledgers[0].rows[0].quantityChange, 0);
  assert.deepEqual(ledgers[0].rows[0].behavior, ['behavior_sample']);
});

test('AC-SAMPLE-SVC2 空状态 ⇒ 也可以改成样品', async () => {
  const { service, updates } = make([rec('live_1', '')]);
  const out = await service.promote({ productRecordId: 'p1', size: 41, requestId: 'req2' });
  assert.equal(out.ok, true);
  assert.equal(updates[0].fields.state, '样品');
});

test('AC-SAMPLE-SVC3 已经有样品 ⇒ 跳过（幂等，不改第二次）', async () => {
  const { service, updates } = make([rec('live_1', '样品')]);
  const out = await service.promote({ productRecordId: 'p1', size: 41, requestId: 'req3' });
  assert.equal(out.ok, true);
  assert.equal(out.skipped, 'already_sample');
  assert.equal(updates.length, 0);
});

test('AC-SAMPLE-SVC4 没有库存 ⇒ no_stock，不写任何东西', async () => {
  const { service, updates, ledgers } = make([]);
  const out = await service.promote({ productRecordId: 'p1', size: 41, requestId: 'req4' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'no_stock');
  assert.equal(updates.length, 0);
  assert.equal(ledgers.length, 0);
});
