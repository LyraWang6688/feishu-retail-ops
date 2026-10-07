// ⭐ 2026-10-07（晚）业务负责人的口径变更（逐字）：
//   「**为什么退货批次不可以像申请一样，也自动生成呢？并且也落到报货批次表里呢？
//    然后如果退货申请也要落到报货批次的话，那么到货状态，就需要你在报货的时候，写入未到货，
//    然后退货，不用写**」
// ⇒ 三条契约，这个文件逐条钉住：
//   A. 退货包也在「报货批次」里有**一行**（号 = 入口按包生成的那个，与「信息填写」同一个号）；
//   B. 那一行**只写 批次号 + 幂等键**，**不写「到货状态」**（连这个键都不进 values）；
//      报货那一行仍然写「未到货」（口径差异对钉）；
//   C. 退货单的 PNG 因此**有了落点**：写进那一行的「单据」（既有附件语义一字不变）；
//   D. 退货行（状态空）**不进** 9 点推送的「未到货」候选；
//   E. 重投 / 重跑只有一行、一份附件；退货与报货不会拿到同一个号（并集计数）。
//
// ⚠️ 库存那一段用**真的 InventoryService**（与 purchaseReturn.test.js 同款）：
//    这里要验的是"`taken > 0` ⇒ 有图 ⇒ 有落点 ⇒ 建行"这条因果，桩不出这件事。
//
// 验收标准与逐条对照：docs/purchase-return-batch-row-2026-10-07.md

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const { PurchasePendingBatchService } = require('../src/services/purchasePendingBatchService');
const { InventoryService } = require('../src/services/inventoryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { RETURN_TITLE } = require('../src/services/purchaseRequestImageService');
const { resolveArrivalConversationConfig } = require('../src/config/arrivalConversation');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';
// 采购单只发群（没配群会「大声跳过」）：这组用例要验的正是"发图 → 写回附件"那一段。
process.env.PURCHASE_CHAT_ID = process.env.PURCHASE_CHAT_ID || 'oc_test_purchase_group';

const table = (key) => V1_BITABLE_SCHEMA.tables[key];
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-return-batch-row-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SIZE_RECORDS = [36, 37].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));

const mapFields = (tableKey, semanticValues) => {
  const schema = V1_BITABLE_SCHEMA.tables[tableKey];
  const out = {};
  Object.entries(semanticValues || {}).forEach(([key, value]) => {
    const fieldName = schema?.fields?.[key];
    if (!fieldName) throw new Error(`未配置语义字段: ${tableKey}.${key}`);
    if (value !== undefined) out[fieldName] = value;
  });
  return out;
};

const makeGateway = (records = {}) => {
  let seq = 0;
  const uploads = [];
  const data = records;
  // 飞书附件单元格读回来带 `name`（= **上传时那个文件名**）。这里照着补上，
  // 否则「同名图 → 跳过」的去重判据在假 Base 上永远命中不了（既有用例同款做法）。
  const tokenNames = new Map();
  return {
    records: data,
    uploads,
    table,
    get: async (tableKey, recordId) => (data[tableKey] || []).find((row) => row.record_id === recordId) || null,
    listAll: async (tableKey) => (tableKey === 'sizeManagement' && !data.sizeManagement
      ? SIZE_RECORDS
      : (data[tableKey] || [])),
    create: async (tableKey, semanticValues) => {
      const fields = mapFields(tableKey, semanticValues);
      const recordId = `new_${tableKey}_${++seq}`;
      const record = { record_id: recordId, fields };
      (data[tableKey] ||= []).push(record);
      return { recordId, record };
    },
    update: async (tableKey, recordId, semanticValues) => {
      const patch = mapFields(tableKey, semanticValues);
      if (Array.isArray(patch['单据'])) {
        patch['单据'] = patch['单据'].map((item) => ({
          ...item, name: tokenNames.get(item.file_token) || item.name || '',
        }));
      }
      const record = (data[tableKey] || []).find((row) => row.record_id === recordId);
      if (record) record.fields = { ...record.fields, ...patch };
      return record || { record_id: recordId };
    },
    // 库存扣到 0 的行会被删掉（真 InventoryService 的行为），桩也要能删。
    delete: async (tableKey, recordId) => {
      data[tableKey] = (data[tableKey] || []).filter((row) => row.record_id !== recordId);
      return true;
    },
    // 直接按中文列名改（模拟"状态没写上"那种重跑场景），不经过语义名映射。
    updateRaw: async (tableKey, recordId, patch) => {
      const record = (data[tableKey] || []).find((row) => row.record_id === recordId);
      if (record) record.fields = { ...record.fields, ...patch };
      return record;
    },
    uploadAttachment: async (filePath) => {
      uploads.push(filePath);
      const token = `file_token_${uploads.length}`;
      tokenNames.set(token, path.basename(filePath));
      return token;
    },
  };
};

const makeClient = (messages) => ({
  im: {
    image: { create: async () => ({ image_key: `img_${messages.length + 1}` }) },
    message: {
      create: async (params) => {
        messages.push(params);
        return { code: 0, msg: 'success', data: { message_id: `om_${messages.length}` } };
      },
      reply: async (params) => {
        messages.push(params);
        return { code: 0, msg: 'success', data: { message_id: `om_${messages.length}`, thread_id: 'omt_thread' } };
      },
    },
  },
});

const makeImages = () => {
  const calls = [];
  return {
    calls,
    render: async (input) => {
      calls.push(input);
      return Buffer.from(`fake-png:${input.title || ''}`);
    },
  };
};

// 「行为管理」两条：采购申请（增加）/ 采购退货（采购减少）。
const BEHAVIORS = [
  { record_id: 'beh_request', fields: { 行为名称: '采购申请', 行为编码: 'STOCK_PURCHASE_INCREASE', 库存方向: '增加', 是否启用: true } },
  { record_id: 'beh_return', fields: { 行为名称: '采购退货', 行为编码: 'STOCK_PURCHASE_DECREASE', 库存方向: '减少', 是否启用: true } },
];

const SUPPLIERS = [
  { record_id: 'sup_A', fields: { 供应商名称: '金猴' } },
  { record_id: 'sup_B', fields: { 供应商名称: '百丽' } },
];

const productFields = (itemNo, color, supplierId = 'sup_A') => ({
  货号: itemNo, 颜色: [{ text: color }], 编号: `${itemNo}${color}`, 供应商: [supplierId],
});

const liveRow = (recordId, state, size, productRecordId = 'prod_1') => ({
  record_id: recordId,
  fields: { 编号: [productRecordId], 尺码: [`size_${size}`], 所属状态: state },
});

// 一条「采购退货」格式的「信息填写」记录：编号 + 数量，**没有尺码**。
// ⚠️ 刻意**不带**「报货批次号」：新口径下号是**入口按包生成并写回**的（这里就是要验这件事）。
const returnRecord = (recordId, fields = {}) => ({
  record_id: recordId,
  fields: {
    处理状态: '待解析',
    采购行为: ['beh_return'],
    经办人: [{ id: 'ou_user_1' }],
    编号: ['prod_1'],
    ...fields,
  },
});

// 一条「采购申请」格式的记录：编号 + 尺码 + 数量说明。
const reportRecord = (recordId, fields = {}) => ({
  record_id: recordId,
  fields: {
    处理状态: '待解析',
    采购行为: ['beh_request'],
    经办人: [{ id: 'ou_user_1' }],
    编号: ['prod_1'],
    尺码: ['size_36'],
    数量说明: '36码1双',
    ...fields,
  },
});

const makeService = (options = {}) => {
  const store = options.store || new JsonTaskStore({ dir: tempDir() });
  const gateway = options.gateway || makeGateway();
  const messages = options.messages || [];
  const images = options.images || makeImages();
  const inventoryStore = new JsonTaskStore({ dir: tempDir(), idField: 'operation_id' });
  const service = new PurchaseWebhookService({
    gateway,
    store,
    client: makeClient(messages),
    images,
    inventory: new InventoryService({ gateway, store: inventoryStore }),
    references: {
      resolveProduct: async ({ productRecordId }) => {
        const fields = (options.products || {})[productRecordId];
        if (!fields) throw new Error(`找不到货品记录：${productRecordId}`);
        return { recordId: productRecordId, record: { record_id: productRecordId, fields } };
      },
    },
    recognizer: { parsePurchaseReportText: async () => [{ size: 36, quantity: 1 }] },
    enableReportAlertBootstrap: false,
    disableBatchAlertTimers: true,
    batchReadMaxRetries: 1,
    batchReadRetryDelay: 0,
    purchaseReturnBatchWindowMs: 10_000,
    reportBatchWindowMs: 10_000,
  });
  return { service, store, gateway, messages, images, inventoryStore };
};

const waitForTaskSettled = async (store, taskId, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = await store.get(taskId);
    if (task && !['queued', 'processing', 'batch_waiting'].includes(task.status)) return task;
    if (Date.now() > deadline) return task;
    await sleep(10);
  }
};

const waitFor = async (label, check, { attempts = 800, pause = 10 } = {}) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await sleep(pause);
  }
  throw new Error(`等待「${label}」超时`);
};

/** 走**生产同一条入口**（accept → 入口按包生成号 → 处理），等这一条落定。 */
const acceptAndSettle = async (ctx, recordId) => {
  const accepted = await ctx.service.accept('supplier-report', recordId);
  const task = await waitForTaskSettled(ctx.store, accepted.taskId);
  return { taskId: accepted.taskId, task };
};

const rowsOf = (gateway, tableKey) => gateway.records[tableKey] || [];
const batchRowsOf = (gateway) => rowsOf(gateway, 'purchaseOrderBatch');
const reportFieldsOf = (gateway, recordId) => (rowsOf(gateway, 'purchaseReport')
  .find((row) => row.record_id === recordId) || {}).fields || {};

// ═══════════════════════════════════════════════════════════════════════════
// A + B + C：退货包 → 一行「报货批次」（号一致 · 到货状态空 · 幂等键同族）· PNG 落在「单据」
// ═══════════════════════════════════════════════════════════════════════════

test('A/B/C 退货包：入口生成号 → 建「报货批次」1 行（号一致 · 到货状态**空**）· 退货单 PNG 写进「单据」', async () => {
  const gateway = makeGateway({
    purchaseReport: [returnRecord('rep_1', { 数量: 1 })],
    liveInventory: [liveRow('live_36', '门盒', 36)],
    behavior: BEHAVIORS,
    supplier: SUPPLIERS,
    purchaseRequest: [],
    purchaseOrderBatch: [],
  });
  const ctx = makeService({ gateway, products: { prod_1: productFields('8088', '黑色') } });
  const { task } = await acceptAndSettle(ctx, 'rep_1');

  assert.equal(task.status, 'posted', '退货整批照常 posted');

  // A1：入口生成的号写回了「信息填写」，同一个号落在「报货批次」那一行
  const reportNo = reportFieldsOf(gateway, 'rep_1')['报货批次号'];
  assert.match(reportNo, /^CGD-\d{8}-\d{4}$/, `入口生成的号形如 CGD-YYYYMMDD-NNNN，实际：${reportNo}`);
  const batches = batchRowsOf(gateway);
  assert.equal(batches.length, 1, '退货包也要建「报货批次」一行（A1）');
  assert.equal(batches[0].fields['报货批次号'], reportNo, '两处必须是同一个号');
  assert.equal(batches[0].fields['幂等键'], `purchase_batch:${reportNo}`,
    '幂等键与报货那条同族（purchase_batch: 前缀），身份取批次号（A3）');

  // A2：**「到货状态」这个键都不许出现**（不是"写了空串"）
  assert.equal(Object.prototype.hasOwnProperty.call(batches[0].fields, '到货状态'), false,
    '退货建行**不写**「到货状态」（留空 ⇒ 不进 9 点推送）');
  assert.equal(batches[0].fields['到货状态'], undefined);

  // B1：退货单 PNG 写到那一行的「单据」（上传 1 次、1 个 file_token、文件名是退货单）
  assert.equal(gateway.uploads.length, 1, '有落点 ⇒ 附件素材要真的上传一次');
  assert.match(path.basename(gateway.uploads[0]), /-退货单\.png$/);
  assert.deepEqual(batches[0].fields['单据'].map((item) => item.file_token), ['file_token_1']);
  // 图照常发到采购群（既有行为不变）
  assert.equal(ctx.images.calls.length, 1);
  assert.equal(ctx.images.calls[0].title, RETURN_TITLE);
  assert.ok(ctx.messages.some((message) => message.data?.msg_type === 'image'));
});

// ═══════════════════════════════════════════════════════════════════════════
// A4 + C1 + E1：报货行仍写「未到货」· 退货行不进 9 点推送候选 · 两个号不同（并集计数）
// ═══════════════════════════════════════════════════════════════════════════

test('A4/C1/E1 报货行写「未到货」· 退货行不进 9 点推送候选 · 退货与报货不会拿到同一个号', async () => {
  const gateway = makeGateway({
    purchaseReport: [
      returnRecord('rep_ret', { 数量: 1 }),
      reportRecord('rep_apply'),
    ],
    liveInventory: [liveRow('live_36', '门盒', 36)],
    behavior: BEHAVIORS,
    supplier: SUPPLIERS,
    purchaseRequest: [],
    purchaseOrderBatch: [],
  });
  const ctx = makeService({ gateway, products: { prod_1: productFields('8088', '黑色') } });

  await acceptAndSettle(ctx, 'rep_ret');
  await acceptAndSettle(ctx, 'rep_apply');
  await waitFor('两行「报货批次」都建好', async () => batchRowsOf(gateway).length === 2);

  const rows = batchRowsOf(gateway);
  const returnNo = reportFieldsOf(gateway, 'rep_ret')['报货批次号'];
  const applyNo = reportFieldsOf(gateway, 'rep_apply')['报货批次号'];
  assert.notEqual(returnNo, applyNo, '退货与报货不会拿到同一个号（生成器数两张表的并集）');

  const returnRow = rows.find((row) => row.fields['报货批次号'] === returnNo);
  const applyRow = rows.find((row) => row.fields['报货批次号'] === applyNo);
  assert.ok(returnRow && applyRow, '两张单子各自有自己那一行');

  // A4：报货那一行**仍然**写「未到货」（取值来自配置，不是中文字面量）
  assert.equal(applyRow.fields['到货状态'], '未到货', '报货建行时显式写未到货（本次不许带坏）');
  // 退货那一行：空 ⇒ 不进推送
  assert.equal(returnRow.fields['到货状态'], undefined, '退货行的到货状态保持空');

  // C1：9 点推送的候选**只认字面量「未到货」** ⇒ 退货行不许出现
  const pending = new PurchasePendingBatchService({ gateway });
  const candidates = await pending.listPendingBatches();
  assert.deepEqual(candidates.map((item) => item.batchNo), [applyNo],
    '候选里只有报货那一批（未到货）；退货行（状态空）一条都不许进');
});

// ═══════════════════════════════════════════════════════════════════════════
// D：重投 / 重跑 —— 不生成第二个号、不建第二行、不重复上传（同名图 → 跳过）
// ═══════════════════════════════════════════════════════════════════════════

test('D 重投 + 重跑：还是 1 行 / 1 份附件（同名图跳过，连上传都不做）', async () => {
  const gateway = makeGateway({
    purchaseReport: [returnRecord('rep_dup', { 数量: 1 })],
    liveInventory: [liveRow('live_36', '门盒', 36)],
    behavior: BEHAVIORS,
    supplier: SUPPLIERS,
    purchaseRequest: [],
    purchaseOrderBatch: [],
  });
  const ctx = makeService({ gateway, products: { prod_1: productFields('8088', '黑色') } });
  const first = await acceptAndSettle(ctx, 'rep_dup');
  const batchNo = reportFieldsOf(gateway, 'rep_dup')['报货批次号'];
  assert.equal(batchRowsOf(gateway).length, 1);
  assert.equal(gateway.uploads.length, 1);

  // D1 重投：同一条记录再收一次 webhook（飞书重投/双击走的就是这里）
  const second = await ctx.service.accept('supplier-report', 'rep_dup');
  assert.equal(second.taskId, first.taskId);
  assert.equal(second.duplicate, true);
  assert.equal(reportFieldsOf(gateway, 'rep_dup')['报货批次号'], batchNo, '重投不许换号');
  assert.equal(batchRowsOf(gateway).length, 1, '重投不许建第二行');
  assert.equal(gateway.uploads.length, 1, '重投连素材都不该再传一次');

  // D2 重跑：把处理状态与任务状态都改回"没处理"，再跑一遍（最坏情况）
  await gateway.updateRaw('purchaseReport', 'rep_dup', { 处理状态: '待解析' });
  await ctx.store.update(first.taskId, { status: 'processing', result: undefined });
  await ctx.service.process('supplier-report', 'rep_dup', first.taskId);
  await waitForTaskSettled(ctx.store, first.taskId);

  assert.equal(reportFieldsOf(gateway, 'rep_dup')['报货批次号'], batchNo, '重跑不许换号');
  assert.equal(batchRowsOf(gateway).length, 1, '重跑不许建第二行（同一批次号只有一行）');
  assert.equal(batchRowsOf(gateway)[0].fields['单据'].length, 1, '同名图跳过：单据里还是一条');
  assert.equal(gateway.uploads.length, 1, '同名图 → 连上传都不做（既有语义不变）');
});

// ═══════════════════════════════════════════════════════════════════════════
// B2：一批多供应商 → 两张图都在同一行的「单据」里（已有附件带上再追加）
// ═══════════════════════════════════════════════════════════════════════════

test('B2 一批两个供应商的退货：两张退货单都写进**同一行**的「单据」（已有附件带上再追加）', async () => {
  const gateway = makeGateway({
    purchaseReport: [
      returnRecord('rep_a', { 数量: 1, 编号: ['prod_a'] }),
      returnRecord('rep_b', { 数量: 1, 编号: ['prod_b'] }),
    ],
    liveInventory: [liveRow('live_a_36', '门盒', 36, 'prod_a'), liveRow('live_b_36', '门盒', 36, 'prod_b')],
    behavior: BEHAVIORS,
    supplier: SUPPLIERS,
    purchaseRequest: [],
    purchaseOrderBatch: [],
  });
  const ctx = makeService({
    gateway,
    products: {
      prod_a: productFields('8088', '黑色', 'sup_A'),
      prod_b: productFields('9090', '白色', 'sup_B'),
    },
  });
  // 一次表单提交（同一包）→ 一个号、一个退货批次
  const accepted = await ctx.service.acceptMany('supplier-report', ['rep_a', 'rep_b']);
  // ⚠️ 判据必须是**整批跑完**，不能只看「处理状态 = 已生成申请」：
  //    那个状态是在 `applySupplierReturn` 里**逐条**写的，而两张图是在**整批**写完之后
  //    才由 `deliverReturnImages` 渲染/发群/回填附件的 —— 只等状态会**抢在出图之前**断言
  //    （CI 上真的红过一次：`images.calls.length` 读到 1）。这里等整批任务落定 +
  //    附件回填到位（这两件事都在出图之后）。
  await waitFor('两条退货整批跑完（任务落定 + 两张图都回填）', async () => {
    const tasks = await Promise.all(accepted.records.map((item) => ctx.store.get(item.taskId)));
    const settled = tasks.every((task) => task && !['queued', 'processing', 'batch_waiting'].includes(task.status));
    return settled && (batchRowsOf(gateway)[0]?.fields['单据'] || []).length === 2;
  });

  const batches = batchRowsOf(gateway);
  assert.equal(batches.length, 1, '同一包 = 一个批次 = 一行');
  assert.equal(reportFieldsOf(gateway, 'rep_a')['报货批次号'], reportFieldsOf(gateway, 'rep_b')['报货批次号']);
  assert.equal(ctx.images.calls.length, 2, '两个供应商 → 两张图');
  assert.equal(gateway.uploads.length, 2, '两张图各上传一次');
  assert.equal(batches[0].fields['单据'].length, 2,
    '两张图都在同一行的「单据」里（写第二张时把已有的那张带上，不许冲掉）');
  assert.equal(Object.prototype.hasOwnProperty.call(batches[0].fields, '到货状态'), false,
    '多供应商也不许顺手写「到货状态」');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑦ 同一批次号**已经有一行**（同一包里的"采购申请"那半边先建过）→ 复用，不建第二行
// ═══════════════════════════════════════════════════════════════════════════

test('⑦ 同一个批次号已经有一行（混着采购申请的那一包）：退货复用那一行，不建第二行、不改它的到货状态', async () => {
  const gateway = makeGateway({
    purchaseReport: [returnRecord('rep_shared', { 数量: 1, 报货批次号: 'BATCH-SHARED' })],
    liveInventory: [liveRow('live_36', '门盒', 36)],
    behavior: BEHAVIORS,
    supplier: SUPPLIERS,
    purchaseRequest: [],
    purchaseOrderBatch: [
      // = 同一包里"采购申请"那半边已经建好的那一行（幂等键是它自己那一套）
      { record_id: 'bat_report', fields: { 报货批次号: 'BATCH-SHARED', 幂等键: 'purchase_batch:task_of_request', 到货状态: '未到货' } },
    ],
  });
  const ctx = makeService({ gateway, products: { prod_1: productFields('8088', '黑色') } });
  const taskId = 'task_rep_shared';
  await ctx.store.create({ task_id: taskId, kind: 'supplier-report', record_id: 'rep_shared', status: 'queued' });
  await ctx.service.process('supplier-report', 'rep_shared', taskId);
  await waitFor('退货单写进那一行的「单据」', async () => (batchRowsOf(gateway)[0]?.fields['单据'] || []).length === 1);

  const batches = batchRowsOf(gateway);
  assert.equal(batches.length, 1, '一个批次号只有一行（复用采购申请那半边建的那一行）');
  assert.equal(batches[0].record_id, 'bat_report');
  assert.equal(batches[0].fields['到货状态'], '未到货',
    '退货**不许**改那一行的到货状态（原来是未到货就还是未到货）');
  assert.deepEqual(batches[0].fields['单据'].map((item) => item.file_token), ['file_token_1'],
    '退货单 PNG 落在那一行上');
});

// ═══════════════════════════════════════════════════════════════════════════
// B3：真的没有号（旧数据 / 入口写回失败）→ 既有行为不变：只 warn、不上传
// ═══════════════════════════════════════════════════════════════════════════

test('B3 没有批次号的旧退货数据：不建行、不上传素材，图照常发（既有行为不变）', async () => {
  const gateway = makeGateway({
    purchaseReport: [returnRecord('rep_legacy', { 数量: 1 })],
    liveInventory: [liveRow('live_36', '门盒', 36)],
    behavior: BEHAVIORS,
    supplier: SUPPLIERS,
    purchaseRequest: [],
    purchaseOrderBatch: [],
  });
  const ctx = makeService({ gateway, products: { prod_1: productFields('8088', '黑色') } });
  const taskId = 'task_rep_legacy';
  await ctx.store.create({ task_id: taskId, kind: 'supplier-report', record_id: 'rep_legacy', status: 'queued' });
  // ⚠️ 直接 process（绕过 accept）：模拟"旧数据/入口没写回号"那条单条路径。
  const task = await ctx.service.process('supplier-report', 'rep_legacy', taskId);

  assert.equal(task.status, 'posted', '没有号不挡出单（既有行为）');
  assert.equal(batchRowsOf(gateway).length, 0, '没有号就建不出行（不编一个号）');
  assert.deepEqual(gateway.uploads, [], '没有落点就不白传一次素材（既有行为）');
  assert.equal(ctx.images.calls.length, 1, '图照常发到群里');
});

// ═══════════════════════════════════════════════════════════════════════════
// G：用户可见文案里的旧表名同步成「到货验收」
// ═══════════════════════════════════════════════════════════════════════════

test('G 到货那条链路的用户可见文案：旧表名「采购到货」→「到货验收」', () => {
  const config = resolveArrivalConversationConfig({});
  assert.equal(config.card.failedTitle, '到货验收核对没成功', '卡片失败标题（她点的那张卡上看得见）');
  assert.match(config.replies.arrivalCreateFailed, /^「到货验收」这一行没建成：/);
  assert.equal(config.replies.arrivalCreateFailed.includes('「采购到货」'), false);
});
