'use strict';

/**
 * 售后退货的「库存流水」必须挂到**销售主表**（业务负责人 2026-11-10 真机测试发现）。
 *
 * 背景：
 *   · 生产「库存流水.关联销售」是**双向关联 → 销售主表**（与销售出库同一个字段）；
 *   · 销售出库（STOCK_SALE_DECREASE）早就有 `ledgerLink` ⇒ 流水写的是主表 id；
 *   · 售后退货（STOCK_SALE_INCREASE）原来**没有** `ledgerLink` ⇒ 把明细 id 写进这个字段：
 *     主表「库存流水」看不到这一行，关联也是坏的。
 *
 * AC-RLL1 动作注册表：STOCK_SALE_INCREASE 声明了 ledgerLink（字段/入参/本地键）。
 * AC-RLL2 真 InventoryService：远端流水的「关联销售」= **销售主表 id**；
 *         同时本地幂等键 `source_record_id` 仍是**明细 id**（同一单退两双不撞键）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const {
  InventoryService, STOCK_MOVEMENTS,
} = require('../src/services/inventoryService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const behavior = (recordId, code, name, direction) => ({
  record_id: recordId,
  fields: { 行为编码: code, 行为名称: name, 库存方向: direction, 是否启用: true },
});

const gatewayFor = (live, behaviors) => {
  const sizes = [38, 40, 41, 42, 43, 44].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));
  const records = new Map([['liveInventory', live], ['behavior', behaviors], ['sizeManagement', sizes]]);
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

test('AC-RLL1 STOCK_SALE_INCREASE 声明 ledgerLink：远端关联销售 = 主表 id，本地键仍=明细 id', () => {
  assert.deepEqual(STOCK_MOVEMENTS.STOCK_SALE_INCREASE.ledgerLink, {
    field: 'salesDetail',
    inputKey: 'salesEntryRecordId',
    operationKey: 'sales_entry_record_id',
  });
  assert.equal(STOCK_MOVEMENTS.STOCK_SALE_INCREASE.ledgerSource, 'salesDetail');
});

test('AC-RLL2 真 InventoryService：流水「关联销售」写销售主表 id；本地 source_record_id 仍是明细 id', async () => {
  const gateway = gatewayFor([], [behavior('behavior_sale_increase', 'STOCK_SALE_INCREASE', '销售增加', '增加')]);
  const store = new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'after-sales-return-ledger-')), idField: 'operation_id' });
  const inventory = new InventoryService({ gateway, store });
  const result = await inventory.applyChange({
    kind: 'STOCK_SALE_INCREASE',
    productRecordId: 'product_1',
    size: 40,
    state: '门盒',
    quantity: 1,
    sourceRecordId: 'detail_1',          // 本地幂等键：明细
    salesEntryRecordId: 'entry_1',       // 远端关联：销售主表
  });
  const ledger = gateway.records.get('inventoryLedger')[0];
  assert.deepEqual(ledger.fields.关联销售, ['entry_1'], '流水必须挂到销售主表（否则主表看不到）');
  assert.equal(ledger.fields.关联采购, undefined, '售后不写关联采购');
  const operations = await store.list();
  assert.equal(operations.length, 1);
  assert.equal(operations[0].source_record_id, 'detail_1', '本地幂等键仍是明细 id（同单退两双不撞键）');
  assert.equal(operations[0].sales_entry_record_id, 'entry_1', '本地任务也记下主表 id（排查用）');
  assert.equal(result.movementQuantity, 1);
});
