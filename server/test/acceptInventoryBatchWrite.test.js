'use strict';

/**
 * ⭐⭐ 2026-10-13（验收提速 ①）——**"加库存"一批一次写**的验收标准。
 *
 * 真账（Lead 实测量）：每批 5 码 = 143.9 秒，其中**逐码"库存流水 + 实时库存" = 119.5 秒（83%）**。
 * 为什么慢：每码要串行敲 **6 次**飞书（≈4 秒/次）——
 *   ① `resolvePurchaseInboundState` → `listAll('liveInventory')` 整表读（**每码重复一次**）
 *   ② `resolveStockBehavior`    → `listAll('behavior')`
 *   ③ `assertNoDuplicateOperationItems` → `listAll('liveInventory')` 又一次整表读
 *   ④ `createOnceByKey`         → `listAll('liveInventory')` 幂等回查
 *   ⑤ `create('inventoryLedger')`
 *   ⑥ `create('liveInventory')`
 * ⇒ 5 码 ≈ **30 次**；目标：**写 10+ ⇒ 2**（`createBatch('inventoryLedger')` + `createBatch('liveInventory')`）。
 *
 * 本文件钉的 AC（**先写先红**）：
 *   AC-B1 `applyPurchaseBatch(5 码)` 存在；**批量写 ≤2 次**、逐条 `create` **0 次**
 *   AC-B2 写入结果与"5 次逐条 `applyPurchase`"**逐字相同**（流水字段集 / 实时库存字段集 / 结果形状）
 *   AC-B3 重跑 ⇒ **零写**（幂等：同一批再跑一次不多写一行）
 *   AC-B4 **整批一次写**（失败粒度 A）：第 3 码那批失败 ⇒ **整批不写**；重试 ⇒ 补齐（各一行、不重复）
 *   AC-B5 常绿对照：**逐条基线 ≥10 次**（证明"为什么要批量"，改前改后都成立的对照）
 *   AC-B6 打点事件名在配置里（`scan.accept.timing`）
 *
 * ⚠️ 字段名一律取自 `V1_BITABLE_SCHEMA`（**不写死物理列名**）+ `OPERATION_ITEM_KEY_FIELD`。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_accept_batch';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'accept_batch_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { InventoryService } = require('../src/services/inventoryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { OPERATION_ITEM_KEY_FIELD } = require('../src/infrastructure/idempotencyKey');

const F = (key) => V1_BITABLE_SCHEMA.tables[key].fields;
const PURCHASE_IN = 'STOCK_PURCHASE_INCREASE';
const SIZES = [35, 36, 37, 38, 39];

/** 计数版假网关：每一次远端调用都记下来（判"调用次数"的唯一依据，不拿时间抖动当证据）。 */
const makeFake = ({ sizes = SIZES, failLedgerBatchAt = 0 } = {}) => {
  const calls = [];
  const data = {
    behavior: [{
      record_id: 'beh_purchase_in',
      fields: {
        [F('behavior').code]: PURCHASE_IN,
        [F('behavior').name]: '采购入库',
        [F('behavior').stockDirection]: '增加',
        [F('behavior').enabled]: true,
      },
    }],
    sizeManagement: sizes.map((n) => ({ record_id: `size_${n}`, fields: { [F('sizeManagement').size]: n } })),
    liveInventory: [],
    inventoryLedger: [],
  };
  let ledgerBatchCount = 0;
  // ⚠️ 真实网关会把**语义键**映射成**物理列名**再发给飞书；假网关必须照做，
  //    否则"按「库存操作键」回查"永远查不到（AC-B3 就是靠这条抓出来的）。
  const physical = (tableKey, values) => {
    const map = V1_BITABLE_SCHEMA.tables[tableKey].fields;
    const out = {};
    for (const [key, value] of Object.entries(values || {})) out[map[key] || key] = value;
    return out;
  };
  const push = (tableKey, values) => {
    const recordId = `rec_${tableKey}_${data[tableKey].length + 1}`;
    data[tableKey].push({ record_id: recordId, fields: physical(tableKey, values) });
    return recordId;
  };
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => { calls.push({ kind: 'listAll', tableKey: key }); return data[key] || []; },
    listByFilter: async (key) => { calls.push({ kind: 'listByFilter', tableKey: key }); return data[key] || []; },
    get: async (key, id) => { calls.push({ kind: 'get', tableKey: key, id }); return (data[key] || []).find((r) => r.record_id === id) || null; },
    create: async (key, values) => {
      calls.push({ kind: 'create', tableKey: key, values });
      return { recordId: push(key, values) };
    },
    createBatch: async (key, rows) => {
      calls.push({ kind: 'createBatch', tableKey: key, values: rows });
      if (key === 'inventoryLedger') {
        ledgerBatchCount += 1;
        if (failLedgerBatchAt && ledgerBatchCount === failLedgerBatchAt) {
          throw new Error('boom: 流水批量写失败（用例故意）');
        }
      }
      return rows.map((values) => ({ recordId: push(key, values), fields: values }));
    },
    updateBatch: async (key, patches) => {
      calls.push({ kind: 'updateBatch', tableKey: key, values: patches });
      return patches.map((patch) => ({ recordId: patch.recordId, fields: patch.fields || {} }));
    },
    delete: async () => { throw new Error('本用例不该删记录'); },
  };
  return {
    gateway,
    calls,
    data,
    writesOf: (key) => calls.filter((call) => call.tableKey === key && ['create', 'createBatch', 'update', 'updateBatch'].includes(call.kind)),
    batchWrites: () => calls.filter((call) => call.kind === 'createBatch' || call.kind === 'updateBatch'),
  };
};

const makeService = (fake) => new InventoryService({
  gateway: fake.gateway,
  store: new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'inv-batch-')), idField: 'operation_id' }),
});

/** 一批 5 码：每码 1 双、门盒（与验收现场同形）。 */
const batchItems = (sizes = SIZES) => sizes.map((size) => ({
  purchaseBatchRecordId: 'rec_batch_row',
  purchaseBatchNo: 'CGD-TEST-0001',
  arrivalTaskId: 'arrival_task_1',
  productRecordId: 'prod_1',
  size,
  quantity: 1,
  state: '门盒',
}));

const norm = (value) => JSON.stringify(value, Object.keys(value || {}).sort());

test('AC-B1 applyPurchaseBatch：5 码一批 ⇒ 批量写 ≤2 次、逐条 create 0 次', async () => {
  const fake = makeFake();
  const inventory = makeService(fake);
  assert.equal(typeof inventory.applyPurchaseBatch, 'function',
    '① 的落点：`InventoryService.applyPurchaseBatch` 必须存在（一批一次写）');
  const results = await inventory.applyPurchaseBatch(batchItems());
  assert.equal(results.length, 5, '5 码 ⇒ 5 个结果');
  const writes = fake.calls.filter((call) => ['create', 'createBatch', 'update', 'updateBatch', 'delete'].includes(call.kind));
  assert.ok(fake.batchWrites().length <= 2,
    `批量写必须 ≤2 次（实际 ${fake.batchWrites().length} 次：${fake.batchWrites().map((c) => c.tableKey).join('/')}）`);
  assert.equal(writes.filter((call) => call.kind === 'create').length, 0,
    '批量通路里**不许**再逐条 create（那是 10+ 次的来源）');
  for (const result of results) {
    assert.ok(result.ledgerRecordId, '每条要有流水 id');
    assert.equal(result.liveRecordIds.length, 1, '每条加 1 双 ⇒ 1 条实时库存');
  }
  // 逐项打出实际次数（报告里的"调用次数对照"用它，不拿时间抖动当证据）。
  const kinds = fake.calls.reduce((acc, call) => {
    const key = `${call.kind}:${call.tableKey}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  console.log('   [批量后] 5 码远端调用合计 =', fake.calls.length, '· 逐项 =', JSON.stringify(kinds));
});

test('AC-B2 写入结果与逐条 applyPurchase **逐字相同**（流水字段集 / 实时库存字段集 / 结果形状）', async () => {
  const legacy = makeFake();
  const legacyService = makeService(legacy);
  const legacyResults = [];
  for (const item of batchItems()) legacyResults.push(await legacyService.applyPurchase(item));

  const fake = makeFake();
  const inventory = makeService(fake);
  if (typeof inventory.applyPurchaseBatch !== 'function') {
    assert.fail('AC-B2 需要 `applyPurchaseBatch`（先红）');
  }
  const results = await inventory.applyPurchaseBatch(batchItems());

  const ledgerValues = (data) => data.inventoryLedger.map((row) => norm(row.fields)).sort();
  const liveValues = (data) => data.liveInventory.map((row) => norm(row.fields)).sort();
  assert.deepEqual(ledgerValues(fake.data), ledgerValues(legacy.data), '库存流水的字段集/值必须与逐条路径逐字相同');
  assert.deepEqual(liveValues(fake.data), liveValues(legacy.data), '实时库存的字段集/值必须与逐条路径逐字相同');
  assert.deepEqual(
    results.map((r) => Object.keys(r).sort()),
    legacyResults.map((r) => Object.keys(r).sort()),
    '结果对象的键必须与逐条路径同形',
  );
  assert.deepEqual(
    results.map((r) => r.movementQuantity), legacyResults.map((r) => r.movementQuantity),
  );
});

test('AC-B3 重跑 ⇒ **零写**（同一批再跑一次不多写一行）', async () => {
  const fake = makeFake();
  const inventory = makeService(fake);
  if (typeof inventory.applyPurchaseBatch !== 'function') assert.fail('AC-B3 需要 `applyPurchaseBatch`（先红）');
  const first = await inventory.applyPurchaseBatch(batchItems());
  const ledgerRows = fake.data.inventoryLedger.length;
  const liveRows = fake.data.liveInventory.length;
  const before = fake.calls.length;
  const second = await inventory.applyPurchaseBatch(batchItems());
  assert.equal(fake.data.inventoryLedger.length, ledgerRows, '重跑不许多写流水');
  assert.equal(fake.data.liveInventory.length, liveRows, '重跑不许多写实时库存');
  const writesAfter = fake.calls.slice(before).filter((c) => ['create', 'createBatch', 'update', 'updateBatch'].includes(c.kind));
  assert.equal(writesAfter.length, 0, `重跑必须零写（实际 ${writesAfter.length} 次）`);
  assert.deepEqual(second.map((r) => r.liveRecordIds), first.map((r) => r.liveRecordIds), '重跑返回同一批记录 id');
});

test('AC-B4 整批一次写：批量失败 ⇒ 这一批一条都不写；重试 ⇒ 补齐（不重复）', async () => {
  const fake = makeFake({ failLedgerBatchAt: 1 });
  const inventory = makeService(fake);
  if (typeof inventory.applyPurchaseBatch !== 'function') assert.fail('AC-B4 需要 `applyPurchaseBatch`（先红）');
  await assert.rejects(() => inventory.applyPurchaseBatch(batchItems()), /boom/);
  assert.equal(fake.data.inventoryLedger.length, 0, '流水批量写失败 ⇒ 流水一条都不许落');
  assert.equal(fake.data.liveInventory.length, 0, '流水没成 ⇒ 实时库存也不许写（整批一次写）');

  const retry = await inventory.applyPurchaseBatch(batchItems());
  assert.equal(fake.data.inventoryLedger.length, 5, '重试补齐 5 条流水');
  assert.equal(fake.data.liveInventory.length, 5, '重试补齐 5 条实时库存');
  assert.equal(retry.length, 5);
});

test('AC-B5 常绿对照：逐条 applyPurchase 5 码 ⇒ 远端调用 ≥10 次（这就是要批量的理由）', async () => {
  const fake = makeFake();
  const inventory = makeService(fake);
  for (const item of batchItems()) await inventory.applyPurchase(item);
  const kinds = fake.calls.reduce((acc, call) => {
    const key = `${call.kind}:${call.tableKey}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const total = fake.calls.length;
  // 逐项打出实际次数（报告要用它做"调用次数对照"，不拿时间抖动当证据）。
  console.log('   [逐条基线] 5 码远端调用合计 =', total, '· 逐项 =', JSON.stringify(kinds));
  assert.ok(total >= 10, `逐条路径 5 码必须 ≥10 次调用（实际 ${total}）—— 这是批量写要解决的那个数`);
  assert.ok((kinds['listAll:liveInventory'] || 0) >= 5, '「实时库存」整表读在逐条路径里每码至少一次');
});

test('AC-B6 打点：配置里有 `scan.accept.timing`（验收分阶段耗时汇总）', () => {
  assert.equal(SCAN_WRITE.events.acceptTiming, 'scan.accept.timing',
    '① 的打点事件名必须在 config/scanWrite.js 里（服务层透传、收尾 logInfo）');
});
