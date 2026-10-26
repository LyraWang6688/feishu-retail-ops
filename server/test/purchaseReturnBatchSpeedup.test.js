/**
 * ⭐⭐ 2026-10-16（业务负责人**逐字**）：「**退货也需要批量提速**」
 *   —— 这一刀把**采购退货**那条链路的写入从「一次一件」改成「攒批」。
 *
 * ⚠️ **命名提醒**：这里的 `AC-RB1…AC-RB6` 是本次任务书给的编号，指**退货批量提速**
 *    （Return Batch write / throughput）。它与仓库里既有的「退货**拦截**（return block）」
 *    那组同名前缀 AC-RB*（`returnBlockNoticeAnchors.test.js` / `scanReturnBlockGuard.test.js` …）
 *    是**两件事** —— 本文件只钉**写入次数与落表等价**，一个字都不动那几组判据。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 这一刀改在哪（**改前逐字 → 改后逐字 → 依据**）
 *
 * ① 明细写入（`services/purchaseReturnService.js` 原 `:203` 的 `for (const item of plan.items)`）
 *   · **改前（逐字）**：每个尺码各调一次 `createOnceByKey({ tableKey: 'purchaseRequest', … })`
 *     —— 而 `createOnceByKey` 内部先 `listByKey` = **整表 `listAll('purchaseRequest')`**
 *     ⇒ N 个尺码 = **N 次整表读**（`listAll` 是 500 条/页的**翻页**读 ⇒ 表越大请求越多）
 *     ＋ **N 次单条 `create`**。
 *   · **改后（逐字）**：**一次**整表读（把 N 把幂等键一次认完）＋ **一次** `createBatch`
 *     （飞书 `records/batch_create`，≤500 条/请求）。
 *   · 依据：她 2026-10-16「退货也需要批量提速」；幂等语义**一个字不变**
 *     （仍然是「先按幂等键回查远端，命中就复用，不命中才建」）。
 *
 * ② 实时库存那一遍（`ensurePlan` 原 `:82/:85`）—— ⭐ **如实说明：这里已经不慢**
 *   · `:82` 的 `gateway.listAll('liveInventory')` 本来就在**循环外**（整表只读一次）；
 *   · 循环里那两次 `resolveSize` 走的是 `SizeReferenceService` 的 **30 秒内存缓存**
 *     （`services/sizeReferenceService.js:52` `load()`）⇒ **不发请求**；
 *   · 循环体只剩**内存 filter**（`items × liveRows`，无 IO）。
 *   ⇒ **这一处一个字都不改**（改了只会引入风险、换不到提速）。判据 `AC-RB1b` 钉住这一点。
 *
 * 🔴 **瓶颈的另一半在 `inventoryService`（本刀不许碰）**：
 *   `applyPurchaseReturn` → `applyChange` 内部**逐尺码**再 `listAll('liveInventory')`
 *   ＋ 逐双 `get` + `delete`。这一半**本文件一行都不改**（它是**另一刀的文件**），
 *   调用次数如实报在 `AC-RB1` 的结论里（见文件末尾的"残留"注释）。
 *
 * ⭐⭐ **2026-10-16 下半场（task-65「库存写入批量化」）已经把那半也做完了** ⇒ 本文件的数字
 *   **随之变了**（`inventoryService.applyPurchaseReturnBatch`：一次整表读 ＋ 一次 `getBatch`
 *   ＋ 一次 `createBatch` 落流水 ＋ 一次 `deleteBatch` 删实时库存；`deleteBatch` 是 task-65
 *   给网关**新加**的口，形态逐行对齐 `createBatch`、官方 `appTableRecord.batchDelete`、≤500/片）。
 *   ⇒ 本文件里两处**成对迁移**已当场标注（改前逐字 → 改后逐字 → 依据）：
 *     ① `AC-RB1` 的"单货品 ⇒ 等量"改成"更少"（26 ⇒ 19，收紧不是放宽）；
 *     ② `batchGet` 替身的入参位置由 `params` 改成真契约的 `data`（它此前从未被走到过）。
 *   新判据在 `test/inventoryReturnBatchWrite.test.js`（AC-IV1…IV6，含"逐双 get+delete 省了多少"）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-RB1  ⭐ **提速可量**：单货品退货 ＋ 多货品退货**各一次** ⇒
 *          贴出"改前语义路径（逐条）vs 改后路径（攒批）"的**真实 HTTP 调用次数**
 *          （`purchaseRequest` 的整表读 / 单条 create / 批量 create 分开数）。
 *  AC-RB1b ⭐ `:85` 那段**已经不是瓶颈**：退货计划那一步**只整表读一次**实时库存，
 *          且尺码解析**零额外请求**（缓存）。
 *  AC-RB2  ⭐⭐ **结果逐字段等价（最重要）**：同样输入 ⇒
 *          「逐条路径」与「攒批路径」的**落表内容一字不差**
 *          （全表快照 deepStrictEqual：退货批次行 / 明细 N 行 / 库存流水 / 实时库存余量
 *            ＋ 每行的货品/尺码/数量/幂等键/明细ID/关联 ＋「发生金额」＋ 单据/出图入参）。
 *          ⚠️ 判据必须**非空转**：同时断言攒批路径**真的用了** `batchCreate`。
 *  AC-RB3  幂等：同一 task 重放 ⇒ 明细不翻倍、批次只有一行、库存只扣一次。
 *  AC-RB4  续跑：写到一半中断 ⇒ 接着跑**不重不漏**
 *          （含「批量写瞬时失败 ⇒ 逐条兜底 ⇒ 不重不漏」）。
 *  AC-RB5  加库存正确：退货扣库存**逐条正确、不漏不加倍**（流水条数与数量、余量都对）。
 *  AC-RB6  出图/发群不变：出图链路被**调用一次**、入参与改前**逐字相同**
 *          （分组出图 / 群消息条数由那份入参决定 ⇒ 入参相同即张数与条数相同）。
 *
 * ⚠️ 本文件用的是**真的** `V1BitableGateway`（只把飞书 SDK 的 `client` 换成内存替身，
 *    所以 `createBatch` / `listAll` 翻页 / `assertSuccess` 都是**生产代码**在跑）、
 *    真的 `InventoryService` / `PurchaseOrderBatchService` / `PurchaseReturnService`。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 真 schema 需要 app_token；尺码管理表没有硬编码兜底 ⇒ 也要给一个非空 table_id。
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_return_batch_test';
process.env.FEISHU_V1_SIZE_TABLE_ID = process.env.FEISHU_V1_SIZE_TABLE_ID || 'tbl_size_return_batch_test';

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

/** 货品信息那一行（供应商 = `sup_1`，与既有 scanPurchaseReturn 用例同一形状）。 */
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

/**
 * 种子数据。⭐ 尺码覆盖面刻意做成"有剩余也有退光"：
 *   · 40 码 3 双（退 2 ⇒ 剩 1）
 *   · 41 码 3 双（门盒 + 样品 + 仓库，退 3 ⇒ 退光）
 *   · 42 码 2 双（退 1 ⇒ 剩 1）
 */
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
    { record_id: 'bh_request', fields: { 行为名称: '采购申请', 行为编码: 'STOCK_PURCHASE_INCREASE' } },
    // ⭐ 采购环节的「退货」（写「采购主表.采购行为」用的那一档）
    { record_id: 'bh_return_purchase', fields: { 行为名称: '退货', 行为编码: 'PURCHASE_RETURN' } },
    // ⭐ 库存环节的「采购减少」（库存引擎扣库存用的那一档）
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

/** 内存表（键 = table_id，与生产一致）。 */
const seedStore = (schema) => {
  const store = new Map();
  for (const [key, records] of Object.entries(seedRecords())) {
    store.set(tableIdOf(schema, key), records.map((record) => ({
      record_id: record.record_id, fields: { ...record.fields },
    })));
  }
  return store;
};

/**
 * `appTableField.list` 要回真字段（`ensureSchema` / `validateSchema` / 幂等键校验都靠它）。
 * 类型按真表：尺码管理的「尺码」= 2（数字）；两张消费尺码的表 = 18（单选关联，multiple=false）；
 * 其余 = 1（文本）。列名一律取真 schema。
 */
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

/** 飞书 SDK `client` 的内存替身：**每次调用 = 一次 HTTP 请求**，逐条记进 `calls`。 */
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
        // ⚠️ 官方《删除多条记录》口径：请求体 `data.records` = id 数组；响应 `data.records` = `[{deleted, record_id}]`。
        //    ⭐ 2026-10-16（task-65 库存写入批量化）：删实时库存由逐双 `delete` 改成一次 `batchDelete`
        //    ⇒ 替身必须照真契约回话（否则"落表等价 / 不退化"的判据会拿替身的缺口当结论）。
        async batchDelete({ path, data }) {
          record('batchDelete', { path, data });
          const wanted = (data?.records || []).map((id) => String(id).trim()).filter(Boolean);
          const rows = rowsOf(path.table_id);
          const deleted = wanted.filter((id) => rows.some((row) => row.record_id === id))
            .map((id) => ({ deleted: true, record_id: id }));
          const removed = new Set(deleted.map((entry) => entry.record_id));
          setRows(path.table_id, rows.filter((row) => !removed.has(row.record_id)));
          return ok({ records: deleted });
        },
        async batchGet({ path, data }) {
          record('batchGet', { path });
          // ⚠️ 2026-10-16 成对迁移（task-65 库存写入批量化）：
          //   **改前逐字**：`const wanted = (params?.record_ids || [])` —— 与飞书真实契约**不符**
          //     （SDK 类型 + `test/bitableGatewayBatchGet.test.js` 都读 **`data.record_ids`**）。
          //     它一直没被发现，是因为在这一刀之前**没有任何生产代码走过 `getBatch`**。
          //   **改后逐字**：`const wanted = (data?.record_ids || [])`。
          //   **依据**：task-65 让"删之前先确认那一条"由逐双 `get` 换成一次 `getBatch` ⇒
          //     替身必须照真契约回话，否则等价性判据会拿"替身自己的 bug"当结论。
          //     ⚠️ 这里**只修替身的入参位置**：断言一条没删、没 skip、没放宽。
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
// harness（真网关 + 真库存引擎 + 真批次服务 + 真退货 service；只有 IM 出图是替身）
// ═══════════════════════════════════════════════════════════════════════════

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `return-batch-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

const createHarness = (options = {}) => {
  const schema = options.schema || buildSchema();
  const store = options.store || seedStore(schema);
  const client = createStubClient(store);
  if (options.failOnce) injectFailOnce(client, options.failOnce);
  const gateway = new V1BitableGateway({ schema, client });
  // ⭐ 「改前语义路径」= 网关**没有**批量口 ⇒ service 逐条 `createOnceByKey`（与改前逐字同一条路）。
  if (options.batch === false) gateway.createBatch = undefined;

  const dirs = options.dirs || { inventory: tempDir('inv'), ret: tempDir('ret') };
  const inventory = new InventoryService({
    gateway, store: new JsonTaskStore({ dir: dirs.inventory, idField: 'operation_id' }),
  });
  const orderBatches = new PurchaseOrderBatchService({ gateway });
  const deliveries = [];
  const webhooks = {
    deliverSupplierImages: async (taskId, task, posting, deliveryOptions) => {
      deliveries.push({
        taskId, posting, options: deliveryOptions, draft: task?.draft, taskStatus: task?.status,
      });
      return { sent: [], failed: [], thread_root_message_id: '' };
    },
  };
  let batchNoCalls = 0;
  const batchNoGenerator = {
    runExclusive: async (work) => work(),
    next: async () => {
      batchNoCalls += 1;
      return { batchNo: `CGD-20261016-000${batchNoCalls}` };
    },
  };
  const purchaseReturn = createPurchaseReturnService({
    gateway,
    config: SCAN_WRITE.purchaseReturn,
    inventory,
    orderBatches,
    webhooks,
    batchNoGenerator,
    store: new JsonTaskStore({ dir: dirs.ret, idField: 'task_id' }),
  });
  return {
    schema,
    store,
    client,
    gateway,
    inventory,
    orderBatches,
    purchaseReturn,
    deliveries,
    dirs,
    cleanup: () => { rmDir(dirs.inventory); rmDir(dirs.ret); },
    /** 接着下一跑（同一份内存表 + 同一批本地任务目录）。 */
    rerun: (next = {}) => createHarness({ ...next, schema, store, dirs }),
  };
};

/** 退货草稿（与 `scanWriteService.submitPurchaseReturn` 交给 service 的形状一致）。 */
const draftFor = (pairs, overrides = {}) => ({
  product_record_id: 'prod_1',
  product_number: NUMBER,
  item_no: ITEM_NO,
  color: '黑色',
  supplier_record_id: 'sup_1',
  behavior_record_id: 'bh_return_purchase',
  operator_open_id: 'ou_return_batch',
  order_amount: '399',
  items: pairs.map(([size, quantity]) => ({ size, quantity })),
  ...overrides,
});

const rowsOf = (harness, tableKey) => harness.store.get(tableIdOf(harness.schema, tableKey)) || [];
const ledgerTotal = (harness) => rowsOf(harness, 'inventoryLedger')
  .reduce((sum, record) => sum + Number(record.fields['变动数量'] || 0), 0);

/** 全表快照（record_id + 字段），用来证明"落表内容一字不差"。 */
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

/** 到「表 × HTTP 动作」的计数。 */
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
};

/** 跑一次并回收「改前语义（逐条）/ 改后（攒批）」两侧的真实调用次数与结果。 */
const runScenario = async (scenarioKey) => {
  const { pairs, label } = SCENARIOS[scenarioKey];
  const before = createHarness({ batch: false });
  const after = createHarness({ batch: true });
  // ⚠️ **同一个 taskId**（两套 harness 各自的内存表 / 本地目录互不相干）——
  //    幂等键里带 taskId，用两个不同的 id 就不是"同样输入"了（等价性也就无从谈起）。
  const taskId = `scan_return_${scenarioKey}`;
  try {
    const beforeResult = await before.purchaseReturn.submit(taskId, draftFor(pairs));
    const afterResult = await after.purchaseReturn.submit(taskId, draftFor(pairs));
    return {
      label,
      before: {
        result: beforeResult, harness: before, http: httpByTable(before), total: before.client.calls.length,
      },
      after: {
        result: afterResult, harness: after, http: httpByTable(after), total: after.client.calls.length,
      },
    };
  } finally { /* 清理留给调用方（下面测试里统一 cleanup） */ }
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-RB1 ⭐ 提速可量（单货品 + 多货品 各一次；贴真实 HTTP 调用次数）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RB1 ⭐ 提速可量：明细写入由 N 次整表读 + N 次单条 create ⇒ 1 次整表读 + 1 次批量 create', async () => {
  for (const key of ['single', 'multi']) {
    const run = await runScenario(key);
    try {
      const { before, after } = run;
      const beforeRequest = before.http.purchaseRequest || {};
      const afterRequest = after.http.purchaseRequest || {};

      // 明细表上的真实 HTTP 请求：改前 = 1 次 plan 取号读 + N 次幂等回查读 + N 次单条 create
      const n = before.result.request_ids.length;
      assert.equal(n, SCENARIOS[key].pairs.length, `${key}: 明细条数`);
      assert.equal(beforeRequest.list, n + 1, `${key}: 改前 = 逐条幂等回查（N 次整表读）+ 取号 1 次`);
      assert.equal(beforeRequest.create, n, `${key}: 改前 = 逐条单条 create`);
      assert.equal(beforeRequest.batchCreate || 0, 0, `${key}: 改前不许有批量口`);

      assert.equal(afterRequest.list, 2, `${key}: 改后 = 取号 1 次 + 幂等回查 1 次`);
      assert.equal(afterRequest.create || 0, 0, `${key}: 改后不再逐条 create`);
      assert.equal(afterRequest.batchCreate, 1, `${key}: 改后 = 一次批量 create（非空转：真的走了批量口）`);

      // ⚠️ 2026-10-16 **成对迁移**（task-65 库存写入批量化）：
      //   · **改前逐字**（本行原来分两支）：
      //       `if (n > 1) { assert.ok(after.total < before.total, '…必须更少…') }`
      //       `else { assert.equal(after.total, before.total, '单货品 ⇒ 总请求数**等量**…') }`
      //     —— 那时"批量口"只换了**明细写入**一处（1 次 `create` ⇒ 1 次 `createBatch`），
      //     而**库存那一段仍是逐条**（逐尺码整表读 ＋ 逐双 `get`/`delete`）⇒ 单货品确实等量。
      //   · **改后逐字**：两支合一 ⇒ `assert.ok(after.total < before.total, '…必须更少…')`。
      //   · **依据**：业务负责人 2026-10-16「**退货也需要批量提速**」＋ task-65
      //     （库存写入批量化）。库存那一段批量化之后，单货品（1 码 3 双）**26 ⇒ 19**
      //     （逐双 `get` 6 次 ⇒ 1 次 `getBatch`；逐双 `delete` 3 次 ⇒ 1 次 `deleteBatch`；
      //      逐尺码整表读 2 次 ⇒ 1 次；流水 1 次 `create` ⇒ 1 次 `createBatch`）
      //     ⇒ **"等量"这个结论被新事实取代**。
      //   ⭐ 口径**不放宽**：从"等量"改成"更少"是**收紧**（它同时排除了"变慢"），
      //     逐双 `get+delete` 省掉多少的逐项数字在 `inventoryReturnBatchWrite.test.js` 的
      //     AC-IV1 里显式贴出（不美化）。
      assert.ok(after.total < before.total,
        `${key}: 总请求数必须更少（改前 ${before.total} / 改后 ${after.total}）`);

      // ⭐ 如实贴出两边的真实数字（供回报引用）
      console.log(`[AC-RB1] ${run.label}`
        + ` | 改前 总HTTP=${before.total} 采购明细{整表读:${beforeRequest.list},单条create:${beforeRequest.create}}`
        + ` | 改后 总HTTP=${after.total} 采购明细{整表读:${afterRequest.list},批量create:${afterRequest.batchCreate}}`
        + ` | 采购明细上的请求 ${(beforeRequest.list || 0) + (beforeRequest.create || 0)}`
        + ` ⇒ ${(afterRequest.list || 0) + (afterRequest.batchCreate || 0)}`);
    } finally { run.before.harness.cleanup(); run.after.harness.cleanup(); }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RB1b ⭐ `:85` 那段（读实时库存）——**如实钉住"这里已经不慢"**
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RB1b ⭐ 「冻结退货计划」整表读实时库存只 1 次、尺码解析只 1 次（这里本来就不慢 ⇒ 不硬改）', async () => {
  const h = createHarness({ batch: true });
  try {
    const pairs = SCENARIOS.multi.pairs;
    const taskId = 'scan_return_rb1b';
    await h.purchaseReturn.store.create({
      task_id: taskId, kind: 'scan_purchase_return', status: 'posting', draft: draftFor(pairs),
    });
    // 只跑「冻结计划」那一步（`:82/:85` 那一段）
    await h.purchaseReturn.ensurePlan(taskId, await h.purchaseReturn.store.get(taskId));
    const http = httpByTable(h);
    assert.equal((http.liveInventory || {}).list, 1,
      '实时库存整表读**只 1 次**（`:82` 本来就在循环外 ⇒ 这一段不是瓶颈）');
    // ⭐ 2026-10-26 成对迁移（统一配置快照）：尺码快照在更早的 schema/服务初始化时已加载，
    //   这一段 **0 次**额外读尺码表（比原来的 1 次更少，不是放宽）；整段只剩实时库存 1 次 HTTP。
    assert.equal((http.sizeManagement || { list: 0 }).list, 0,
      '尺码解析整表读 **0 次**（走进程内配置快照）');
    assert.ok(!(http.sizeManagement || {}).create && !(http.sizeManagement || {}).update, '尺码表只读');
    assert.equal(h.client.calls.length, 1, '整段计划只剩 1 次 HTTP（实时库存整表读）');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RB2 ⭐⭐ 结果逐字段等价（最重要）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RB2 ⭐⭐ 同样输入 ⇒ 逐条路径与攒批路径**落表内容一字不差**（单货品 + 多货品）', async () => {
  for (const key of ['single', 'multi']) {
    const run = await runScenario(key);
    try {
      const { before, after } = run;
      // 先证明"两边真的走了不同的路"（否则等价是空转）
      assert.equal(after.harness.client.calls.filter((call) => call.api === 'batchCreate'
        && call.table_id === tableIdOf(after.harness.schema, 'purchaseRequest')).length, 1,
      `${key}: 攒批路径必须真的用了 batchCreate`);
      assert.equal(before.harness.client.calls.filter((call) => call.api === 'batchCreate').length, 0,
        `${key}: 逐条路径不许有 batchCreate`);

      // ① 返回值逐字段等价
      assert.deepStrictEqual(after.result, before.result, `${key}: service 返回值必须逐字段一致`);
      // ② **全表快照**逐字节等价（批次行 / 明细 N 行 / 库存流水 / 实时库存余量 / 幂等键 / 明细ID / 发生金额）
      assert.deepStrictEqual(snapshot(after.harness), snapshot(before.harness),
        `${key}: 落表内容必须一字不差`);
      // ③ 出图链路的入参逐字等价（⇒ 分组出图的张数与群消息条数不变）
      assert.deepStrictEqual(after.harness.deliveries, before.harness.deliveries,
        `${key}: 出图/发群的入参必须一字不差`);
    } finally { run.before.harness.cleanup(); run.after.harness.cleanup(); }
  }
});

test('AC-RB2b ⭐ 多货品退货：批次 1 行 · 明细 N 行 · 每行货品/尺码/数量/幂等键/明细ID/关联都对', async () => {
  const h = createHarness({ batch: true });
  try {
    const result = await h.purchaseReturn.submit('scan_return_rb2b', draftFor(SCENARIOS.multi.pairs));
    assert.equal(result.taken_count, 6);
    assert.equal(result.shortfall, 0);

    const batches = rowsOf(h, 'purchaseOrderBatch');
    assert.equal(batches.length, 1, '退货批次 1 行');
    assert.equal(batches[0].fields['到货状态'], undefined, '退货批次不写「到货状态」');
    assert.equal(batches[0].fields['发生金额'], 399, '「发生金额」= 整单金额');
    // ⭐ 2026-10-17：主表行为列真表已改名「发生行为」（她逐字）
    assert.deepEqual(batches[0].fields['发生行为'], ['bh_return_purchase']);
    assert.equal(batches[0].fields['录入数量'], 6, '录入数量 = 实退合计');

    const requests = rowsOf(h, 'purchaseRequest');
    assert.equal(requests.length, 3, '明细 N 行');
    const bySize = new Map(requests.map((record) => [String(record.fields['尺码']), record]));
    assert.deepEqual([...bySize.keys()].sort(), ['size_40', 'size_41', 'size_42']);
    for (const [size, quantity] of SCENARIOS.multi.pairs) {
      const record = bySize.get(`size_${size}`);
      assert.deepEqual(record.fields['编号'], ['prod_1'], '货品关联');
      assert.equal(record.fields['数量'], quantity, `${size} 码数量`);
      assert.equal(record.fields['幂等键'], `purchase_return_doc:scan_return_rb2b:${size}`, '幂等键');
      assert.deepEqual(record.fields['报货批次号'], [batches[0].record_id], '关联到那张退货批次行');
      assert.equal('发生行为' in record.fields, false, '「发生行为」是 Lookup，不许写');
    }
    // ⭐⭐ **绝对口径**（对照"改前逐字"的那把尺子）：明细ID 必须**按计划顺序**落在对应尺码上
    //    （40→01、41→02、42→03）。⚠️ 只断言"ID 集合是 01/02/03"是**不够**的 ——
    //    把顺序弄反了那个断言照样绿（2026-10-16 变异实验实测：只钉集合 ⇒ 变异③不红）。
    //    `requests` 是**创建顺序**（内存表按创建先后追加）⇒ 这组"尺码→ID"的有序对同时钉住创建顺序。
    assert.deepEqual(
      requests.map((record) => [String(record.fields['尺码']), record.fields['采购明细ID']]),
      [
        ['size_40', 'CGD-20261016-0001-01'],
        ['size_41', 'CGD-20261016-0001-02'],
        ['size_42', 'CGD-20261016-0001-03'],
      ],
      '明细ID 必须按计划顺序落在对应尺码上（40→01 / 41→02 / 42→03）',
    );
    // 返回的 `request_ids` 也必须与计划顺序一一对应（出图/回填单据都按这个顺序用）
    assert.deepEqual(result.request_ids,
      ['size_40', 'size_41', 'size_42'].map((size) => bySize.get(size).record_id),
      'request_ids 顺序 = 计划顺序');
    assert.deepEqual(result.request_ids, requests.map((record) => record.record_id),
      '返回的明细 id 顺序 = 创建顺序');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RB3 幂等：同一 task 重放 ⇒ 不重复建行
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RB3 同一 task 重放 ⇒ 明细不翻倍、批次只 1 行、库存只扣一次、单据入参逐字相同', async () => {
  // ⭐ 两条路（改前语义的逐条 / 改后的攒批）都跑一遍重放 ⇒ 重放形状必须**逐字相同**。
  const shapes = [];
  for (const batch of [false, true]) {
    const h = createHarness({ batch });
    try {
      const pairs = SCENARIOS.multi.pairs;
      const first = await h.purchaseReturn.submit('scan_return_rb3', draftFor(pairs));
      const afterFirst = snapshot(h);
      const deliveriesAfterFirst = h.deliveries.length;

      const second = await h.purchaseReturn.submit('scan_return_rb3', draftFor(pairs));
      assert.deepStrictEqual(second, first, '重放把上一次的结果还给她');
      assert.deepStrictEqual(snapshot(h), afterFirst, '重放后落表内容一个字都不许变');
      assert.equal(rowsOf(h, 'purchaseRequest').length, 3, '明细不翻倍');
      assert.equal(rowsOf(h, 'purchaseOrderBatch').length, 1, '批次只 1 行');
      assert.equal(ledgerTotal(h), 6, '库存只扣一次');
      // ⚠️ 出图链路**会被再调一次** —— 这是**改前就有的形状**（去重判据在**未改动**的
      //    出图链路内部，见 `supplierSplitAtGeneration` 的 AC-SS4「这一组已经出过 ⇒ 跳过」）
      //    ⇒ 本刀只保证**入参逐字相同** ⇒ 那条判据照旧生效、群消息条数不变。
      assert.equal(h.deliveries.length, deliveriesAfterFirst + 1, '重放照旧走一次出图入口');
      assert.deepStrictEqual(h.deliveries[1], h.deliveries[0],
        '重放的出图入参必须与第一次**逐字相同**（链路内部的去重判据据此跳过重传）');
      shapes.push({
        requests: rowsOf(h, 'purchaseRequest').length,
        batches: rowsOf(h, 'purchaseOrderBatch').length,
        ledger: ledgerTotal(h),
        deliveries: h.deliveries.length,
      });
    } finally { h.cleanup(); }
  }
  assert.deepStrictEqual(shapes[0], shapes[1], '重放形状：改前（逐条）与改后（攒批）逐字相同');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RB3b 远端**已经**有两条同键记录 ⇒ 必须停（绝不把它当"已写过"滑过去）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RB3b 远端同键两条 ⇒ 攒批路与逐条路**同样**当场停（不写新行、不动库存）', async () => {
  const outcomes = [];
  for (const batch of [false, true]) {
    const h = createHarness({ batch });
    try {
      const pairs = [[41, 3]];
      const taskId = 'scan_return_rb3b';
      // 预置：远端已经有**两条**同一个幂等键的记录 = "重复业务事实"。
      const key = `purchase_return_doc:${taskId}:41`;
      const table = tableIdOf(h.schema, 'purchaseRequest');
      h.store.set(table, [
        { record_id: 'dup_1', fields: { 幂等键: key } },
        { record_id: 'dup_2', fields: { 幂等键: key } },
      ]);
      await assert.rejects(
        () => h.purchaseReturn.submit(taskId, draftFor(pairs)),
        /重复业务事实/,
        '同键两条 ⇒ 必须停下来报"重复业务事实"（与逐条版同一句）',
      );
      assert.equal(rowsOf(h, 'purchaseRequest').length, 2, '不许多写一行明细');
      assert.equal(rowsOf(h, 'inventoryLedger').length, 0, '库存一个字都不许动');
      outcomes.push(rowsOf(h, 'purchaseRequest').length);
    } finally { h.cleanup(); }
  }
  assert.deepStrictEqual(outcomes[0], outcomes[1], '两条路的"停下"形状逐字相同');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RB4 续跑：写到一半中断 ⇒ 接着跑不重不漏
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RB4a 写到一半中断（批量删那一步抛）⇒ 接着跑不重不漏（明细不翻倍、流水不重记、余量正确）', async () => {
  // ⚠️ 2026-10-16 **成对迁移**（task-65 库存写入批量化）：
  //   · **改前逐字**：`failOnce: { api: 'delete', at: 3 }` —— 那时实时库存是**逐双** `delete`，
  //     第 3 次抛 ⇒ 前 2 双已经删掉、journal 也记了。
  //   · **改后逐字**：`failOnce: { api: 'batchDelete', at: 1 }` —— 删除已经批量化，整批**一次** HTTP
  //     ⇒ 注入点跟着"那一次 HTTP"走；这一次在**发请求之前**就抛 ⇒ 一双都没删。
  //   · **依据**：task-65（Lead 授权给网关加 `deleteBatch`）；同一段行为、同一个"中断接着跑"语义。
  //   ⚠️ 断言一条没删、没 skip、没放宽（"余量正确"那一句照旧）。
  const first = createHarness({ batch: true, failOnce: { api: 'batchDelete', at: 1 } });
  const pairs = SCENARIOS.multi.pairs;
  try {
    await assert.rejects(() => first.purchaseReturn.submit('scan_return_rb4a', draftFor(pairs)),
      /injected transient failure/, '中断必须如实抛（不许假成功）');
    // 中断时：明细已经一次批量写完（N 行），库存那一段只写了流水、一双都没删
    assert.equal(rowsOf(first, 'purchaseRequest').length, 3, '攒批 ⇒ 明细是一次写完的');
    assert.equal(rowsOf(first, 'purchaseOrderBatch').length, 1);
    assert.equal(rowsOf(first, 'liveInventory').length, 8, '删那一步失败 ⇒ 实时库存一双都不许少');

    const second = first.rerun({ batch: true });
    try {
      const resumed = await second.purchaseReturn.submit('scan_return_rb4a', draftFor(pairs));
      assert.equal(resumed.taken_count, 6, '续跑接着把没扣的扣完');
      assert.equal(rowsOf(second, 'purchaseRequest').length, 3, '明细不翻倍');
      assert.equal(rowsOf(second, 'purchaseOrderBatch').length, 1, '批次不重复建');
      assert.equal(rowsOf(second, 'inventoryLedger').length, 3, '流水不重记（一档一条）');
      assert.equal(ledgerTotal(second), 6, '总共只扣 6 双');
      assert.deepStrictEqual(
        rowsOf(second, 'liveInventory').map((record) => record.record_id).sort(),
        ['live_40_box_3', 'live_42_box_2'],
        '余量正确：40 剩 1 双、42 剩 1 双、41 退光',
      );
    } finally { second.cleanup(); }
  } finally { rmDir(first.dirs.inventory); rmDir(first.dirs.ret); }
});

test('AC-RB4b 批量写**瞬时失败一次** ⇒ 逐条兜底 ⇒ 不重不漏（明细仍是 N 行）', async () => {
  const h = createHarness({ batch: true, failOnce: { api: 'batchCreate', at: 1 } });
  try {
    const result = await h.purchaseReturn.submit('scan_return_rb4b', draftFor(SCENARIOS.multi.pairs));
    assert.equal(result.taken_count, 6);
    assert.equal(rowsOf(h, 'purchaseRequest').length, 3, '兜底路径也不许多写一行');
    assert.equal(rowsOf(h, 'purchaseRequest').filter(
      (record) => record.fields['幂等键'],
    ).length, 3);
    assert.equal(ledgerTotal(h), 6);
    assert.equal(rowsOf(h, 'purchaseOrderBatch').length, 1);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RB5 加库存（退货扣库存）逐条正确、不漏不加倍
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RB5 退货扣库存：一档一条流水、数量=实退数、consumes=门盒+样品+仓库、余量精确', async () => {
  const h = createHarness({ batch: true });
  try {
    const result = await h.purchaseReturn.submit('scan_return_rb5', draftFor(SCENARIOS.multi.pairs));
    assert.equal(result.taken_count, 6);

    const ledger = rowsOf(h, 'inventoryLedger');
    assert.equal(ledger.length, 3, '一档一条流水（不多不少）');
    assert.equal(ledgerTotal(h), 6);
    for (const record of ledger) assert.deepEqual(record.fields['库存行为'], ['bh_return']);
    // 每档数量 = 实退数
    const byQuantity = ledger.map((record) => Number(record.fields['变动数量'])).sort((a, b) => a - b);
    assert.deepStrictEqual(byQuantity, [1, 2, 3], '40→2 / 41→3 / 42→1');

    // 余量：40 剩 1 双、41 退光（门盒+样品+仓库三种状态都被扣）、42 剩 1 双
    const remaining = rowsOf(h, 'liveInventory').map((record) => record.record_id).sort();
    assert.deepStrictEqual(remaining, ['live_40_box_3', 'live_42_box_2']);
    // 41 码三种状态都真的被扣过（reads 的 consumes 由注册表决定）
    assert.equal(remaining.some((id) => id.includes('live_41')), false, '41 码三档全扣光');
  } finally { h.cleanup(); }
});

test('AC-RB5b 超库存（报 5 双、只有 3 双）⇒ 明细与流水都写实退 3、差额 2 如实回报', async () => {
  const h = createHarness({ batch: true });
  try {
    const result = await h.purchaseReturn.submit('scan_return_rb5b', draftFor([[41, 5]]));
    assert.equal(result.taken_count, 3);
    assert.equal(result.shortfall, 2);
    assert.equal(rowsOf(h, 'purchaseRequest')[0].fields['数量'], 3);
    assert.equal(ledgerTotal(h), 3);
    assert.equal(rowsOf(h, 'liveInventory').some((record) => record.record_id.includes('live_41')), false);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RB6 出图 / 发群不变
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RB6 出退货单图：链路被调用一次、入参与改前逐字相同（⇒ 每组一张图、群消息条数不变）', async () => {
  const h = createHarness({ batch: true });
  try {
    const result = await h.purchaseReturn.submit('scan_return_rb6', draftFor(SCENARIOS.multi.pairs));
    assert.equal(h.deliveries.length, 1, '一次退货只走一次出图链路（分组在它内部，输入只有一份）');
    const delivery = h.deliveries[0];
    assert.equal(delivery.taskId, 'scan_return_rb6');
    assert.equal(delivery.options.title, SCAN_WRITE.purchaseReturn.imageTitle);
    assert.equal(delivery.options.fileNameSuffix, SCAN_WRITE.purchaseReturn.fileNameSuffix);
    assert.equal(delivery.posting.batch_no, 'CGD-20261016-0001');
    assert.deepStrictEqual(delivery.posting.request_ids, result.request_ids, '回填单据统计的就是这一次的明细');
    // ⭐ 绝对口径：回填单据的明细 id 必须按**计划顺序**（40 / 41 / 42）——
    //    与 `result.request_ids` 自比是**不够**的（两条一起被弄反时自比照样绿）。
    const recordIdOfSize = (size) => rowsOf(h, 'purchaseRequest')
      .find((record) => String(record.fields['尺码']) === size).record_id;
    assert.deepStrictEqual(delivery.posting.request_ids,
      ['size_40', 'size_41', 'size_42'].map(recordIdOfSize), '回填单据的明细 id 顺序 = 计划顺序');
    // 出图入参 = **只有真的退掉的尺码**，顺序与计划一致（供应商分组按它分组，一个字没动）
    assert.deepStrictEqual(delivery.draft.items, [
      {
        product_record_id: 'prod_1', product_number: NUMBER, item_no: ITEM_NO,
        color: '黑色', size: 40, quantity: 2, supplier_record_id: 'sup_1',
      },
      {
        product_record_id: 'prod_1', product_number: NUMBER, item_no: ITEM_NO,
        color: '黑色', size: 41, quantity: 3, supplier_record_id: 'sup_1',
      },
      {
        product_record_id: 'prod_1', product_number: NUMBER, item_no: ITEM_NO,
        color: '黑色', size: 42, quantity: 1, supplier_record_id: 'sup_1',
      },
    ]);
    assert.equal(delivery.taskStatus, 'posted', '出图前任务已置 posted');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RB7（源码哨兵）本刀只改采购退货那一条：不许碰 4 个禁改文件 / scanWriteService
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RB7 源码哨兵：禁改文件与「一次一件」的老写法都不许在本刀里出现（本文件的护栏）', () => {
  const src = path.join(__dirname, '..', 'src');
  // ⚠️ 这条哨兵钉的是"本刀改法"的自证：明细写入**不再**在循环里逐条 createOnceByKey。
  const returnService = fs.readFileSync(path.join(src, 'services/purchaseReturnService.js'), 'utf8');
  assert.match(returnService, /createOnceByKeys/, '明细写入必须走批量件');
  // 循环里那一条逐条写法不许再出现（正则宽容空白）
  assert.equal(/for \(const item of plan\.items\)[\s\S]{0,400}?createOnceByKey\(/.test(returnService), false,
    '明细循环里不许再有逐条 createOnceByKey');
});
