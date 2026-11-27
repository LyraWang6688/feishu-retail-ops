'use strict';
// 入库继承当季：端到端（库存引擎 → 建行值）
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { InventoryService } = require('../src/services/inventoryService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { normalizeLinkFields } = require('./support/linkReadShape');

const behavior = (recordId, code, name, direction) => ({ record_id: recordId,
  fields: { 行为编码: code, 行为名称: name, 库存方向: direction, 是否启用: true } });

const make = ({ products = [], live = [] } = {}) => {
  const sizes = [38, 40, 41, 42, 43, 44].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));
  const records = new Map([
    ['liveInventory', live.slice()],
    ['behavior', [
      behavior('behavior_sale', 'STOCK_SALE_DECREASE', '销售减少', '减少'),
      behavior('behavior_purchase', 'STOCK_PURCHASE_INCREASE', '采购增加', '增加'),
    ]],
    ['sizeManagement', sizes],
    ['product', products.slice()],
  ]);
  const calls = [];
  let seq = 0;
  const physical = (tableKey, values) => normalizeLinkFields(Object.fromEntries(Object.entries(values || {})
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => [V1_BITABLE_SCHEMA.tables[tableKey].fields[name] || name, value])));
  const gateway = {
    calls, records,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    validateTables: async () => [],
    listAll: async (key) => records.get(key) || [],
    get: async (key, id) => { calls.push({ kind: 'get', key }); return (records.get(key) || []).find((row) => row.record_id === id); },
    getBatch: async (key, ids, options = {}) => {
      calls.push({ kind: 'getBatch', key, ids, retry: options.retry });
      return (records.get(key) || []).filter((row) => ids.includes(row.record_id));
    },
    create: async (key, values) => {
      const recordId = `rec_${++seq}`;
      if (!records.has(key)) records.set(key, []);
      records.get(key).push({ record_id: recordId, fields: physical(key, values) });
      return { recordId };
    },
    createBatch: async (key, rows) => rows.map((values) => {
      const recordId = `rec_${++seq}`;
      if (!records.has(key)) records.set(key, []);
      records.get(key).push({ record_id: recordId, fields: physical(key, values) });
      return { recordId };
    }),
    delete: async (key, id) => records.set(key, (records.get(key) || []).filter((row) => row.record_id !== id)),
    update: async (key, id, values) => {
      const record = (records.get(key) || []).find((row) => row.record_id === id);
      Object.assign(record.fields, physical(key, values));
      return record;
    },
  };
  const inventory = new InventoryService({
    gateway,
    store: new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'season-in-')), idField: 'operation_id' }),
  });
  return { gateway, inventory, records, calls };
};

const unit = (id, state) => ({ record_id: id,
  fields: { 编号: [{ record_ids: ['product_1'] }], 尺码: [{ record_ids: ['size_38'] }], 所属状态: state } });
const productOf = (label) => ({ record_id: 'product_1', fields: { 当季: label } });
const liveRows = (records) => records.get('liveInventory');
const lastRow = (records) => liveRows(records)[liveRows(records).length - 1];

test('AC-SI-IN1 货品当季=是 ⇒ 入库新行勾当季', async () => {
  const h = make({ products: [productOf('是')] });
  await h.inventory.applyPurchase({ purchaseBatchRecordId: 'batch_1', productRecordId: 'product_1', size: 38, quantity: 1, state: '门盒', sampleSize: 38 });
  assert.equal(lastRow(h.records).fields['当季'], true);
  assert.ok(h.calls.some((call) => call.kind === 'getBatch' && call.key === 'product'), '必须读货品当季');
});

test('AC-SI-IN2 当季=否 + 还有库存 ⇒ 新行不写当季', async () => {
  const h = make({ products: [productOf('否')], live: [unit('door_1', '门盒')] });
  await h.inventory.applyPurchase({ purchaseBatchRecordId: 'batch_2', productRecordId: 'product_1', size: 38, quantity: 1, state: '门盒', sampleSize: 38 });
  const row = lastRow(h.records);
  assert.equal(row.fields['当季'], undefined, '否 + 有库存 ⇒ 一律不写');
});

test('AC-SI-IN3 当季=否 + 实时库存 0 行 ⇒ 首次入库勾当季', async () => {
  const h = make({ products: [productOf('否')] });
  await h.inventory.applyPurchase({ purchaseBatchRecordId: 'batch_3', productRecordId: 'product_1', size: 38, quantity: 1, state: '门盒', sampleSize: 38 });
  assert.equal(lastRow(h.records).fields['当季'], true);
});

test('AC-SI-IN4 出库/状态类不读货品、不写当季', async () => {
  const h = make({ products: [productOf('是')], live: [unit('door_1', '门盒')] });
  await h.inventory.applySale({ salesDetailRecordId: 'detail_1', productRecordId: 'product_1', size: 38, quantity: 1, state: '门盒' });
  assert.equal(h.calls.filter((call) => call.kind === 'getBatch').length, 0, '出库不许读货品');
});

test('AC-SI-IN5 批量入库：同批一次读货品，是 ⇒ 每一行都勾当季', async () => {
  const h = make({ products: [productOf('是')] });
  const items = [38, 40].map((size) => ({
    purchaseBatchRecordId: 'batch_5', productRecordId: 'product_1', size, quantity: 1, state: '门盒',
  }));
  items[0].sampleSize = 38;
  await h.inventory.applyPurchaseBatch(items);
  const rows = liveRows(h.records);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.fields['当季'] === true), '批量路径每行都勾当季');
  const productReads = h.calls.filter((call) => call.kind === 'getBatch' && call.key === 'product');
  assert.equal(productReads.length, 1, '同批只读一次货品');
});
