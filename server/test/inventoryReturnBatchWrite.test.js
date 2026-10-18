'use strict';

/**
 * ⭐⭐ task-65（2026-10-16）：**库存写入批量化** —— 采购退货那条「扣库存」的写入
 *   从「**逐尺码整表读** ＋ **逐双 `get`/`delete`**」改成「**一次整表读＋内存索引** ＋
 *   **一次 `getBatch`** ＋ **一次 `createBatch`（流水）** ＋ **一次 `deleteBatch`**」。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 改前逐字 → 改后逐字 → 依据
 *
 * **依据**：业务负责人 2026-10-16 逐字「**退货也需要批量提速**」
 *   —— #750 补货（明细）＋ #749 退货（明细）之后，**就剩库存这一段**（执行者实测后如实交上来的残留）。
 *
 * **改前（逐字）**：`services/purchaseReturnService.js` 的「③ 逐尺码：扣库存」循环里
 *   每个尺码各调一次 `inventory.applyPurchaseReturn(...)` ⇒ 落到
 *   `InventoryService.applyChange` ＋ `executeOperation`：
 *     · 每个尺码 **1 次** `listAll('behavior')`（`resolveStockBehavior`）
 *     · 每个尺码 **1 次** `listAll('liveInventory')`（整表读 ⇒ 生产几千行 ⇒ 翻页 ⇒ 多次 HTTP）
 *     · 每个尺码 **1 次** `create('inventoryLedger')`
 *     · 每一双 **1 次** `get('liveInventory')` ＋ **1 次** `delete('liveInventory')`
 *
 * **改后（逐字）**：`purchaseReturnService` 一次调 `inventory.applyPurchaseReturnBatch(payloads)`，
 *   库存引擎**逐行对齐** `applyPurchaseBatch`（2026-10-13 验收提速那一刀）的批量形态：
 *     · 整批 **1 次** `listAll('behavior')`
 *     · 整批 **1 次** `listAll('liveInventory')`＋**内存索引**（按 货品|尺码|状态）
 *     · 整批 **1 次** `createBatch('inventoryLedger')`
 *     · 整批 **1 次** `getBatch('liveInventory')`（替掉逐双 `get`，仍保留"删之前先确认那一条"的守护）
 *     · 整批 **1 次** `deleteBatch('liveInventory')`（替掉逐双 `delete`，≤500/片由网关分片）
 *
 * ⭐ **`delete` 那一半也做完了**（task-65 · Lead 当场授权加口）：网关原来有
 *   `createBatch` / `updateBatch` / `getBatch`、**没有 `deleteBatch`**（grep 零命中；
 *   飞书 SDK 有 `appTableRecord.batchDelete`，但网关没包）⇒ 本卡给网关**加**了 `deleteBatch`
 *   （**单独一个提交**，好回退；形态逐行对齐 `createBatch`；官方《删除多条记录》≤500/片）。
 *   🔴 **只加能力**：网关单条 `delete` 一行没动，它的既有调用方（`executeOperation` 等）**逐字不变**。
 *   ⚠️ 老替身 / 夹具没有 `deleteBatch` ⇒ **只有删这一步**退回逐双，那一段与改动前**逐字相同**
 *   （AC-IV2c 两侧对照钉住它）。
 *
 * 🔴 **行为一个字节都不许变**（判据 AC-IV2/IV3/IV4）：库存流水行数与字段、实时库存余量、
 *   幂等键、行为编码、数量、行序 —— 全表快照 `deepStrictEqual`。
 *   · 网关**没有**批量口（老替身 / 未接线）⇒ **退回逐条**，与改动前**逐字节同形**（AC-IV2 的 before 侧）。
 *   · 增加方向（到货验收 / 销售）**一个字都没动**：`applyChange` / `applyPurchaseBatch` 原样（AC-IV1b）。
 *
 * ⚠️ **已知边界（如实标，不美化）**：`deleteBatch` 超过 500 条时由网关**内部**分片 ⇒
 *   "1 次 `deleteBatch`"这句在 **N ≤ 500** 时成立。分片中后一片失败时，前一片已删、
 *   而 journal 的 `removed_live_record_ids` 还没落盘 ⇒ 续跑会在那几条上报"不存在，请人工核对"
 *   （**宁可停下让人核对，也不重复扣 / 假报成功**）。退货一批到不了 500 双 ⇒ 现实里走不到。
 *
 * ⚠️ 本文件用**真的** `V1BitableGateway`（只把飞书 SDK 的 `client` 换成内存替身 ⇒
 *    `createBatch` / `getBatch` / `listAll` 翻页 / `assertSuccess` 全是**生产代码**在跑）
 *   ＋ 真的 `InventoryService` / `PurchaseOrderBatchService` / `PurchaseReturnService`。
 *   HTTP 次数 = 内存 client 的**请求级计数**（不拿时间抖动当证据）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 真 schema 需要 app_token；尺码管理表没有硬编码兜底 ⇒ 也要给一个非空 table_id。
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_inv_return_batch_test';
process.env.FEISHU_V1_SIZE_TABLE_ID = process.env.FEISHU_V1_SIZE_TABLE_ID || 'tbl_size_inv_return_batch_test';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { V1BitableGateway } = require('../src/services/v1BitableGateway');
const { createPurchaseReturnService } = require('../src/services/purchaseReturnService');
const { PurchaseOrderBatchService } = require('../src/services/purchaseOrderBatchService');
const { InventoryService } = require('../src/services/inventoryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const NUMBER = 'YD6693-2|黑色|A';
const ITEM_NO = 'YD6693-2';

// ═══════════════════════════════════════════════════════════════════════════
// schema / 内存表 / 飞书 client 替身（**HTTP 请求级**计数）
// ═══════════════════════════════════════════════════════════════════════════

/** 真 schema 的副本：只把**空 table_id** 补成非空（否则网关会按"未配置表 ID"当场抛）。 */
const buildSchema = () => {
  const tables = {};
  for (const [key, table] of Object.entries(V1_BITABLE_SCHEMA.tables)) {
    tables[key] = { ...table, tableId: table.tableId || `tbl_missing_${key}` };
  }
  return { appToken: V1_BITABLE_SCHEMA.appToken, tables };
};

const tableIdOf = (schema, key) => schema.tables[key].tableId;

const PRODUCT = {
  record_id: 'prod_1',
  fields: {
    编号: NUMBER,
    货号: ITEM_NO,
    颜色: { text: '黑色', record_ids: ['color_black'] },
    类别: 'A',
    单价: 399,
    供应商: ['sup_1'],
  },
};

/** 一双「实时库存」记录（门盒 / 样品 / 仓库 = 采购退货 consumes 的那三档）。 */
const liveUnit = (id, size, state = '门盒') => ({
  record_id: id,
  fields: { 编号: ['prod_1'], 尺码: [`size_${size}`], 所属状态: state },
});

const seedRecords = () => ({
  product: [PRODUCT],
  sizeManagement: [40, 41, 42].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } })),
  liveInventory: [
    liveUnit('live_40_box_1', 40), liveUnit('live_40_box_2', 40), liveUnit('live_40_box_3', 40),
    liveUnit('live_41_box', 41), liveUnit('live_41_sample', 41, '样品'), liveUnit('live_41_store', 41, '仓库'),
    liveUnit('live_42_box_1', 42), liveUnit('live_42_box_2', 42),
  ],
  inventoryLedger: [],
  behavior: [
    {
      record_id: 'bh_purchase_in',
      fields: { 行为名称: '采购入库', 行为编码: 'STOCK_PURCHASE_INCREASE', 库存方向: '增加', 是否启用: true },
    },
    { record_id: 'bh_return_purchase', fields: { 行为名称: '退货', 行为编码: 'PURCHASE_RETURN' } },
    {
      record_id: 'bh_return',
      fields: {
        行为名称: '采购减少', 行为编码: 'STOCK_PURCHASE_DECREASE', 库存方向: '减少', 是否启用: true,
      },
    },
  ],
  supplier: [{ record_id: 'sup_1', fields: { 供应商名称: '大发鞋厂' } }],
  purchaseOrderBatch: [],
  purchaseRequest: [],
});

const seedStore = (schema) => {
  const store = new Map();
  for (const [key, records] of Object.entries(seedRecords())) {
    store.set(tableIdOf(schema, key), records.map((record) => ({
      record_id: record.record_id, fields: { ...record.fields },
    })));
  }
  return store;
};

const fieldListOf = (schema, tableKey) => {
  const table = schema.tables[tableKey];
  const sizeField = schema.tables.sizeManagement.fields.size;
  const sizeTableId = schema.tables.sizeManagement.tableId;
  return Object.values(table.fields || {}).map((name) => {
    if (tableKey === 'sizeManagement' && name === sizeField) return { field_name: name, type: 2 };
    if (name === sizeField && ['liveInventory', 'inventoryLedger'].includes(tableKey)) {
      return { field_name: name, type: 18, property: { table_id: sizeTableId, multiple: false } };
    }
    return { field_name: name, type: 1 };
  });
};

/**
 * 飞书 SDK `client` 的内存替身：**每次调用 = 一次 HTTP 请求**，逐条记进 `calls`。
 * ⚠️ 各接口的入参位置**照 SDK 的真实契约**：`batch_get` 的 id 在 **`data.record_ids`**
 *    （见 `test/bitableGatewayBatchGet.test.js` 与 SDK 类型声明），不是 `params`。
 */
const createStubClient = (store, options = {}) => {
  const calls = [];
  let sequence = 0;
  const ok = (data) => ({ code: 0, data });
  const nextId = () => `rec_${++sequence}`;
  // 「官方明说这一条没删掉」的注入点（默认谁都不命中）⇒ AC-IV2d 用它钉失败粒度。
  const notDeleted = options.notDeleted || (() => false);
  const rowsOf = (tableId) => (store.get(tableId) || []);
  const setRows = (tableId, rows) => store.set(tableId, rows);
  const record = (api, payload) => calls.push({
    api, table_id: payload?.path?.table_id, count: payload?.data?.records?.length,
  });

  return {
    calls,
    bitable: {
      appTableRecord: {
        async list({ path, params }) {
          record('list', { path });
          const rows = rowsOf(path.table_id);
          const offset = params?.page_token ? Number(params.page_token) : 0;
          const size = Number(params?.page_size) || 500;
          const items = rows.slice(offset, offset + size);
          const hasMore = offset + size < rows.length;
          return ok({ items, has_more: hasMore, page_token: hasMore ? String(offset + size) : undefined });
        },
        async get({ path }) {
          record('get', { path });
          const found = rowsOf(path.table_id).find((row) => row.record_id === path.record_id);
          if (!found) return { code: 1254005, msg: 'not found' };
          return ok({ record: found });
        },
        async create({ path, data }) {
          record('create', { path });
          const created = { record_id: nextId(), fields: data.fields };
          setRows(path.table_id, [...rowsOf(path.table_id), created]);
          return ok({ record: created });
        },
        async batchCreate({ path, data }) {
          record('batchCreate', { path, data });
          const created = data.records.map((row) => ({ record_id: nextId(), fields: row.fields }));
          setRows(path.table_id, [...rowsOf(path.table_id), ...created]);
          return ok({ records: created });
        },
        async update({ path, data }) {
          record('update', { path });
          const rows = rowsOf(path.table_id);
          const index = rows.findIndex((row) => row.record_id === path.record_id);
          if (index < 0) return { code: 1254005, msg: 'not found' };
          const updated = { record_id: path.record_id, fields: { ...rows[index].fields, ...data.fields } };
          rows[index] = updated;
          return ok({ record: updated });
        },
        async batchUpdate({ path, data }) {
          record('batchUpdate', { path, data });
          const rows = rowsOf(path.table_id);
          const updated = data.records.map((patch) => {
            const index = rows.findIndex((row) => row.record_id === patch.record_id);
            rows[index] = { record_id: patch.record_id, fields: { ...rows[index].fields, ...patch.fields } };
            return rows[index];
          });
          return ok({ records: updated });
        },
        async delete({ path }) {
          record('delete', { path });
          const rows = rowsOf(path.table_id);
          if (!rows.some((row) => row.record_id === path.record_id)) return { code: 1254005, msg: 'not found' };
          setRows(path.table_id, rows.filter((row) => row.record_id !== path.record_id));
          return ok({ deleted: true });
        },
        // ⚠️ 真飞书口径（官方《删除多条记录》+ SDK 类型）：请求体 `data.records` = **id 字符串数组**；
        //    响应 `data.records` = `[{ deleted, record_id }]`。
        //    `notDeleted` 用来模拟"官方明说某几条没删掉" ⇒ 判据 AC-IV2d 钉"不许把部分成功当全成功"。
        async batchDelete({ path, data }) {
          record('batchDelete', { path, data });
          const wanted = (data?.records || []).map((id) => String(id).trim()).filter(Boolean);
          const rows = rowsOf(path.table_id);
          const deleted = wanted
            .filter((id) => rows.some((row) => row.record_id === id))
            .map((id) => ({ deleted: !notDeleted(id), record_id: id }));
          const removed = new Set(deleted.filter((entry) => entry.deleted).map((entry) => entry.record_id));
          setRows(path.table_id, rows.filter((row) => !removed.has(row.record_id)));
          return ok({ records: deleted });
        },
        // ⚠️ 真飞书口径（SDK 类型 + `test/bitableGatewayBatchGet.test.js`）：id 在 **`data.record_ids`**。
        async batchGet({ path, data }) {
          record('batchGet', { path });
          const wanted = (data?.record_ids || []).map((id) => String(id).trim()).filter(Boolean);
          const items = wanted.map((id) => rowsOf(path.table_id).find((row) => row.record_id === id))
            .filter(Boolean);
          return ok({ records: items, forbidden_record_ids: [] });
        },
      },
      appTableField: {
        async list({ path }) {
          record('fieldList', { path });
          const tableKey = Object.keys(V1_BITABLE_SCHEMA.tables)
            .find((key) => tableIdOf(V1_BITABLE_SCHEMA, key) === path.table_id);
          return ok({ items: fieldListOf(V1_BITABLE_SCHEMA, tableKey), has_more: false });
        },
      },
    },
  };
};

/** 第 N 次调用某个 API ⇒ 抛一次（模拟瞬时故障 / 写到一半中断）。 */
const injectFailOnce = (client, { api, at = 1, message = 'injected transient failure' }) => {
  let seen = 0;
  const target = client.bitable.appTableRecord[api];
  client.bitable.appTableRecord[api] = async (payload) => {
    seen += 1;
    if (seen === at) throw new Error(message);
    return target(payload);
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// harness
// ═══════════════════════════════════════════════════════════════════════════

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `inv-return-batch-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 不影响结论 */ } };

/**
 * `batchPorts: false` ⇒ 网关**没有**批量口（`createBatch` / `getBatch` 都拿掉）
 * = 「改动前的语义路径」（老替身 / 未接线）⇒ 库存引擎必须**退回逐条**、与今天逐字节同形。
 * `deleteBatchPort: false` ⇒ 只有 `deleteBatch` 拿掉（老夹具）⇒ **只有删这一步**退回逐双。
 * `notDeleted` ⇒ 让 `batchDelete` 如实回报某几条 `deleted: false`（AC-IV2d 的失败粒度）。
 */
const createHarness = (options = {}) => {
  const schema = options.schema || buildSchema();
  const store = options.store || seedStore(schema);
  const client = createStubClient(store, { notDeleted: options.notDeleted });
  if (options.failOnce) injectFailOnce(client, options.failOnce);
  const gateway = new V1BitableGateway({ schema, client });
  if (options.batchPorts === false) {
    gateway.createBatch = undefined;
    gateway.getBatch = undefined;
  }
  if (options.deleteBatchPort === false) gateway.deleteBatch = undefined;
  const dirs = options.dirs || { inventory: tempDir('inv'), ret: tempDir('ret') };
  const inventory = new InventoryService({
    gateway, store: new JsonTaskStore({ dir: dirs.inventory, idField: 'operation_id' }),
  });
  const orderBatches = new PurchaseOrderBatchService({ gateway });
  const deliveries = [];
  const webhooks = {
    deliverSupplierImages: async (taskId, task, posting, deliveryOptions) => {
      deliveries.push({ taskId, posting, options: deliveryOptions, draft: task?.draft });
      return { sent: [], failed: [], thread_root_message_id: '' };
    },
  };
  let batchNoCalls = 0;
  const purchaseReturn = createPurchaseReturnService({
    gateway,
    config: SCAN_WRITE.purchaseReturn,
    inventory,
    orderBatches,
    webhooks,
    batchNoGenerator: {
      runExclusive: async (work) => work(),
      next: async () => { batchNoCalls += 1; return { batchNo: `CGD-20261016-000${batchNoCalls}` }; },
    },
    store: new JsonTaskStore({ dir: dirs.ret, idField: 'task_id' }),
  });
  return {
    schema, store, client, gateway, inventory, purchaseReturn, deliveries, dirs,
    cleanup: () => { rmDir(dirs.inventory); rmDir(dirs.ret); },
    rerun: (next = {}) => createHarness({ ...next, schema, store, dirs }),
  };
};

const draftFor = (pairs, overrides = {}) => ({
  product_record_id: 'prod_1',
  product_number: NUMBER,
  item_no: ITEM_NO,
  color: '黑色',
  supplier_record_id: 'sup_1',
  behavior_record_id: 'bh_return_purchase',
  operator_open_id: 'ou_inv_return_batch',
  order_amount: '399',
  items: pairs.map(([size, quantity]) => ({ size, quantity })),
  ...overrides,
});

const rowsOf = (harness, tableKey) => harness.store.get(tableIdOf(harness.schema, tableKey)) || [];
const ledgerTotal = (harness) => rowsOf(harness, 'inventoryLedger')
  .reduce((sum, record) => sum + Number(record.fields['变动数量'] || 0), 0);
const liveIds = (harness) => rowsOf(harness, 'liveInventory').map((record) => record.record_id).sort();

const snapshot = (harness) => {
  const out = {};
  for (const key of Object.keys(harness.schema.tables)) {
    out[key] = rowsOf(harness, key).map((record) => ({
      record_id: record.record_id,
      fields: JSON.parse(JSON.stringify(record.fields || {})),
    }));
  }
  return out;
};

/** 到「表 × HTTP 动作」的计数（判"调用次数"的唯一依据）。 */
const httpByTable = (harness) => {
  const tableKeyOf = new Map(Object.keys(harness.schema.tables)
    .map((key) => [tableIdOf(harness.schema, key), key]));
  const out = {};
  for (const call of harness.client.calls) {
    const key = tableKeyOf.get(call.table_id) || call.table_id;
    out[key] = out[key] || {};
    out[key][call.api] = (out[key][call.api] || 0) + 1;
  }
  return out;
};

const SCENARIOS = {
  single: { label: '单货品退货（41 码 3 双）', pairs: [[41, 3]] },
  multi: { label: '多货品退货（40/41/42 三档，共 6 双）', pairs: [[40, 2], [41, 3], [42, 1]] },
  unit: { label: '单件退货（41 码 1 双）', pairs: [[41, 1]] },
};

/** 跑一次并回收「无批量口（逐条）/ 有批量口（攒批）」两侧的真实调用次数与结果。 */
const runScenario = async (scenarioKey, taskId = `scan_return_${scenarioKey}`, extra = {}) => {
  const { pairs } = SCENARIOS[scenarioKey];
  const before = createHarness({ ...extra, batchPorts: false });
  const after = createHarness({ ...extra, batchPorts: true });
  const beforeResult = await before.purchaseReturn.submit(taskId, draftFor(pairs));
  const afterResult = await after.purchaseReturn.submit(taskId, draftFor(pairs));
  return {
    before: { result: beforeResult, harness: before, http: httpByTable(before), total: before.client.calls.length },
    after: { result: afterResult, harness: after, http: httpByTable(after), total: after.client.calls.length },
  };
};

const inventoryCounts = (side) => {
  const live = side.http.liveInventory || {};
  const ledger = side.http.inventoryLedger || {};
  return {
    listLive: live.list || 0,
    getLive: live.get || 0,
    batchGetLive: live.batchGet || 0,
    deleteLive: live.delete || 0,
    batchDeleteLive: live.batchDelete || 0,
    createLedger: ledger.create || 0,
    batchCreateLedger: ledger.batchCreate || 0,
    listBehavior: (side.http.behavior || {}).list || 0,
  };
};

const pretty = (counts) => `整表读:${counts.listLive} 逐双get:${counts.getLive} batchGet:${counts.batchGetLive}`
  + ` 逐双delete:${counts.deleteLive} batchDelete:${counts.batchDeleteLive}`
  + ` 流水create:${counts.createLedger}`
  + ` 流水batchCreate:${counts.batchCreateLedger} behavior读:${counts.listBehavior}`;

// ═══════════════════════════════════════════════════════════════════════════
// AC-IV1 ⭐ 提速可量（退货 单货品 + 多货品 各一次；贴真实 HTTP 次数）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-IV1 ⭐ 退货扣库存：逐尺码整表读＋逐双 get/delete ⇒ 各一次批量口（真实 HTTP 次数）', async () => {
  for (const key of ['single', 'multi']) {
    const run = await runScenario(key);
    try {
      const { before, after } = run;
      assert.equal(typeof before.harness.inventory.applyPurchaseReturnBatch, 'function',
        '落点：`InventoryService.applyPurchaseReturnBatch` 必须存在（本卡先红的那一条）');

      const b = inventoryCounts(before);
      const a = inventoryCounts(after);
      const sizes = SCENARIOS[key].pairs.length;
      // 非空转：批量路**真的**打了三个批量口（否则"等价"与"提速"都是空转）
      assert.ok(a.batchGetLive >= 1, `批量路必须真的用 getBatch 替掉逐双 get（实际 ${a.batchGetLive}）`);
      assert.equal(a.batchCreateLedger, 1, '批量路必须一次 createBatch 落流水');
      assert.equal(a.batchDeleteLive, 1, '批量路必须一次 deleteBatch 替掉逐双 delete（非空转）');
      assert.equal(a.getLive, 0, '批量路不许再有逐双 get');
      assert.equal(a.deleteLive, 0, '批量路不许再有逐双 delete');
      assert.equal(a.createLedger, 0, '批量路不许再有逐条 create 流水的调用');
      // 整条链上「实时库存」的整表读：1 次来自**冻结计划**那一步（本刀没改）
      // ＋ 库存那一段（改前 = 每个尺码 1 次；改后 = 整批 1 次）。
      assert.equal(b.listLive, 1 + sizes, '改前：冻结计划 1 次 ＋ 每个尺码各 1 次整表读');
      assert.equal(a.listLive, 2, '改后：冻结计划 1 次（没改）＋ 库存那一段 1 次');
      assert.equal(a.listBehavior, 1, '整批只许一次读行为表（改前每尺码一次）');

      // 改前的形状（这就是要批量的理由）
      assert.equal(b.getLive, 2 * before.result.taken_count,
        '改前：每一双 2 次 get（`auditExistingOperationRecords` 一次 ＋ 删之前确认一次）');
      assert.equal(b.deleteLive, before.result.taken_count, '改前：每一双 1 次 delete');
      assert.equal(b.createLedger, sizes, '改前：每个尺码 1 次 create 流水');
      assert.equal(b.listBehavior, sizes, '改前：每个尺码各读一次行为表');
      assert.equal(b.batchGetLive, 0, '改前没有批量读');
      assert.equal(b.batchDeleteLive, 0, '改前没有批量删');

      // 提速可量：总 HTTP 真的更少
      assert.ok(after.total < before.total,
        `${key}: 总 HTTP 必须更少（改前 ${before.total} / 改后 ${after.total}）`);
      // ⭐ 逐双 get+delete 这一段**省掉多少**（如实贴，不美化）：
      //    改前 = 2×双数（get）＋ 1×双数（delete）；改后 = 1（batchGet）＋ 1（batchDelete）。
      const saved = (b.getLive + b.deleteLive) - (a.batchGetLive + a.batchDeleteLive);
      console.log(`[AC-IV1] ${SCENARIOS[key].label} | 改前 总HTTP=${before.total} {${pretty(b)}}`
        + ` | 改后 总HTTP=${after.total} {${pretty(a)}}`
        + ` | 逐双 get+delete 那一段：${b.getLive + b.deleteLive} ⇒ ${a.batchGetLive + a.batchDeleteLive}`
        + `（省 ${saved} 次 · 双数=${before.result.taken_count}）`);
    } finally { run.before.harness.cleanup(); run.after.harness.cleanup(); }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-IV1b ⭐ 第二条链（验收）：**不是同一段**，且本卡对它零改动
// ═══════════════════════════════════════════════════════════════════════════

test('AC-IV1b ⭐ 验收（加库存）走的**不是同一段**：它已是 applyPurchaseBatch ⇒ 0 次 get/delete', async () => {
  // ① 只读核：验收那条链在 main 上就接的是**批量口**（`purchaseWebhookService.confirmArrival`）。
  //   ⭐ 2026-10-18 成对迁移（task-6 文件大小门禁）：`confirmArrivalLocked` 的方法体原样搬进
  //     `services/purchase/arrival.js`（facade 只留同名薄委托）⇒ 改前逐字读 `purchaseWebhookService.js`，
  //     改后逐字读**代码搬过去的那个文件**；**断言文本与正则逐字未动**（不是放宽）。
  const webhookSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'purchase', 'arrival.js'), 'utf8',
  );
  assert.match(webhookSrc, /inventory\.applyPurchaseBatch\(/, '验收那条链必须仍在调批量口');
  // 而退货那条链走的是**另一条**（批量口是 `applyPurchaseReturnBatch`，不是验收那个）——
  // 这就是"不是同一段"的证据。⚠️ 先剥注释再看代码（注释里提到对方的名字是**对的**）。
  const returnSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'purchaseReturnService.js'), 'utf8',
  );
  const returnCode = returnSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.equal(/\.applyPurchaseBatch\s*\(/.test(returnCode), false,
    '退货链从不走验收那个批量口（两段不同；它走的是 applyPurchaseReturnBatch）');

  // ② 实测：验收那一段（`applyPurchaseBatch`，3 码）在同一份计数 harness 上打了几次 HTTP。
  //    ⚠️ 这把刀**不碰**这条链 ⇒ 「改前 = 改后」不是一个可以"两边跑"的对照，
  //       而是一条**源码＋数字双向钉住**的结论：链路没变（上面两条哨兵）＋ 数字就是批量口的形状。
  const h = createHarness({ batchPorts: true });
  try {
    const sizes = [40, 41, 42];
    const items = sizes.map((size) => ({
      purchaseBatchRecordId: 'rec_batch_row',
      purchaseBatchNo: 'CGD-TEST-0001',
      arrivalTaskId: 'arrival_task_1',
      productRecordId: 'prod_1',
      size,
      quantity: 1,
      state: '门盒',
    }));
    const results = await h.inventory.applyPurchaseBatch(items);
    const a = inventoryCounts({ http: httpByTable(h) });
    assert.equal(results.length, 3);
    assert.deepStrictEqual(results.map((r) => r.movementQuantity), [1, 1, 1]);
    // 加库存 = 只建不删 ⇒ 逐条 get/delete 本来就是 0；批量化在 2026-10-13（#425）就完成了。
    assert.equal(a.getLive, 0, '验收（增加方向）不该有逐条 get');
    assert.equal(a.deleteLive, 0, '验收（增加方向）不该有逐条 delete');
    assert.equal(a.createLedger, 0, '验收不许逐条 create 流水');
    assert.equal(a.batchCreateLedger, 1, '验收 = 一次 createBatch 落流水');
    assert.equal(a.listLive, 1, '验收 = 一次整表读');
    assert.equal(a.batchGetLive, 0, '验收（增加方向）没有要"删之前先确认"的记录 ⇒ 不需要 batchGet');
    // ⚠️ 排除 schema 校验那一批 `appTableField.list`（一次性、与库存写入段无关）。
    const calls = h.client.calls.filter((call) => call.api !== 'fieldList');
    assert.equal(calls.length, 5,
      '验收那一段 = 5 次 HTTP：读行为表 1 ＋ 读实时库存 1 ＋ 读尺码表 1 ＋ createBatch 2（流水 / 实时库存）');
    console.log(`[AC-IV1b] 验收（加库存，3 码）| 改前=改后 那一段HTTP=${calls.length} {${pretty(a)}}`
      + ' | 它 2026-10-13 已经是批量口，本卡零改动');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-IV2 ⭐⭐ 结果逐字段等价（最重要）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-IV2 ⭐⭐ 同一输入两条路（有批量口 / 退回逐条）⇒ 全表快照＋返回值 deepStrictEqual', async () => {
  for (const key of ['single', 'multi']) {
    const run = await runScenario(key);
    try {
      const { before, after } = run;
      // 先证明「两条路真的不同路」—— 否则等价是空转。
      const a = inventoryCounts(after);
      const b = inventoryCounts(before);
      assert.ok(a.batchGetLive >= 1 && a.batchCreateLedger === 1 && a.batchDeleteLive === 1,
        '攒批路必须真的打了三个批量口（非空转）');
      assert.ok(b.getLive >= 1 && b.batchGetLive === 0 && b.deleteLive >= 1 && b.batchDeleteLive === 0
        && b.createLedger >= 1, '退回逐条那一侧必须真的是逐条（非空转）');

      // ① service 返回值逐字段等价
      assert.deepStrictEqual(after.result, before.result, `${key}: 退货 service 返回值逐字段一致`);
      // ② 全表快照逐字节等价：库存流水整张 / 实时库存余量 / 幂等键 / 行为编码 / 数量 / 行序
      assert.deepStrictEqual(snapshot(after.harness), snapshot(before.harness),
        `${key}: 落表内容必须一字不差（含 record_id 与行序）`);
      // ③ 出图/发群入参逐字等价
      assert.deepStrictEqual(after.harness.deliveries, before.harness.deliveries,
        `${key}: 出图/发群的入参一字不差`);
    } finally { run.before.harness.cleanup(); run.after.harness.cleanup(); }
  }
});

test('AC-IV2c ⭐ 老夹具（有 createBatch/getBatch、**没有** deleteBatch）⇒ 只有删那一步退回逐双，落表一字不差', async () => {
  // 这一条钉的是任务书①那句「网关没有 batchDelete（老替身/夹具）⇒ 退回逐条、与改动前逐字节同形」。
  const { pairs } = SCENARIOS.multi;
  const noDeleteBatch = createHarness({ batchPorts: true, deleteBatchPort: false });
  const allBatch = createHarness({ batchPorts: true });
  const allPerItem = createHarness({ batchPorts: false });
  try {
    const degraded = await noDeleteBatch.purchaseReturn.submit('scan_return_iv2c', draftFor(pairs));
    const batched = await allBatch.purchaseReturn.submit('scan_return_iv2c', draftFor(pairs));
    const perItem = await allPerItem.purchaseReturn.submit('scan_return_iv2c', draftFor(pairs));
    const d = inventoryCounts({ http: httpByTable(noDeleteBatch) });
    // 非空转：这一侧真的是"流水/确认走批量、删走逐双"的混合形态
    assert.equal(d.batchCreateLedger, 1, '流水仍是一次 createBatch（批量口都在，不该被删那一步拖累）');
    assert.equal(d.batchGetLive, 1, '"删之前先确认"仍是一次 getBatch');
    assert.equal(d.batchDeleteLive, 0, '没有 deleteBatch ⇒ 一次批量删都不许发');
    assert.equal(d.deleteLive, perItem.taken_count, `逐双 delete 次数 = 双数（${perItem.taken_count}）`);
    assert.equal(d.getLive, 0, '逐双 get 不该回来（确认那一步是 getBatch）');
    // 落表 / 返回值：三条路逐字节一致（含行序）
    assert.deepStrictEqual(snapshot(noDeleteBatch), snapshot(allBatch), '混合路 vs 全批量路：落表一字不差');
    assert.deepStrictEqual(snapshot(noDeleteBatch), snapshot(allPerItem), '混合路 vs 全逐条路：落表一字不差');
    assert.deepStrictEqual(degraded, batched);
    assert.deepStrictEqual(degraded, perItem);
    console.log(`[AC-IV2c] 老夹具（无 deleteBatch）| ${pretty(d)} ⇒ 只有删那一步是逐双，落表与两条路一字不差`);
  } finally { noDeleteBatch.cleanup(); allBatch.cleanup(); allPerItem.cleanup(); }
});

test('AC-IV2d ⭐ 失败粒度：官方明说某几条 deleted:false ⇒ 整批如实抛、绝不报"扣成功"、续跑不重不漏', async () => {
  // 「整片失败 ⇒ 不许把部分成功当全成功 ✗ · 也不许把全成功当失败 ✗」这一片的行为。
  // ⚠️ 注入面在**网关那一层的应答**（不是"让库存引擎自己抛"）：
  //    这样量的才是"官方如实回报 ⇒ 上层不谎报 + 把官方回报的那份账记准"。
  const h = createHarness({ batchPorts: true, notDeleted: (id) => id === 'live_41_box' });
  try {
    await assert.rejects(
      () => h.purchaseReturn.submit('scan_return_iv2d', draftFor(SCENARIOS.multi.pairs)),
      /batch_delete_count_mismatch/,
      '有记录明说没删掉 ⇒ 必须如实抛（绝不把"部分成功"当全成功）',
    );
    // 落表状态：流水已经写了（那是前一步、单独一次批量写），实时库存**只少了官方说删掉的那些**
    assert.equal(rowsOf(h, 'inventoryLedger').length, 3, '流水是一批写完的（3 档）');
    assert.deepStrictEqual(liveIds(h), ['live_40_box_3', 'live_41_box', 'live_42_box_2'],
      '只删掉官方回报 deleted:true 的那几条（40 剩 1 / 41 的 box 没删掉 / 42 剩 1）');
    // 不许把"半截"记成"已扣"；但**官方如实回报的那份账**必须记下来（否则续跑会卡在"不存在"）
    const journalDir = h.dirs.inventory;
    const states = fs.readdirSync(journalDir).filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(journalDir, name), 'utf8')));
    assert.deepStrictEqual(
      states.flatMap((state) => state.removed_live_record_ids || []).sort(),
      ['live_40_box_1', 'live_40_box_2', 'live_41_sample', 'live_41_store', 'live_42_box_1'],
      'journal 记的必须**恰好**是官方回报"已删"的那几条（不多记、不少记）',
    );
    assert.equal(states.every((state) => state.status !== 'completed'), true,
      '失败那一次不许有任何一条被标成 completed（"全成功当失败"也不许）');

    // 续跑（这一次官方不再"赖账"）⇒ 补齐、不重不漏
    const retry = h.rerun({ batchPorts: true });
    try {
      const result = await retry.purchaseReturn.submit('scan_return_iv2d', draftFor(SCENARIOS.multi.pairs));
      assert.equal(result.taken_count, 6, '续跑把没扣的扣完');
      assert.equal(rowsOf(retry, 'inventoryLedger').length, 3, '流水不重记（一档一条）');
      assert.equal(ledgerTotal(retry), 6, '总共只扣 6 双');
      assert.deepStrictEqual(liveIds(retry), ['live_40_box_3', 'live_42_box_2'], '余量正确');
    } finally { retry.cleanup(); }
    console.log('[AC-IV2d] deleted:false ⇒ 整批抛 + journal 记准官方回报的那份 + 续跑补齐不重复 ✓');
  } finally { rmDir(h.dirs.inventory); rmDir(h.dirs.ret); }
});

test('AC-IV2e ⭐ 失败粒度（另一头）：**整片成功**绝不许被当成失败（一次 batchDelete 全部 deleted:true ⇒ 正常返回）', async () => {
  // 「也不许把"全成功"当失败」——上面 AC-IV2d 钉的是前半句，这一条钉后半句。
  const h = createHarness({ batchPorts: true });
  try {
    const result = await h.purchaseReturn.submit('scan_return_iv2e', draftFor(SCENARIOS.multi.pairs));
    assert.equal(result.taken_count, 6, '整片成功 ⇒ service 正常返回（没有多抛）');
    assert.equal(result.shortfall, 0, '没有少退（不该把成功当失败）');
    const counts = inventoryCounts({ http: httpByTable(h) });
    assert.equal(counts.batchDeleteLive, 1, '成功路 = 一次 batchDelete');
    assert.equal(counts.deleteLive, 0, '成功路不许再逐双删一遍（那就是"重复扣"）');
    assert.deepStrictEqual(liveIds(h), ['live_40_box_3', 'live_42_box_2']);
    const journalDir = h.dirs.inventory;
    const states = fs.readdirSync(journalDir).filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(journalDir, name), 'utf8')));
    assert.equal(states.every((state) => state.status === 'completed'), true,
      '整片成功 ⇒ 三条都该是 completed（不许有半截状态）');
  } finally { h.cleanup(); }
});

test('AC-IV2b ⭐ 库存那一段自己的字段：流水 = 一档一条（数量/行为/尺码/货品）、余量精确', async () => {
  const h = createHarness({ batchPorts: true });
  try {
    const result = await h.purchaseReturn.submit('scan_return_iv2b', draftFor(SCENARIOS.multi.pairs));
    assert.equal(result.taken_count, 6);
    assert.equal(result.shortfall, 0);
    const ledger = rowsOf(h, 'inventoryLedger');
    assert.equal(ledger.length, 3, '一档一条流水（不多不少）');
    assert.equal(ledgerTotal(h), 6);
    for (const record of ledger) assert.deepStrictEqual(record.fields['库存行为'], ['bh_return']);
    assert.deepStrictEqual(
      ledger.map((record) => Number(record.fields['变动数量'])).sort((left, right) => left - right),
      [1, 2, 3],
    );
    assert.deepStrictEqual(liveIds(h), ['live_40_box_3', 'live_42_box_2'],
      '余量精确：40 剩 1、41 退光（门盒+样品+仓库）、42 剩 1');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-IV3 幂等：同一 task 重放 ⇒ 不重复扣
// ═══════════════════════════════════════════════════════════════════════════

test('AC-IV3 同一 task 重放 ⇒ 库存零写、流水不翻倍、余量不变、结果逐字相同', async () => {
  for (const batchPorts of [false, true]) {
    const h = createHarness({ batchPorts });
    try {
      const first = await h.purchaseReturn.submit('scan_return_iv3', draftFor(SCENARIOS.multi.pairs));
      const snap = snapshot(h);
      const ledgerRows = rowsOf(h, 'inventoryLedger').length;
      const remaining = liveIds(h);
      const before = h.client.calls.length;

      const second = await h.purchaseReturn.submit('scan_return_iv3', draftFor(SCENARIOS.multi.pairs));
      assert.deepStrictEqual(second, first, '重放把上一次的结果还给她');
      assert.deepStrictEqual(snapshot(h), snap, '重放后落表内容一个字都不许变');
      assert.equal(rowsOf(h, 'inventoryLedger').length, ledgerRows, '流水不翻倍');
      assert.deepStrictEqual(liveIds(h), remaining, '余量不变');
      // ⭐ 本条钉的是**库存那两张表**零写（"不重复加/扣"）。
      //    「采购主表」在重放时本来就有一次既有 update（`purchase.batch.order_amount.written`，
      //    改前改后都一样）—— 它不在本卡范围内，也不是库存重复扣的判据。
      const inventoryTableIds = [tableIdOf(h.schema, 'inventoryLedger'), tableIdOf(h.schema, 'liveInventory')];
      const writesAfter = h.client.calls.slice(before).filter(
        (call) => inventoryTableIds.includes(call.table_id)
          && ['create', 'batchCreate', 'update', 'batchUpdate', 'delete'].includes(call.api),
      );
      assert.equal(writesAfter.length, 0,
        `重放必须对库存零写（实际 ${writesAfter.length} 次：${writesAfter.map((c) => c.api).join('/')}）`);
      assert.equal(ledgerTotal(h), 6, '库存只扣一次');
      assert.deepStrictEqual(h.client.calls.slice(before).filter((c) => c.api === 'batchGet'), [],
        '重放连"删之前先确认"的批量读都不该再发（没有要删的）');
    } finally { h.cleanup(); }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-IV3b 幂等（**直接驱动库存引擎**，不许空转）：同一批重放 ⇒ 零写 + 同一批结果
// ═══════════════════════════════════════════════════════════════════════════

test('AC-IV3b 直接把同一批喂给 applyPurchaseReturnBatch 两次 ⇒ 第二次零写、返回同一批 id', async () => {
  const h = createHarness({ batchPorts: true });
  // 直接调库存引擎（不经过退货 service）⇒ 这条判据量得到"库存那一层自己的幂等"，
  // 不会因为上层短路而变成空转。
  const payloads = SCENARIOS.multi.pairs.map(([size, quantity]) => ({
    productRecordId: 'prod_1',
    size,
    quantity,
    state: '门盒',
    purchaseBatchRecordId: 'rec_batch_row',
    purchaseBatchNo: 'CGD-TEST-0001',
    returnTaskId: 'scan_return_iv3b',
  }));
  try {
    const first = await h.inventory.applyPurchaseReturnBatch(payloads);
    const snap = snapshot(h);
    const before = h.client.calls.length;

    const second = await h.inventory.applyPurchaseReturnBatch(payloads);
    assert.deepStrictEqual(second, first, '重放返回同一批结果（同一串流水 id / 实时库存 id）');
    assert.deepStrictEqual(snapshot(h), snap, '重放后落表内容一个字都不许变');
    const after = h.client.calls.slice(before);
    const inventoryTableIds = [tableIdOf(h.schema, 'inventoryLedger'), tableIdOf(h.schema, 'liveInventory')];
    const writes = after.filter((call) => inventoryTableIds.includes(call.table_id)
      && ['create', 'batchCreate', 'update', 'batchUpdate', 'delete'].includes(call.api));
    assert.equal(writes.length, 0,
      `重放必须对库存零写（实际 ${writes.length} 次：${writes.map((c) => c.api).join('/')}）`);
    assert.deepStrictEqual(after.filter((call) => call.api === 'batchGet'), [],
      '重放没有要删的双 ⇒ 连"删之前先确认"的批量读都不发');
    // ⭐ 非空转：重放**真的进了**那条路（批量口被调过一次幂等回查所在的通路），
    //    只是它认出了"这批已经做过" ⇒ 零写（不是"根本没跑"）。
    assert.ok(after.some((call) => call.api === 'list' || call.api === 'batchGet'),
      '重放必须真的走过读表那段（否则这条判据是空转）');
    assert.equal(ledgerTotal(h), 6, '库存只扣一次');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-IV4 续跑：写到一半中断 ⇒ 接着跑不重不漏
// ═══════════════════════════════════════════════════════════════════════════

test('AC-IV4a 批量删那一步中断（deleteBatch 抛）⇒ 接着跑不重不漏（流水不重记、余量正确）', async () => {
  // 改前逐字：注入面是 `delete`（逐双，at:3）；改后逐字：删除已批量化 ⇒ 注入面是 `batchDelete`。
  // 依据：task-65 库存写入批量化（同一段行为，注入点跟着"那一次 HTTP"走）。
  const first = createHarness({ batchPorts: true, failOnce: { api: 'batchDelete', at: 1 } });
  try {
    await assert.rejects(
      () => first.purchaseReturn.submit('scan_return_iv4a', draftFor(SCENARIOS.multi.pairs)),
      /injected transient failure/,
      '中断必须如实抛（不许假成功）',
    );
    assert.equal(rowsOf(first, 'inventoryLedger').length, 3, '流水是一批写完的（3 档）');
    assert.equal(rowsOf(first, 'purchaseOrderBatch').length, 1);
    // ⭐ 失败粒度：那一次 batchDelete **在发请求之前就抛**（结构化的瞬时故障）⇒
    //   实时库存一双都不许少（绝不把"没删成"当"删掉了"）。
    assert.deepStrictEqual(liveIds(first),
      ['live_40_box_1', 'live_40_box_2', 'live_40_box_3', 'live_41_box', 'live_41_sample',
        'live_41_store', 'live_42_box_1', 'live_42_box_2'],
      '删那一步失败 ⇒ 实时库存一双都不许少');

    const second = first.rerun({ batchPorts: true });
    try {
      const resumed = await second.purchaseReturn.submit('scan_return_iv4a', draftFor(SCENARIOS.multi.pairs));
      assert.equal(resumed.taken_count, 6, '续跑把没扣的扣完');
      assert.equal(rowsOf(second, 'inventoryLedger').length, 3, '流水不重记（一档一条）');
      assert.equal(ledgerTotal(second), 6, '总共只扣 6 双');
      assert.deepStrictEqual(liveIds(second), ['live_40_box_3', 'live_42_box_2'], '余量正确');
      assert.equal(rowsOf(second, 'purchaseRequest').length, 3, '明细不翻倍');
      assert.equal(rowsOf(second, 'purchaseOrderBatch').length, 1, '批次不重复建');
    } finally { second.cleanup(); }
  } finally { rmDir(first.dirs.inventory); rmDir(first.dirs.ret); }
});

test('AC-IV4b 流水那一次批量写失败 ⇒ 这一批一条都不写；重试 ⇒ 补齐、不重复', async () => {
  // ⚠️ 直接驱动库存引擎（不经过退货 service）：退货明细那条链自己也有一个 `batchCreate`
  //    （#749 的兜底），从 service 层注入会先命中它 ⇒ 量不到"流水那一次批量写"。
  const h = createHarness({ batchPorts: true, failOnce: { api: 'batchCreate', at: 1 } });
  const payloads = SCENARIOS.multi.pairs.map(([size, quantity]) => ({
    productRecordId: 'prod_1',
    size,
    quantity,
    state: '门盒',
    purchaseBatchRecordId: 'rec_batch_row',
    purchaseBatchNo: 'CGD-TEST-0001',
    returnTaskId: 'scan_return_iv4b',
  }));
  try {
    await assert.rejects(
      () => h.inventory.applyPurchaseReturnBatch(payloads),
      /injected transient failure/,
      '批量写失败必须如实抛（不许把半截当成功）',
    );
    assert.equal(rowsOf(h, 'inventoryLedger').length, 0, '流水批量写失败 ⇒ 流水一条都不落');
    assert.equal(liveIds(h).length, 8, '实时库存一双都不许少');

    const retry = await h.inventory.applyPurchaseReturnBatch(payloads);
    assert.deepStrictEqual(retry.map((result) => result.movementQuantity), [2, 3, 1]);
    assert.equal(rowsOf(h, 'inventoryLedger').length, 3, '重试补齐、不重复（一档一条）');
    assert.equal(ledgerTotal(h), 6);
    assert.deepStrictEqual(liveIds(h), ['live_40_box_3', 'live_42_box_2']);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-IV5 单件（N=1）不退化
// ═══════════════════════════════════════════════════════════════════════════

test('AC-IV5 ⭐ 单件（1 尺码 1 双）不退化：总 HTTP **等量或更好**（如实标，不美化）', async () => {
  const run = await runScenario('unit');
  try {
    const { before, after } = run;
    const b = inventoryCounts(before);
    const a = inventoryCounts(after);
    assert.ok(after.total <= before.total,
      `单件 ⇒ 总 HTTP 不许变慢（改前 ${before.total} / 改后 ${after.total}）`);
    // 非空转：单件也必须真的走批量口（否则"不退化"是空转）
    assert.equal(a.batchGetLive, 1, '单件也必须一次 getBatch');
    assert.equal(a.batchDeleteLive, 1, '单件也必须一次 deleteBatch');
    assert.equal(a.getLive + a.deleteLive, 0, '单件不许再有逐双 get/delete');
    console.log(`[AC-IV5] ${SCENARIOS.unit.label} | 改前 总HTTP=${before.total} {${pretty(b)}}`
      + ` | 改后 总HTTP=${after.total} {${pretty(a)}}`
      + ` ⇒ ${after.total === before.total ? '等量（如实，不美化）' : `更快（省 ${before.total - after.total} 次）`}`);
  } finally { run.before.harness.cleanup(); run.after.harness.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-IV6 源码哨兵：形态**逐行对齐 applyPurchaseBatch**，且不碰禁区
// ═══════════════════════════════════════════════════════════════════════════

test('AC-IV6 源码哨兵：批量口与 applyPurchaseBatch 同形（runForStocks/整表读/createBatch/getBatch/deleteBatch）', () => {
  const src = path.join(__dirname, '..', 'src');
  const inventory = fs.readFileSync(path.join(src, 'services', 'inventoryService.js'), 'utf8');
  const batchBody = inventory.slice(inventory.indexOf('async applyPurchaseReturnBatch('));
  assert.ok(batchBody.length > 0, '`applyPurchaseReturnBatch` 必须存在');
  const end = batchBody.indexOf('\n  async ', 10);
  const body = end > 0 ? batchBody.slice(0, end) : batchBody;
  assert.match(body, /this\.runForStocks\(/, '必须与 applyPurchaseBatch 一样按 stock_key 占住串行队列');
  assert.match(body, /this\.gateway\.listAll\('liveInventory'\)/, '必须一次整表读＋内存索引');
  assert.match(body, /this\.gateway\.createBatch\('inventoryLedger'/, '流水必须走既有批量口');
  assert.match(body, /this\.gateway\.getBatch\('liveInventory'/, '逐双 get 必须换成既有批量读口');
  // ⭐ task-65 收口（Lead 授权加口）：删除改走网关新加的 `deleteBatch`，
  //   同时**保留**逐双 `delete` 的回落（老夹具没有 deleteBatch ⇒ 只有删那一步退回，见 AC-IV2c）。
  assert.match(body, /this\.gateway\.deleteBatch\('liveInventory'/,
    '逐双 delete 必须换成网关新加的批量删口');
  assert.match(body, /this\.gateway\.delete\('liveInventory'/,
    '老夹具没有 deleteBatch ⇒ 必须仍能退回逐双删（同形）');
  // 🔴 形态对齐：**不许在库存引擎里自造第二套批量形态**（批量 HTTP 一律经网关）
  assert.equal(/bitable\.appTableRecord|batch_delete/.test(inventory), false,
    '库存引擎不许直连飞书 SDK 的批量删（批量形态只许在网关里有一份）');
  // 网关那一半：`deleteBatch` 存在，且用的是官方 `appTableRecord.batchDelete`、分片与既有批量口同尺子
  const gateway = fs.readFileSync(path.join(src, 'services', 'v1BitableGateway.js'), 'utf8');
  assert.match(gateway, /async deleteBatch\(tableKey, ids = \[\], options = \{\}\)/,
    '网关必须有 `deleteBatch`（task-65 ①）');
  assert.match(gateway, /appTableRecord\.batchDelete\(\{/, '必须调官方 batchDelete');
  const deleteBatchBody = gateway.slice(gateway.indexOf('async deleteBatch(tableKey'));
  assert.match(deleteBatchBody, /BATCH_GET_CHUNK_SIZE/, '分片必须与 createBatch / getBatch 同一把尺子（500）');
  // 🔴 只加能力：单条 `delete` 一字没动（它的既有调用方行为逐字不变）
  assert.match(gateway, /async delete\(tableKey, recordId\) \{\n    const table = this\.tableWithId\(tableKey\);\n    const response = await this\.client\.bitable\.appTableRecord\.delete\(\{/,
    '单条 delete 必须原样保留（只加能力，不改既有调用）');
  // 退货 service 走的是批量薄封装，且**保留**逐条回落（网关没有批量口时与改动前逐字节同形）
  const returnService = fs.readFileSync(path.join(src, 'services', 'purchaseReturnService.js'), 'utf8');
  assert.match(returnService, /applyPurchaseReturnBatch/, '退货链必须接上批量口');
  assert.match(returnService, /applyPurchaseReturn\(/, '网关没有批量口时仍要能退回逐条（同形）');
});
