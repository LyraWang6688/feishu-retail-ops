const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { InventoryService, operationId } = require('../src/services/inventoryService');
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
  ]);
  const inventory = new InventoryService({ gateway, store: store() });
  await inventory.validateStockBehaviors();
  const result = await inventory.applySale({ salesDetailRecordId: 'detail_renamed',
    productRecordId: 'product_1', size: 38, quantity: 1 });
  assert.equal(result.ledgerRecordId, 'rec_1');
  assert.equal(gateway.records.get('inventoryLedger').length, 1);
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
