const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { InventoryService, operationId, STOCK_MOVEMENTS } = require('../src/services/inventoryService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

// 库存动作现在按「行为编码」匹配，编码是行为管理表里的稳定标识。
const behavior = (recordId, code, name, direction) => ({ record_id: recordId,
  fields: { 行为编码: code, 行为名称: name, 库存方向: direction, 是否启用: true } });

const gatewayFor = (live, behaviors = [
  behavior('behavior_sale', 'STOCK_SALE_DECREASE', '销售减少', '减少'),
  behavior('behavior_purchase', 'STOCK_PURCHASE_INCREASE', '采购增加', '增加'),
]) => {
  const sizes = [38, 40, 41, 42, 43, 44].map((size) => ({
    record_id: `size_${size}`, fields: { 尺码: size },
  }));
  const records = new Map([['liveInventory', live], ['behavior', behaviors], ['sizeManagement', sizes]]);
  let seq = 0;
  return { records, table: (key) => V1_BITABLE_SCHEMA.tables[key], validateTables: async () => [],
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
const store = () => new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-mvp-')), idField: 'operation_id' });
const unit = (id, state) => ({ record_id: id, fields: { 编号: ['product_1'], 尺码: ['size_38'], 所属状态: state } });

test('sale deducts one matching door-box unit, preserves sample, and is idempotent', async () => {
  const gateway = gatewayFor([unit('door_1', '门盒'), unit('door_2', '门盒'), unit('sample_1', '样品')]);
  const inventory = new InventoryService({ gateway, store: store() });
  const request = { salesDetailRecordId: 'detail_1', productRecordId: 'product_1', size: 38, quantity: 1, state: '门盒' };
  await inventory.applySale(request);
  await inventory.applySale(request);
  assert.deepEqual(gateway.records.get('liveInventory').map((row) => row.record_id).sort(), ['door_2', 'sample_1']);
  assert.equal(gateway.records.get('inventoryLedger').length, 1);
  assert.deepEqual(gateway.records.get('inventoryLedger')[0].fields, {
    编号: ['product_1'], 尺码: ['size_38'], 变动数量: 1,
    库存行为: ['behavior_sale'], 关联销售: ['detail_1'],
  });
});

test('sale matches live inventory when Feishu returns product links as record_ids', async () => {
  const linked = [{ record_ids: ['product_1'], text: '6681-1|黑灰|A', type: 'text' }];
  const gateway = gatewayFor([
    { record_id: 'sample_42', fields: { 编号: linked,
      尺码: [{ record_ids: ['size_42'], text: '42', type: 'text' }], 所属状态: ['样品'] } },
    { record_id: 'door_44', fields: { 编号: linked,
      尺码: [{ record_ids: ['size_44'], text: '44', type: 'text' }], 所属状态: ['门盒'] } },
  ]);
  const inventory = new InventoryService({ gateway, store: store() });
  const result = await inventory.applySale({ salesDetailRecordId: 'detail_42',
    productRecordId: 'product_1', size: 42, quantity: 1 });
  assert.deepEqual(result.liveRecordIds, ['sample_42']);
  assert.equal(result.sampleConsumedQuantity, 1);
  assert.deepEqual(result.remainingSizes, [
    { size: 44, doorBoxCount: 1, sampleCount: 0, warehouseCount: 0 },
  ]);
});

test('purchase adds one live record per pair', async () => {
  const gateway = gatewayFor([]);
  const inventory = new InventoryService({ gateway, store: store() });
  await inventory.applyPurchase({ purchaseInboundRecordId: 'inbound_1', productRecordId: 'product_1', size: 38,
    quantity: 2, state: '仓库' });
  assert.equal(gateway.records.get('liveInventory').length, 2);
  assert.ok(gateway.records.get('liveInventory').every((row) => row.fields['所属状态'] === '仓库'));
  assert.ok(gateway.records.get('liveInventory').every((row) =>
    JSON.stringify(row.fields['尺码']) === JSON.stringify(['size_38'])));
  assert.deepEqual(gateway.records.get('inventoryLedger')[0].fields, {
    编号: ['product_1'], 尺码: ['size_38'], 变动数量: 2,
    库存行为: ['behavior_purchase'], 关联采购: ['inbound_1'],
  });
  assert.ok(gateway.records.get('liveInventory').every((row) => !Object.hasOwn(row.fields, '更新时间')));
});

test('a missing or opposite behavior direction never writes stock records', async () => {
  for (const direction of [null, '增加']) {
    const gateway = gatewayFor([unit('door_1', '门盒')], [behavior('behavior_sale', 'STOCK_SALE_DECREASE', '销售减少', direction)]);
    const inventory = new InventoryService({ gateway, store: store() });
    await assert.rejects(inventory.applySale({ salesDetailRecordId: 'detail_1', productRecordId: 'product_1',
      size: 38, quantity: 1 }), /库存方向设置为“减少”/);
    assert.equal(gateway.records.get('inventoryLedger'), undefined);
    assert.equal(gateway.records.get('liveInventory').length, 1);
  }
});

test('inventory preflight checks both sale and purchase behavior settings', async () => {
  const gateway = gatewayFor([], [
    behavior('behavior_sale', 'STOCK_SALE_DECREASE', '销售减少', '减少'),
    { ...behavior('behavior_purchase', 'STOCK_PURCHASE_INCREASE', '采购增加', '增加'), fields: {
      行为编码: 'STOCK_PURCHASE_INCREASE', 行为名称: '采购增加', 库存方向: '增加', 是否启用: false,
    } },
  ]);
  const inventory = new InventoryService({ gateway, store: store() });
  await assert.rejects(inventory.validateStockBehaviors(), /请启用行为管理中的「采购增加」/);
  assert.equal(gateway.records.get('inventoryLedger'), undefined);
});

test('sale consumes a sample only after door-box stock is exhausted and reports remaining sizes', async () => {
  const gateway = gatewayFor([
    unit('sample_1', '样品'),
    { record_id: 'door_40', fields: { 编号: ['product_1'], 尺码: ['size_40'], 所属状态: '门盒' } },
    { record_id: 'warehouse_41', fields: { 编号: ['product_1'], 尺码: ['size_41'], 所属状态: '仓库' } },
  ]);
  const inventory = new InventoryService({ gateway, store: store() });
  const request = { salesDetailRecordId: 'detail_1', productRecordId: 'product_1', size: 38, quantity: 1 };
  const result = await inventory.applySale(request);
  assert.deepEqual(result.liveRecordIds, ['sample_1']);
  assert.equal(result.sampleConsumedQuantity, 1);
  assert.deepEqual(result.remainingSizes, [
    { size: 40, doorBoxCount: 1, sampleCount: 0, warehouseCount: 0 },
    { size: 41, doorBoxCount: 0, sampleCount: 0, warehouseCount: 1 },
  ]);
  await inventory.applySale(request);
  assert.equal(gateway.records.get('inventoryLedger').length, 1);
  assert.deepEqual(gateway.records.get('liveInventory').map((row) => row.record_id), ['door_40', 'warehouse_41']);
});

test('bad remaining-size link cannot turn an already deducted sample sale into a failed delivery', async () => {
  const gateway = gatewayFor([
    unit('sample_38', '样品'),
    { record_id: 'door_bad', fields: { 编号: ['product_1'], 尺码: ['missing_size'], 所属状态: '门盒' } },
  ]);
  const taskStore = store();
  const inventory = new InventoryService({ gateway, store: taskStore });
  const request = { salesDetailRecordId: 'detail_bad_candidate', productRecordId: 'product_1',
    size: 38, quantity: 1 };
  const result = await inventory.applySale(request);
  assert.equal(result.sampleConsumedQuantity, 1);
  assert.equal(result.replacementCandidatesUnavailable, true);
  assert.deepEqual(result.remainingSizes, []);
  assert.deepEqual(result.liveRecordIds, ['sample_38']);
  assert.equal((await taskStore.get(operationId('STOCK_SALE_DECREASE', request.salesDetailRecordId))).status, 'completed');
  assert.deepEqual(gateway.records.get('liveInventory').map((record) => record.record_id), ['door_bad']);
  assert.equal(gateway.records.get('inventoryLedger').length, 1);
  assert.deepEqual(await inventory.applySale(request), result);
  assert.equal(gateway.records.get('inventoryLedger').length, 1);

  gateway.records.get('liveInventory')[0].fields['尺码'] = ['size_40'];
  assert.deepEqual(await inventory.sampleReplacementCandidates('product_1'), [
    { size: 40, doorBoxCount: 1, sampleCount: 0, warehouseCount: 0 },
  ]);
});

test('an interrupted sample deduction resumes without deleting stock twice', async () => {
  const gateway = gatewayFor([
    unit('sample_38', '样品'),
    { record_id: 'door_bad', fields: { 编号: ['product_1'], 尺码: ['missing_size'], 所属状态: '门盒' } },
  ]);
  const taskStore = store();
  const originalUpdate = taskStore.update.bind(taskStore);
  let failCompletionOnce = true;
  taskStore.update = async (id, changes) => {
    if (changes.status === 'completed' && failCompletionOnce) {
      failCompletionOnce = false;
      throw new Error('模拟任务完成状态持久化中断');
    }
    return originalUpdate(id, changes);
  };
  const inventory = new InventoryService({ gateway, store: taskStore });
  const request = { salesDetailRecordId: 'detail_interrupted', productRecordId: 'product_1',
    size: 38, quantity: 1 };
  await assert.rejects(inventory.applySale(request), /持久化中断/);
  assert.deepEqual(gateway.records.get('liveInventory').map((record) => record.record_id), ['door_bad']);
  const result = await inventory.applySale(request);
  assert.deepEqual(result.liveRecordIds, ['sample_38']);
  assert.equal(result.replacementCandidatesUnavailable, true);
  assert.equal(gateway.records.get('inventoryLedger').length, 1);
  assert.equal((await taskStore.get(operationId('STOCK_SALE_DECREASE', request.salesDetailRecordId))).status, 'completed');
});

test('a sale never consumes warehouse stock and does not write a ledger when total floor stock is short', async () => {
  const gateway = gatewayFor([unit('sample_1', '样品'), unit('warehouse_1', '仓库')]);
  const inventory = new InventoryService({ gateway, store: store() });
  await assert.rejects(inventory.applySale({ salesDetailRecordId: 'detail_1', productRecordId: 'product_1',
    size: 38, quantity: 2 }), /门盒和样品库存不足/);
  assert.equal(gateway.records.get('inventoryLedger'), undefined);
  assert.equal(gateway.records.get('liveInventory').length, 2);
});

test('sample replacement moves one selected door-box pair without changing total quantity and is idempotent', async () => {
  const gateway = gatewayFor([
    { record_id: 'door_40', fields: { 编号: ['product_1'], 尺码: ['size_40'], 所属状态: '门盒' } },
    { record_id: 'door_41', fields: { 编号: ['product_1'], 尺码: ['size_41'], 所属状态: '门盒' } },
  ], [behavior('behavior_sample', 'STOCK_DOORBOX_TO_SAMPLE', '门盒转样品', '不影响')]);
  const inventory = new InventoryService({ gateway, store: store() });
  const request = { salesDetailRecordId: 'detail_sold_sample', productRecordId: 'product_1', size: 40 };
  const first = await inventory.promoteToSample(request);
  const again = await inventory.promoteToSample(request);
  assert.deepEqual(again, first);
  assert.equal(gateway.records.get('liveInventory').length, 2);
  assert.equal(gateway.records.get('liveInventory')[0].fields['所属状态'], '样品');
  assert.equal(gateway.records.get('liveInventory')[1].fields['所属状态'], '门盒');
  assert.equal(gateway.records.get('inventoryLedger').length, 1);
  assert.deepEqual(gateway.records.get('inventoryLedger')[0].fields, {
    编号: ['product_1'], 尺码: ['size_40'], 变动数量: 0,
    库存行为: ['behavior_sample'], 关联销售: ['detail_sold_sample'],
  });
  await assert.rejects(inventory.promoteToSample({ ...request, size: 41 }), /已选择其他补样品尺码/);
});

test('sample replacement refuses an unconfigured behavior before writing records', async () => {
  const gateway = gatewayFor([unit('door_1', '门盒')], [behavior('behavior_sample', 'STOCK_DOORBOX_TO_SAMPLE', '门盒转样品', null)]);
  const inventory = new InventoryService({ gateway, store: store() });
  await assert.rejects(inventory.promoteToSample({ salesDetailRecordId: 'detail_1',
    productRecordId: 'product_1', size: 38 }), /库存方向设置为“不影响”/);
  assert.equal(gateway.records.get('inventoryLedger'), undefined);
  assert.equal(gateway.records.get('liveInventory')[0].fields['所属状态'], '门盒');
});

const legacyPurchase = async ({ ledgerSize = ['size_38'], liveSize = ['size_38'],
  includeLedger = true } = {}) => {
  const live = { record_id: 'legacy_live', fields: {
    编号: ['product_1'], 尺码: liveSize, 所属状态: '门盒',
  } };
  const gateway = gatewayFor([live]);
  if (includeLedger) gateway.records.set('inventoryLedger', [{ record_id: 'legacy_ledger', fields: {
    编号: ['product_1'], 尺码: ledgerSize, 变动数量: 2,
    库存行为: ['behavior_purchase'], 关联采购: ['inbound_legacy'],
  } }]);
  const taskStore = store();
  const id = operationId('STOCK_PURCHASE_INCREASE', 'inbound_legacy');
  await taskStore.create({
    operation_id: id, type: 'inventory_change', schema_version: 2,
    status: includeLedger ? 'ledger_created' : 'prepared', kind: 'STOCK_PURCHASE_INCREASE',
    stock_key: 'product_1|38|门盒', product_record_id: 'product_1', size: 38,
    state: '门盒', quantity: 2, direction: '增加',
    behavior_record_id: 'behavior_purchase', source_record_id: 'inbound_legacy',
    ledger_record_id: includeLedger ? 'legacy_ledger' : undefined,
    live_record_ids: [], created_live_record_ids: ['legacy_live'],
    removed_live_record_ids: [], target_quantity: 2,
  });
  const inventory = new InventoryService({ gateway, store: taskStore });
  const request = { purchaseInboundRecordId: 'inbound_legacy', productRecordId: 'product_1',
    size: 38, quantity: 2, state: '门盒' };
  return { gateway, taskStore, id, inventory, request };
};

test('version 2 purchase refuses an old numeric-size ledger before adding stock', async () => {
  for (const ledgerSize of [38, ['size_40']]) {
    const { gateway, taskStore, id, inventory, request } = await legacyPurchase({ ledgerSize });
    await assert.rejects(inventory.applyPurchase(request), /已有库存流水.*尺码关联.*不能自动恢复/);
    assert.equal(gateway.records.get('liveInventory').length, 1);
    assert.notEqual((await taskStore.get(id)).status, 'completed');
  }
});

test('version 2 purchase refuses an old numeric-size live row before adding stock', async () => {
  for (const liveSize of [38, ['size_40']]) {
    const { gateway, taskStore, id, inventory, request } = await legacyPurchase({ liveSize });
    await assert.rejects(inventory.applyPurchase(request), /已有实时库存.*尺码关联.*不能自动恢复/);
    assert.equal(gateway.records.get('liveInventory').length, 1);
    assert.equal(gateway.records.get('inventoryLedger').length, 1);
    assert.notEqual((await taskStore.get(id)).status, 'completed');
  }
});

test('version 2 purchase resumes only after existing ledger and live row links verify', async () => {
  const { gateway, taskStore, id, inventory, request } = await legacyPurchase();
  const result = await inventory.applyPurchase(request);
  assert.equal(result.ledgerRecordId, 'legacy_ledger');
  assert.equal(gateway.records.get('inventoryLedger').length, 1);
  assert.equal(gateway.records.get('liveInventory').length, 2);
  assert.ok(gateway.records.get('liveInventory').every((record) =>
    JSON.stringify(record.fields['尺码']) === JSON.stringify(['size_38'])));
  assert.equal((await taskStore.get(id)).status, 'completed');
});

test('version 2 purchase without a confirmable ledger stops for manual reconciliation', async () => {
  const { gateway, taskStore, id, inventory, request } = await legacyPurchase({ includeLedger: false });
  await assert.rejects(inventory.applyPurchase(request), /未能确认已有流水.*人工核对/);
  assert.equal(gateway.records.get('inventoryLedger'), undefined);
  assert.notEqual((await taskStore.get(id)).status, 'completed');
});

test('version 2 sale with already deleted stock cannot silently complete', async () => {
  const gateway = gatewayFor([]);
  gateway.records.set('inventoryLedger', [{ record_id: 'sale_ledger', fields: {
    编号: ['product_1'], 尺码: ['size_38'], 变动数量: 1,
    库存行为: ['behavior_sale'], 关联销售: ['detail_legacy'],
  } }]);
  const taskStore = store();
  const id = operationId('STOCK_SALE_DECREASE', 'detail_legacy');
  await taskStore.create({
    operation_id: id, type: 'inventory_change', schema_version: 2,
    status: 'ledger_created', kind: 'STOCK_SALE_DECREASE', stock_key: 'product_1|38|门盒',
    product_record_id: 'product_1', size: 38, state: '门盒', quantity: 1,
    direction: '减少', behavior_record_id: 'behavior_sale', source_record_id: 'detail_legacy',
    ledger_record_id: 'sale_ledger', live_record_ids: ['deleted_legacy'],
    removed_live_record_ids: ['deleted_legacy'], created_live_record_ids: [], target_quantity: 0,
  });
  const inventory = new InventoryService({ gateway, store: taskStore });
  await assert.rejects(inventory.applySale({ salesDetailRecordId: 'detail_legacy',
    productRecordId: 'product_1', size: 38, quantity: 1 }), /旧版销售任务已有库存删除.*不能自动恢复/);
  assert.notEqual((await taskStore.get(id)).status, 'completed');
});

// A resumable sample promotion: the task may already have written its ledger
// row, so every resume path has to prove that row still belongs to the task.
const legacySamplePromotion = async ({ ledgerSize = ['size_40'], sizeRecordId = 'size_40',
  omitSizeRecordId = false } = {}) => {
  const gateway = gatewayFor([
    { record_id: 'door_40', fields: { 编号: ['product_1'], 尺码: ['size_40'], 所属状态: '门盒' } },
  ], [behavior('behavior_sample', 'STOCK_DOORBOX_TO_SAMPLE', '门盒转样品', '不影响')]);
  gateway.records.set('inventoryLedger', [{ record_id: 'sample_ledger', fields: {
    编号: ['product_1'], 尺码: ledgerSize, 变动数量: 0,
    库存行为: ['behavior_sample'], 关联销售: ['detail_sold_sample'],
  } }]);
  const taskStore = store();
  const id = operationId('sample', 'detail_sold_sample');
  const task = {
    operation_id: id, type: 'sample_promotion', status: 'ledger_created',
    stock_key: 'product_1|40|门盒', source_record_id: 'detail_sold_sample',
    product_record_id: 'product_1', size: 40, live_record_id: 'door_40',
    behavior_record_id: 'behavior_sample',
  };
  if (!omitSizeRecordId) task.size_record_id = sizeRecordId;
  await taskStore.create(task);
  const inventory = new InventoryService({ gateway, store: taskStore });
  const request = { salesDetailRecordId: 'detail_sold_sample', productRecordId: 'product_1', size: 40 };
  return { gateway, taskStore, id, inventory, request };
};

test('sample promotion without a recorded size link stops for manual reconciliation', async () => {
  const { gateway, taskStore, id, inventory, request } = await legacySamplePromotion({ omitSizeRecordId: true });
  await assert.rejects(inventory.promoteToSample(request), /尺码关联.*不能自动恢复/);
  assert.equal(gateway.records.get('liveInventory')[0].fields['所属状态'], '门盒');
  assert.notEqual((await taskStore.get(id)).status, 'completed');
});

test('sample promotion refuses an existing ledger whose size link is empty or wrong', async () => {
  for (const ledgerSize of [[], ['size_41'], 40]) {
    const { gateway, taskStore, id, inventory, request } = await legacySamplePromotion({ ledgerSize });
    await assert.rejects(inventory.promoteToSample(request), /已有库存流水.*尺码关联.*不能自动恢复/);
    assert.equal(gateway.records.get('inventoryLedger').length, 1);
    assert.equal(gateway.records.get('liveInventory')[0].fields['所属状态'], '门盒');
    assert.notEqual((await taskStore.get(id)).status, 'completed');
  }
});

test('sample promotion resumes only after the existing ledger links verify', async () => {
  const { gateway, taskStore, id, inventory, request } = await legacySamplePromotion();
  const result = await inventory.promoteToSample(request);
  assert.equal(result.ledgerRecordId, 'sample_ledger');
  assert.equal(gateway.records.get('inventoryLedger').length, 1);
  assert.equal(gateway.records.get('liveInventory')[0].fields['所属状态'], '样品');
  assert.equal((await taskStore.get(id)).status, 'completed');
});

// 动作按「行为编码」匹配，编码是行为管理表里的稳定标识。
// 这条测试锁住这个性质：运维在飞书里把中文名改掉，代码必须照常工作。
test('stock behavior lookup survives renaming the display name', async () => {
  const gateway = gatewayFor([unit('door_1', '门盒')], [
    behavior('behavior_sale', 'STOCK_SALE_DECREASE', '销售出库（已改名）', '减少'),
    behavior('behavior_purchase', 'STOCK_PURCHASE_INCREASE', '采购收货（已改名）', '增加'),
    // 售后三条行为同样要启用：validateStockBehaviors 会遍历整张注册表。
    behavior('behavior_return', 'SALE_RETURN', '销售退货（已改名）', '增加'),
    behavior('behavior_compensation', 'SALE_COMPENSATION', '销售赔货（已改名）', '减少'),
    behavior('behavior_cash', 'SALE_CASH', '现货销售（已改名）', '减少'),
  ]);
  const inventory = new InventoryService({ gateway, store: store() });
  await inventory.validateStockBehaviors();
  const result = await inventory.applySale({ salesDetailRecordId: 'detail_renamed',
    productRecordId: 'product_1', size: 38, quantity: 1 });
  assert.equal(result.ledgerRecordId, 'rec_1');
  assert.equal(gateway.records.get('inventoryLedger').length, 1);
});

// 售后三条声明是**契约**：方向错了、或赔货/换货出货去吃了样品，实时库存就会和账面对不上。
// 用一条断言锁住，防止以后有人"顺手"改动方向或 consumes。
test('售后动作的库存语义：退货增加、赔货与现货减少且只吃门盒', () => {
  assert.deepEqual(STOCK_MOVEMENTS.SALE_RETURN, {
    direction: '增加', ledgerSource: 'salesDetail', consumes: null, triggerSampleReplacement: false,
  });
  assert.deepEqual(STOCK_MOVEMENTS.SALE_COMPENSATION, {
    direction: '减少', ledgerSource: 'salesDetail', consumes: ['门盒'], triggerSampleReplacement: false,
  });
  assert.deepEqual(STOCK_MOVEMENTS.SALE_CASH, {
    direction: '减少', ledgerSource: 'salesDetail', consumes: ['门盒'], triggerSampleReplacement: false,
  });
});

// 光有声明不够：这三条行为编码必须真的能被既有库存引擎执行（真 InventoryService，不是注入端口）。
test('售后动作在真 InventoryService 里生效：退货加一行、现货出库从门盒减一行', async () => {
  const gateway = gatewayFor([unit('door_1', '门盒')], [
    behavior('behavior_return', 'SALE_RETURN', '销售退货', '增加'),
    behavior('behavior_cash', 'SALE_CASH', '现货销售', '减少'),
  ]);
  const inventory = new InventoryService({ gateway, store: store() });

  const returned = await inventory.applyChange({
    kind: 'SALE_RETURN', productRecordId: 'product_1', size: 38, state: '样品',
    quantity: 1, sourceRecordId: 'detail_ret_1',
  });
  assert.equal(returned.direction, '增加');
  assert.deepEqual(gateway.records.get('inventoryLedger')[0].fields, {
    编号: ['product_1'], 尺码: ['size_38'], 变动数量: 1,
    库存行为: ['behavior_return'], 关联销售: ['detail_ret_1'],
  });
  const added = gateway.records.get('liveInventory').filter((row) => row.fields['所属状态'] === '样品');
  assert.equal(added.length, 1);
  assert.deepEqual(added[0].fields['编号'], ['product_1']);

  const outgoing = await inventory.applyChange({
    kind: 'SALE_CASH', productRecordId: 'product_1', size: 38, state: '门盒',
    quantity: 1, sourceRecordId: 'detail_new_1',
  });
  assert.equal(outgoing.direction, '减少');
  assert.deepEqual(outgoing.liveRecordIds, ['door_1']);
  assert.equal(gateway.records.get('liveInventory').some((row) => row.record_id === 'door_1'), false);
});

// 没在注册表里声明的动作必须明确报错，而不是像以前那样静默按「采购增加」处理。
test('an unregistered movement fails loudly instead of falling back to purchase semantics', async () => {
  const gateway = gatewayFor([unit('door_1', '门盒')]);
  const inventory = new InventoryService({ gateway, store: store() });
  await assert.rejects(
    inventory.applyChange({ kind: 'PURCHASE_RETURN', productRecordId: 'product_1', size: 38,
      quantity: 1, sourceRecordId: 'ret_1', state: '门盒' }),
    /未在库存动作注册表中声明动作「PURCHASE_RETURN」/,
  );
  assert.equal(gateway.records.get('inventoryLedger'), undefined);
  assert.equal(gateway.records.get('liveInventory').length, 1);
});

// ─── 采购增加库存的 Unknown Outcome（Main Merge Blocker C）───

// 「远端写入成功、本地落盘失败」：只让第一次匹配的 update 抛错。
const failingOnceStore = (inner, shouldFail) => {
  let armed = true;
  return {
    create: (...args) => inner.create(...args),
    get: (...args) => inner.get(...args),
    list: (...args) => inner.list(...args),
    update: async (recordId, patch) => {
      if (armed && shouldFail(patch)) {
        armed = false;
        throw new Error('模拟本地落盘失败');
      }
      return inner.update(recordId, patch);
    },
  };
};

const liveKeys = (gateway) => gateway.records.get('liveInventory')
  .map((row) => row.fields['库存操作键']).filter(Boolean).sort();

test('C1 采购 2 双：1 条流水、2 条实时库存，且两条库存操作键不同', async () => {
  const gateway = gatewayFor([]);
  const inventory = new InventoryService({ gateway, store: store() });
  await inventory.applyPurchase({ purchaseInboundRecordId: 'inbound_1', productRecordId: 'product_1',
    size: 38, quantity: 2, state: '仓库' });

  assert.equal(gateway.records.get('inventoryLedger').length, 1, '一次采购入库只写一条业务流水');
  const rows = gateway.records.get('liveInventory');
  assert.equal(rows.length, 2);
  const keys = liveKeys(gateway);
  assert.equal(keys.length, 2);
  assert.ok(keys[0].endsWith(':1') && keys[1].endsWith(':2'), `键应按序号生成：${keys.join(', ')}`);
  assert.equal(keys[0].slice(0, -2), keys[1].slice(0, -2), '两条必须来自同一次库存操作');
});

test('C2 第一双已写入远端但本地清单没落盘：重试只补第二双，不会变成 3 双', async () => {
  const gateway = gatewayFor([]);
  const inventory = new InventoryService({
    gateway,
    store: failingOnceStore(store(), (patch) => Array.isArray(patch.created_live_record_ids)),
  });
  const input = { purchaseInboundRecordId: 'inbound_1', productRecordId: 'product_1',
    size: 38, quantity: 2, state: '仓库' };

  await assert.rejects(inventory.applyPurchase(input), /模拟本地落盘失败/);
  assert.equal(gateway.records.get('liveInventory').length, 1, '第一双已经写进远端');

  await inventory.applyPurchase(input);
  assert.equal(gateway.records.get('liveInventory').length, 2, '重试必须复用第一双，只补第二双');
  assert.equal(gateway.records.get('inventoryLedger').length, 1, '流水不得因为重试再写一条');
});

test('C3 实时库存已创建但响应丢失：按库存操作键找回，不重复建', async () => {
  const gateway = gatewayFor([]);
  const originalCreate = gateway.create;
  gateway.create = async (key, values) => {
    const created = await originalCreate(key, values);
    // 飞书写成功、客户端只拿到超时：不能当成「肯定没写」再建一条。
    if (key === 'liveInventory') throw new Error('read ECONNRESET');
    return created;
  };
  const inventory = new InventoryService({ gateway, store: store() });

  const result = await inventory.applyPurchase({ purchaseInboundRecordId: 'inbound_1',
    productRecordId: 'product_1', size: 38, quantity: 2, state: '仓库' });

  assert.equal(gateway.records.get('liveInventory').length, 2, '必须找回已写入的那一双，而不是再建');
  assert.equal(result.liveRecordIds.length, 2);
  assert.equal(result.quantity, 2);
});

test('C4 远端出现两条相同库存操作键：停止入库并转人工核对', async () => {
  // 键由 operation_id 决定：这里用同一个来源明细算出「这一双本该有的键」。
  const operationKey = `${operationId('STOCK_PURCHASE_INCREASE', 'inbound_dup')}:1`;
  const gateway = gatewayFor([
    { record_id: 'dup_a', fields: { 编号: ['product_1'], 尺码: ['size_38'], 所属状态: '仓库', 库存操作键: operationKey } },
    { record_id: 'dup_b', fields: { 编号: ['product_1'], 尺码: ['size_38'], 所属状态: '仓库', 库存操作键: operationKey } },
  ]);
  const inventory = new InventoryService({ gateway, store: store() });

  await assert.rejects(
    inventory.applyChange({ kind: 'STOCK_PURCHASE_INCREASE', productRecordId: 'product_1', size: 38,
      quantity: 1, sourceRecordId: 'inbound_dup', state: '仓库' }),
    /库存事实重复，请人工核对/,
  );
  assert.equal(gateway.records.get('liveInventory').length, 2, '重复事实存在时不得再写入新的实时库存');
  assert.equal(gateway.records.get('inventoryLedger'), undefined, '发现重复时必须先停下，不再补写流水');
});

test('C5 同一个 applyPurchase 重复执行：流水只有一条，库存只增加一次', async () => {
  const gateway = gatewayFor([]);
  const inventory = new InventoryService({ gateway, store: store() });
  const input = { purchaseInboundRecordId: 'inbound_1', productRecordId: 'product_1',
    size: 38, quantity: 3, state: '门盒' };

  await inventory.applyPurchase(input);
  await inventory.applyPurchase(input);

  assert.equal(gateway.records.get('inventoryLedger').length, 1);
  assert.equal(gateway.records.get('liveInventory').length, 3, '重复执行不得把库存变成 6');
  assert.deepEqual(liveKeys(gateway).map((key) => key.slice(-2)), [':1', ':2', ':3']);
});
