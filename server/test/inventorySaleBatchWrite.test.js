'use strict';

/**
 * ⭐⭐ task-3（2026-10-18 提速 · 第 4 步）：**销售出库（扣库存）的批量写**。
 *
 * ## 改前逐字 → 改后逐字 → 依据
 *
 * **依据**：Lead 派卡「第 4 步：库存流水 ＋ 实时库存批量扣减」——
 *   销售交付（`SalesDeliveryService.deliver`）那一跑里**最后一段串行写**。
 *
 * **改前（逐字）**：`_deliver` 里**逐条明细**调 `inventory.applySale` ⇒ 落到
 *   `InventoryService.applyChange` ＋ `executeOperation`，**每条明细**要敲：
 *     · **1 次** `listAll('behavior')`（`resolveStockBehavior`）
 *     · **1 次** `listAll('liveInventory')`（整表读，生产几千行 ⇒ 翻页 ⇒ 多次 HTTP）
 *     · **1 次** `listAll('inventoryLedger')`（`findLedger` 的"远端是否已有流水"守护）
 *     · **1 次** `create('inventoryLedger')`（写流水）
 *     · **1 次** `get('liveInventory')`（`auditExistingOperationRecords` 的逐双核对）
 *     · **1 次** `get('liveInventory')`（删之前确认那一条）
 *     · **1 次** `delete('liveInventory')`（扣那一双）
 *   ⇒ 3 行 = 3×(读 3 表) ＋ 3 次 create ＋ 6 次 get ＋ 3 次 delete。
 *
 * **改后（逐字）**：一次 `inventory.applySaleBatch(rows)`，**整批**只敲：
 *     · **1 次** `listAll('behavior')`
 *     · **1 次** `listAll('liveInventory')` ＋ 内存索引（同一单里同款同码的行用 `claimed` 排除已挑走的双）
 *     · **1 次** `listAll('inventoryLedger')`（远端"已有流水"守护，整批一次）
 *     · **1 次** `createBatch('inventoryLedger')`（流水一次写完）
 *     · **1 次** `getBatch('liveInventory')`（替掉逐双 `get`，仍保留"删之前先确认那一条"的守护）
 *     · **1 次** `deleteBatch('liveInventory')`（整批一次删完，≤500/片由网关分片）
 *
 * 🔴 **语义一个字节都不许变**（判据 AC-SB2 / AC-SB3 / AC-SB4）：
 *   · 流水字段（编号 / 尺码 / 变动数量 / 库存行为 / **关联销售 = 销售主表 record_id**）、
 *     实时库存余量、销售明细「履约状态」、返回值 —— 有批量口与无批量口**逐字段等价**；
 *   · 「门盒 → 样品」的消耗顺序、样品消耗计数、补样品候选（`remainingSizes`）**同一条口径**；
 *   · 幂等仍是「销售明细 id（本地幂等键）＋ `operationId`」⇒ **重放零写、不重复扣**；
 *   · 部分失败（某一行库存不足）**只让那一行失败**，其余照扣；失败如实带 reason，不静默。
 *
 * ⚠️ **已知边界（如实标，不美化）**：`deleteBatch` 超过 500 条时由网关**内部**分片 ⇒
 *   "1 次 `deleteBatch`"这句在 **N ≤ 500** 时成立（一堆销售明细远到不了 500）。
 *
 * ⚠️ 本文件用**真的** `V1BitableGateway`（只把飞书 SDK 的 `client` 换成内存替身 ⇒
 *   `createBatch` / `getBatch` / `deleteBatch` / `listAll` 翻页 / `assertSuccess` 全是**生产代码**在跑）
 *   ＋ 真的 `InventoryService` / `SalesDeliveryService`。
 *   HTTP 次数 = 内存 client 的**请求级计数**（不拿时间抖动当证据）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 真 schema 需要 app_token；尺码管理表没有硬编码兜底 ⇒ 也要给一个非空 table_id。
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_inv_sale_batch_test';
process.env.FEISHU_V1_SIZE_TABLE_ID = process.env.FEISHU_V1_SIZE_TABLE_ID || 'tbl_size_inv_sale_batch_test';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { V1BitableGateway } = require('../src/services/v1BitableGateway');
const { InventoryService } = require('../src/services/inventoryService');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const ENTRY_ID = 'entry_sale_batch_1';
const SALE_BEHAVIOR_ID = 'bh_sale_decrease';

// ── 语义键 → 物理列名（照真 schema；写错语义键当场抛，别让夹具自己漂）─────────
const F = (table, key) => {
  const name = V1_BITABLE_SCHEMA.tables[table].fields[key];
  if (!name) throw new Error(`schema 里没有 ${table}.${key}`);
  return name;
};

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

const SALE_BEHAVIOR = {
  record_id: SALE_BEHAVIOR_ID,
  fields: {
    [F('behavior', 'name')]: '销售减少',
    [F('behavior', 'code')]: 'STOCK_SALE_DECREASE',
    [F('behavior', 'stockDirection')]: '减少',
    [F('behavior', 'enabled')]: true,
  },
};

/** 销售主表那一行：`写入状态=成功`（= 已入账，交付的前置闸门）。 */
const entryRow = () => ({
  record_id: ENTRY_ID,
  fields: {
    [F('salesEntry', 'orderNo')]: 'XSD-TEST-0001',
    [F('salesEntry', 'writeStatus')]: '成功',
  },
});

const detailRow = (recordId, productRecordId, size) => ({
  record_id: recordId,
  fields: {
    [F('salesDetail', 'salesEntry')]: [ENTRY_ID],
    [F('salesDetail', 'product')]: [productRecordId],
    [F('salesDetail', 'size')]: [`size_${size}`],
    [F('salesDetail', 'fulfillmentStatus')]: '未交付',
    [F('salesDetail', 'actualAmount')]: 100,
  },
});

/** 一双「实时库存」记录（门盒 / 样品）。 */
const liveUnit = (recordId, productRecordId, size, state = '门盒') => ({
  record_id: recordId,
  fields: {
    [F('liveInventory', 'product')]: [productRecordId],
    [F('liveInventory', 'size')]: [`size_${size}`],
    [F('liveInventory', 'state')]: state,
    [F('liveInventory', 'stockKey')]: `${productRecordId}|黑色|A|${size}`,
  },
});

const sizeRow = (size) => ({ record_id: `size_${size}`, fields: { [F('sizeManagement', 'size')]: size } });

/**
 * 场景（每条明细 = 一双，`quantity` 恒 1 —— 与扫码销售"一单一双一行"同一个形状）。
 * `live` 就是"这一单开始前店里有什么"。
 */
const SCENARIOS = {
  three: {
    label: '3 行现货（三个不同货品 / 尺码）',
    details: [['detail_a', 'prod_a', 40], ['detail_b', 'prod_b', 41], ['detail_c', 'prod_c', 42]],
    live: [
      liveUnit('live_a_40_box', 'prod_a', 40),
      liveUnit('live_b_41_box', 'prod_b', 41),
      liveUnit('live_c_42_box', 'prod_c', 42),
    ],
  },
  partial: {
    label: '4 行里第 2 行缺货（部分失败）',
    details: [
      ['detail_a', 'prod_a', 40], ['detail_b', 'prod_b', 41],
      ['detail_c', 'prod_c', 42], ['detail_d', 'prod_d', 43],
    ],
    live: [
      liveUnit('live_a_40_box', 'prod_a', 40),
      liveUnit('live_c_42_box', 'prod_c', 42),
      liveUnit('live_d_43_box', 'prod_d', 43),
    ],
  },
  sample: {
    label: '1 行扣到样品（还剩一双样品）＋ 1 行门盒',
    details: [['detail_s', 'prod_s', 40], ['detail_t', 'prod_t', 41]],
    live: [
      liveUnit('live_s_40_sample_1', 'prod_s', 40, '样品'),
      liveUnit('live_s_40_sample_2', 'prod_s', 40, '样品'),
      liveUnit('live_t_41_box', 'prod_t', 41),
    ],
  },
  same: {
    label: '同一单两行同款同码、只有 1 双现货',
    details: [['detail_x1', 'prod_x', 40], ['detail_x2', 'prod_x', 40]],
    live: [liveUnit('live_x_40_box', 'prod_x', 40)],
  },
  unit: {
    label: '单件（1 行 1 双）',
    details: [['detail_u', 'prod_u', 40]],
    live: [liveUnit('live_u_40_box', 'prod_u', 40)],
  },
};

const seedRecords = (scenario) => ({
  salesEntry: [entryRow()],
  salesDetail: scenario.details.map(([recordId, productRecordId, size]) =>
    detailRow(recordId, productRecordId, size)),
  liveInventory: scenario.live,
  inventoryLedger: [],
  behavior: [SALE_BEHAVIOR],
  // 38 起，三行/四行的场景用得到哪几个就放哪几个（尺码表是"要哪一码先有那一行"）。
  sizeManagement: [38, 39, 40, 41, 42, 43, 44].map(sizeRow),
  paymentRecord: [],
});

const seedStore = (schema, scenario) => {
  const store = new Map();
  for (const [key, records] of Object.entries(seedRecords(scenario))) {
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
    if (name === sizeField && ['liveInventory', 'inventoryLedger', 'salesDetail'].includes(tableKey)) {
      return { field_name: name, type: 18, property: { table_id: sizeTableId, multiple: false } };
    }
    return { field_name: name, type: 1 };
  });
};

/**
 * 飞书 SDK `client` 的内存替身：**每次调用 = 一次 HTTP 请求**，逐条记进 `calls`。
 * ⚠️ 各接口的入参位置**照 SDK 的真实契约**：`batch_get` 的 id 在 **`data.record_ids`**；
 *    `batchDelete` 请求体 `data.records` = **id 字符串数组**，响应 `data.records = [{deleted, record_id}]`。
 */
const createStubClient = (store) => {
  const calls = [];
  let sequence = 0;
  const ok = (data) => ({ code: 0, data });
  const nextId = () => `rec_${++sequence}`;
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
        async batchDelete({ path, data }) {
          record('batchDelete', { path, data });
          const wanted = (data?.records || []).map((id) => String(id).trim()).filter(Boolean);
          const rows = rowsOf(path.table_id);
          const deleted = wanted
            .filter((id) => rows.some((row) => row.record_id === id))
            .map((id) => ({ deleted: true, record_id: id }));
          const removed = new Set(deleted.map((entry) => entry.record_id));
          setRows(path.table_id, rows.filter((row) => !removed.has(row.record_id)));
          return ok({ records: deleted });
        },
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

// ═══════════════════════════════════════════════════════════════════════════
// harness
// ═══════════════════════════════════════════════════════════════════════════

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `inv-sale-batch-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 不影响结论 */ } };

/**
 * `batchPorts: false` ⇒ 网关**没有**批量口（`createBatch` / `getBatch` / `deleteBatch` 都拿掉）
 * = 「改动前的语义路径」（老替身 / 未接线）⇒ 库存引擎必须**退回逐条**、与今天逐字节同形。
 */
const createHarness = (scenarioKey, options = {}) => {
  const scenario = SCENARIOS[scenarioKey];
  const schema = options.schema || buildSchema();
  const store = options.store || seedStore(schema, scenario);
  const client = createStubClient(store);
  const gateway = new V1BitableGateway({ schema, client });
  if (options.batchPorts === false) {
    gateway.createBatch = undefined;
    gateway.getBatch = undefined;
    gateway.deleteBatch = undefined;
  }
  const dirs = options.dirs || { inventory: tempDir(scenarioKey) };
  const inventory = new InventoryService({
    gateway, store: new JsonTaskStore({ dir: dirs.inventory, idField: 'operation_id' }),
  });
  const delivery = new SalesDeliveryService({ gateway, inventory });
  return {
    scenario, schema, store, client, gateway, inventory, delivery, dirs,
    detailIds: scenario.details.map(([recordId]) => recordId),
    cleanup: () => rmDir(dirs.inventory),
    rerun: (next = {}) => createHarness(scenarioKey, { ...options, ...next, schema, store, dirs }),
  };
};

const rowsOf = (harness, tableKey) => harness.store.get(tableIdOf(harness.schema, tableKey)) || [];
const liveIds = (harness) => rowsOf(harness, 'liveInventory').map((record) => record.record_id).sort();
const ledgerTotal = (harness) => rowsOf(harness, 'inventoryLedger')
  .reduce((sum, record) => sum + Number(record.fields[F('inventoryLedger', 'quantityChange')] || 0), 0);

const snapshot = (harness) => {
  const out = {};
  for (const [key, tableId] of Object.entries(harness.schema.tables).map(([k, v]) => [k, v.tableId])) {
    out[key] = (harness.store.get(tableId) || []).map((record) => ({
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

const deliverAll = (harness) => harness.delivery.deliver({
  salesEntryRecordId: ENTRY_ID, detailRecordIds: harness.detailIds,
});

/** 跑一次并回收「无批量口（逐条）/ 有批量口（攒批）」两侧的真实调用次数与结果。 */
const runScenario = async (scenarioKey) => {
  const before = createHarness(scenarioKey, { batchPorts: false });
  const after = createHarness(scenarioKey, { batchPorts: true });
  const beforeResult = await deliverAll(before);
  const afterResult = await deliverAll(after);
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
    listLedger: ledger.list || 0,
    createLedger: ledger.create || 0,
    batchCreateLedger: ledger.batchCreate || 0,
    listBehavior: (side.http.behavior || {}).list || 0,
  };
};

const pretty = (c) => `整表读:${c.listLive} 逐双get:${c.getLive} batchGet:${c.batchGetLive}`
  + ` 逐双delete:${c.deleteLive} batchDelete:${c.batchDeleteLive}`
  + ` 流水读:${c.listLedger} 流水create:${c.createLedger} 流水batchCreate:${c.batchCreateLedger}`
  + ` behavior读:${c.listBehavior}`;

// ═══════════════════════════════════════════════════════════════════════════
// AC-SB1 ⭐ 提速可量：逐条 ⇒ 各一次批量口（贴真实 HTTP 次数）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SB1 ⭐ 销售扣库存：逐条整表读＋逐双 get/delete ⇒ 整批各一次批量口（真实 HTTP 次数）', async () => {
  for (const key of ['three', 'partial']) {
    const run = await runScenario(key);
    try {
      const { before, after } = run;
      assert.equal(typeof after.harness.inventory.applySaleBatch, 'function',
        '落点：`InventoryService.applySaleBatch` 必须存在（本卡先红的那一条）');
      const b = inventoryCounts(before);
      const a = inventoryCounts(after);
      const applied = 3; // three / partial 两侧都正好扣成 3 行（partial 第 2 行缺货）
      const lines = after.harness.scenario.details.length; // 缺货那一行**也**读过整表才报错
      // 非空转：批量路**真的**打了那几个批量口（否则"等价"与"提速"都是空转）
      assert.equal(a.batchCreateLedger, 1, '批量路必须一次 createBatch 落流水');
      assert.equal(a.batchGetLive, 1, '批量路必须一次 getBatch 替掉逐双 get（删之前确认）');
      assert.equal(a.batchDeleteLive, 1, '批量路必须一次 deleteBatch 替掉逐双 delete');
      assert.equal(a.createLedger, 0, '批量路不许再有逐条 create 流水的调用');
      assert.equal(a.getLive, 0, '批量路不许再有逐双 get');
      assert.equal(a.deleteLive, 0, '批量路不许再有逐双 delete');
      assert.equal(a.listLive, 1, '改后：库存那一段整批只读一次「实时库存」');
      assert.equal(a.listBehavior, 1, '改后：整批只读一次行为表');
      assert.equal(a.listLedger, 1, '改后：远端"已有流水"守护整批只读一次');
      // 改前的形状（这就是要批量的理由）
      assert.equal(b.batchCreateLedger + b.batchGetLive + b.batchDeleteLive, 0, '改前没有批量口');
      assert.equal(b.createLedger, applied, '改前：每条明细 1 次 create 流水');
      assert.equal(b.getLive, 2 * applied, '改前：每一双 2 次 get（audit 一次 ＋ 删之前确认一次）');
      assert.equal(b.deleteLive, applied, '改前：每一双 1 次 delete');
      assert.equal(b.listLive, lines, '改前：每条明细一次整表读（缺货那一条也读过才报错）');
      assert.equal(b.listBehavior, lines, '改前：每条明细各读一次行为表');
      assert.ok(b.listLedger >= applied,
        `改前：每条明细至少读一次流水表（幂等守护 ＋ executeOperation 再回查一次；实际 ${b.listLedger}）`);
      // 提速可量：总 HTTP 真的更少
      assert.ok(after.total < before.total,
        `${key}: 总 HTTP 必须更少（改前 ${before.total} / 改后 ${after.total}）`);
      console.log(`[AC-SB1] ${after.harness.scenario.label} | 改前 总HTTP=${before.total} {${pretty(b)}}`
        + ` | 改后 总HTTP=${after.total} {${pretty(a)}}`
        + ` ⇒ 库存那一段 ${b.createLedger + b.getLive + b.deleteLive + b.listLive + b.listBehavior + b.listLedger}`
        + ` ⇒ ${a.batchCreateLedger + a.batchGetLive + a.batchDeleteLive + a.listLive + a.listBehavior + a.listLedger} 次`);
    } finally { run.before.harness.cleanup(); run.after.harness.cleanup(); }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SB2 ⭐⭐ 结果逐字段等价（最重要）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SB2 ⭐⭐ 同一输入两条路（有批量口 / 退回逐条）⇒ 全表快照＋返回值 deepStrictEqual', async () => {
  for (const key of ['three', 'partial', 'sample', 'same', 'unit']) {
    const run = await runScenario(key);
    try {
      const { before, after } = run;
      // 先证明「两条路真的不同路」—— 否则等价是空转。
      const a = inventoryCounts(after);
      const b = inventoryCounts(before);
      assert.ok(a.batchCreateLedger >= 1 && a.batchGetLive >= 1 && a.batchDeleteLive >= 1,
        `${key}: 攒批路必须真的打了批量口（非空转）`);
      assert.ok(b.createLedger >= 1 && b.getLive >= 1 && b.deleteLive >= 1
        && b.batchCreateLedger === 0 && b.batchGetLive === 0 && b.batchDeleteLive === 0,
      `${key}: 退回逐条那一侧必须真的是逐条（非空转）`);

      // ① 交付 service 返回值逐字段等价（results 里含每条的流水 id / 实时库存 id / 余量）
      assert.deepStrictEqual(after.result, before.result,
        `${key}: 交付返回值逐字段一致（含 ledgerRecordId / liveRecordIds / remainingSizes）`);
      // ② 全表快照逐字节等价：流水整张 / 实时库存余量 / 明细履约状态 / 行序
      assert.deepStrictEqual(snapshot(after.harness), snapshot(before.harness),
        `${key}: 落表内容必须一字不差（含 record_id 与行序）`);
    } finally { run.before.harness.cleanup(); run.after.harness.cleanup(); }
  }
});

test('AC-SB2b ⭐ 流水字段逐字：编号 / 尺码 / 变动数量 / 库存行为 / **关联销售=销售主表 id**', async () => {
  const h = createHarness('three', { batchPorts: true });
  try {
    const result = await deliverAll(h);
    assert.equal(result.failures.length, 0);
    assert.equal(result.fulfilledQuantity, undefined); // 返回值里没有这个名字（防手滑加字段）
    assert.equal(result.deliveredQuantity, 3);
    const ledger = rowsOf(h, 'inventoryLedger');
    assert.equal(ledger.length, 3, '三行明细 = 三条流水（不多不少）');
    assert.equal(ledgerTotal(h), 3, '变动数量合计 = 3 双');
    const details = rowsOf(h, 'salesDetail');
    for (const [index, record] of ledger.entries()) {
      const [detailId, productRecordId, size] = h.scenario.details[index];
      assert.deepStrictEqual(record.fields[F('inventoryLedger', 'product')], [productRecordId],
        `第 ${index + 1} 条流水的货品`);
      assert.deepStrictEqual(record.fields[F('inventoryLedger', 'size')], [`size_${size}`],
        `第 ${index + 1} 条流水的尺码`);
      assert.equal(Number(record.fields[F('inventoryLedger', 'quantityChange')]), 1);
      assert.deepStrictEqual(record.fields[F('inventoryLedger', 'behavior')], [SALE_BEHAVIOR_ID]);
      // 🔴 关联销售 = **销售主表** record_id（2026-10-18 业务口径）；明细 id 只进本地幂等键。
      assert.deepStrictEqual(record.fields[F('inventoryLedger', 'salesDetail')], [ENTRY_ID],
        '「关联销售」必须写销售主表 id（不是明细 id、不是批次）');
      const detail = details.find((row) => row.record_id === detailId);
      assert.equal(detail.fields[F('salesDetail', 'fulfillmentStatus')], '已交付',
        '扣成功那一条明细的「履约状态」= 已交付');
    }
  } finally { h.cleanup(); }
});

test('AC-SB2c ⭐ 门盒→样品顺序 / 样品消耗 / 补样品候选（remainingSizes）一个字没变', async () => {
  for (const batchPorts of [false, true]) {
    const h = createHarness('sample', { batchPorts });
    try {
      const result = await deliverAll(h);
      assert.equal(result.failures.length, 0);
      const sampleLine = result.results.find((item) => item.detailRecordId === 'detail_s');
      assert.equal(sampleLine.inventoryResult.sampleConsumedQuantity, 1,
        '1 门盒都没有 ⇒ 扣到样品，样品消耗计数 = 1');
      // 扣的是**先门盒、后样品**那一条口径下应当扣的那一双：两双样品里 record_id 小的那双。
      assert.deepStrictEqual(sampleLine.inventoryResult.consumedLiveRecordIds, ['live_s_40_sample_1'],
        '同一状态内按 record_id 升序（与改动前逐个 sort 的顺序一致）');
      // 补样品候选：这一单卖了 40 码样品 ⇒ 40 码还剩 1 双样品（41 码门盒不属于这个货品）
      assert.deepStrictEqual(sampleLine.inventoryResult.remainingSizes,
        [{ size: 40, doorBoxCount: 0, sampleCount: 1, warehouseCount: 0 }],
        'remainingSizes 与逐条路径同一份（从这批已读到的实时库存算，零额外整表读）');
      assert.deepStrictEqual(result.sampleReplacements.map((item) => item.salesDetailRecordId), ['detail_s']);
      assert.deepStrictEqual(liveIds(h), ['live_s_40_sample_2'],
        '扣掉 1 双样品（detail_s）＋ 1 双门盒（detail_t），余量正确');
    } finally { h.cleanup(); }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SB3 ⭐ 部分失败语义：一行缺货不拖累其余，且如实带 reason
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SB3 ⭐ 第 2 行缺货 ⇒ 只那一行失败（其余 3 行照扣），批量路与逐条路结果一致', async () => {
  const run = await runScenario('partial');
  try {
    const { before, after } = run;
    for (const [label, side] of [['逐条', before], ['批量', after]]) {
      const result = side.result;
      assert.deepStrictEqual(result.failures.map((item) => item.lineNumber), [2],
        `${label}: 只有第 2 行失败（失败如实、不静默）`);
      assert.match(result.failures[0].error, /库存不足/,
        `${label}: 失败原因必须带库存引擎那句 reason`);
      assert.equal(result.deliveredQuantity, 3, `${label}: 其余 3 行照扣`);
      assert.equal(result.totalQuantity, 4);
      assert.equal(result.fulfillmentStatus, '部分交付');
      assert.equal(rowsOf(side.harness, 'inventoryLedger').length, 3, `${label}: 流水 3 条`);
      assert.deepStrictEqual(await Promise.all(side.harness.detailIds.map(async (id) =>
        (await side.harness.gateway.get('salesDetail', id))
          .fields[F('salesDetail', 'fulfillmentStatus')])),
      ['已交付', '未交付', '已交付', '已交付'], `${label}: 明细履约状态`);
    }
    assert.deepStrictEqual(after.result, before.result, '批量 / 逐条两条路返回值逐字段一致');
    assert.deepStrictEqual(snapshot(after.harness), snapshot(before.harness), '落表一字不差');
    // 一行失败**没有**把批量口变成逐条：整批仍是一次 createBatch + 一次 deleteBatch
    const a = inventoryCounts(after);
    assert.equal(a.batchCreateLedger, 1, '缺一行不影响"流水一次 batch"');
    assert.equal(a.batchDeleteLive, 1, '缺一行不影响"实时库存一次批量删"');
    console.log(`[AC-SB3] 缺 1 行 ⇒ 批量路仍是 1 次 createBatch + 1 次 deleteBatch（部分失败如实）`);
  } finally { run.before.harness.cleanup(); run.after.harness.cleanup(); }
});

test('AC-SB3b ⭐ 同一单两行同款同码、只有 1 双 ⇒ 只扣 1 双，第 2 行如实报库存不足（与逐条路径同一句）', async () => {
  const run = await runScenario('same');
  try {
    const { before, after } = run;
    for (const [label, side] of [['逐条', before], ['批量', after]]) {
      const result = side.result;
      assert.deepStrictEqual(result.failures.map((item) => item.lineNumber), [2], `${label}: 第 2 行失败`);
      assert.match(result.failures[0].error, /门盒和样品库存不足/,
        `${label}: 与改动前**逐字同一句**报文（现有 0 双 —— 前面那行刚把这一双扣掉）`);
      assert.equal(rowsOf(side.harness, 'inventoryLedger').length, 1, `${label}: 只扣 1 双`);
      assert.deepStrictEqual(liveIds(side.harness), [], `${label}: 那一双被扣掉，不重复扣`);
    }
    assert.deepStrictEqual(after.result, before.result, '批量 / 逐条两条路返回值逐字段一致');
    assert.deepStrictEqual(snapshot(after.harness), snapshot(before.harness), '落表一字不差');
  } finally { run.before.harness.cleanup(); run.after.harness.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SB4 幂等：重放零写、流水不翻倍、余量不变、结果逐字相同
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SB4a 同一单重放（有 / 无批量口）⇒ 库存两张表零写、流水不翻倍、结果逐字相同', async () => {
  for (const batchPorts of [false, true]) {
    const h = createHarness('three', { batchPorts });
    try {
      const first = await deliverAll(h);
      const snap = snapshot(h);
      const ledgerRows = rowsOf(h, 'inventoryLedger').length;
      const remaining = liveIds(h);
      const before = h.client.calls.length;

      const second = await deliverAll(h);
      // ⚠️ 重放时明细已经是「已交付」⇒ 走的是**改动前就存在的那一支**（`duplicate: true`，
      //    库存结果由 `getSaleResult` 从本地任务记录里取回来）。所以比的不是整串 results 的形状，
      //    而是**库存本身**（每条的流水 id / 实时库存 id / 余量）—— 那才是"不重复扣"的判据。
      assert.equal(second.failures.length, 0, '重放不报错');
      assert.deepStrictEqual(second.results.map((item) => item.duplicate), [true, true, true],
        '已交付的明细重放 = duplicate（改动前同一支）');
      assert.deepStrictEqual(second.results.map((item) => item.inventoryResult),
        first.results.map((item) => item.inventoryResult),
        '重放把上一次的库存结果还给她（同一串流水 id / 实时库存 id）');
      assert.equal(second.deliveredQuantity, first.deliveredQuantity);
      assert.equal(second.fulfillmentStatus, first.fulfillmentStatus);
      assert.deepStrictEqual(second.sampleReplacements, first.sampleReplacements);
      assert.deepStrictEqual(snapshot(h), snap, '重放后落表内容一个字都不许变');
      assert.equal(rowsOf(h, 'inventoryLedger').length, ledgerRows, '流水不翻倍');
      assert.deepStrictEqual(liveIds(h), remaining, '余量不变');
      const inventoryTableIds = [tableIdOf(h.schema, 'inventoryLedger'), tableIdOf(h.schema, 'liveInventory')];
      const writesAfter = h.client.calls.slice(before).filter(
        (call) => inventoryTableIds.includes(call.table_id)
          && ['create', 'batchCreate', 'update', 'batchUpdate', 'delete', 'batchDelete'].includes(call.api),
      );
      assert.equal(writesAfter.length, 0,
        `重放必须对库存零写（实际 ${writesAfter.length} 次：${writesAfter.map((c) => c.api).join('/')}）`);
      assert.equal(ledgerTotal(h), 3, '库存只扣一次');
      console.log(`[AC-SB4a] ${batchPorts ? '批量口' : '逐条'} 重放 ⇒ 库存零写 ✓`);
    } finally { h.cleanup(); }
  }
});

test('AC-SB4b ⭐ 直接把同一批喂给 applySaleBatch 两次 ⇒ 第二次零写、返回同一批 id', async () => {
  const h = createHarness('three', { batchPorts: true });
  try {
    const payloads = h.scenario.details.map(([detailId, productRecordId, size]) => ({
      salesDetailRecordId: detailId,
      salesEntryRecordId: ENTRY_ID,
      productRecordId,
      size,
      quantity: 1,
    }));
    const first = await h.inventory.applySaleBatch(payloads);
    assert.equal(first.length, 3, '返回与入参同序的 3 条结果');
    assert.deepStrictEqual(first.map((outcome) => outcome.ok), [true, true, true]);
    const snap = snapshot(h);
    const before = h.client.calls.length;

    const second = await h.inventory.applySaleBatch(payloads);
    assert.deepStrictEqual(second, first, '重放返回同一批结果（同一串流水 id / 实时库存 id）');
    assert.deepStrictEqual(snapshot(h), snap, '重放后落表内容一个字都不许变');
    const after = h.client.calls.slice(before);
    const inventoryTableIds = [tableIdOf(h.schema, 'inventoryLedger'), tableIdOf(h.schema, 'liveInventory')];
    const writes = after.filter((call) => inventoryTableIds.includes(call.table_id)
      && ['create', 'batchCreate', 'update', 'batchUpdate', 'delete', 'batchDelete'].includes(call.api));
    assert.equal(writes.length, 0,
      `重放必须对库存零写（实际 ${writes.length} 次：${writes.map((c) => c.api).join('/')}）`);
    // 非空转：重放**真的进了**那条路（读了实时库存并认出"这批已经做过"），只是零写。
    assert.ok(after.some((call) => call.api === 'list' || call.api === 'batchGet'),
      '重放必须真的走过读表那段（否则这条判据是空转）');
    assert.equal(ledgerTotal(h), 3, '库存只扣一次');
  } finally { h.cleanup(); }
});

test('AC-SB4c ⭐ 网关没有批量口（老替身）⇒ applySaleBatch 逐条回落，语义与改动前逐字节同形', async () => {
  const h = createHarness('three', { batchPorts: false });
  try {
    assert.equal(typeof h.gateway.createBatch, 'undefined');
    assert.equal(typeof h.gateway.getBatch, 'undefined');
    assert.equal(typeof h.gateway.deleteBatch, 'undefined');
    const payloads = h.scenario.details.map(([detailId, productRecordId, size]) => ({
      salesDetailRecordId: detailId,
      salesEntryRecordId: ENTRY_ID,
      productRecordId,
      size,
      quantity: 1,
    }));
    const outcomes = await h.inventory.applySaleBatch(payloads);
    assert.equal(outcomes.length, 3, '回落也返回与入参同序的结果（每行一个 ok/error）');
    assert.deepStrictEqual(outcomes.map((outcome) => outcome.ok), [true, true, true]);
    assert.equal(rowsOf(h, 'inventoryLedger').length, 3, '逐条回落照旧写 3 条流水');
    assert.deepStrictEqual(liveIds(h), [], '逐条回落照旧扣光 3 双');
    const counts = inventoryCounts({ http: httpByTable(h) });
    assert.equal(counts.createLedger, 3, '回落 = 逐条 create（没有批量口）');
    assert.equal(counts.deleteLive, 3, '回落 = 逐双 delete');
    // 一行不合法只让那一行失败（不是整批抛）
    h.store.get(tableIdOf(h.schema, 'liveInventory')).push({ record_id: 'live_d_new', fields: {
      [F('liveInventory', 'product')]: ['prod_d'], [F('liveInventory', 'size')]: ['size_43'],
      [F('liveInventory', 'state')]: '门盒',
    } });
    const mixed = await h.inventory.applySaleBatch([
      { salesDetailRecordId: 'detail_new_ok', salesEntryRecordId: ENTRY_ID, productRecordId: 'prod_d',
        size: 43, quantity: 1 },
      { salesDetailRecordId: 'detail_new_missing', salesEntryRecordId: ENTRY_ID, productRecordId: 'prod_missing',
        size: 44, quantity: 1 },
    ]);
    assert.deepStrictEqual(mixed.map((outcome) => outcome.ok), [true, false]);
    assert.match(mixed[1].error.message, /库存不足/, '失败那一行带着 reason（不静默）');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SB4d 批量写失败 ⇒ 两层如实语义：能退回逐条就退回；两层都写不进去 ⇒ 如实报失败；续跑不重不漏
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SB4d-1 流水那一次批量写失败（只失败一次）⇒ 退回逐条把它写完（优雅降级、账不许错）', async () => {
  const h = createHarness('three', { batchPorts: true });
  try {
    const target = h.client.bitable.appTableRecord.batchCreate;
    let seen = 0;
    h.client.bitable.appTableRecord.batchCreate = async (payload) => {
      seen += 1;
      if (seen === 1) throw new Error('injected transient failure');
      return target(payload);
    };
    const result = await deliverAll(h);
    assert.equal(seen, 1, '批量口真的被打过一次（非空转）');
    assert.equal(result.failures.length, 0, '整批写失败 ⇒ 退回逐条写完 ⇒ 这一单仍然交付成功');
    assert.equal(rowsOf(h, 'inventoryLedger').length, 3, '流水一行一条（没有重复写）');
    assert.equal(ledgerTotal(h), 3, '总共只扣 3 双');
    assert.deepStrictEqual(liveIds(h), [], '实时库存扣光，不重复扣');
  } finally { h.cleanup(); }
});

test('AC-SB4d-2 批量口和逐条口都写不进去 ⇒ 如实报失败（不静默）、一双不少；续跑补齐不重复', async () => {
  const h = createHarness('three', { batchPorts: true });
  try {
    // 批量口与逐条口都失败 ⇒ 这一单一条都写不进去。判据：**如实报失败**，账不许错。
    h.client.bitable.appTableRecord.batchCreate = async () => { throw new Error('injected ledger outage'); };
    h.client.bitable.appTableRecord.create = async () => { throw new Error('injected ledger outage'); };
    const result = await deliverAll(h);
    assert.equal(result.failures.length, 3, '三条明细全部如实记为失败（不静默、不假成功）');
    assert.equal(result.deliveredQuantity, 0);
    assert.equal(result.fulfillmentStatus, '未交付');
    assert.match(result.failures[0].error, /injected ledger outage/, '失败带 reason');
    assert.equal(rowsOf(h, 'inventoryLedger').length, 0, '流水一条都不许落');
    assert.equal(liveIds(h).length, 3, '实时库存一双都不许少（绝不把"没删成"当"扣掉了"）');
    const ledgerRows = rowsOf(h, 'salesDetail').map((row) => row.fields[F('salesDetail', 'fulfillmentStatus')]);
    assert.deepStrictEqual(ledgerRows, ['未交付', '未交付', '未交付'], '没扣成 ⇒ 明细不许标已交付');
    // 续跑（这一次批量口正常）⇒ 补齐、不重不漏
    const retry = h.rerun();
    try {
      const resumed = await deliverAll(retry);
      assert.equal(resumed.failures.length, 0, '续跑补齐');
      assert.equal(rowsOf(retry, 'inventoryLedger').length, 3, '流水不重记（一行一条）');
      assert.equal(ledgerTotal(retry), 3, '总共只扣 3 双');
      assert.deepStrictEqual(liveIds(retry), [], '余量正确');
    } finally { retry.cleanup(); }
  } finally { rmDir(h.dirs.inventory); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SB5 单件（N=1）不退化
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SB5 ⭐ 单件（1 行 1 双）不退化：总 HTTP **等量或更好**（如实标，不美化）', async () => {
  const run = await runScenario('unit');
  try {
    const { before, after } = run;
    const b = inventoryCounts(before);
    const a = inventoryCounts(after);
    assert.ok(after.total <= before.total,
      `单件 ⇒ 总 HTTP 不许变慢（改前 ${before.total} / 改后 ${after.total}）`);
    assert.equal(a.batchCreateLedger, 1, '单件也必须一次 createBatch');
    assert.equal(a.batchGetLive, 1, '单件也必须一次 getBatch');
    assert.equal(a.batchDeleteLive, 1, '单件也必须一次 deleteBatch');
    assert.equal(a.getLive + a.deleteLive + a.createLedger, 0, '单件不许再有逐条 get/delete/create');
    console.log(`[AC-SB5] ${after.harness.scenario.label} | 改前 总HTTP=${before.total} {${pretty(b)}}`
      + ` | 改后 总HTTP=${after.total} {${pretty(a)}}`
      + ` ⇒ ${after.total === before.total ? '等量（如实，不美化）' : `更快（省 ${before.total - after.total} 次）`}`);
  } finally { run.before.harness.cleanup(); run.after.harness.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SB6 源码哨兵：形态对齐既有批量口 ＋ 交付那一段只经批量口（回落只有一处）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SB6 源码哨兵：applySaleBatch 与 applyPurchaseReturnBatch 同形；交付那一段只经批量口', () => {
  const src = path.join(__dirname, '..', 'src');
  // ⚠️ 2026-10-18（task-5 · inventoryService.js 大文件拆分）**成对迁移**：
  //    `applySaleBatch` 原样搬到 `src/services/inventory/saleBatch.js`（方法体逐字节未改，仍用 `this.`）
  //    ⇒ 这里改读新模块；下面所有断言**逐字不变**（只把"class 方法签名"识别成同名的 function 声明）。
  const inventory = fs.readFileSync(path.join(src, 'services', 'inventory', 'saleBatch.js'), 'utf8');
  assert.ok(inventory.includes('async function applySaleBatch('), '`applySaleBatch` 必须存在');
  const batchStart = inventory.indexOf('async function applySaleBatch(');
  const nextMethod = inventory.indexOf('\n  async ', batchStart + 10);
  const body = nextMethod > 0 ? inventory.slice(batchStart, nextMethod) : inventory.slice(batchStart);
  assert.match(body, /this\.runForStocks\(/, '必须与其它批量口一样按 stock_key 占住串行队列');
  assert.match(body, /this\.gateway\.listAll\('liveInventory'\)/, '必须一次整表读＋内存索引');
  assert.match(body, /this\.gateway\.createBatch\('inventoryLedger'/, '流水必须走既有批量口');
  assert.match(body, /this\.gateway\.getBatch\('liveInventory'/, '逐双 get 必须换成既有批量读口');
  assert.match(body, /this\.gateway\.deleteBatch\('liveInventory'/, '逐双 delete 必须换成批量删口');
  assert.match(body, /this\.gateway\.delete\('liveInventory'/, '老夹具没有 deleteBatch ⇒ 必须仍能退回逐双删');
  assert.match(body, /this\.applySale\(item, options\)/, '网关没有批量口 ⇒ 必须能整体退回逐条');
  // 流水那一行必须**保留**「关联销售」的 ledgerLink 覆盖（销售主表 id）与 ledgerSource 两处，
  // 否则批量路会把关联写回明细 id —— 那是 2026-10-18 业务口径的回归。
  assert.match(body, /movement\.ledgerSource/, '来源列必须按注册表声明写');
  assert.match(body, /movement\.ledgerLink/, '「关联销售」的覆盖必须按注册表声明写');
  // 🔴 形态对齐：**不许在库存引擎里自造第二套批量形态**（批量 HTTP 一律经网关）
  assert.equal(/bitable\.appTableRecord|batch_create/.test(inventory), false,
    '库存引擎不许直连飞书 SDK 的批量口（批量形态只许在网关里有一份）');

  const delivery = fs.readFileSync(path.join(src, 'services', 'salesDeliveryService.js'), 'utf8');
  assert.match(delivery, /this\.inventory\.applySaleBatch\(payloads/, '交付那一段必须接上批量口');
  const helperStart = delivery.indexOf('async _applySalesInventory(');
  assert.ok(helperStart > 0, '`_applySalesInventory` 必须存在（批量 / 落回的唯一切换点）');
  const helper = delivery.slice(helperStart);
  assert.match(helper, /this\.inventory\.applySale\(payload/, '批量口抛 ⇒ 必须能退回逐条');
  // 回落只有一处：`_deliver` 里**不许**再直接调 `applySale`（否则就是两套逻辑散在两处）。
  const deliverBody = delivery.slice(delivery.indexOf('async _deliver('), helperStart);
  assert.equal(/this\.inventory\.applySale\(/.test(deliverBody), false,
    '逐条回落只许在 `_applySalesInventory` 里有一份');
});
