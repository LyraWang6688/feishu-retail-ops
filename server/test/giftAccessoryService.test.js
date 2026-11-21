'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGiftAccessoryService } = require('../src/services/giftAccessoryService');
const { resetConfigTableCache, invalidateConfigTable } = require('../src/services/configTableCache');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const makeGateway = (rows) => {
  const calls = { n: 0 };
  const table = V1_BITABLE_SCHEMA.tables.accessory;
  return {
    calls,
    table: (key) => (key === 'accessory' ? table : null),
    listAll: async (key) => { calls.n += 1; assert.equal(key, 'accessory'); return rows; },
  };
};

test('AC-GF1 赠品候选只返回 赠品=true，未勾选不进缓存', async () => {
  resetConfigTableCache();
  const gateway = makeGateway([
    { record_id: 'r1', fields: { 名称: '鞋油', 种类: ['鞋油'], 赠品: true } },
    { record_id: 'r2', fields: { 名称: '39元腰带', 种类: ['腰带'], 赠品: false } },
    { record_id: 'r3', fields: { 名称: '袜子', 种类: ['袜子'], 赠品: true } },
    { record_id: 'r4', fields: { 名称: '未勾选', 种类: ['其他'], 赠品: false } },
  ]);
  const service = createGiftAccessoryService({ gateway, table: { ...V1_BITABLE_SCHEMA.tables.accessory, tableId: 'tbl_test_accessory' } });
  const items = await service.list();
  assert.deepEqual(items.map((item) => item.name), ['鞋油', '袜子']);
  assert.equal(gateway.calls.n, 1);
  await service.list();
  assert.equal(gateway.calls.n, 1, '第二次读赠品候选命中缓存，不重读全表');
});

test('AC-GF3 配品候选返回全部其他配品（不按赠品过滤）', async () => {
  const gateway = makeGateway([
    { record_id: 'r1', fields: { 名称: '鞋油', 种类: ['鞋油'], 赠品: true } },
    { record_id: 'r2', fields: { 名称: '39元腰带', 种类: ['腰带'], 赠品: false } },
  ]);
  const service = createGiftAccessoryService({ gateway, table: { ...V1_BITABLE_SCHEMA.tables.accessory, tableId: 'tbl_test_accessory' } });
  const items = await service.listAll();
  assert.deepEqual(items.map((item) => item.name), ['鞋油', '39元腰带']);
  await service.listAll();
  assert.equal(gateway.calls.n, 1, '添加配品候选整表读命中 accessory 缓存');
  invalidateConfigTable('accessory');
  await service.listAll();
  assert.equal(gateway.calls.n, 2, '其他配品记录变更后重新读');
});

test('AC-GF2 赠品候选缓存被 record_changed 失效后会重读', async () => {
  resetConfigTableCache();
  const gateway = makeGateway([
    { record_id: 'r1', fields: { 名称: '鞋油', 种类: ['鞋油'], 赠品: true } },
  ]);
  const service = createGiftAccessoryService({ gateway, table: { ...V1_BITABLE_SCHEMA.tables.accessory, tableId: 'tbl_test_accessory' } });
  await service.list();
  invalidateConfigTable('accessory');
  invalidateConfigTable('giftAccessory');
  await service.list();
  assert.equal(gateway.calls.n, 2);
});
