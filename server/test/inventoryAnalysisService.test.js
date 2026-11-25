'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { createInventoryAnalysisService } = require('../src/services/inventoryAnalysisService');
const { resetConfigTableCache } = require('../src/services/configTableCache');

const LIVE = V1_BITABLE_SCHEMA.tables.liveInventory.fields;
const LEDGER = V1_BITABLE_SCHEMA.tables.inventoryLedger.fields;
const BEHAVIOR = V1_BITABLE_SCHEMA.tables.behavior.fields;
const PRODUCT = V1_BITABLE_SCHEMA.tables.product.fields;
const SUPPLIER = V1_BITABLE_SCHEMA.tables.supplier.fields;

const at = (text) => Date.parse(text);

const behavior = (id, name, direction) => ({
  record_id: id,
  fields: { [BEHAVIOR.name]: name, [BEHAVIOR.stockDirection]: direction },
});

const liveRow = ({ product, season, state, category }) => ({
  record_id: 'live_' + product + '_' + (state || 'empty'),
  fields: {
    [LIVE.product]: product ? [{ record_ids: [product] }] : [],
    [LIVE.season]: season,
    [LIVE.state]: state,
    [LIVE.category]: category,
  },
});

const productRow = (id, classType, supplierId) => ({
  record_id: id,
  fields: {
    [PRODUCT.category]: classType ? [classType] : [],
    [PRODUCT.supplier]: supplierId ? [{ record_ids: [supplierId] }] : [],
  },
});

const supplierRow = (id, name) => ({
  record_id: id,
  fields: { [SUPPLIER.name]: name },
});

const ledgerRow = ({ behaviorId, quantity, createdAt }) => ({
  record_id: 'led_' + Math.random().toString(36).slice(2),
  fields: {
    [LEDGER.behavior]: behaviorId ? [{ record_ids: [behaviorId] }] : [],
    [LEDGER.quantityChange]: quantity,
    [LEDGER.ledgerCreatedAt]: createdAt,
  },
});

const gatewayFor = ({ live = [], behaviors = [], ledger = [], products = [], suppliers = [], filterThrows = false } = {}) => {
  const calls = { live: 0, behavior: 0, ledgerFilter: 0, ledgerAll: 0 };
  return {
    calls,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => {
      if (key === 'liveInventory') { calls.live += 1; return live; }
      if (key === 'behavior') { calls.behavior += 1; return behaviors; }
      if (key === 'inventoryLedger') { calls.ledgerAll += 1; return ledger; }
      if (key === 'product') return products;
      if (key === 'supplier') return suppliers;
      return [];
    },
    listByFilter: async (key, formula, options = {}) => {
      calls.ledgerFilter += 1;
      if (filterThrows) {
        throw Object.assign(new Error('Request failed with status code 400'), {
          response: { status: 400, data: { code: 1254607, msg: 'Data not ready' } },
        });
      }
      const max = Number(options.maxRecords) > 0 ? Number(options.maxRecords) : ledger.length;
      return ledger.slice(0, max);
    },
  };
};

const serviceFor = (gateway) => createInventoryAnalysisService({
  gateway,
  now: () => new Date('2026-11-25T12:00:00+08:00'),
});

const baseLive = () => [
  liveRow({ product: 'p1', season: true, state: '门盒', category: '单鞋' }),
  liveRow({ product: 'p1', season: true, state: '样品', category: '单鞋' }),
  liveRow({ product: 'p2', season: true, state: '', category: '棉鞋' }),
  liveRow({ product: 'p3', season: false, state: '门盒', category: '方口鞋' }),
];

const baseProducts = () => [
  productRow('p1', '男', 's1'),
  productRow('p2', '女', ''),
  productRow('p3', '女', 's1'),
];

const baseSuppliers = () => [supplierRow('s1', '信踏')];

const baseBehaviors = () => [
  behavior('b_in', '采购增加', '增加'),
  behavior('b_manual_in', '手工调增', '增加'),
  behavior('b_out', '销售减少', '减少'),
  behavior('b_state', '转样品', '不影响'),
  behavior('b_empty', '销售收入', ''),
];

test.beforeEach(() => resetConfigTableCache());

test('库存现状：季节/状态/品类/类别/供应商口径', async () => {
  const service = serviceFor(gatewayFor({ live: baseLive(), behaviors: baseBehaviors(), products: baseProducts(), suppliers: baseSuppliers(), ledger: [] }));
  const { snapshot } = await service.getOverview({ from: '2026-11-25', to: '2026-11-25' });

  assert.deepEqual(snapshot.total, { pairs: 4, styles: 3 }, '4 双 / 3 款（同编号两条算 1 款）');
  assert.deepEqual(snapshot.seasons.current, { key: 'current', label: '当季', pairs: 3, styles: 2 });
  assert.deepEqual(snapshot.seasons.off, { key: 'off', label: '非当季', pairs: 1, styles: 1 });

  const states = snapshot.current.states;
  assert.equal(states.find((item) => item.key === 'doorbox').pairs, 2, '门盒 + 空状态并入门盒');
  assert.equal(states.find((item) => item.key === 'sample').pairs, 1);

  assert.deepEqual(
    snapshot.current.by_category.map((row) => [row.name, row.pairs, row.styles]),
    [['单鞋', 2, 1], ['棉鞋', 1, 1]],
  );
  assert.equal(snapshot.current.by_category[0].share, 0.667);
  assert.deepEqual(
    snapshot.current.by_class.map((row) => [row.name, row.pairs]),
    [['男', 2], ['女', 1]],
  );
  assert.deepEqual(
    snapshot.current.by_supplier.map((row) => [row.name, row.pairs]),
    [['信踏', 2], ['未分类', 1]],
  );
  assert.equal(snapshot.missing.supplier_pairs, 1);
  assert.equal(snapshot.missing.category_pairs, 0);
});

test('库存变动：增加=入库 / 减少=出库；状态调整只记笔数，不进进出', async () => {
  const ledger = [
    ledgerRow({ behaviorId: 'b_in', quantity: 3, createdAt: at('2026-11-25T09:00:00+08:00') }),
    ledgerRow({ behaviorId: 'b_manual_in', quantity: 2, createdAt: at('2026-11-25T09:10:00+08:00') }),
    ledgerRow({ behaviorId: 'b_out', quantity: 1, createdAt: at('2026-11-25T09:20:00+08:00') }),
    ledgerRow({ behaviorId: 'b_state', quantity: 0, createdAt: at('2026-11-25T09:30:00+08:00') }),
    ledgerRow({ behaviorId: 'b_empty', quantity: 5, createdAt: at('2026-11-25T09:40:00+08:00') }),
    // 区间外：必须被本地上海日期过滤掉
    ledgerRow({ behaviorId: 'b_out', quantity: 100, createdAt: at('2026-11-24T23:00:00+08:00') }),
  ];
  const service = serviceFor(gatewayFor({ live: baseLive(), behaviors: baseBehaviors(), products: baseProducts(), suppliers: baseSuppliers(), ledger }));
  const { change } = await service.getOverview({ from: '2026-11-25', to: '2026-11-25' });

  assert.deepEqual(change.inbound, { records: 2, pairs: 5 });
  assert.deepEqual(change.outbound, { records: 1, pairs: 1 });
  assert.equal(change.net_pairs, 4);
  assert.equal(change.state_anomalies, 0);

  const byKey = new Map(change.groups.map((group) => [group.key, group]));
  assert.deepEqual(byKey.get('inbound').behaviors.map((item) => [item.name, item.records, item.pairs]), [
    ['采购增加', 1, 3],
    ['手工调增', 1, 2],
  ]);
  assert.equal(byKey.get('state').records, 1);
  assert.equal(byKey.get('state').pairs, 0);
  assert.equal(byKey.get('state').behaviors[0].name, '转样品');
  assert.equal(byKey.get('unknown').records, 1, '方向为空的行为进未分类，不并进进出');
  assert.equal(byKey.get('unknown').pairs, 5);
});

test('状态调整里出现非 0 数量 → state_anomalies 记数，但不并进入库/出库', async () => {
  const ledger = [ledgerRow({ behaviorId: 'b_state', quantity: 2, createdAt: at('2026-11-25T09:30:00+08:00') })];
  const service = serviceFor(gatewayFor({ live: baseLive(), behaviors: baseBehaviors(), products: baseProducts(), suppliers: baseSuppliers(), ledger }));
  const { change } = await service.getOverview({ from: '2026-11-25', to: '2026-11-25' });
  assert.equal(change.state_anomalies, 1);
  assert.deepEqual(change.inbound, { records: 0, pairs: 0 });
  assert.deepEqual(change.outbound, { records: 0, pairs: 0 });
  assert.equal(change.net_pairs, 0);
});

test('条件读失败 ⇒ 回退整表读，结果不变并留 fallback 路径', async () => {
  const ledger = [ledgerRow({ behaviorId: 'b_in', quantity: 1, createdAt: at('2026-11-25T09:00:00+08:00') })];
  const gateway = gatewayFor({ live: baseLive(), behaviors: baseBehaviors(), products: baseProducts(), suppliers: baseSuppliers(), ledger, filterThrows: true });
  const { change } = await serviceFor(gateway).getOverview({ from: '2026-11-25', to: '2026-11-25' });
  assert.equal(gateway.calls.ledgerAll, 1);
  assert.deepEqual(change.inbound, { records: 1, pairs: 1 });
});

test('日期区间不合法 / 超过上限 ⇒ 400', async () => {
  const service = serviceFor(gatewayFor({ live: [], behaviors: [], ledger: [] }));
  await assert.rejects(() => service.getOverview({ from: '2026-11-26', to: '2026-11-25' }),
    (error) => error.statusCode === 400);
  await assert.rejects(() => service.getOverview({ from: '2024-01-01', to: '2026-11-25' }),
    (error) => error.statusCode === 400);
});

test('流水超过上限 ⇒ 截断标记 + limit', async () => {
  const ledger = [];
  for (let index = 0; index < 20001; index += 1) {
    ledger.push(ledgerRow({ behaviorId: 'b_in', quantity: 0, createdAt: at('2026-11-25T09:00:00+08:00') }));
  }
  const service = serviceFor(gatewayFor({ live: [], behaviors: baseBehaviors(), ledger }));
  const { change } = await service.getOverview({ from: '2026-11-25', to: '2026-11-25' });
  assert.equal(change.truncated, true);
  assert.equal(change.limit, 20000);
  assert.equal(change.inbound.records, 20000);
});
