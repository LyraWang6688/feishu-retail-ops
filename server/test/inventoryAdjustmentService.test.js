const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { InventoryService, ADJUSTMENT_BEHAVIORS } = require('../src/services/inventoryService');
const { InventoryAdjustmentService, ADJUSTMENT_ACTIONS, COUNT_MODES } = require('../src/services/inventoryAdjustmentService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

// 「库存手工调整」的验收标准（先写预期，再对照跑）：
//   ① 盘点调整改**数量**，可增可减：盘多了加、盘少了减；
//   ② 换季调整改**状态**，**数量一双都不变**（不新建、不删除实时库存记录）；
//   ③ 幂等：同一次提交重试（requestId 不变）不得重复加/减；
//   ④ 方向=不影响的行为**绝不**走数量通路（否则凭空建鞋且账面看不出来）——
//      断言方式是"实时库存条数不变 + 流水变动数量为 0"。
const behavior = (recordId, code, name, direction) => ({
  record_id: recordId,
  fields: { 行为编码: code, 行为名称: name, 库存方向: direction, 是否启用: true },
});

const BEHAVIORS = [
  behavior('behavior_manual_increase', 'STOCK_MANUAL_INCREASE', '手工调增', '增加'),
  behavior('behavior_manual_decrease', 'STOCK_MANUAL_DECREASE', '手工调减', '减少'),
  behavior('behavior_freeze', 'STOCK_FREEZE', '转冻结', '不影响'),
  behavior('behavior_unfreeze', 'STOCK_UNFREEZE', '转释放', '不影响'),
];

const SIZES = [38, 40, 41, 42, 43, 44].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));

const gatewayFor = (live, extraBehaviors = []) => {
  const records = new Map([
    ['liveInventory', live],
    ['behavior', [...BEHAVIORS, ...extraBehaviors]],
    ['sizeManagement', SIZES],
  ]);
  let seq = 0;
  return {
    records,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    validateTables: async () => [],
    listAll: async (key) => records.get(key) || [],
    create: async (key, values) => {
      const recordId = `rec_${++seq}`;
      const fields = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)
        .map(([name, value]) => [V1_BITABLE_SCHEMA.tables[key].fields[name], value]));
      if (!records.has(key)) records.set(key, []);
      records.get(key).push({ record_id: recordId, fields });
      return { recordId };
    },
    delete: async (key, id) => records.set(key, records.get(key).filter((row) => row.record_id !== id)),
    get: async (key, id) => (records.get(key) || []).find((row) => row.record_id === id),
    update: async (key, id, values) => {
      const record = (records.get(key) || []).find((row) => row.record_id === id);
      Object.assign(record.fields, Object.fromEntries(Object.entries(values)
        .map(([name, value]) => [V1_BITABLE_SCHEMA.tables[key].fields[name], value])));
      return record;
    },
  };
};

const store = () => new JsonTaskStore({
  dir: fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-adjustment-')), idField: 'operation_id',
});
const unit = (id, state) => ({ record_id: id, fields: { 编号: ['product_1'], 尺码: ['size_38'], 所属状态: state } });
const setup = (live, extraBehaviors) => {
  const gateway = gatewayFor(live, extraBehaviors);
  const inventory = new InventoryService({ gateway, store: store() });
  return { gateway, inventory, adjustment: new InventoryAdjustmentService({ inventory }) };
};
const ledger = (gateway) => (gateway.records.get('inventoryLedger') || []).map((row) => row.fields);
const states = (gateway) => gateway.records.get('liveInventory').map((row) => row.fields['所属状态']);

test('盘点调整：实际盘点数比账面多 → 走手工调增，按差额新建实时库存', async () => {
  const { gateway, adjustment } = setup([unit('door_1', '门盒'), unit('door_2', '门盒')]);

  const result = await adjustment.adjustCount({ productRecordId: 'product_1', size: 38, state: '门盒',
    mode: COUNT_MODES.COUNTED, countedQuantity: 4, requestId: 'req-1' });

  assert.equal(result.action, ADJUSTMENT_ACTIONS.COUNT_INCREASE);
  assert.equal(result.delta, 2);
  assert.equal(result.before_quantity, 2);
  assert.equal(result.after_quantity, 4);
  assert.equal(gateway.records.get('liveInventory').length, 4, '多出来的 2 双必须真的建出来');
  assert.equal(ledger(gateway).length, 1);
  // 「变动数量」存的是**绝对值**，增减靠「库存行为」的库存方向表达。
  assert.equal(ledger(gateway)[0]['变动数量'], 2);
  assert.deepEqual(ledger(gateway)[0]['库存行为'], ['behavior_manual_increase']);
});

test('盘点调整：实际盘点数比账面少 → 走手工调减，按差额删掉实时库存', async () => {
  const { gateway, adjustment } = setup([
    unit('door_1', '门盒'), unit('door_2', '门盒'), unit('door_3', '门盒'),
  ]);

  const result = await adjustment.adjustCount({ productRecordId: 'product_1', size: 38, state: '门盒',
    mode: COUNT_MODES.COUNTED, countedQuantity: 1, requestId: 'req-1' });

  assert.equal(result.action, ADJUSTMENT_ACTIONS.COUNT_DECREASE);
  assert.equal(result.delta, -2);
  assert.equal(result.after_quantity, 1);
  assert.equal(gateway.records.get('liveInventory').length, 1);
  assert.equal(ledger(gateway)[0]['变动数量'], 2, '流水里仍是绝对值 2，不是 -2');
  assert.deepEqual(ledger(gateway)[0]['库存行为'], ['behavior_manual_decrease']);
});

test('盘点调整：按增减数量直接提交（正数加、负数减）', async () => {
  const { gateway, adjustment } = setup([unit('door_1', '门盒')]);

  await adjustment.adjustCount({ productRecordId: 'product_1', size: 38, state: '门盒',
    mode: COUNT_MODES.DELTA, delta: 2, requestId: 'req-a' });
  await adjustment.adjustCount({ productRecordId: 'product_1', size: 38, state: '门盒',
    mode: COUNT_MODES.DELTA, delta: -1, requestId: 'req-b' });

  assert.equal(gateway.records.get('liveInventory').length, 2);
  assert.equal(ledger(gateway).length, 2);
});

test('盘点调整：同一个 requestId 重试不会加两次（幂等）', async () => {
  const { gateway, adjustment } = setup([unit('door_1', '门盒')]);
  const request = { productRecordId: 'product_1', size: 38, state: '门盒',
    mode: COUNT_MODES.COUNTED, countedQuantity: 3, requestId: 'req-retry' };

  await adjustment.adjustCount(request);
  const second = await adjustment.adjustCount(request);

  assert.equal(second.after_quantity, 3, '重试返回的还是同一个目标数量');
  assert.equal(gateway.records.get('liveInventory').length, 3, '不得变成 5 双');
  assert.equal(ledger(gateway).length, 1, '不得写第二条流水');
});

test('盘点调整：实际盘点数与账面一致 → 报错，且一个字都不写', async () => {
  const { gateway, adjustment } = setup([unit('door_1', '门盒'), unit('door_2', '门盒')]);

  await assert.rejects(adjustment.adjustCount({ productRecordId: 'product_1', size: 38, state: '门盒',
    mode: COUNT_MODES.COUNTED, countedQuantity: 2, requestId: 'req-same' }), /不需要调整/);

  assert.equal(gateway.records.get('liveInventory').length, 2);
  assert.equal(gateway.records.get('inventoryLedger'), undefined);
});

test('盘点调整：增减数量为 0 / 尺码不是整数 → 入参报错（statusCode=400）', async () => {
  const { adjustment } = setup([unit('door_1', '门盒')]);
  await assert.rejects(adjustment.adjustCount({ productRecordId: 'product_1', size: 38, state: '门盒',
    mode: COUNT_MODES.DELTA, delta: 0, requestId: 'req-zero' }),
  (error) => error.statusCode === 400 && /不能为 0/.test(error.message));
  await assert.rejects(adjustment.adjustCount({ productRecordId: 'product_1', size: '四十二', state: '门盒',
    mode: COUNT_MODES.DELTA, delta: 1, requestId: 'req-size' }),
  (error) => error.statusCode === 400 && /必须是整数/.test(error.message));
});

test('换季调整：转冻结只改「所属状态」，一条记录都不增删，流水变动数量为 0', async () => {
  const { gateway, adjustment } = setup([unit('door_1', '门盒'), unit('door_2', '门盒'), unit('sample_1', '样品')]);

  const result = await adjustment.adjustSeason({ action: ADJUSTMENT_ACTIONS.SEASON_FREEZE,
    targets: [{ productRecordId: 'product_1', size: 38, state: '门盒', quantity: 2 }], requestId: 'req-freeze' });

  assert.equal(result.succeeded, 1);
  assert.equal(gateway.records.get('liveInventory').length, 3, '不新建也不删除');
  assert.deepEqual(states(gateway).sort(), ['仓库', '仓库', '样品']);
  assert.equal(ledger(gateway)[0]['变动数量'], 0, '状态变更不改变数量，流水记 0');
  assert.deepEqual(ledger(gateway)[0]['库存行为'], ['behavior_freeze']);
  assert.equal(ledger(gateway)[0]['关联销售'], undefined, '人工调整没有来源列，整列不写');
});

test('换季调整：转释放必须由界面选回门盒还是样品', async () => {
  const { gateway, adjustment } = setup([unit('wh_1', '仓库'), unit('wh_2', '仓库')]);

  await assert.rejects(adjustment.adjustSeason({ action: ADJUSTMENT_ACTIONS.SEASON_RELEASE,
    targets: [{ productRecordId: 'product_1', size: 38, state: '仓库', quantity: 1 }], requestId: 'req-x' }),
  (error) => error.statusCode === 400 && /释放回哪里/.test(error.message));
  assert.deepEqual(states(gateway), ['仓库', '仓库'], '没选目标状态时不得动库存');

  // 选「样品」→ 仓库 → 样品；再选「门盒」→ 另一个回门盒。
  await adjustment.adjustSeason({ action: ADJUSTMENT_ACTIONS.SEASON_RELEASE, toState: '样品',
    targets: [{ productRecordId: 'product_1', size: 38, state: '仓库', quantity: 1 }], requestId: 'req-y' });
  await adjustment.adjustSeason({ action: ADJUSTMENT_ACTIONS.SEASON_RELEASE, toState: '门盒',
    targets: [{ productRecordId: 'product_1', size: 38, state: '仓库', quantity: 1 }], requestId: 'req-z' });

  assert.deepEqual(states(gateway).sort(), ['样品', '门盒']);
  assert.equal(gateway.records.get('liveInventory').length, 2);
});

test('换季调整：起点状态不对 / 数量不足 → 逐条报错，库存不动', async () => {
  const { gateway, adjustment } = setup([unit('door_1', '门盒')]);

  // 门盒只有 1 双，却要冻结 2 双。
  const result = await adjustment.adjustSeason({ action: ADJUSTMENT_ACTIONS.SEASON_FREEZE,
    targets: [{ productRecordId: 'product_1', size: 38, state: '门盒', quantity: 2 }], requestId: 'req-short' });

  assert.equal(result.succeeded, 0);
  assert.equal(result.failed, 1);
  assert.match(result.failures[0].error, /门盒库存不足/);
  assert.deepEqual(states(gateway), ['门盒'], '失败时不得改状态');
  assert.equal(gateway.records.get('inventoryLedger'), undefined, '失败时不得写流水');
});

test('换季调整：批量里一条失败不拖垮其它（与销售交付的 failures 形状一致）', async () => {
  const { gateway, adjustment } = setup([
    unit('door_1', '门盒'),
    { record_id: 'door_40', fields: { 编号: ['product_1'], 尺码: ['size_40'], 所属状态: '门盒' } },
  ]);

  const result = await adjustment.adjustSeason({ action: ADJUSTMENT_ACTIONS.SEASON_FREEZE, targets: [
    { productRecordId: 'product_1', size: 38, state: '门盒', quantity: 1 },
    { productRecordId: 'product_1', size: 40, state: '门盒', quantity: 2 },
  ], requestId: 'req-batch' });

  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.failures[0].size, 40);
  assert.deepEqual(states(gateway).sort(), ['仓库', '门盒'], '成功的那条照常生效');
});

test('换季调整：同一批里重复的「货号+尺码+状态」直接拒绝（避免重复扣同一双）', async () => {
  const { adjustment } = setup([unit('door_1', '门盒')]);
  await assert.rejects(adjustment.adjustSeason({ action: ADJUSTMENT_ACTIONS.SEASON_FREEZE, targets: [
    { productRecordId: 'product_1', size: 38, state: '门盒', quantity: 1 },
    { productRecordId: 'product_1', size: 38, state: '门盒', quantity: 1 },
  ], requestId: 'req-dup' }), (error) => error.statusCode === 400 && /重复/.test(error.message));
});

test('换季调整：超过一次批量上限 → 直接拒绝（阈值可配，见 config/inventoryAdjustment.js）', async () => {
  const { adjustment } = setup([]);
  const { INVENTORY_ADJUSTMENT_MAX_TARGETS } = require('../src/config/inventoryAdjustment');
  const targets = Array.from({ length: INVENTORY_ADJUSTMENT_MAX_TARGETS + 1 },
    (_, index) => ({ productRecordId: 'product_1', size: 38 + index, state: '门盒', quantity: 1 }));

  await assert.rejects(adjustment.adjustSeason({ action: ADJUSTMENT_ACTIONS.SEASON_FREEZE, targets, requestId: 'req-big' }),
    (error) => error.statusCode === 400 && /一次最多调整/.test(error.message));
});

test('人工调整的来源 id 由 requestId + 目标身份拼成，同一次提交可重试', () => {
  const { adjustmentSourceId } = require('../src/services/inventoryAdjustmentService');
  const base = { requestId: 'req-1', productRecordId: 'p1', size: 38, state: '门盒' };
  assert.equal(adjustmentSourceId(base), 'req-1:p1:38:门盒');
  assert.equal(adjustmentSourceId(base), adjustmentSourceId({ ...base }), '同样入参必须得到同样来源 id');
  assert.notEqual(adjustmentSourceId(base), adjustmentSourceId({ ...base, state: '仓库' }));
});

test('人工调整把操作人 open_id 落进本地任务与日志（「库存流水」暂时没有「操作人」列）', async () => {
  const { inventory, adjustment } = setup([unit('door_1', '门盒')]);
  await adjustment.adjustCount({ productRecordId: 'product_1', size: 38, state: '门盒',
    mode: COUNT_MODES.COUNTED, countedQuantity: 2, requestId: 'req-op', operatorOpenId: 'ou_operator' });

  const operations = await inventory.store.list();
  assert.equal(operations.length, 1);
  assert.equal(operations[0].operator_open_id, 'ou_operator');
});

test('方向=不影响的行为绝不进数量通路：换季调整不会走到 applyChange', async () => {
  const { inventory } = setup([unit('door_1', '门盒')]);
  await assert.rejects(inventory.applyChange({ kind: ADJUSTMENT_BEHAVIORS.FREEZE,
    productRecordId: 'product_1', size: 38, quantity: 1, sourceRecordId: 'src', state: '门盒' }),
  /属于状态类变更/);
  // 反向也拦：数量类行为不许走状态变更通路。
  await assert.rejects(inventory.transitionState({ kind: ADJUSTMENT_BEHAVIORS.MANUAL_INCREASE,
    productRecordId: 'product_1', size: 38, fromState: '门盒', quantity: 1, sourceRecordId: 'src' }),
  /属于数量类变更/);
});
