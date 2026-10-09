// 采购链路的写入类日志补「关联键」（2026-10-07 下半场；上半场是销售，见 logCorrelation.test.js）。
//
// 这个文件钉住的是**日志本身**，不是业务行为：
//   ① 采购的**写库那半**（bitable.record.created / bitable.record.updated /
//      inventory.change.applied）必须带上「这一层已经知道的」关联键：
//      `task_id`（purchase_supplier-report_… / arrival_reconcile_…）·
//      `batch_no`（202610071 / BH-YYYYMMDD-NNNN）·
//      `purchase_report_record_id`（「信息填写」那条记录）·
//      `purchase_batch_record_id`（「报货批次」那条记录；⭐ 2026-10-07 晚替换掉了原来的
//      `purchase_arrival_record_id` —— 「到货验收」表已被业务负责人删除，到货信息落在批次行上）
//      ⇒ 按 `task_id`（或 `batch_no`）一个 grep 就能串起整条链；
//   ② **拿不到就不传**：到货/入库那条链路没有报单记录 id，就不许冒出这个键；
//   ③ 既有字段一个都不少；不传关联键时**一个键都不出现**（不是空串）。
//
// ⚠️ 为什么用**真实的 V1BitableGateway**（只把飞书 client 换成内存假 Base）：
//    `bitable.record.created/updated` 是**网关层**打的日志，只有让真实网关跑，
//    才证明得了"业务层传下去的关联键真的到了那条日志上"。用假 gateway 测等于什么都没测。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ⚠️ 必须在 require v1BitableSchema **之前**设好：schema 是模块级对象字面量，
//    tableId 在 require 那一刻求值一次（「尺码管理」这类表没有硬编码兜底，
//    漏设就会拿到空串，然后在 tableWithId 当场抛「未配置 table_id」）。
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';
process.env.FEISHU_V1_SIZE_TABLE_ID = process.env.FEISHU_V1_SIZE_TABLE_ID || 'tbl_size_test';
process.env.FEISHU_V1_ACCESSORY_TABLE_ID = process.env.FEISHU_V1_ACCESSORY_TABLE_ID || 'tbl_accessory_test';

const { V1BitableGateway } = require('../src/services/v1BitableGateway');
const { V1_BITABLE_SCHEMA: SCHEMA } = require('../src/config/v1BitableSchema');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const { InventoryService } = require('../src/services/inventoryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { CORRELATION_KEYS } = require('../src/utils/correlationFields');

// ── 日志抓取（与 logCorrelation.test.js / salesMvp.test.js 同一个写法）──────────
const captureLogs = () => {
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => { lines.push(args.map((value) => String(value)).join(' ')); };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  return {
    lines,
    logs: (event) => lines.filter((line) => line.includes(`"event":"${event}"`)).map((line) => JSON.parse(line)),
    restore: () => { console.log = originals.log; console.warn = originals.warn; console.error = originals.error; },
  };
};

// ── 内存假 Base：字段名仍然走 v1BitableSchema 的**真实中文列名** ────────────────
// 假的是"网络"，不是"字段映射"：写错列名这里也会当场抛（与线上同形）。
const tableKeyById = () => {
  const map = new Map();
  for (const [key, table] of Object.entries(SCHEMA.tables)) {
    if (table.tableId) map.set(table.tableId, key);
  }
  return map;
};

// 字段元数据：只给尺码相关两列真类型（尺码管理.尺码 = 数字；各表的.尺码 = 单选关联），
// 其余一律 type=1。类型是 sizeReferenceService.validateSchema 的硬要求。
const fieldMetaOf = (tableKey) => Object.entries(SCHEMA.tables[tableKey].fields).map(([key, fieldName]) => {
  if (key === 'size') {
    return tableKey === 'sizeManagement'
      ? { field_name: fieldName, type: 2 }
      : { field_name: fieldName, type: 18,
        property: { table_id: SCHEMA.tables.sizeManagement.tableId, multiple: false } };
  }
  return { field_name: fieldName, type: 1 };
});

const fakeLarkClient = (records) => {
  const byId = tableKeyById();
  let seq = 0;
  const listOf = (tableId, { create = false } = {}) => {
    const key = byId.get(tableId);
    if (!records.has(key)) {
      if (!create) return [];
      records.set(key, []);
    }
    return records.get(key);
  };
  const find = (tableId, recordId) => listOf(tableId).find((row) => row.record_id === recordId);
  return {
    bitable: {
      appTableField: {
        list: async ({ path }) => ({
          code: 0,
          data: { items: fieldMetaOf(byId.get(path.table_id)), has_more: false },
        }),
      },
      appTableRecord: {
        create: async ({ path, data }) => {
          const record = { record_id: `rec_${++seq}`, fields: { ...data.fields } };
          listOf(path.table_id, { create: true }).push(record);
          return { code: 0, data: { record } };
        },
        update: async ({ path, data }) => {
          const record = find(path.table_id, path.record_id);
          if (!record) return { code: 1254043, msg: 'RecordIdNotFound' };
          Object.assign(record.fields, data.fields);
          return { code: 0, data: { record } };
        },
        get: async ({ path }) => {
          const record = find(path.table_id, path.record_id);
          if (!record) return { code: 1254043, msg: 'RecordIdNotFound' };
          return { code: 0, data: { record } };
        },
        delete: async ({ path }) => {
          const list = listOf(path.table_id);
          const index = list.findIndex((row) => row.record_id === path.record_id);
          if (index >= 0) list.splice(index, 1);
          return { code: 0, data: {} };
        },
        list: async ({ path }) => ({
          code: 0,
          data: { items: listOf(path.table_id).slice(), has_more: false },
        }),
      },
    },
    im: {
      image: { create: async () => ({ image_key: `img_${++seq}` }) },
      message: {
        create: async () => ({ code: 0, msg: 'success', data: { message_id: `om_${++seq}`, thread_id: `omt_${++seq}` } }),
        reply: async () => ({ code: 0, msg: 'success', data: { message_id: `om_${++seq}`, thread_id: `omt_${++seq}` } }),
      },
    },
    // 采购单图写回附件：飞书是「先上传素材拿 file_token，再写进附件字段」两步。
    drive: { media: { uploadAll: async () => ({ file_token: `file_token_${++seq}` }) } },
  };
};

// ── 世界：真实网关 ＋ 假飞书 client ＋ 内存假 Base ─────────────────────────────
const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// 「货品信息」只通过 references 注入（和既有采购用例同一个口径）：
// 这里测的是**日志**，货品怎么读出来的不是本文件的对象。
const fakeReferences = {
  resolveProduct: async ({ productRecordId }) => ({
    recordId: productRecordId,
    record: { record_id: productRecordId, fields: { 编号: '8081黑', 货号: '8081', 颜色: [{ text: '黑色' }], 供应商: ['sup_1'] } },
  }),
  resolveSupplier: async () => ({ recordId: 'sup_1', record: { record_id: 'sup_1', fields: { 供应商名称: '测试供应商' } } }),
};

const makeWorld = (seed = {}, options = {}) => {
  const records = new Map(Object.entries(seed));
  const client = fakeLarkClient(records);
  const gateway = new V1BitableGateway({ client });
  const store = new JsonTaskStore({ dir: tempDir('purchase-log-correlation-'), idField: 'task_id' });
  const inventory = new InventoryService({
    gateway,
    store: new JsonTaskStore({ dir: tempDir('purchase-log-correlation-stock-'), idField: 'operation_id' }),
  });
  const service = new PurchaseWebhookService({
    gateway,
    client,
    store,
    inventory,
    references: options.references || fakeReferences,
    recognizer: options.recognizer
      || { parsePurchaseReportText: async () => [{ size: 36, quantity: 2 }, { size: 37, quantity: 1 }] },
    images: { render: async ({ supplierName }) => Buffer.from(`fake-png:${supplierName || ''}`) },
    // 群 id 走构造入参（显式沙箱通道），不读环境变量：并发用例之间不会互相污染。
    sandboxChatId: 'oc_test_purchase_group',
    batchLocatorStore: new JsonTaskStore({ dir: tempDir('purchase-log-correlation-locator-'), idField: 'task_id' }),
    batchReadMaxRetries: 1,
    batchReadRetryDelay: 0,
    reportBatchWindowMs: 20,
    purchaseReturnBatchWindowMs: 20,
  });
  return { records, client, gateway, store, inventory, service };
};

const waitFor = async (label, check, { attempts = 2000, pause = 5 } = {}) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
  throw new Error(`等待「${label}」超时`);
};

const SIZE_36_37 = [
  { record_id: 'size_36', fields: { 尺码: 36 } },
  { record_id: 'size_37', fields: { 尺码: 37 } },
];

// 每条日志里「改动前就有」的字段：一个都不许少（这是"只加日志字段"的哨兵）。
const assertGatewayCommon = (row, tableKey) => {
  assert.equal(row.table_key, tableKey, `${row.event}.table_key`);
  assert.equal(row.table_id, SCHEMA.tables[tableKey].tableId, `${row.event}.table_id`);
  assert.equal(typeof row.record_id, 'string');
  assert.equal(typeof row.duration_ms, 'number');
};

// ── ① 报单（**单条路径**：入口写回批次号失败 → 退回单条处理，取号走 `nextBatchNo()`）────
// ⚠️ 2026-10-07：报货批次号改成**入口按包生成并写回**之后，"单条路径"只剩一种到达方式
//   —— 入口那一步没写成（飞书读/写抽了一下）。这条用例测的正是单条路径的日志，
//   所以这里**刻意让那一步失败**（与真实场景同形）。
test('到货确认：写「报货批次.到货信息」/加库存的日志带 task_id ＋ batch_no ＋ **批次记录 id**（没有报单记录 id），且**不再有**入库明细行', async () => {
  const world = makeWorld({
    sizeManagement: [{ record_id: 'size_36', fields: { 尺码: 36 } }],
    behavior: [
      { record_id: 'beh_in', fields: { 行为名称: '入库', 行为编码: 'PURCHASE_IN', 库存方向: '增加', 是否启用: true } },
      { record_id: 'beh_stock_in', fields: { 行为名称: '采购增加', 行为编码: 'STOCK_PURCHASE_INCREASE', 库存方向: '增加', 是否启用: true } },
    ],
    // ⭐ 到货信息的落点 = 「报货批次」那一行（2026-10-07 晚；「到货验收」表已被业务负责人删除）。
    purchaseOrderBatch: [{ record_id: 'batch_1', fields: { 报货批次号: '202610071' } }],
    purchaseRequest: [],
    liveInventory: [],
    inventoryLedger: [],
  });

  const taskId = 'arrival_reconcile_test';
  await world.store.create({
    task_id: taskId,
    status: 'processing',
    batch_no: '202610071',
    batch_record_id: 'batch_1',
    request_ids: ['req_1'],
    draft: {
      batch_record_id: 'batch_1',
      batch_no: '202610071',
      acceptance_text: '都到了',
      // ⭐ 2026-10-09：那次 update 写的是「实际数量 / 实际金额」（「验收原话 / 确认状态」已退场）。
      actual_quantity: 2,
      actual_amount: 1200,
      operator_open_id: 'ou_user_1',
      requests: [{ record_id: 'req_1', fields: { 编号: ['prod_1'], 尺码: ['size_36'] } }],
      actual: [{ product_record_id: 'prod_1', item_no: '8081', color: '黑色', size: 36, quantity: 2 }],
      pending_creation: [],
      created_products: [],
      inventory_applied: {},
    },
  });

  const logs = captureLogs();
  try {
    await world.service.confirmArrival(taskId, await world.store.get(taskId), 'ou_user_1');
  } finally {
    logs.restore();
  }

  const TASK = taskId;
  const BATCH = '202610071';
  // ⭐ 2026-10-07 晚：关联键从 `purchase_arrival_record_id`（「到货验收」那条记录）
  //    换成 `purchase_batch_record_id`（「报货批次」那一行）—— 前者已无来源。
  const BATCH_RECORD = 'batch_1';

  // a. ⭐ 新建的记录**只有**「库存流水」+「实时库存」：到货链路再也不新建任何入库明细行
  //    （「采购入库」表已被业务负责人整表删除 —— 全仓连那个表键都不许再出现，
  //      见 purchaseInboundRemoval.test.js 的 ①）。
  const createdTables = [...new Set(logs.logs('bitable.record.created').map((row) => row.table_key))].sort();
  assert.deepEqual(createdTables, ['inventoryLedger', 'liveInventory'],
    '这次确认只新建「库存流水」一条 +「实时库存」两条；入库明细行一条都没有');

  // b. ⭐ 库存那半：采购加库存带同一组键
  const applied = logs.logs('inventory.change.applied');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].task_id, TASK);
  assert.equal(applied[0].batch_no, BATCH);
  assert.equal(applied[0].purchase_batch_record_id, BATCH_RECORD);
  assert.equal(applied[0].purchase_report_record_id, undefined);
  assert.equal(applied[0].purchase_arrival_record_id, undefined);
  // 既有字段一个都不少
  assert.equal(applied[0].kind, 'STOCK_PURCHASE_INCREASE');
  assert.equal(applied[0].stock_key, 'prod_1|36|样品');
  assert.equal(applied[0].movement_quantity, 2);
  assert.equal(applied[0].direction, '增加');
  assert.equal(applied[0].target_quantity, 2);
  // 第一双新品：实时库里没有可抄的「库存键」→ 如实说 unavailable，不猜
  assert.equal(applied[0].stock_key_label, undefined);
  assert.equal(applied[0].stock_key_label_source, 'unavailable');

  // c. 「实时库存」那两个新建：来自库存引擎，同样带键
  const liveRows = logs.logs('bitable.record.created').filter((row) => row.table_key === 'liveInventory');
  assert.equal(liveRows.length, 2, '入 2 双 = 新建 2 条实时库存');
  for (const row of liveRows) {
    assert.equal(row.task_id, TASK);
    assert.equal(row.batch_no, BATCH);
    assert.equal(row.purchase_batch_record_id, BATCH_RECORD);
    assert.equal(row.purchase_arrival_record_id, undefined);
    assertGatewayCommon(row, 'liveInventory');
  }

  // d. ⭐ 到货信息在**批次行**上的写入：这次确认只写一次「实际数量 / 实际金额」。
  //    ⛔ 2026-10-09：原先这里是两次（「验收原话」＋「确认状态」）—— 两列在真表上都没有了，
  //       写入点删除 ⇒ 只剩这一次。「到货状态 = 已到货」不在这里写（由对话链路的
  //       `notifyBatchArrived` 负责，本用例只调 `confirmArrival`）。
  const batchRows = logs.logs('bitable.record.updated').filter((row) => row.table_key === 'purchaseOrderBatch');
  assert.equal(batchRows.length, 1, '「实际数量 / 实际金额」写一次');
  for (const row of batchRows) {
    assert.equal(row.task_id, TASK);
    assert.equal(row.batch_no, BATCH);
    assert.equal(row.purchase_batch_record_id, BATCH_RECORD);
    assert.equal(row.record_id, BATCH_RECORD);
    assertGatewayCommon(row, 'purchaseOrderBatch');
  }

  // e. 业务日志：purchase.arrival.posted
  const posted = logs.logs('purchase.arrival.posted');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].task_id, TASK);
  assert.equal(posted[0].batch_no, BATCH);
  assert.equal(posted[0].purchase_batch_record_id, BATCH_RECORD);
  // 既有字段一个都不少（`arrival_record_id` 已随表退场 → 换成 `batch_record_id`）
  assert.equal(posted[0].batch_record_id, BATCH_RECORD);
  assert.equal(posted[0].arrival_record_id, undefined);
  // ⚠️ 键名与事实对齐：不再有"入库几条"，改数"给几个（货品+尺码）加了库存"，并明写入库行 0。
  assert.equal(posted[0].inventory_applied_count, 1);
  assert.equal(posted[0].inbound_rows_written, 0);
  assert.equal(posted[0].inventory_applied, true);
});


// ⛔⛔ 2026-10-09：本文件里由「信息填写」表变更事件驱动的那几条用例**整批删除**：
//   · 「供应商报单：写「报货批次」/「具体信息」/「信息填写」/附件写回的日志都带
//      task_id ＋ batch_no（＋报单记录 id）」；
//   · 「采购退货：写「单据信息」/扣库存/回写「供应商对接」的日志都带 task_id ＋
//      batch_no ＋ 报单记录 id」；
//   · 「拿不到报货批次号：只给 task_id ＋ 报单记录 id，`batch_no` 一个都不许冒出来」
//     （那条造法本身就是"入口按包写回失败"，入口退场之后没有这个形状了）。
//   它们钉的入口（`accept('supplier-report')`）与关联键 `purchase_report_record_id`
//   （已从白名单删除）都随那张表一起退场。
// ⭐ **保留**的是「到货确认」那条：写「实际数量 / 实际金额」＋「到货状态」＋加库存的日志
//    照旧带 `task_id ＋ batch_no ＋ purchase_batch_record_id`，且**不再有**入库明细行。
