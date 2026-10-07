const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const { PurchaseOrderBatchService } = require('../src/services/purchaseOrderBatchService');
const { PurchaseArrivalConversationService } = require('../src/services/purchaseArrivalConversationService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { ARRIVAL_BATCH_KINDS } = require('../src/config/arrivalConversation');
const {
  resolvePurchaseArrivalStatusConfig,
  DEFAULT_PURCHASE_ARRIVAL_STATUS_PENDING,
  DEFAULT_PURCHASE_ARRIVAL_STATUS_ARRIVED,
} = require('../src/config/purchaseArrivalStatus');
const {
  resolvePurchaseAcceptanceConfig,
  DEFAULT_PURCHASE_ACCEPTANCE_CONFIRMED,
} = require('../src/config/purchaseAcceptance');
const { validateV1SchemaScope } = require('../scripts/validate_v1_schema');

// ⭐ 2026-10-07 业务负责人：报货批次这张表现在**主要控制该批次的到货情况**：
//   ① 每创建一条新记录时，默认值是「未到货」；
//   ② 用户在话题群里说了到货（到货核对**确认成功**）之后，状态改成「已到货」。
// 验收标准里对应 ⑦ / ⑧ / D4（值域不写死中文、部署闸门对着真表字段元数据核对）。

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';
process.env.PURCHASE_CHAT_ID = process.env.PURCHASE_CHAT_ID || 'oc_test_purchase_group';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-arrival-status-'));
const table = (key) => V1_BITABLE_SCHEMA.tables[key];
const BATCH_NO = 'CGD-20261007-0007';
const BATCH_RECORD_ID = 'bat_1';
const sizeLink = (size) => [`size_${size}`];

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
  const writes = [];
  return {
    writes,
    table,
    get: async (tableKey, recordId) => (records[tableKey] || []).find((r) => r.record_id === recordId) || null,
    listAll: async (tableKey) => {
      if (tableKey === 'sizeManagement') return [{ record_id: 'size_38', fields: { 尺码: 38 } }];
      if (tableKey === 'behavior') return [];
      return records[tableKey] || [];
    },
    create: async (tableKey, semanticValues) => {
      const fields = mapFields(tableKey, semanticValues);
      writes.push({ tableKey, op: 'create', fields });
      const record = { record_id: `new_${tableKey}_${(records[tableKey] || []).length + 1}`, fields };
      (records[tableKey] ||= []).push(record);
      return { recordId: record.record_id, record };
    },
    update: async (tableKey, recordId, semanticValues) => {
      const patch = mapFields(tableKey, semanticValues);
      writes.push({ tableKey, op: 'update', recordId, fields: patch });
      const record = (records[tableKey] || []).find((r) => r.record_id === recordId);
      if (record) record.fields = { ...record.fields, ...patch };
      return record || { record_id: recordId };
    },
    uploadAttachment: async () => 'file_token_1',
  };
};

// ── ⑦ 新建「报货批次」记录 = 未到货 ─────────────────────────────────────────────

test('⑦ 新建「报货批次」记录时显式写「未到货」（值来自配置，不是中文字面量）', async () => {
  const gateway = makeGateway({
    purchaseReport: [{
      record_id: 'rep_1',
      fields: {
        处理状态: '待解析', 采购行为: ['beh_1'], 经办人: [{ id: 'ou_1' }],
        编号: ['prod_1'], 尺码: sizeLink(38), 数量说明: '38码2双',
      },
    }],
    purchaseOrderBatch: [],
    purchaseRequest: [],
  });
  const service = new PurchaseWebhookService({
    gateway,
    store: new JsonTaskStore({ dir: tempDir() }),
    references: {
      resolveProduct: async () => ({ recordId: 'prod_1', record: { record_id: 'prod_1', fields: { 编号: '8088黑', 供应商: ['sup_1'] } } }),
      resolveSupplier: async () => ({ recordId: 'sup_1', record: { record_id: 'sup_1', fields: { 供应商名称: '金猴' } } }),
    },
    recognizer: { parsePurchaseReportText: async () => [{ size: 38, quantity: 2 }] },
    inventory: { applyPurchase: async () => ({}) },
    client: {
      im: {
        image: { create: async () => ({ image_key: 'k' }) },
        message: { create: async () => ({ code: 0 }), reply: async () => ({ code: 0 }) },
      },
    },
    images: { render: async () => Buffer.from('png') },
    batchReadMaxRetries: 1,
    batchReadRetryDelay: 0,
    reportBatchWindowMs: 20,
  });
  await service.acceptMany('supplier-report', ['rep_1']);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const batches = await gateway.listAll('purchaseOrderBatch');
  assert.equal(batches.length, 1);
  assert.equal(batches[0].fields['到货状态'], DEFAULT_PURCHASE_ARRIVAL_STATUS_PENDING);
  assert.equal(batches[0].fields['到货状态'], '未到货');
  // ⚠️ 「采购行为」她明确说不用管 ⇒ 一个字都不许写
  assert.equal(Object.prototype.hasOwnProperty.call(batches[0].fields, '采购行为'), false);
});

test('⑦ 值域来自配置：换一套字面量，写进去的就是那一套（证明没写死中文）', async () => {
  const settings = resolvePurchaseArrivalStatusConfig({
    PURCHASE_ARRIVAL_STATUS_PENDING: 'PENDING-X',
    PURCHASE_ARRIVAL_STATUS_ARRIVED: 'ARRIVED-X',
  });
  const gateway = makeGateway({ purchaseOrderBatch: [], purchaseReport: [] });
  await gateway.create('purchaseOrderBatch', {
    batchNo: BATCH_NO, idempotencyKey: 'k1', arrivalStatus: settings.pending,
  });
  assert.equal((await gateway.listAll('purchaseOrderBatch'))[0].fields['到货状态'], 'PENDING-X');
});

test('⑦ 配置写错当场抛错（空串 / 两个取值相同）', () => {
  assert.throws(() => resolvePurchaseArrivalStatusConfig({ PURCHASE_ARRIVAL_STATUS_PENDING: ' ' }), /不能是空串/);
  assert.throws(() => resolvePurchaseArrivalStatusConfig({ PURCHASE_ARRIVAL_STATUS_ARRIVED: '' }), /不能是空串/);
  assert.throws(() => resolvePurchaseArrivalStatusConfig({
    PURCHASE_ARRIVAL_STATUS_PENDING: 'X', PURCHASE_ARRIVAL_STATUS_ARRIVED: 'X',
  }), /不能是同一个取值/);
  const defaults = resolvePurchaseArrivalStatusConfig({});
  assert.equal(defaults.pending, DEFAULT_PURCHASE_ARRIVAL_STATUS_PENDING);
  assert.equal(defaults.arrived, DEFAULT_PURCHASE_ARRIVAL_STATUS_ARRIVED);
});

// ── ⑧ 到货核对确认成功 → 已到货 ────────────────────────────────────────────────

const makeArrivalHarness = (options = {}) => {
  const records = {
    purchaseOrderBatch: [{
      record_id: BATCH_RECORD_ID,
      fields: { 报货批次号: BATCH_NO, 幂等键: 'k1', 到货状态: DEFAULT_PURCHASE_ARRIVAL_STATUS_PENDING },
    }],
    purchaseRequest: [
      { record_id: 'req_38', fields: { 报货批次号: [BATCH_RECORD_ID], 编号: ['prod_1'], 尺码: sizeLink(38), 数量: 2 } },
    ],
    // ⚠️ 这里**故意没有** `purchaseArrival`：那张表已被业务负责人整个删除。
    purchaseInbound: [],
    ...(options.records || {}),
  };
  const gateway = makeGateway(records);
  const store = new JsonTaskStore({ dir: tempDir() });
  const invocations = [];
  const orderBatches = new PurchaseOrderBatchService({
    gateway,
    settings: resolvePurchaseArrivalStatusConfig({}),
  });
  const markBatchArrived = options.markBatchArrived || (async (batchNo, opts) => {
    invocations.push({ batchNo, opts });
    return orderBatches.markArrived(batchNo, opts);
  });
  const service = new PurchaseArrivalConversationService({
    gateway,
    store,
    recognizer: { parseArrivalReconcile: async () => ({ complete: true, same: true, differences: [] }) },
    sizeReferences: { resolveByNumber: async (size) => ({ recordId: `size_${size}`, size }) },
    confirmArrival: options.confirmArrival || (async (taskId, task) => {
      await store.update(taskId, { status: 'posted' });
      return { toast: { type: 'success', content: 'ok' } };
    }),
    markBatchArrived,
    replyText: async () => 'om_reply',
    replyCard: async () => 'om_card',
    updateCard: async () => true,
    config: { enabled: true },
  });
  return { gateway, records, store, service, invocations, orderBatches, markBatchArrived };
};

const seedConfirmedTask = async (store, overrides = {}) => {
  const taskId = 'arrival_reconcile_test';
  await store.create({
    task_id: taskId,
    batch_no: BATCH_NO,
    batch_kind: ARRIVAL_BATCH_KINDS.PURCHASE_REQUEST,
    status: 'awaiting_confirmation',
    acceptance_text: '都到了',
    request_ids: ['req_38'],
    request_rows: [{ record_id: 'req_38', item_no: '8088', color: '黑', size: 38, quantity: 2 }],
    plan: [{ product_record_id: 'prod_1', item_no: '8088', color: '黑', size: 38, quantity: 2, actual: 2 }],
    ...overrides,
  });
  return taskId;
};

test('⑧ 点「是」入库成功之后 → 「报货批次」那一行的到货状态改成「已到货」', async () => {
  const harness = makeArrivalHarness();
  const taskId = await seedConfirmedTask(harness.store);
  await harness.service.handleCardAction(
    { action: 'confirm_arrival_reconcile', draft_id: taskId }, {}, 'ou_1',
  );
  assert.equal(harness.invocations.length, 1, '确认成功之后必须叫一次"这一批到货了"');
  assert.equal(harness.invocations[0].batchNo, BATCH_NO, '交给它的是这一批的批次号');
  // 真的写进了「报货批次」那一行（不是"看起来写了"）
  const batch = await harness.gateway.get('purchaseOrderBatch', BATCH_RECORD_ID);
  assert.equal(batch.fields['到货状态'], '已到货');
  const task = await harness.store.get(taskId);
  assert.equal(task.status, 'posted');
});

test('⑧ 退货批次 / 认不出是哪一批：不写任何到货状态（不猜）', async () => {
  const harness = makeArrivalHarness();
  // 任务上没有批次号（理论上的旧数据）→ 直接跳过，不写任何表
  const taskId = await seedConfirmedTask(harness.store, { batch_no: '' });
  const before = harness.gateway.writes.length;
  await harness.service.handleCardAction(
    { action: 'confirm_arrival_reconcile', draft_id: taskId }, {}, 'ou_1',
  );
  assert.equal(harness.invocations.length, 0, '没有批次号 → 一次都不叫（不猜是哪一批）');
  assert.equal(harness.gateway.writes.filter((item) => item.tableKey === 'purchaseOrderBatch').length, 0);
  assert.ok(harness.gateway.writes.length >= before);
});

test('⑧ 写「已到货」失败**不阻塞**：入库已经成功，任务照旧 posted', async () => {
  const harness = makeArrivalHarness({
    markBatchArrived: async () => { throw new Error('模拟：写批次行失败'); },
  });
  const taskId = await seedConfirmedTask(harness.store);
  const result = await harness.service.handleCardAction(
    { action: 'confirm_arrival_reconcile', draft_id: taskId }, {}, 'ou_1',
  );
  const task = await harness.store.get(taskId);
  assert.equal(task.status, 'posted', '入库事实已经落地；批次状态写不回去不能把这一单判失败');
  assert.ok(result !== undefined);
});

test('⑧ 点「否」（不入库）→ 到货状态不动，仍然是「未到货」', async () => {
  const harness = makeArrivalHarness();
  const taskId = await seedConfirmedTask(harness.store);
  await harness.service.handleCardAction(
    { action: 'reject_arrival_reconcile', draft_id: taskId }, {}, 'ou_1',
  );
  assert.equal(harness.invocations.length, 0);
  const batch = await harness.gateway.get('purchaseOrderBatch', BATCH_RECORD_ID);
  assert.equal(batch.fields['到货状态'], '未到货');
});

test('⑧ 按批次号定位那一行：找不到就只 warn，不抛（写不进去不阻塞）', async () => {
  const gateway = makeGateway({ purchaseOrderBatch: [] });
  const orderBatches = new PurchaseOrderBatchService({
    gateway, settings: resolvePurchaseArrivalStatusConfig({}),
  });
  const result = await orderBatches.markArrived('CGD-20261007-9999', { correlation: {} });
  assert.equal(result.updated, false);
  assert.equal(result.reason, 'no_batch_record');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ 2026-10-07 晚：到货信息的落点也搬到「报货批次」那一行
//    「验收原话」（入库之前写）＋「确认状态」（入库成功之后写）
// ═══════════════════════════════════════════════════════════════════════════

test('⭐ writeAcceptance：按**批次 record id** 写「验收原话」（拿不到 id 时按批次号回查）', async () => {
  const records = { purchaseOrderBatch: [{ record_id: BATCH_RECORD_ID, fields: { 报货批次号: BATCH_NO } }] };
  const gateway = makeGateway(records);
  const service = new PurchaseOrderBatchService({ gateway, settings: resolvePurchaseArrivalStatusConfig({}) });

  // ① 有 record id：直接用（零额外请求）
  const byId = await service.writeAcceptance({
    batchNo: BATCH_NO, batchRecordId: BATCH_RECORD_ID, acceptanceText: '38 码少一双', correlation: {},
  });
  assert.equal(byId.updated, true);
  assert.equal(byId.matched_by, 'record_id');
  assert.equal((await gateway.get('purchaseOrderBatch', BATCH_RECORD_ID)).fields['验收原话'], '38 码少一双');

  // ② 只有批次号：整表回查定位
  const byNo = await service.writeAcceptance({
    batchNo: BATCH_NO, batchRecordId: '', acceptanceText: '都到了', correlation: {},
  });
  assert.equal(byNo.updated, true);
  assert.equal(byNo.matched_by, 'batch_no');
  assert.equal((await gateway.get('purchaseOrderBatch', BATCH_RECORD_ID)).fields['验收原话'], '都到了');

  // ③ 两个都没有 = 孤儿调用：如实说 no_batch_identity（调用方决定不阻塞）
  const orphan = await service.writeAcceptance({ acceptanceText: 'x', correlation: {} });
  assert.equal(orphan.updated, false);
  assert.equal(orphan.reason, 'no_batch_identity');

  // ④ 有身份但找不到那一行：no_batch_record（调用方会报给她）
  const missing = await service.writeAcceptance({
    batchNo: 'CGD-20261007-9999', batchRecordId: '', acceptanceText: 'x', correlation: {},
  });
  assert.equal(missing.updated, false);
  assert.equal(missing.reason, 'no_batch_record');
});

test('⭐ markConfirmed：入库成功之后按**批次 record id** 写「确认状态」，取值来自配置', async () => {
  const records = { purchaseOrderBatch: [{ record_id: BATCH_RECORD_ID, fields: { 报货批次号: BATCH_NO } }] };
  const gateway = makeGateway(records);
  const service = new PurchaseOrderBatchService({ gateway, settings: resolvePurchaseArrivalStatusConfig({}) });

  const done = await service.markConfirmed({ batchNo: BATCH_NO, batchRecordId: BATCH_RECORD_ID, correlation: {} });
  assert.equal(done.updated, true);
  assert.equal(done.confirm_status, DEFAULT_PURCHASE_ACCEPTANCE_CONFIRMED);
  assert.equal((await gateway.get('purchaseOrderBatch', BATCH_RECORD_ID)).fields['确认状态'], '已确认');
  // ⚠️ 到货日 / 验收人是飞书自动字段 ⇒ 这次写入的载荷里一个字都没有。
  const write = gateway.writes.at(-1);
  assert.deepEqual(Object.keys(write.fields), ['确认状态']);

  const orphan = await service.markConfirmed({ correlation: {} });
  assert.equal(orphan.reason, 'no_batch_identity');
  const missing = await service.markConfirmed({ batchNo: 'CGD-20261007-9999', correlation: {} });
  assert.equal(missing.reason, 'no_batch_record');
});

test('⭐ 确认状态取值可配（证明没写死中文）；空串当场抛错', async () => {
  const custom = new PurchaseOrderBatchService({
    gateway: makeGateway({ purchaseOrderBatch: [{ record_id: BATCH_RECORD_ID, fields: { 报货批次号: BATCH_NO } }] }),
    settings: resolvePurchaseArrivalStatusConfig({}),
    acceptance: resolvePurchaseAcceptanceConfig({ PURCHASE_ACCEPTANCE_CONFIRMED_STATUS: '验收通过-X' }),
  });
  const result = await custom.markConfirmed({ batchNo: BATCH_NO, correlation: {} });
  assert.equal(result.confirm_status, '验收通过-X');

  assert.equal(resolvePurchaseAcceptanceConfig({}).confirmed, DEFAULT_PURCHASE_ACCEPTANCE_CONFIRMED);
  assert.throws(() => resolvePurchaseAcceptanceConfig({ PURCHASE_ACCEPTANCE_CONFIRMED_STATUS: '  ' }), /不能是空串/);
});

// ── 部署闸门：到货状态的**取值**要对着真表字段元数据核对 ────────────────────────

const gatewayForSchemaCheck = (batchFields) => ({
  // 表 ID 全部给成假值：本用例只关心「到货状态」的取值契约，别的校验（尺码关联 /
  // 幂等键 / 字段名）都喂成合格形状，免得它们先报错把结论盖住。
  table: (key) => ({
    tableName: V1_BITABLE_SCHEMA.tables[key]?.tableName || key,
    tableId: `tbl_test_${key}`,
    fields: V1_BITABLE_SCHEMA.tables[key]?.fields || {},
  }),
  validateTables: async (keys) => keys.map((tableKey) => ({ tableKey })),
  listFields: async (key) => {
    if (key === 'purchaseOrderBatch') return batchFields;
    if (key === 'sizeManagement') return [{ field_name: '尺码', type: 2 }];
    const fields = V1_BITABLE_SCHEMA.tables[key]?.fields || {};
    return Object.entries(fields).map(([semantic, fieldName]) => (
      semantic === 'size'
        ? { field_name: fieldName, type: 18, property: { table_id: 'tbl_test_sizeManagement', multiple: false } }
        : { field_name: fieldName, type: 1 }
    ));
  },
  listAll: async (key) => (key === 'behavior' ? [] : []),
});

test('B4 闸门：真表「到货状态」缺了「已到货」这个选项 → 部署前就判红（拦住"飞书自动新建选项"）', async () => {
  const options = (names) => ({
    field_name: '到货状态',
    type: 3,
    property: { options: names.map((name, index) => ({ id: `opt${index}`, name })) },
  });
  // 绿：两个取值都在
  await validateV1SchemaScope({
    gateway: gatewayForSchemaCheck([{ field_name: '幂等键', type: 1 }, options(['未到货', '已到货'])]),
    scope: 'purchase',
  });
  // 红：少了「已到货」
  await assert.rejects(
    validateV1SchemaScope({
      gateway: gatewayForSchemaCheck([{ field_name: '幂等键', type: 1 }, options(['未到货'])]),
      scope: 'purchase',
    }),
    /缺少选项: 已到货/,
  );
  // 红：干脆不是单选（写进去飞书会按文本处理 / 直接报错）
  await assert.rejects(
    validateV1SchemaScope({
      gateway: gatewayForSchemaCheck([{ field_name: '幂等键', type: 1 }, { field_name: '到货状态', type: 1 }]),
      scope: 'purchase',
    }),
    /必须是单选字段/,
  );
  // 字段不在时**不在这里报错**（存在性由 validateTables 负责，它先跑）——避免重复报同一个问题
  await validateV1SchemaScope({
    gateway: gatewayForSchemaCheck([{ field_name: '幂等键', type: 1 }]),
    scope: 'purchase',
  });
});

// ── 接线：生产入口（larkMvpService）真的把这两个端口连上了 ──────────────────────
// 源码级钉子（本仓既有范式）：单测直接 new 会话 service 时走的是注入桩，
// 真正"生产上谁会调它"只能在这一处接线里看出来。少了它，这个功能在线上是**静默不生效**的。
test('⑧ 接线（源码级）：larkMvpService 把「报货批次」的写回接到到货核对那条链上', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/services/larkMvpService.js'), 'utf8',
  );
  assert.match(source, /markBatchArrived:\s*\(batchNo, options\)\s*=>/, '必须把 markBatchArrived 注入会话 service');
  assert.match(source, /orderBatches\?\.markArrived/, '代理到「报货批次」那个小 service 的 markArrived');
  // 采购服务桩（别的用例注入的 {}）没有 orderBatches → 必须优雅退化成"什么都不做"，不许抛
  assert.match(source, /not_wired/, '没有 orderBatches 时要退化成空实现（注入桩的用例不受影响）');
});
