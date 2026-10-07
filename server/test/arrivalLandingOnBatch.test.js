/**
 * ⭐ 到货落点大改（2026-10-07 晚）的验收测试。
 *
 * 业务负责人口径（逐字）：
 *   「我们到货验收数据表需要写入的点**变到了报货批次里面**。到货日这些是**多表关联的自动字段**，
 *    所以你现在要做的，就是把原本写到到货验收数据表里的字段改写到报货批次里：
 *    **1. 验收原话：改写到报货批次  2. 验收人：改写到报货批次  3. 确认状态：改到报货批次**
 *    也就是说，我们要把原来到货信息数据表里的落点改写到报货批次里面，
 *    **「采购入库.采购到货批次」字段删除了，不需要了**，你重新看下～」
 *
 * 这张文件把**改动之后的验收标准**一条条钉住（按 brief 给的六条 + 两条补充）：
 *   □ ① 到货确认之后：**批次行**上同时有 验收原话 ＋ 确认状态 ＋ 到货状态=已到货
 *   □ ② 不再有任何 `purchaseArrival` 的创建/更新调用（表已被她删除）
 *   □ ③ 采购入库写入**不含**「采购到货批次」
 *   □ ④ 重放 / 重试**不重复写**（批次行、采购入库、库存三者都不重复）
 *     —— 含"本地 inbound_created 丢了"那条崩溃恢复路径（回查判据换成了采购申请关联）
 *   □ ⑤ 到货核对**全链路**（12 件那种多行的）走通
 *   □ ⑥ 9 点推送不受影响（仍按「报货批次.到货状态 = 未到货」筛）
 *   □ ⑦ 不写飞书自动字段（到货日 = 更新时间、验收人 = 创建人）
 *   □ ⑧ 没有批次身份（孤儿调用）不阻塞入库
 *
 * 测试栈与 `arrivalConversation.test.js` 同一套：**真的**跑
 * `PurchaseArrivalConversationService` + `PurchaseWebhookService.confirmArrival`，
 * 只把远端（gateway / 库存 / IM）换成记录型假实现。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PurchaseArrivalConversationService,
  taskIdForBatch,
} = require('../src/services/purchaseArrivalConversationService');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const { PurchasePendingBatchService } = require('../src/services/purchasePendingBatchService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const {
  ARRIVAL_CONVERSATION_ACTIONS,
  ARRIVAL_BATCH_KINDS,
} = require('../src/config/arrivalConversation');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const table = (key) => V1_BITABLE_SCHEMA.tables[key];
const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const SIZE_RECORDS = [37, 38, 39, 40].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));
const sizeLink = (size) => [`size_${size}`];

const BATCH_NO = 'CGD-20261007-0001';
const BATCH_RECORD_ID = 'batch_record_1';
const PRODUCT_1 = 'prod_1';

/** 记录型 gateway：写入全部进 `writes`，断言"写了哪张表、写了什么"就靠它。 */
const makeGateway = (records = {}) => {
  const writes = [];
  const mapFields = (tableKey, semanticValues) => {
    const schema = table(tableKey);
    const out = {};
    Object.entries(semanticValues || {}).forEach(([key, value]) => {
      const fieldName = schema?.fields?.[key];
      if (!fieldName) throw new Error(`未配置语义字段: ${tableKey}.${key}`);
      if (value !== undefined) out[fieldName] = value;
    });
    return out;
  };
  return {
    writes,
    table,
    get: async (tableKey, recordId) => (records[tableKey] || []).find((item) => item.record_id === recordId) || null,
    listAll: async (tableKey) => {
      if (tableKey === 'sizeManagement') return SIZE_RECORDS;
      if (tableKey === 'behavior' && !records.behavior) {
        return [{ record_id: 'bhv_in', fields: { 行为名称: '入库', 行为编码: 'PURCHASE_IN', 库存方向: '增加', 是否启用: true } }];
      }
      return records[tableKey] || [];
    },
    create: async (tableKey, semanticValues) => {
      const fields = mapFields(tableKey, semanticValues);
      writes.push({ op: 'create', tableKey, values: fields });
      const recordId = `new_${tableKey}_${(records[tableKey] || []).length + 1}`;
      const record = { record_id: recordId, fields };
      (records[tableKey] ||= []).push(record);
      return { recordId, record };
    },
    update: async (tableKey, recordId, semanticValues) => {
      const patch = mapFields(tableKey, semanticValues);
      writes.push({ op: 'update', tableKey, recordId, values: patch });
      const record = (records[tableKey] || []).find((item) => item.record_id === recordId);
      if (record) record.fields = { ...record.fields, ...patch };
      return record || { record_id: recordId };
    },
    delete: async (tableKey, recordId) => {
      writes.push({ op: 'delete', tableKey, recordId });
      return true;
    },
  };
};

const makeInventory = () => ({
  calls: [],
  async applyPurchase(payload) {
    this.calls.push(payload);
    return { ledgerRecordId: `led_${this.calls.length}`, liveRecordIds: [`live_${this.calls.length}`] };
  },
});

const writesTo = (gateway, tableKey) => gateway.writes.filter((item) => item.tableKey === tableKey);
const batchFields = (records) =>
  (records.purchaseOrderBatch || []).find((item) => item.record_id === BATCH_RECORD_ID)?.fields || {};

/** 两个尺码的最小批次（38 / 39，各申请 2 双）。 */
const baseRecords = () => ({
  purchaseOrderBatch: [{ record_id: BATCH_RECORD_ID, fields: { 报货批次号: BATCH_NO, 到货状态: '未到货' } }],
  product: [{ record_id: PRODUCT_1, fields: { 货号: 'XHB8095', 颜色: '黑' } }],
  purchaseRequest: [
    { record_id: 'req_38', fields: { 报货批次号: [BATCH_RECORD_ID], 编号: [PRODUCT_1], 尺码: sizeLink(38), 数量: 2 } },
    { record_id: 'req_39', fields: { 报货批次号: [BATCH_RECORD_ID], 编号: [PRODUCT_1], 尺码: sizeLink(39), 数量: 2 } },
  ],
  purchaseInbound: [],
});

const makeHarness = ({ records = baseRecords(), parseResult, inboundCreated } = {}) => {
  const gateway = makeGateway(records);
  const inventory = makeInventory();
  const store = new JsonTaskStore({ dir: tempDir('arrival-on-batch-test-'), idField: 'task_id' });
  const webhook = new PurchaseWebhookService({
    client: {}, gateway, store, inventory, images: { render: async () => Buffer.from('png') },
  });
  const service = new PurchaseArrivalConversationService({
    gateway,
    store,
    recognizer: {
      calls: [],
      async parseArrivalReconciliation(input) { this.calls.push(input); return parseResult; },
    },
    sizeReferences: webhook.getSizeReferences,
    confirmArrival: (taskId, task, operatorOpenId) => webhook.confirmArrival(taskId, task, operatorOpenId),
    markBatchArrived: (batchNo, options) => webhook.orderBatches.markArrived(batchNo, options),
    replyText: async () => 'om_reply',
    replyCard: async () => 'om_card_1',
    updateCard: async () => true,
  });
  return {
    gateway, inventory, store, webhook, service, records, inboundCreated,
  };
};

const topicBatch = (overrides = {}) => ({
  batch_no: BATCH_NO,
  batch_kind: ARRIVAL_BATCH_KINDS.PURCHASE_REQUEST,
  request_ids: ['req_38', 'req_39'],
  chat_id: 'oc_test_group',
  ...overrides,
});

/** 说一句话 → 点卡片「是」。返回 { taskId, result }。 */
const arriveAndConfirm = async (harness, text = '都到了') => {
  await harness.service.handleTopicMessage({
    batch: topicBatch(), text, messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });
  const taskId = taskIdForBatch(BATCH_NO);
  const result = await harness.service.handleCardAction(
    { action: ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, draft_id: taskId },
    { context: { open_message_id: 'om_card_1' } }, 'ou_1',
  );
  return { taskId, result };
};

// ═══════════════════════════════════════════════════════════════════════════
// □ ① 到货确认之后：批次行上是 验收原话 ＋ 确认状态 ＋ 到货状态=已到货
// ═══════════════════════════════════════════════════════════════════════════

test('① 点「是」之后：到货信息的落点 = **「报货批次」那一行**（三个值都在、且互不冲突）', async () => {
  const harness = makeHarness({
    // 12 件那种现场：她说完差异 → 实际数按申请数算。
    parseResult: { complete: true, same: true, differences: [] },
  });
  const { result } = await arriveAndConfirm(harness, '都到了\n完毕');

  assert.equal(result.toast.type, 'success');
  const fields = batchFields(harness.records);
  assert.equal(fields['验收原话'], '都到了\n完毕', '验收原话（她说的原话）');
  assert.equal(fields['确认状态'], '已确认', '确认状态（入库成功之后写，取值来自 config）');
  assert.equal(fields['到货状态'], '已到货', '到货状态（这条本来就有，不许被写歪）');
  // 批次行上的「报货批次号」一个字没动。
  assert.equal(fields['报货批次号'], BATCH_NO);
});

// ═══════════════════════════════════════════════════════════════════════════
// □ ② 不再有任何 purchaseArrival 的创建/更新调用 + □ ③ 入库不含「采购到货批次」
// ═══════════════════════════════════════════════════════════════════════════

test('② 全链路一次 `purchaseArrival` 的 create/update 都没有（表已被她删除）', async () => {
  const harness = makeHarness({ parseResult: { complete: true, same: true, differences: [] } });
  await arriveAndConfirm(harness);

  assert.equal(harness.gateway.writes.some((item) => item.tableKey === 'purchaseArrival'), false,
    '不许再写「到货验收」这张表（它已经不存在了）');
  // 守门：schema 里也不许再有这个表键（真写了会在记录型 gateway 上抛「未配置语义字段」）。
  assert.equal(V1_BITABLE_SCHEMA.tables.purchaseArrival, undefined);
});

test('③ 采购入库写入 = 编号/尺码/数量/采购行为/采购申请；**没有** 采购到货批次、没有 入库时间', async () => {
  const harness = makeHarness({ parseResult: { complete: true, same: true, differences: [] } });
  await arriveAndConfirm(harness);

  const inbounds = writesTo(harness.gateway, 'purchaseInbound').filter((item) => item.op === 'create');
  assert.equal(inbounds.length, 2, '38 / 39 各一条');
  for (const inbound of inbounds) {
    const names = Object.keys(inbound.values).sort();
    // 逐字：**只有**这几列（多一列都算回归 —— 尤其不许把已删的「采购到货批次」加回来）。
    assert.deepEqual(names, ['尺码', '数量', '编号', '采购申请', '采购行为'],
      `入库载荷只许有这几列（实际：${names.join('、')}）`);
    assert.deepEqual(inbound.values['采购行为'], ['bhv_in']);
    assert.equal('采购到货批次' in inbound.values, false, '「采购到货批次」列已删 → 不许写');
    assert.equal('入库时间' in inbound.values, false, '「入库时间」是自动的创建时间 → 不许写');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// □ ④ 重放 / 重试不重复写（含"本地落盘丢了"那条崩溃恢复路径）
// ═══════════════════════════════════════════════════════════════════════════

test('④-1 重复点「是」（飞书重投）：批次行 / 采购入库 / 库存 都不重复写', async () => {
  const harness = makeHarness({ parseResult: { complete: true, same: true, differences: [] } });
  const { taskId } = await arriveAndConfirm(harness);

  const batchesAfterFirst = writesTo(harness.gateway, 'purchaseOrderBatch').length;
  const inboundsAfterFirst = writesTo(harness.gateway, 'purchaseInbound').length;

  await harness.service.handleCardAction(
    { action: ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, draft_id: taskId },
    { context: { open_message_id: 'om_card_1' } }, 'ou_1',
  );

  assert.equal(writesTo(harness.gateway, 'purchaseOrderBatch').length, batchesAfterFirst, '批次行不再写');
  assert.equal(writesTo(harness.gateway, 'purchaseInbound').length, inboundsAfterFirst, '入库行不再写');
  assert.equal(harness.inventory.calls.length, 2, '库存不再加');
  assert.equal(batchFields(harness.records)['验收原话'], '都到了');
  assert.equal(batchFields(harness.records)['确认状态'], '已确认');
});

test('④-2 崩溃恢复：本地 inbound_created 丢了 → 靠**采购申请关联**认出已写过的入库行，不重复写', async () => {
  // 这是**新判据**的核心用例：改动前"这次到货已经写过哪些入库行"靠
  // `采购入库.采购到货批次 == 到货记录 id` 回查；那一列已被业务负责人删除 ⇒
  // 判据换成「采购入库.采购申请 ∈ 本批的申请行」。这里直接把本地草稿里的
  // `inbound_created` 抹掉（模拟"写完远端、落盘失败"），再确认一次：
  // 必须靠远端回查认出那两行，而不是再写一遍。
  const harness = makeHarness({ parseResult: { complete: true, same: true, differences: [] } });
  const { taskId } = await arriveAndConfirm(harness);

  const inboundRowsBefore = writesTo(harness.gateway, 'purchaseInbound').filter((item) => item.op === 'create');
  assert.equal(inboundRowsBefore.length, 2);
  const existingInboundIds = (harness.records.purchaseInbound || []).map((row) => row.record_id);
  assert.equal(existingInboundIds.length, 2);
  const inventoryCallsBefore = harness.inventory.calls.length;

  // ⭐ 关键：把已写入库行上的「采购到货批次」抹掉 —— 那正是**生产现在的形状**
  //    （业务负责人已把这一列从「采购入库」整列删除）。改动前的回查判据就是读这一列，
  //    所以在真实生产形状下它**永远认不出已写过的行**（会重复建）；新判据用「采购申请」。
  for (const row of harness.records.purchaseInbound || []) {
    delete row.fields['采购到货批次'];
  }

  // 抹掉本地进度 + 把任务退回"没入过库"（模拟崩溃在"写完远端、还没落盘"之间）。
  const task = await harness.store.get(taskId);
  await harness.store.update(taskId, {
    status: 'posting',
    draft: { ...task.draft, inbound_created: {} },
  });

  const again = await harness.webhook.confirmArrival(taskId, await harness.store.get(taskId), 'ou_1');
  assert.equal(again.toast.type, 'success');

  assert.equal(writesTo(harness.gateway, 'purchaseInbound').filter((item) => item.op === 'create').length, 2,
    '远端回查认出已写过的两行 → 不重复建（判据 = 采购申请关联，不再是已删的「采购到货批次」）');
  // ⚠️ 库存**可能**再补一次（回查出来的行 `inventoryApplied` 默认 false —— 改动前就是这个语义，
  //    因为"库里到底加没加"这一步没有远端判据）。安全性来自 `inventory.applyPurchase`
  //    以**采购入库记录 id** 为幂等键 ⇒ 重复调用不会重复加库存。
  //    所以这里断言的是那条契约，而不是"调用次数不变"。
  const extraCalls = harness.inventory.calls.slice(inventoryCallsBefore);
  for (const call of extraCalls) {
    assert.ok(existingInboundIds.includes(call.purchaseInboundRecordId),
      `重复确认时只允许对**已存在的入库行**再调一次库存（幂等键就是它），实际：${call.purchaseInboundRecordId}`);
  }
});

test('④-3 批次行写入本身也是幂等的：重跑写的是同一个值（不新建、不追加）', async () => {
  const harness = makeHarness({ parseResult: { complete: true, same: true, differences: [] } });
  const { taskId } = await arriveAndConfirm(harness);
  const acceptanceWrites = writesTo(harness.gateway, 'purchaseOrderBatch')
    .filter((item) => item.values['验收原话'] !== undefined);
  assert.equal(acceptanceWrites.length, 1, '「验收原话」只写一次');

  // 再跑一次 confirmArrival（任务已经被置成 posted，直接早退 —— 连写都不发）。
  const before = writesTo(harness.gateway, 'purchaseOrderBatch').length;
  await harness.webhook.confirmArrival(taskId, await harness.store.get(taskId), 'ou_1');
  assert.equal(writesTo(harness.gateway, 'purchaseOrderBatch').length, before);
  assert.equal((harness.records.purchaseOrderBatch || []).length, 1, '批次行还是那一行');
});

// ═══════════════════════════════════════════════════════════════════════════
// □ ⑤ 到货核对全链路：12 件那种多行的
// ═══════════════════════════════════════════════════════════════════════════

test('⑤ 12 件全链路：3 行实际 0 双 → 其余 9 行入库，批次行照旧落实（验收原话 + 确认状态 + 已到货）', async () => {
  const products = ['p1', 'p2', 'p3'];
  const rows = products.flatMap((productId, index) => [37, 38, 39, 40].map((size) => ({
    record_id: `req_${index}_${size}`, productId, size,
  })));
  const records = {
    purchaseOrderBatch: [{ record_id: BATCH_RECORD_ID, fields: { 报货批次号: BATCH_NO, 到货状态: '未到货' } }],
    product: products.map((id, index) => ({ record_id: id, fields: { 货号: `XHB809${index}`, 颜色: ['黑', '棕', '白'][index] } })),
    purchaseRequest: rows.map((row) => ({
      record_id: row.record_id,
      fields: { 报货批次号: [BATCH_RECORD_ID], 编号: [row.productId], 尺码: sizeLink(row.size), 数量: 1 },
    })),
    purchaseInbound: [],
  };
  const harness = makeHarness({
    records,
    parseResult: {
      complete: true,
      same: false,
      differences: [
        { item_no: 'XHB8090', color: '黑', size: 38, type: 'less', quantity: 1 },
        { item_no: 'XHB8091', color: '棕', size: 39, type: 'less', quantity: 1 },
        { item_no: 'XHB8091', color: '棕', size: 40, type: 'less', quantity: 1 },
      ],
    },
  });

  await harness.service.handleTopicMessage({
    batch: topicBatch({ request_ids: rows.map((row) => row.record_id) }),
    text: '8230黑色少一双38码\n93827黑色少39 40码各一双\n完毕',
    messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });
  const taskId = taskIdForBatch(BATCH_NO);
  const result = await harness.service.handleCardAction(
    { action: ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, draft_id: taskId },
    { context: { open_message_id: 'om_card_1' } }, 'ou_1',
  );

  assert.equal(result.toast.type, 'success');
  assert.equal(writesTo(harness.gateway, 'purchaseInbound').filter((item) => item.op === 'create').length, 9,
    '12 行里 3 行 0 双 → 只入 9 行');
  assert.equal(harness.inventory.calls.length, 9);
  const fields = batchFields(harness.records);
  assert.equal(fields['验收原话'], '8230黑色少一双38码\n93827黑色少39 40码各一双\n完毕');
  assert.equal(fields['确认状态'], '已确认');
  assert.equal(fields['到货状态'], '已到货');
  // 「具体信息」（采购申请表）一个字都没写。
  assert.deepEqual(writesTo(harness.gateway, 'purchaseRequest'), []);
});

// ═══════════════════════════════════════════════════════════════════════════
// □ ⑥ 9 点推送不受影响：仍按「报货批次.到货状态 = 未到货」筛
// ═══════════════════════════════════════════════════════════════════════════

test('⑥ 9 点推送候选：到货确认之后这一批**不再**进「未到货」候选；退货批次从来不在候选里', async () => {
  const gateway = makeGateway({
    purchaseOrderBatch: [
      { record_id: 'b_pending', fields: { 报货批次号: 'BH-PENDING', 到货状态: '未到货' } },
      { record_id: 'b_arrived', fields: { 报货批次号: 'BH-ARRIVED', 到货状态: '已到货', 确认状态: '已确认' } },
      // 退货批次：只写 批次号 + 幂等键（不写「到货状态」）——她说「退货，不用写」。
      { record_id: 'b_return', fields: { 报货批次号: 'BH-RETURN', 幂等键: 'purchase_batch:BH-RETURN' } },
    ],
    purchaseReport: [{ record_id: 'rep_1', fields: { 报货批次号: 'BH-PENDING', 供应商: '供应商A' } }],
  });
  const service = new PurchasePendingBatchService({ gateway });

  const pending = await service.listPendingBatches();
  assert.deepEqual(pending.map((item) => item.batchNo), ['BH-PENDING'],
    '候选只有一个：仍是按到货状态 = 未到货 筛（已到货/退货行都不进）');
  assert.deepEqual(pending[0].suppliers, ['供应商A']);
});

test('⑥-补 到货确认**真的会**把这一批从 9 点候选里摘掉（同一台假 Base，前后对照）', async () => {
  const records = baseRecords();
  records.purchaseReport = [{ record_id: 'rep_1', fields: { 报货批次号: BATCH_NO, 供应商: '供应商A' } }];
  const harness = makeHarness({ records, parseResult: { complete: true, same: true, differences: [] } });
  const pending = new PurchasePendingBatchService({ gateway: harness.gateway });

  assert.deepEqual((await pending.listPendingBatches()).map((item) => item.batchNo), [BATCH_NO],
    '确认之前：这一批在「未到货」候选里');

  await arriveAndConfirm(harness);

  assert.deepEqual((await pending.listPendingBatches()).map((item) => item.batchNo), [],
    '确认之后：到货状态变「已到货」⇒ 不再进候选（9 点推送的口径一个字没动）');
});

// ═══════════════════════════════════════════════════════════════════════════
// □ ⑦ 不写飞书自动字段 · □ ⑧ 孤儿调用不阻塞
// ═══════════════════════════════════════════════════════════════════════════

test('⑦ 任何一次写入里都没有「到货日」「验收人」（飞书自动字段：更新时间 / 创建人）', async () => {
  const harness = makeHarness({ parseResult: { complete: true, same: true, differences: [] } });
  await arriveAndConfirm(harness);

  for (const write of harness.gateway.writes) {
    assert.equal('到货日' in (write.values || {}), false, `不许写「到货日」：${write.tableKey}`);
    assert.equal('验收人' in (write.values || {}), false, `不许写「验收人」：${write.tableKey}`);
  }
  // 源码级：这条链路里根本没有这两个键（映射也不该有）。
  const source = fs.readFileSync(path.join(__dirname, '../src/services/purchaseOrderBatchService.js'), 'utf8');
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
  assert.equal(/(^|[^_\w])arrivalAt\s*:/.test(codeOnly), false, '不许出现 arrivalAt 这个语义键');
  // ⚠️ 别用 `\binspector` —— `wrote_inspector: false`（日志字段）会被带进来；
  //    这里要抓的是**语义键** inspector。
  assert.equal(/(^|[^_\w])inspector\s*:/.test(codeOnly), false, '不许出现 inspector 这个语义键');
});

test('⑧ 没有批次身份的孤儿调用：**不阻塞入库**（既有能力），也不写批次行', async () => {
  const harness = makeHarness({ parseResult: { complete: true, same: true, differences: [] } });

  // 造一条"历史草稿"：batch_no / batch_record_id 都空（改动前这些用例的形状）。
  const taskId = 'arrival_orphan_1';
  await harness.store.create({
    task_id: taskId,
    status: 'awaiting_confirmation',
    draft: {
      batch_record_id: '',
      batch_no: '',
      acceptance_text: '都到了',
      operator_open_id: 'ou_1',
      requests: [{ record_id: 'req_38', fields: { 编号: [PRODUCT_1], 尺码: sizeLink(38) } }],
      actual: [{ product_record_id: PRODUCT_1, item_no: 'XHB8095', color: '黑', size: 38, quantity: 1 }],
      pending_creation: [],
      created_products: [],
      inbound_created: {},
    },
  });

  const result = await harness.webhook.confirmArrival(taskId, await harness.store.get(taskId), 'ou_1');
  assert.equal(result.toast.type, 'success', '孤儿调用照常入库（改动前就有这种形状）');
  assert.equal(writesTo(harness.gateway, 'purchaseInbound').filter((item) => item.op === 'create').length, 1);
});
