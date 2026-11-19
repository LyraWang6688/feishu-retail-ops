'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPurchaseAcceptanceSampleService } = require('../src/services/purchaseAcceptanceSampleService');

const make = (records) => {
  const gateway = {
    table: (key) => key === 'liveInventory' ? { fields: { product: '货品', state: '所属状态' } } : null,
    listAll: async () => records,
  };
  return createPurchaseAcceptanceSampleService({ gateway });
};

const rec = (id, product, state) => ({
  record_id: id,
  fields: { 货品: [{ record_ids: [product] }], 所属状态: state },
});

test('AC-SAMPLE-STATE1 无库存 / 有库存无样品 / 有样品 三种判断', async () => {
  const service = make([
    rec('l1', 'p_box', '门盒'),
    rec('l2', 'p_sample', '样品'),
    rec('l3', 'p_sample', '门盒'),
  ]);
  const states = await service.stateOfProducts(['p_empty', 'p_box', 'p_sample']);
  assert.deepEqual(states.get('p_empty'), {
    hasStock: false, hasSample: false, needsSampleChoice: true, unavailable: false,
  });
  assert.deepEqual(states.get('p_box'), {
    hasStock: true, hasSample: false, needsSampleChoice: true, unavailable: false,
  });
  assert.deepEqual(states.get('p_sample'), {
    hasStock: true, hasSample: true, needsSampleChoice: false, unavailable: false,
  });
});

test('AC-SAMPLE-STATE2 读不到实时库存 ⇒ unavailable，不假装“没有样品”', async () => {
  const gateway = {
    table: () => ({ fields: { product: '货品', state: '所属状态' } }),
    listAll: async () => { throw new Error('boom'); },
  };
  const service = createPurchaseAcceptanceSampleService({ gateway });
  const states = await service.stateOfProducts(['p1']);
  assert.equal(states.get('p1').unavailable, true);
});

test('AC-SAMPLE-STATE3 30 秒内复用实时库存快照，不重复整表读', async () => {
  let calls = 0;
  const gateway = {
    table: () => ({ fields: { product: '货品', state: '所属状态' } }),
    listAll: async () => { calls += 1; return [rec('l1', 'p1', '门盒')]; },
  };
  const service = createPurchaseAcceptanceSampleService({ gateway, now: () => 1000 });
  await service.stateOfProducts(['p1']);
  await service.stateOfProducts(['p1']);
  assert.equal(calls, 1, '第二次应命中短 TTL 缓存');
});

test('AC-SAMPLE-STATE4 有 recordID 查找列时按本批货品精确读，不整表读', async () => {
  const calls = { filters: [], listAll: 0 };
  const gateway = {
    table: () => ({ fields: { product: '货品', state: '所属状态', recordId: 'recordID' } }),
    listByFilter: async (tableKey, formula) => {
      calls.filters.push({ tableKey, formula });
      return [rec('l1', 'p1', '门盒')];
    },
    listAll: async () => { calls.listAll += 1; return []; },
  };
  const service = createPurchaseAcceptanceSampleService({ gateway, now: () => 1000 });
  const states = await service.stateOfProducts(['p1', 'p2']);
  assert.equal(calls.listAll, 0, '不许整表读 liveInventory');
  assert.equal(calls.filters.length, 1);
  assert.match(calls.filters[0].formula, /recordID/);
  assert.match(calls.filters[0].formula, /p1/);
  assert.match(calls.filters[0].formula, /p2/);
  assert.equal(states.get('p1').hasStock, true);
});
