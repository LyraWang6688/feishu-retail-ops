'use strict';

/**
 * 「待验收批次列表」缓存与「发生行为含入库」筛选的验收标准。
 * 2026-11-20：到货状态字段已删除；候选 = 发生行为不包含「入库」。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_pending_cache';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'pending_cache_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { PurchasePendingBatchService } = require('../src/services/purchasePendingBatchService');
const { normalizeLinkFields } = require('./support/linkReadShape');

const F = V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields;
const B = V1_BITABLE_SCHEMA.tables.behavior.fields;
const D = V1_BITABLE_SCHEMA.tables.purchaseRequest.fields;

const makeRecords = () => ([
  {
    record_id: 'rec_pending_1',
    fields: {
      [F.behavior]: [], [F.batchNo]: 'CGD-1',
      [F.createdAt]: '2026-10-12', [F.quantity]: '3',
    },
  },
  {
    record_id: 'rec_pending_2',
    fields: { [F.behavior]: [], [F.batchNo]: '', [F.createdAt]: '', [F.quantity]: '' },
  },
  {
    record_id: 'rec_done',
    fields: { [F.behavior]: ['behavior_in'], [F.batchNo]: 'CGD-2' },
  },
]);

const makeDetails = () => ([
  { record_id: 'detail_1', fields: { [D.batchNo]: [{ record_ids: ['rec_pending_1'] }], [D.supplier]: '金猴' } },
]);

const makeFake = (records = makeRecords(), details = makeDetails()) => {
  const calls = [];
  const behaviors = [
    { record_id: 'behavior_in', fields: { [B.code]: 'PURCHASE_IN' } },
    { record_id: 'behavior_ret', fields: { [B.code]: 'PURCHASE_RETURN' } },
  ];
  return {
    calls,
    records,
    behaviors,
    reads: () => calls.filter((call) => call.kind === 'listAll'),
    gateway: {
      table: (key) => V1_BITABLE_SCHEMA.tables[key],
      listAll: async (key, options) => {
        calls.push({ kind: 'listAll', key, options });
        const rows = key === 'purchaseRequest' ? details : key === 'behavior' ? behaviors : records;
        return rows.map((row) => ({ record_id: row.record_id, fields: normalizeLinkFields(row.fields) }));
      },
      listByFilter: async () => { throw new Error('不应再按到达状态过滤'); },
    },
  };
};

const makeService = (fake, { ttlMs = 30000, clock = { now: 1000 } } = {}) => ({
  clock,
  service: new PurchasePendingBatchService({
    gateway: fake.gateway,
    cacheTtlMs: ttlMs,
    now: () => clock.now,
  }),
});

test('AC-P1 冷读：批次 + 行为表 + 供应商索引，按「不含入库」筛', async () => {
  const fake = makeFake();
  const { service } = makeService(fake);
  const batches = await service.listPendingBatches();
  assert.equal(fake.reads().length, 3, '批次 + 行为表 + 采购明细三次');
  assert.deepEqual(batches.map((row) => row.recordId), ['rec_pending_1']);
  assert.deepEqual(batches[0].suppliers, ['金猴']);
  assert.ok(fake.reads().every((call) => call.kind === 'listAll'));
});

test('AC-P2 TTL 内重复读 ⇒ 零飞书调用', async () => {
  const fake = makeFake();
  const { service, clock } = makeService(fake);
  const first = await service.listPendingBatches();
  const readsAfterCold = fake.reads().length;
  clock.now += 1000;
  const second = await service.listPendingBatches();
  assert.equal(fake.reads().length, readsAfterCold);
  assert.deepEqual(second, first);
});

test('AC-P3 TTL 过期 ⇒ 批次 + 明细重新读（行为表 id 已缓存）', async () => {
  const fake = makeFake();
  const { service, clock } = makeService(fake);
  await service.listPendingBatches();
  assert.equal(fake.reads().length, 3);
  clock.now += 30001;
  await service.listPendingBatches();
  assert.equal(fake.reads().length, 5);
});

test('AC-P4 invalidate() ⇒ 立刻反映「已入库」', async () => {
  const fake = makeFake();
  const { service } = makeService(fake);
  await service.listPendingBatches();
  fake.records[0].fields[F.behavior] = ['behavior_in'];
  service.invalidate();
  const after = await service.listPendingBatches();
  assert.deepEqual(after.map((row) => row.recordId), []);
});

test('AC-P5 内容与「整表读 + 行为不含入库」口径逐条相同', async () => {
  const records = makeRecords();
  const details = makeDetails();
  const fake = makeFake(records, details);
  const { service } = makeService(fake);
  const got = await service.listPendingBatches();
  const expected = records
    .filter((record) => !(record.fields?.[F.behavior] || []).includes('behavior_in'))
    .map((record) => ({
      batchNo: String(record.fields?.[F.batchNo] ?? '').trim(),
      recordId: record.record_id,
      suppliers: ['金猴'].filter(() => record.record_id === 'rec_pending_1'),
      reportedAt: record.fields?.[F.createdAt] ?? '',
      quantity: String(record.fields?.[F.quantity] ?? '').trim(),
    }))
    .filter((item) => item.batchNo);
  assert.deepEqual(got, expected);
});

test('AC-P7 缓存 TTL 可配、非法值抛错', () => {
  const { resolvePendingCacheTtlMs } = require('../src/config/purchasePendingCache');
  assert.equal(resolvePendingCacheTtlMs({ SCAN_ACCEPT_PENDING_CACHE_TTL_MS: '60000' }), 60000);
  assert.equal(resolvePendingCacheTtlMs({ SCAN_ACCEPT_PENDING_CACHE_TTL_MS: '' }), 45000);
  assert.equal(resolvePendingCacheTtlMs({}), 45000);
  assert.throws(() => resolvePendingCacheTtlMs({ SCAN_ACCEPT_PENDING_CACHE_TTL_MS: 'abc' }),
    /SCAN_ACCEPT_PENDING_CACHE_TTL_MS/);
});
