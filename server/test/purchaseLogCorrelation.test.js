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
test('供应商报单：写「报货批次」/「具体信息」/「信息填写」/附件写回的日志都带 task_id ＋ batch_no', async () => {
  const world = makeWorld({
    sizeManagement: SIZE_36_37,
    // 行为表为空 → classifyReportBehavior 退回「采购申请」（今日行为）
    behavior: [],
    supplier: [{ record_id: 'sup_1', fields: { 供应商名称: '测试供应商' } }],
    purchaseOrderBatch: [],
    purchaseRequest: [],
    purchaseReport: [{
      record_id: 'rep_1',
      fields: {
        处理状态: '待解析', 采购行为: [], 编号: ['prod_1'], 尺码: ['size_36', 'size_37'],
        数量说明: '36码2双，37码1双', 经办人: [{ id: 'ou_user_1' }],
      },
    }],
  });
  // 入口"把号写回信息填写"这一步失败 ⇒ 记录里仍然是空号 ⇒ 退回单条路径（与改动前同形）。
  const originalUpdateForIntake = world.client.bitable.appTableRecord.update;
  world.client.bitable.appTableRecord.update = async ({ path, data }) => {
    if (data?.fields?.['报货批次号'] !== undefined && data.fields['报货批次号'] !== null) {
      return { code: 99991400, msg: '模拟：写回批次号失败' };
    }
    return originalUpdateForIntake({ path, data });
  };

  const logs = captureLogs();
  let taskId = '';
  try {
    const accepted = await world.service.accept('supplier-report', 'rep_1');
    taskId = accepted.taskId;
    await waitFor('报单记录进入「已生成申请」', async () => {
      const row = (world.records.get('purchaseReport') || []).find((item) => item.record_id === 'rep_1');
      return row?.fields?.['处理状态'] === '已生成申请' && (row.fields['关联采购申请'] || []).length > 0;
    });
    await waitFor('附件写回', async () => {
      const rows = world.records.get('purchaseOrderBatch') || [];
      // ⚠️ 2026-10-07：附件落点从「具体信息.采购申请单」（那一列已被她从生产表删除）
      //    搬到**「报货批次.单据」**。判据不变：这一批只写**一条** → some 不是 every。
      return rows.some((row) => (row.fields['单据'] || []).length === 1);
    });
    // ⚠️ 附件写回之后还有收尾（写话题映射、`purchase.report.posted`）。
    //    这里等的是**与既有采购用例同一个判据**：任务 result 已落盘 = 这一条真的处理完了。
    await waitFor('任务跑完（result 已落盘）', async () => {
      const task = await world.store.get(taskId);
      return Boolean(task) && (task.result !== undefined || task.status === 'failed');
    });
  } finally {
    logs.restore();
  }

  // 任务 id 就是采购那套本地任务 id（不是销售/到货那两套）
  assert.match(taskId, /^purchase_supplier-report_/);

  const created = logs.logs('bitable.record.created');
  const batchRow = created.find((row) => row.table_key === 'purchaseOrderBatch');
  const requestRow = created.find((row) => row.table_key === 'purchaseRequest');
  assert.ok(batchRow, '必须真的写过「报货批次」（否则这条用例测不到东西）');
  assert.ok(requestRow, '必须真的写过「单据信息」');

  // a. 新键真的在；批次号三条日志**逐字相同**（一个键串到底）
  const batchNo = batchRow.batch_no;
  // ⚠️ 2026-10-07 口径变更：报货批次号不再手填、也不再是 `BH-…`，而是**入口代码生成**的
  //    `CGD-YYYYMMDD-NNNN`（业务负责人给的样例 `CGD-20261007-0003`）。
  //    断言**收严**：从"BH- + 8 位 + 0001"改成**逐字匹配整条格式的完整正则**。
  assert.match(batchNo, /^CGD-\d{8}-\d{4}$/, `单条路径的批次号由入口生成，实际：${batchNo}`);
  assert.equal(batchRow.task_id, taskId);
  assert.equal(requestRow.task_id, taskId);
  assert.equal(requestRow.batch_no, batchNo);
  assert.equal(requestRow.purchase_report_record_id, 'rep_1');
  // ⚠️ 「报货批次」那一行是**批次级**的：它没有"哪一条报单记录"这回事 → 不编。
  assert.equal(batchRow.purchase_report_record_id, undefined);
  assert.equal(batchRow.purchase_batch_record_id, undefined);
  // ⚠️ 2026-10-07 晚：`purchase_arrival_record_id` 这个键**整体退场**（表已被删除）⇒ 一个都不许冒出来。
  assert.equal(batchRow.purchase_arrival_record_id, undefined);

  // b. 既有字段一个都不少
  assertGatewayCommon(batchRow, 'purchaseOrderBatch');
  assertGatewayCommon(requestRow, 'purchaseRequest');

  // c. 「供应商对接」的终态回写：带这批的键 ＋ 那条记录自己的 id
  const reportUpdated = logs.logs('bitable.record.updated')
    .find((row) => row.table_key === 'purchaseReport' && row.record_id === 'rep_1');
  assert.ok(reportUpdated);
  assert.equal(reportUpdated.task_id, taskId);
  assert.equal(reportUpdated.batch_no, batchNo);
  assert.equal(reportUpdated.purchase_report_record_id, 'rep_1');
  assertGatewayCommon(reportUpdated, 'purchaseReport');

  // d. 附件写回也是写库：task_id ＋ batch_no 都在（2026-10-07 起落在「报货批次.单据」上）
  const attachmentRow = logs.logs('bitable.record.updated').find((row) => row.table_key === 'purchaseOrderBatch');
  assert.ok(attachmentRow, '附件写回必须真的发生过');
  assert.equal(attachmentRow.task_id, taskId);
  assert.equal(attachmentRow.batch_no, batchNo);

  // e. 业务日志：purchase.report.posted 也带同一个批次号（改动前它只有 task_id）
  const posted = logs.logs('purchase.report.posted');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].task_id, taskId);
  assert.equal(posted[0].batch_no, batchNo);
  assert.equal(posted[0].purchase_report_record_id, 'rep_1');
  // 既有字段一个都不少
  assert.equal(posted[0].record_id, 'rep_1');
  assert.equal(typeof posted[0].item_count, 'number');

  // f. 一句话验收：一个 grep 就能串起来
  const chained = logs.lines.filter((line) => line.includes(`"task_id":"${taskId}"`));
  for (const event of ['bitable.record.created', 'bitable.record.updated', 'purchase.report.posted']) {
    assert.ok(chained.some((line) => line.includes(`"event":"${event}"`)), `${event} 必须能被 task_id 一把 grep 到`);
  }

  // g. ⭐ AC-P5 的另一半：关联键**只进日志**，一个字节都不许落进业务表 ——
  //    远端收到的 fields 与改动前逐字相同（写什么值、写什么表都没动）。
  const requestRows = world.records.get('purchaseRequest') || [];
  assert.equal(requestRows[0].fields['数量'], 2);
  assert.deepEqual(requestRows[0].fields['编号'], ['prod_1']);
  assert.deepEqual(requestRows[0].fields['尺码'], ['size_36']);
  assert.equal(requestRows[0].fields['幂等键'], `purchase_request:${taskId}:0`);
  for (const key of CORRELATION_KEYS) {
    for (const row of [...requestRows, ...(world.records.get('purchaseOrderBatch') || [])]) {
      assert.equal(Object.prototype.hasOwnProperty.call(row.fields, key), false,
        `关联键 ${key} 不许落进业务表`);
    }
  }
});

// ── ② 采购退货（带报货批次号）：扣库存那半也要能串 ─────────────────────────────
test('采购退货：写「单据信息」/扣库存/回写「供应商对接」的日志都带 task_id ＋ batch_no ＋ 报单记录 id', async () => {
  const world = makeWorld({
    sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }],
    behavior: [
      { record_id: 'beh_return', fields: { 行为名称: '采购退货', 行为编码: 'PURCHASE_RETURN', 库存方向: '减少', 是否启用: true } },
      { record_id: 'beh_stock_out', fields: { 行为名称: '采购减少', 行为编码: 'STOCK_PURCHASE_DECREASE', 库存方向: '减少', 是否启用: true } },
    ],
    purchaseReport: [{
      record_id: 'rep_return_1',
      fields: {
        处理状态: '待解析', 采购行为: ['beh_return'], 编号: ['prod_1'],
        // 声明 2 双、库存只有 1 双 → 走"差额要在群里说一句"那条路（顺带覆盖群提示日志）
        // 🔴 2026-10-07 口径变更：退货也是「尺码（关联多选）+ 数量说明」，
        //    「数量」那一列已被业务负责人从生产表删除。
        尺码: ['size_38'], 数量说明: '38码2双', 报货批次号: '202610071', 经办人: [{ id: 'ou_user_1' }],
      },
    }],
    purchaseRequest: [],
    liveInventory: [{
      record_id: 'live_1',
      fields: { 库存键: '5801-38|灰色|B|38', 所属状态: '门盒', 编号: ['prod_1'], 尺码: ['size_38'] },
    }],
    inventoryLedger: [],
  }, {
    // 桩按说明里的数给答案（38 码 2 双）。
    recognizer: { parsePurchaseReportText: async () => [{ size: 38, quantity: 2 }] },
  });

  const logs = captureLogs();
  let taskId = '';
  try {
    const accepted = await world.service.accept('supplier-report', 'rep_return_1');
    taskId = accepted.taskId;
    // ⚠️ 等的是**整批处理完**：`处理状态=已生成申请` 只是整批中途的一步，
    //    之后还有出图/发群/差额提示（purchase.return.posted）。
    //    批次任务落 posted 是 flushReturnBatch 在 runReturnBatch 返回之后写的 ⇒ 它一到就都跑完了。
    await waitFor('退货整批处理完成（任务落 posted）', async () => {
      const task = await world.store.get(taskId);
      return task?.status === 'posted';
    });
  } finally {
    logs.restore();
  }

  const TASK = taskId;
  const BATCH = '202610071';
  const REPORT = 'rep_return_1';

  // a. 「单据信息」（退货单）那一行
  const docRow = logs.logs('bitable.record.created').find((row) => row.table_key === 'purchaseRequest');
  assert.ok(docRow, '退货必须真的写了一条「单据信息」');
  assert.equal(docRow.task_id, TASK);
  assert.equal(docRow.batch_no, BATCH);
  assert.equal(docRow.purchase_report_record_id, REPORT);
  // 退货不写「采购到货」/「报货批次」上的到货信息 → 那两个键一个都不许冒出来
  assert.equal(docRow.purchase_arrival_record_id, undefined);
  assert.equal(docRow.purchase_batch_record_id, undefined);
  assertGatewayCommon(docRow, 'purchaseRequest');

  // b. ⭐ 库存那半（这条以前**一个键都没有**）
  const applied = logs.logs('inventory.change.applied');
  assert.equal(applied.length, 1, '退 1 双 = 一次库存操作');
  assert.equal(applied[0].task_id, TASK);
  assert.equal(applied[0].batch_no, BATCH);
  assert.equal(applied[0].purchase_report_record_id, REPORT);
  // 既有字段一个都不少
  assert.equal(applied[0].kind, 'STOCK_PURCHASE_DECREASE');
  assert.equal(applied[0].stock_key, 'prod_1|38|门盒');
  assert.equal(applied[0].stock_key_label, '5801-38|灰色|B|38');
  assert.equal(applied[0].movement_quantity, 1);
  assert.equal(applied[0].direction, '减少');
  assert.equal(applied[0].target_quantity, 0);
  assert.equal(typeof applied[0].ledger_record_id, 'string');
  assert.deepEqual(applied[0].live_record_ids, ['live_1']);

  // c. 「供应商对接」的终态回写
  const reportUpdated = logs.logs('bitable.record.updated').find((row) => row.table_key === 'purchaseReport');
  assert.ok(reportUpdated);
  assert.equal(reportUpdated.task_id, TASK);
  assert.equal(reportUpdated.batch_no, BATCH);
  assert.equal(reportUpdated.purchase_report_record_id, REPORT);

  // d. 业务日志：purchase.return.stock_applied / posted / notice 都带同一组键
  const stockApplied = logs.logs('purchase.return.stock_applied');
  assert.equal(stockApplied.length, 1);
  assert.equal(stockApplied[0].task_id, TASK);
  assert.equal(stockApplied[0].batch_no, BATCH);
  assert.equal(stockApplied[0].purchase_report_record_id, REPORT);
  // 既有字段一个都不少
  assert.equal(stockApplied[0].record_id, REPORT);
  assert.equal(stockApplied[0].size, 38);
  assert.equal(stockApplied[0].quantity, 1);
  assert.equal(typeof stockApplied[0].doc_id, 'string');

  // ⚠️ 带批次号的退货走**整批**那条路，它的收尾日志是 `purchase.return.batch.posted`
  //    （`purchase.return.posted` 只属于"没有批次号的单条"那条路，见下一条用例）。
  const returnPosted = logs.logs('purchase.return.batch.posted');
  assert.equal(returnPosted.length, 1);
  assert.equal(returnPosted[0].task_id, TASK);
  assert.equal(returnPosted[0].batch_no, BATCH);
  // 既有字段一个都不少
  assert.equal(returnPosted[0].record_count, 1);
  assert.equal(returnPosted[0].doc_count, 1);
  assert.equal(returnPosted[0].item_count, 1);

  // e. 「发采购群」的提示日志同样带键（差额提示 + 那句群消息）
  const notice = logs.logs('purchase.return.notice');
  assert.equal(notice.length, 1, '差额 1 双 → 必须发一句提示');
  assert.equal(notice[0].task_id, TASK);
  assert.equal(notice[0].batch_no, BATCH);
  assert.equal(notice[0].purchase_report_record_id, REPORT);
  assert.equal(notice[0].sent, true);

  const groupSent = logs.logs('purchase.group_notice.sent');
  assert.equal(groupSent.length, 1);
  assert.equal(groupSent[0].task_id, TASK);
  assert.equal(groupSent[0].batch_no, BATCH);
  assert.equal(groupSent[0].purchase_report_record_id, REPORT);
  assert.equal(groupSent[0].chat_id, 'oc_test_purchase_group');
});

// ── ③ 到货 → 加库存：到货核对是**另一套 task**，如实照传；报单记录 id 拿不到就不给 ──
// ⚠️ 2026-10-07 **深夜**：「采购入库」表已被业务负责人**整表删除** ⇒ 这条用例从
//    "写「采购入库」+ 加库存"翻成"**只**加库存（＋批次行两列）"，日志断言跟着翻。
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

  // d. ⭐ 到货信息在**批次行**上的两次写入：写「验收原话」＋ 写「确认状态」，都带同一组键
  const batchRows = logs.logs('bitable.record.updated').filter((row) => row.table_key === 'purchaseOrderBatch');
  assert.equal(batchRows.length, 2, '「验收原话」与「确认状态」各写一次');
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

// ── ④ 「拿不到批次号」这一种：只给拿得到的键，`batch_no` **不出现**（不许编）──────────
// ⚠️ 2026-10-07 **口径变更**：报货批次号不再手填 —— 入口会按包生成一个并写回「信息填写」。
//   所以"记录里没有号"这件事**不再能靠空夹具造出来**（`accept` 会先补上）。
//   这条用例保住的**不变式一个字没变**：**拿不到批次号就不传这个键，绝不编一个**。
//   造法跟着改成"入口写回失败"（真实场景：那一刻飞书读/写抽了一下）——
//   号生成了但没落进「信息填写」，下游（退货链路）依然拿不到它。
test('拿不到报货批次号：只给 task_id ＋ 报单记录 id，`batch_no` 一个都不许冒出来', async () => {
  const world = makeWorld({
    sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }],
    behavior: [
      { record_id: 'beh_return', fields: { 行为名称: '采购退货', 行为编码: 'PURCHASE_RETURN', 库存方向: '减少', 是否启用: true } },
      { record_id: 'beh_stock_out', fields: { 行为名称: '采购减少', 行为编码: 'STOCK_PURCHASE_DECREASE', 库存方向: '减少', 是否启用: true } },
    ],
    purchaseReport: [{
      record_id: 'rep_return_old',
      fields: {
        处理状态: '待解析', 采购行为: ['beh_return'], 编号: ['prod_1'],
        // ⚠️ 报货批次号字段上线前录入的旧数据：它是空的
        // 🔴 2026-10-07 口径变更：退货也是「尺码 + 数量说明」；数量说明不写 = 1 双。
        尺码: ['size_38'], 经办人: [{ id: 'ou_user_1' }],
      },
    }],
    purchaseRequest: [],
    liveInventory: [{
      record_id: 'live_1',
      fields: { 库存键: '5801-38|灰色|B|38', 所属状态: '门盒', 编号: ['prod_1'], 尺码: ['size_38'] },
    }],
    inventoryLedger: [],
  });
  // 让「入口把号写回信息填写」这一步失败（其余写入照常）：号没落盘 ⇒ 下游拿不到。
  const originalUpdate = world.client.bitable.appTableRecord.update;
  world.client.bitable.appTableRecord.update = async ({ path, data }) => {
    if (data?.fields?.['报货批次号'] !== undefined && data.fields['报货批次号'] !== null) {
      return { code: 99991400, msg: '模拟：写回批次号失败' };
    }
    return originalUpdate({ path, data });
  };

  const logs = captureLogs();
  let taskId = '';
  try {
    const accepted = await world.service.accept('supplier-report', 'rep_return_old');
    taskId = accepted.taskId;
    await waitFor('单条退货处理完成（任务落 posted）', async () => {
      const task = await world.store.get(taskId);
      return task?.status === 'posted';
    });
  } finally {
    logs.restore();
  }

  // 正向证据：这一次确实是"写回失败"那条路（不是夹具里恰好有号）
  assert.equal(logs.logs('purchase.batch_no.write_back_failed').length >= 1, true,
    '必须真的走到"入口写回失败"这条路，否则这条用例什么都没测到');
  assert.equal((world.records.get('purchaseReport') || [])
    .find((row) => row.record_id === 'rep_return_old')?.fields?.['报货批次号'] ?? '', '',
  '入口写回失败之后，那一列必须仍然是空的（所以下游拿不到号）');

  const TASK = taskId;
  const REPORT = 'rep_return_old';
  for (const event of ['purchase.return.posted', 'inventory.change.applied', 'purchase.return.stock_applied']) {
    const rows = logs.logs(event);
    assert.equal(rows.length, 1, `${event} 必须记下来`);
    assert.equal(rows[0].task_id, TASK, `${event}.task_id`);
    assert.equal(rows[0].purchase_report_record_id, REPORT, `${event}.purchase_report_record_id`);
    // 拿不到批次号 → 这个键**不出现**（不是 `"batch_no":""`），也绝不编一个
    assert.equal(Object.prototype.hasOwnProperty.call(rows[0], 'batch_no'), false, `${event} 不该有 batch_no`);
  }
  // 既有字段一个都不少
  const posted = logs.logs('purchase.return.posted')[0];
  assert.equal(posted.record_id, REPORT);
  assert.equal(posted.declared, 1);
  assert.equal(posted.available, 1);
  assert.equal(posted.taken, 1);
  const applied = logs.logs('inventory.change.applied')[0];
  assert.equal(applied.kind, 'STOCK_PURCHASE_DECREASE');
  assert.equal(applied.stock_key, 'prod_1|38|门盒');

  // 「单据信息」那一行（网关层）同样：有报单记录 id，没有 batch_no
  const docRow = logs.logs('bitable.record.created').find((row) => row.table_key === 'purchaseRequest');
  assert.ok(docRow);
  assert.equal(docRow.task_id, TASK);
  assert.equal(docRow.purchase_report_record_id, REPORT);
  assert.equal(Object.prototype.hasOwnProperty.call(docRow, 'batch_no'), false);
});

// ── ⑤ 不传关联键 = 一个键都不出现（不是空串）─────────────────────────────────
test('不传关联键时：业务日志里一个关联键都不出现（不是写成空串）', async () => {
  const world = makeWorld({ sizeManagement: SIZE_36_37, behavior: [] });

  const logs = captureLogs();
  let sent = false;
  try {
    sent = await world.service.sendPurchaseGroupNotice('一句普通提示');
  } finally {
    logs.restore();
  }
  assert.equal(sent, true);

  const rows = logs.logs('purchase.group_notice.sent');
  assert.equal(rows.length, 1);
  // 既有字段一个都不少
  assert.equal(rows[0].chat_id, 'oc_test_purchase_group');
  for (const key of CORRELATION_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(rows[0], key), false, `不传时不该有 ${key}`);
  }
});
