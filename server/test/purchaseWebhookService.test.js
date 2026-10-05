const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const { V1ReferenceResolver } = require('../src/services/v1ReferenceResolver');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

// 新品的记录链接要用 Base token 拼。本地/CI 没有真配置时给个测试值，
// 才能断言「链接带上了正确的 record_id」。（每个测试文件是独立进程，不会污染别的用例。）
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-test-'));

const table = (key) => V1_BITABLE_SCHEMA.tables[key];

// 「尺码」是指向「尺码管理」的关联字段：写入用关联 ID，读取时解析回整数。
const SIZE_RECORDS = [36, 37].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));
const sizeLink = (size) => [`size_${size}`];
const sizeLinks = (...sizes) => sizes.map((size) => `size_${size}`);

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
  const uploads = [];
  return {
    uploads,
    table,
    get: async (tableKey, recordId) => {
      const list = records[tableKey] || [];
      return list.find((r) => r.record_id === recordId) || null;
    },
    listAll: async (tableKey) => {
      if (tableKey === 'sizeManagement' && !records.sizeManagement) return SIZE_RECORDS;
      if (tableKey === 'behavior' && !records.behavior) {
        return [{ record_id: 'behavior_purchase_in', fields: { '行为名称': '采购入库', '行为编码': 'PURCHASE_IN', '库存方向': '增加', '是否启用': true } }];
      }
      return records[tableKey] || [];
    },
    create: async (tableKey, semanticValues) => {
      const fields = mapFields(tableKey, semanticValues);
      const recordId = `new_${tableKey}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const record = { record_id: recordId, fields };
      (records[tableKey] ||= []).push(record);
      return { recordId, record };
    },
    update: async (tableKey, recordId, semanticValues) => {
      const patch = mapFields(tableKey, semanticValues);
      const list = records[tableKey] || [];
      const record = list.find((r) => r.record_id === recordId);
      if (record) record.fields = { ...record.fields, ...patch };
      return record || { record_id: recordId };
    },
    // 采购申请图写回附件字段时用：飞书是先传素材拿 file_token、再把 token 写进附件字段。
    uploadAttachment: async (filePath) => {
      uploads.push(filePath);
      return `file_token_${uploads.length}`;
    },
  };
};

const makeReferences = (overrides = {}) => ({
  resolveProduct: overrides.resolveProduct || (async () => ({ recordId: 'prod_1', record: { record_id: 'prod_1', fields: { 编号: '8088灰', 供应商: ['sup_1'] } } })),
  resolveSupplier: overrides.resolveSupplier || (async () => ({ recordId: 'sup_1', record: { record_id: 'sup_1', fields: { 供应商名称: '测试供应商' } } })),
});

// ⚠️ 原先这里还有 recognizeLabels / recognizePurchaseDocument 两个假实现（鞋盒 / 到货单识别）。
// 拍照识别链路退场后 service 只剩**文字**解析这一个 recognizer 用途（采购数量说明），
// 所以假实现也只留它。
const makeRecognizer = (overrides = {}) => ({
  parsePurchaseReportText: overrides.parsePurchaseReportText || (async () => [{ size: 36, quantity: 2 }, { size: 37, quantity: 1 }]),
  ...overrides,
});

const makeClient = (overrides = {}) => ({
  im: {
    // 发图要先用 im.image 上传拿 image_key，再发 image 消息。
    image: {
      create: overrides.uploadImage || (async () => ({ image_key: `img_key_${Math.random().toString(36).slice(2, 8)}` })),
    },
    message: {
      create: overrides.sendMessage || (async () => ({ code: 0, msg: 'success' })),
    },
  },
});

// 出图的假实现：记录每个供应商一次的渲染调用，测试就能断言
// 「多供应商出多张」「同供应商合成一张」，而不必在单测里真的跑 sharp。
const makeImages = (options = {}) => {
  const calls = [];
  return {
    calls,
    render: async (input) => {
      calls.push(input);
      if (options.render) return options.render(input);
      return Buffer.from(`fake-png:${input.supplierName || ''}:${(input.items || []).length}`);
    },
  };
};

const makeInventory = (options = {}) => {
  const calls = [];
  const sampleRecords = options.sampleRecords || []; // 模拟样品库存记录
  return {
    calls,
    applyPurchase: async (input) => { calls.push(input); return { stockKey: `${input.productRecordId}|${input.size}`, ledgerRecordId: 'ledger_1', liveRecordIds: ['live_1'], movementQuantity: input.quantity, direction: '增加', quantity: input.quantity }; },
    findLiveInventory: async (productRecordId, size, state) => {
      // 默认返回空数组（表示没有样品库存），测试时可通过 options.sampleRecords 配置
      return sampleRecords;
    },
  };
};

const makeService = (options = {}) => {
  const dir = options.dir || tempDir();
  const store = options.store || new JsonTaskStore({ dir });
  const gateway = options.gateway || makeGateway();
  const references = options.references || makeReferences();
  const recognizer = options.recognizer || makeRecognizer();
  const inventory = options.inventory || makeInventory();
  const client = options.client || makeClient();
  const images = options.images || makeImages();
  const service = new PurchaseWebhookService({
    gateway, references, recognizer, inventory: inventory.applyPurchase ? inventory : undefined,
    client, store, images, enablePurchaseInventory: options.enablePurchaseInventory ?? true,
    batchReadMaxRetries: options.batchReadMaxRetries ?? 1,
    batchReadRetryDelay: options.batchReadRetryDelay ?? 0,
    // 对外调用的超时：undefined 时用服务自己的默认值。
    // ⚠️ 到货识别那一组（mediaTimeoutMs / recognitionTimeoutMs / failureWrite* /
    // arrivalNotice* 四个等待阈值）已随识别链路退场删除，构造入参也不再传。
    imTimeoutMs: options.imTimeoutMs,
    gatewayTimeoutMs: options.gatewayTimeoutMs,
    // 报货「归批窗口」：生产默认 4000ms（读 REPORT_BATCH_WINDOW_MS），
    // 单测里压到 20ms —— 验证的是"同一批次号的记录归成一批、窗口到点才处理"，
    // 而不是真的等 4 秒。需要验证窗口本身的用例会显式传更大的值。
    reportBatchWindowMs: options.reportBatchWindowMs ?? 20,
  });
  return { service, store, gateway, references, recognizer, inventory, client, images, dir };
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// accept() 返回时后台处理并没有结束：它把工作丢进 setImmediate，之后还要解析、
// 写卡片、等批次窗口，耗时取决于机器。固定 sleep 在慢机器上会读到 processing
// 这类中间状态（CI 上就这样失败过），所以统一改为轮询到任务进入稳定状态。
// ⚠️ 原先这里还有 'awaiting_confirmation'（到货识别跑完、等卡片的中间态）。
// 识别链路退场后没有任何一条链路会落到那个状态，所以从"稳定态"里去掉——
// 留着会让等待逻辑把一个永远不会出现的状态当成终点。
const SETTLED_STATUSES = ['failed', 'cancelled', 'posted', 'completed'];
const waitForSettled = async (store, taskIds, expected = ['posted', 'failed', 'completed', 'cancelled']) => {
  let tasks = [];
  await waitFor('任务全部进入终态', async () => {
    tasks = await Promise.all(taskIds.map((id) => store.get(id)));
    return tasks.every((task) => expected.includes(task?.status));
  });
  return tasks;
};

// ⚠️ 批次链路上「status=posted」**不等于**「跑完了」。
//
// confirmPurchaseRequest 写完采购申请后就把任务置成 posted（这是有意的：让重复投递
// 立刻被幂等守卫挡掉，不再发第二遍图），之后还要出图、发图、把附件写回记录，最后才由
// process() 把 result 落盘。所以「处理完了」的唯一可靠判据是**result 已落盘**：
// 只等 status=posted 会在慢机器上读到半成品状态（status 已落盘、result 还没有），
// CI 上就是这样挂的——TypeError: Cannot read properties of undefined (reading 'status')。
// failed 是唯一的例外：它是 process() 的收尾写入，本来就没有 result。
const isProcessed = (task) => Boolean(task) && (task.result !== undefined || task.status === 'failed');

const waitForProcessed = async (store, taskIds) => {
  const ids = Array.isArray(taskIds) ? taskIds : [taskIds];
  let tasks = [];
  await waitFor('任务跑完（终态且 result 已落盘）', async () => {
    tasks = await Promise.all(ids.map((id) => store.get(id)));
    return tasks.every(isProcessed);
  });
  return Array.isArray(taskIds) ? tasks : tasks[0];
};

const waitForTask = async (store, taskId, statuses = SETTLED_STATUSES, { attempts = 1500, pause = 10 } = {}) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const task = await store.get(taskId);
    if (task && statuses.includes(task.status)) return task;
    await wait(pause);
  }
  const last = await store.get(taskId);
  throw new Error(`等待任务进入 ${statuses.join('/')} 超时，当前状态：${last?.status}`);
};

const waitFor = async (label, check, { attempts = 1500, pause = 10 } = {}) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await wait(pause);
  }
  throw new Error(`等待「${label}」超时`);
};

// ─── 报货批次链路的时间等待 ─────────────────────────────────────────────────
//
// 批次什么时候处理，由「报货批次号 + 短窗口」的归批决定（见下面「归批」一节）；
// 这些用例一律用轮询不变量（waitFor / waitForTask / waitForBatchPosted）等待，
// 不用固定 sleep 卡时间。

// ─── 供应商报单链路（免确认 → 按供应商出图 → 发图 → 写回附件）───

// ⚠️ 原先这里还有一个 cardMessages（只数 interactive 卡片消息）：它服务的是到货详情卡片
// 那几条断言。到货卡片与本文件里的卡片断言一起删掉了，helper 也没人用了。
// 留下一句提醒：断言消息条数时先想清楚"这条链路上会发几种消息"，别被提示类消息带偏。
const textMessages = (messages) => messages
  .filter((message) => message.data?.msg_type === 'text')
  .map((message) => JSON.parse(message.data.content).text);

// ─── 供应商报单链路 ───

// 出图要用的货品信息：货号 / 颜色（关联字段会带回被关联记录的主字段文本）/ 编号 / 供应商。
const productFields = (itemNo, color, supplierId) => ({
  货号: itemNo, 颜色: [{ text: color }], 编号: `${itemNo}${color}`, 供应商: [supplierId],
});
const SUPPLIERS = [
  { record_id: 'sup_A', fields: { 供应商名称: '金猴' } },
  { record_id: 'sup_B', fields: { 供应商名称: '奥康' } },
];
const referencesFor = (products) => makeReferences({
  resolveProduct: async ({ productRecordId }) => {
    const fields = products[productRecordId];
    if (!fields) throw new Error(`找不到货品记录：${productRecordId}`);
    return { recordId: productRecordId, record: { record_id: productRecordId, fields } };
  },
});
const reportRecord = (recordId, fields) => ({ record_id: recordId, fields: { 处理状态: '待解析', 采购行为: ['beh_1'], 经办人: [{ id: 'ou_user_1' }], ...fields } });

// 批次真正完成的不变量：这一批的**所有**报单记录都被推到了终态
//（处理状态「已生成申请」是 confirmPurchaseRequest 在最后一步写的）。
// 比"等某个任务的 status"可靠：批次里每条明细各有一个任务，它们都停在等窗口的
// 非终态上，只有窗口到点后统一跑完；靠单个任务的 status 会读到中间态。
const waitForBatchPosted = async (gateway, batchNo) => {
  await waitFor(`批次 ${batchNo} 的记录全部进入「已生成申请」`, async () => {
    const rows = await gateway.listAll('purchaseReport');
    const batch = rows.filter((record) => record.fields['报货批次号'] === batchNo);
    return batch.length > 0 && batch.every((record) => record.fields['处理状态'] === '已生成申请');
  });
};

// 「posted」表示采购申请已经写成，附件写回是它之后的收尾动作（顺序：先发图、再写附件）。
// 所以断言附件不能只等任务状态，要等附件字段真的落到记录上。
const waitForAttachments = async (gateway, expected) => {
  await waitFor('附件写回', async () => {
    const rows = await gateway.listAll('purchaseRequest');
    return rows.filter((record) => (record.fields['采购申请单'] || []).length === 1).length === expected;
  });
};

test('供应商报单免确认：解析完直接生成采购申请、不发确认卡片，并把图发给报单人', async () => {
  const messages = [];
  const { service, store, gateway, images } = makeService({
    client: makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } }),
    gateway: makeGateway({
      purchaseReport: [reportRecord('rep_1', { 尺码: sizeLinks(36, 37), 数量说明: '36码2双，37码1双', 编号: ['prod_1'] })],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
  });
  const result = await service.accept('supplier-report', 'rep_1');
  assert.equal(result.accepted, true);
  assert.equal(result.duplicate, false);
  const task = await waitForTask(store, result.taskId);
  // 免确认：没有「待确认」这个中间态，任务直接 posted
  assert.equal(task.status, 'posted');
  assert.equal(task.draft.items.length, 2);

  // 免确认的红线：整条链路上不能出现任何交互卡片
  assert.equal(messages.filter((m) => m.data.msg_type === 'interactive').length, 0, '免确认后不能再发确认卡片');
  await waitFor('图片和说明发出', async () => messages.length === 2);
  const [image, text] = messages;
  assert.equal(image.data.msg_type, 'image');
  assert.equal(image.data.receive_id, 'ou_user_1');
  assert.equal(text.data.msg_type, 'text');
  assert.equal(JSON.parse(text.data.content).text, '金猴 这批 2 条（共 3 双），图可以直接转给供应商。');

  // 采购申请直接写出，报单记录进入终态
  const requests = await gateway.listAll('purchaseRequest');
  assert.equal(requests.length, 2);
  assert.equal((await gateway.get('purchaseReport', 'rep_1')).fields.处理状态, '已生成申请');

  // 一个供应商 → 一张图，图上的明细带上了货号/颜色/欧码/数量
  assert.equal(images.calls.length, 1);
  assert.equal(images.calls[0].supplierName, '金猴');
  assert.deepEqual(
    images.calls[0].items.map((item) => [item.item_no, item.color, item.size, item.quantity]),
    [['8088', '黑色', 36, 2], ['8088', '黑色', 37, 1]],
  );

  // 图写回「采购申请单」附件；同一批次+同一供应商只写一条
  await waitForAttachments(gateway, 1);
  const withAttachment = (await gateway.listAll('purchaseRequest'))
    .filter((record) => (record.fields['采购申请单'] || []).length === 1);
  assert.equal(withAttachment.length, 1, '同一批次+同一供应商只应写一条附件');
  assert.equal(gateway.uploads.length, 1, '附件上传只应发生一次');
});

test('重收同一条报单 webhook：不重复建单，也不重复发图', async () => {
  const { service, store, gateway, images } = makeService({
    gateway: makeGateway({
      purchaseReport: [reportRecord('rep_dup', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'] })],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 2 }] }),
  });
  const first = await service.accept('supplier-report', 'rep_dup');
  await waitForTask(store, first.taskId);
  const requestsAfterFirst = (await gateway.listAll('purchaseRequest')).length;
  const imagesAfterFirst = images.calls.length;

  const second = await service.accept('supplier-report', 'rep_dup');
  assert.equal(second.duplicate, true);
  assert.equal((await store.get(first.taskId)).status, 'posted');
  assert.equal((await gateway.listAll('purchaseRequest')).length, requestsAfterFirst, '重收 webhook 不得重复建单');
  assert.equal(images.calls.length, imagesAfterFirst, '重收 webhook 不得重复发图');
});

test('多尺码一次报单：每个尺码一条采购申请，尺码与批次都以关联写入', async () => {
  const { service, store, gateway } = makeService({
    gateway: makeGateway({
      purchaseReport: [reportRecord('rep_multi', { 尺码: sizeLinks(36, 37), 数量说明: '36码2双，37码1双', 编号: ['prod_1'] })],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
  });
  const accepted = await service.accept('supplier-report', 'rep_multi');
  const task = await waitForTask(store, accepted.taskId);
  assert.equal(task.draft.items.length, 2);

  const batches = await gateway.listAll('purchaseOrderBatch');
  assert.equal(batches.length, 1);
  assert.ok(batches[0].fields.报货批次号.startsWith('BH-'));
  const requests = await gateway.listAll('purchaseRequest');
  assert.equal(requests.length, 2);
  // 数量说明只描述例外：36 码两双、37 码默认一双。
  const quantityBySize = new Map(requests.map((row) => [row.fields.尺码[0], row.fields.数量]));
  assert.deepEqual([...quantityBySize.entries()].sort(), [['size_36', 2], ['size_37', 1]]);
  for (const request of requests) {
    assert.equal(request.fields.尺码.length, 1);
    assert.ok(String(request.fields.尺码[0]).startsWith('size_'), `尺码应为关联 ID，实际：${request.fields.尺码[0]}`);
    assert.deepEqual(request.fields.报货批次号, [batches[0].record_id]);
  }
});

test('同一个供应商的多条明细合并成一张图', async () => {
  const messages = [];
  const { service, store, gateway, images } = makeService({
    client: makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } }),
    gateway: makeGateway({
      purchaseReport: [
        reportRecord('rep_merge_1', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'], 报货批次号: 'BATCH-MERGE'}),
        reportRecord('rep_merge_2', { 尺码: sizeLink(37), 数量说明: '37码1双', 编号: ['prod_1'], 报货批次号: 'BATCH-MERGE'}),
      ],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async (text) => (text.includes('36') ? [{ size: 36, quantity: 2 }] : [{ size: 37, quantity: 1 }]) }),
  });
  const first = await service.accept('supplier-report', 'rep_merge_1');
  await service.accept('supplier-report', 'rep_merge_2');
  const task = await waitForTask(store, first.taskId, ['posted', 'failed']);
  assert.equal(task.status, 'posted');
  assert.equal(task.draft.items.length, 2);
  // 同一个供应商：只渲染、只发送一次，两条明细都在同一张图上。
  // 附件写回是每个供应商的最后一步，等它落定再断言"没有多出第二张图"。
  await waitForAttachments(gateway, 1);
  assert.equal(images.calls.length, 1, `同一供应商应只出一张图，实际出了 ${images.calls.length} 张`);
  assert.equal(images.calls[0].items.length, 2);
  await waitFor('图片和说明发出', async () => messages.length === 2);
  assert.equal(JSON.parse(messages[1].data.content).text, '金猴 这批 2 条（共 3 双），图可以直接转给供应商。');
});

test('多个供应商：每个供应商各出一张图、各发一条说明', async () => {
  const messages = [];
  const { service, store, gateway, images } = makeService({
    client: makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } }),
    gateway: makeGateway({
      purchaseReport: [
        reportRecord('rep_two_1', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_A'], 报货批次号: 'BATCH-TWO'}),
        reportRecord('rep_two_2', { 尺码: sizeLink(37), 数量说明: '37码1双', 编号: ['prod_B'], 报货批次号: 'BATCH-TWO'}),
      ],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({
      prod_A: productFields('8088', '黑色', 'sup_A'),
      prod_B: productFields('1366', '棕色', 'sup_B'),
    }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async (text) => (text.includes('36') ? [{ size: 36, quantity: 2 }] : [{ size: 37, quantity: 1 }]) }),
  });
  const first = await service.accept('supplier-report', 'rep_two_1');
  await service.accept('supplier-report', 'rep_two_2');
  await waitForTask(store, first.taskId, ['posted', 'failed']);
  // 附件写回是每个供应商的最后一步：两家都写完，才谈得上"一共出了几张图"。
  await waitForAttachments(gateway, 2);

  const bySupplier = new Map(images.calls.map((call) => [call.supplierName, call.items.length]));
  assert.deepEqual([...bySupplier.entries()].sort(), [['奥康', 1], ['金猴', 1]], '每个供应商各一张图，不能混成一张');
  await waitFor('两个供应商的图都发出', async () => messages.length === 4);
  const texts = messages.filter((m) => m.data.msg_type === 'text').map((m) => JSON.parse(m.data.content).text).sort();
  assert.deepEqual(texts, [
    '奥康 这批 1 条（共 1 双），图可以直接转给供应商。',
    '金猴 这批 1 条（共 2 双），图可以直接转给供应商。',
  ]);
  const requests = await gateway.listAll('purchaseRequest');
  assert.equal(requests.filter((record) => (record.fields['采购申请单'] || []).length === 1).length, 2);
});

test('先发图再写表：写附件失败时图仍然发出，任务仍然是 posted', async () => {
  const messages = [];
  const records = {
    purchaseReport: [reportRecord('rep_attach_fail', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'] })],
    purchaseOrderBatch: [],
    purchaseRequest: [],
    supplier: SUPPLIERS,
  };
  const gateway = makeGateway(records);
  const originalUpdate = gateway.update;
  gateway.update = async (tableKey, recordId, values) => {
    if (tableKey === 'purchaseRequest' && values.attachment !== undefined) throw new Error('模拟附件写入失败');
    return originalUpdate(tableKey, recordId, values);
  };
  const { service, store } = makeService({
    client: makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } }),
    gateway,
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 2 }] }),
  });
  const accepted = await service.accept('supplier-report', 'rep_attach_fail');
  const task = await waitForTask(store, accepted.taskId);
  assert.equal(task.status, 'posted', '写附件失败不得把任务判成失败');
  await waitFor('图发出', async () => messages.some((m) => m.data.msg_type === 'image'));
  assert.ok(messages.some((m) => m.data.msg_type === 'image'), '写附件失败不能影响发图');
  assert.ok(messages.some((m) => m.data.msg_type === 'text'), '说明也要发出去');
  const requests = await gateway.listAll('purchaseRequest');
  assert.equal(requests.length, 1, '采购申请本身已经写出，不受附件失败影响');
  assert.ok(requests.every((record) => !(record.fields['采购申请单'] || []).length));
});

test('发图失败（例如机器人缺 im:resource 图片上传权限）不把任务判成失败，采购申请照样写出', async () => {
  // 线上真实踩到过：应用没开通 im:resource:upload，上传图片直接 400 + 99991672。
  // 这种情况绝不能把已经写好的采购事实判成失败。
  const uploadError = new Error('Request failed with status code 400');
  uploadError.response = { data: { code: 99991672, msg: 'Access denied. One of the following scopes is required: [im:resource:upload, im:resource]' } };
  const records = {
    purchaseReport: [reportRecord('rep_upload_fail', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'] })],
    purchaseOrderBatch: [],
    purchaseRequest: [],
    supplier: SUPPLIERS,
  };
  const gateway = makeGateway(records);
  const { service, store } = makeService({
    client: makeClient({ uploadImage: async () => { throw uploadError; } }),
    gateway,
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 2 }] }),
  });
  const accepted = await service.accept('supplier-report', 'rep_upload_fail');
  const task = await waitForTask(store, accepted.taskId);
  assert.equal(task.status, 'posted', '发图失败不得影响采购申请落库');
  assert.equal((await gateway.listAll('purchaseRequest')).length, 1);
  // 图没发出去就不写附件：保持「先发图、再写回」的顺序
  assert.equal(gateway.uploads.length, 0);
  // 失败要留在任务里，运维才知道哪一批图欠着
  await waitFor('发图失败被记录', async () => ((await store.get(accepted.taskId))?.image_delivery?.failed || []).length === 1);
  const recorded = await store.get(accepted.taskId);
  assert.equal(recorded.image_delivery.failed[0].supplier, '金猴');
  assert.ok(recorded.image_delivery.failed[0].error.includes('99991672'), '失败原因要带上飞书错误码');
});

test('图片写回：取「明细ID」最小的那条，重复执行不新增第二条附件', async () => {
  const records = {
    purchaseReport: [reportRecord('rep_min', { 尺码: sizeLinks(36, 37), 数量说明: '36码2双，37码1双', 编号: ['prod_1'] })],
    purchaseOrderBatch: [],
    purchaseRequest: [],
    supplier: SUPPLIERS,
  };
  const gateway = makeGateway(records);
  const originalCreate = gateway.create;
  let autoNumber = 100;
  gateway.create = async (tableKey, values) => {
    const created = await originalCreate(tableKey, values);
    // 「明细ID」是飞书的 auto_number：写入时由表自动发号，按创建顺序递增。
    if (tableKey === 'purchaseRequest') {
      autoNumber += 1;
      created.record.fields['明细ID'] = autoNumber;
    }
    return created;
  };
  const { service, store } = makeService({
    gateway,
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
  });
  const accepted = await service.accept('supplier-report', 'rep_min');
  await waitForTask(store, accepted.taskId);
  await waitForAttachments(gateway, 1);

  const requests = await gateway.listAll('purchaseRequest');
  assert.equal(requests.length, 2);
  const minDetailId = Math.min(...requests.map((record) => record.fields['明细ID']));
  const withAttachment = requests.filter((record) => (record.fields['采购申请单'] || []).length === 1);
  assert.equal(withAttachment.length, 1, '同一批次+同一供应商只写一条附件');
  assert.equal(withAttachment[0].fields['明细ID'], minDetailId, '必须写在明细ID最小的那条采购申请上');
  const uploadsBefore = gateway.uploads.length;

  // 重复执行（重跑批次）：不得写出第二条附件，也不该重复上传
  await service.confirmPurchaseRequest(accepted.taskId, await store.get(accepted.taskId));
  const afterRerun = await gateway.listAll('purchaseRequest');
  assert.equal(afterRerun.filter((record) => (record.fields['采购申请单'] || []).length === 1).length, 1,
    '重跑批次不得新增第二条附件');
  assert.equal(gateway.uploads.length, uploadsBefore, '已经有附件的记录不该再上传一次');
});

test('已 posted 的报单任务再次收到确认卡片动作：不再产生任何写入', async () => {
  const { service, store, gateway } = makeService({
    gateway: makeGateway({
      purchaseReport: [reportRecord('rep_done_card', { 尺码: sizeLink(36), 编号: ['prod_1'] })],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
  });
  const accepted = await service.accept('supplier-report', 'rep_done_card');
  await waitForTask(store, accepted.taskId);
  const snapshot = () => gateway.listAll('purchaseRequest').then((rows) => rows.length);
  const before = await snapshot();
  // 线上已经发出去的老确认卡片仍然点得动，但采购申请已经生成，不能再写一遍
  const result = await service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_request' }, 'ou_user_1');
  assert.ok(result.toast.content.includes('采购申请已生成'));
  const cancel = await service.handleCardAction({ draft_id: accepted.taskId, action: 'cancel_purchase_request' }, 'ou_user_1');
  assert.ok(cancel.toast.content.includes('不能取消'));
  assert.equal(await snapshot(), before);
  assert.equal((await gateway.get('purchaseReport', 'rep_done_card')).fields.处理状态, '已生成申请');
});

test('supplier report without batch number falls back to single processing', async () => {
  const { service, store } = makeService({
    gateway: makeGateway({
      purchaseReport: [reportRecord('rep_nobatch', { 尺码: sizeLink(36), 编号: ['prod_1'] })],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
  });
  const result = await service.accept('supplier-report', 'rep_nobatch');
  const task = await waitForTask(store, result.taskId);
  assert.equal(task.status, 'posted');
  assert.ok(!task.draft.is_batch);
});
// ═══════════════════════════════════════════════════════════════════════════════
// 「采购到货」表的**保留能力**：入库 / 库存 / 建档 / 成本
//
// 2026-10-05 业务负责人删掉了「采购到货」表的「类型」「识别状态」「识别失败原因」，
// 并决定「拍照 → 视觉识别 → 匹配 → 卡片确认 → 入库」这条链路整体退场（改成纯对话驱动）。
// 入口分派也摘掉了（routes/larkEvents.js），所以 accept('arrival') 不再有处理分支。
//
// ⚠️ 但**入库 / 库存 / 建档 / 成本**这四项能力刻意保留：「采购入库」表、库存调用
// （inventory.applyPurchase）、以及将来要剥成 ProductCreationService 的「建档 + 成本」
// 都要留给新的「对话到货」。它们现在是"孤儿能力"：没有任何生产调用方。
// 下面这组用例直接调 confirmArrival / ensureArrivalProducts 把口径继续钉住——
// **断言一条都没削弱**，只是不再经过"拍照识别"那个入口。
//
// 被整条删除的用例：识别链路自身的（识别成功/失败、等待与超时、卡片动作、识别匹配），
// 以及依赖 purchaseArrivalDetailCard 的卡片断言。每处都有删除理由。
// ═══════════════════════════════════════════════════════════════════════════════

// 货品表里确实没有这条：resolveProduct 抛带 code 的错，建档那一步才敢自动建。
// 「货号对应多个颜色」这类歧义不带这个 code。
const productNotFound = (itemNo, color) => Object.assign(new Error(`找不到货品：${itemNo}${color}`), { code: 'PRODUCT_NOT_FOUND' });

// 捕获 warn 日志（logger 的 warn 走 console.warn，一行一个 JSON）。
// 这些测试在同一个文件里顺序执行，await 期间不会有别的用例并发写 console。
const captureWarn = async (run) => {
  const lines = [];
  const original = console.warn;
  console.warn = (line) => {
    try { lines.push(JSON.parse(line)); } catch { lines.push({ event: 'unparsed_warn', raw: String(line) }); }
  };
  try {
    const result = await run();
    return { result, lines };
  } finally {
    console.warn = original;
  }
};

// 种一条「识别已经跑完」的到货任务。形状与 processArrival 原先落盘的草稿完全一致；
// 生产上这份草稿将来由「对话到货」流程写入，测试里直接种。
//
// 为什么不从入口进：入口（drive.file.bitable_record_changed_v1 → kind='arrival'）
// 已摘掉，accept('arrival') 不再有处理分支——那是"链路退场"的定义。
const seedArrivalTask = async (store, {
  taskId,
  arrivalRecordId = 'arr_seeded',
  operatorOpenId = 'ou_1',
  actual = [],
  requests = [],
  pendingCreation = [],
  recognized = [],
  inboundCreated = null,
} = {}) => {
  const id = taskId || `purchase_arrival_${Math.random().toString(36).slice(2, 10)}`;
  await store.create({ task_id: id, kind: 'arrival', record_id: arrivalRecordId, status: 'awaiting_confirmation' });
  const draft = {
    arrival_record_id: arrivalRecordId,
    direct_arrival: true,
    batch_record_id: '',
    batch_no: '',
    operator_open_id: operatorOpenId,
    requests,
    actual,
    unrecognized: [],
    pending_creation: pendingCreation,
    created_products: [],
    created_colors: [],
    creation_state: pendingCreation.length ? 'pending' : 'done',
    creation_error: '',
  };
  if (inboundCreated) draft.inbound_created = inboundCreated;
  await store.update(id, { recognized, draft });
  return store.get(id);
};

// 一条「已经匹配到货品」的到货明细：入库用例的最小输入。
const arrivalActual = (extra = {}) => ({
  product_record_id: 'prod_1',
  product_number: '8088灰',
  item_no: '8088',
  color: '灰色',
  size: 36,
  quantity: 1,
  created_product: false,
  ...extra,
});

// ─── 入库：写「采购入库」+ 库存 + 回写状态（confirmArrival）────────────────

test('入库：写采购入库 + 挂回采购申请 + 回写申请到货状态与到货确认状态', async () => {
  const inventory = makeInventory();
  const records = {
    purchaseArrival: [{ record_id: 'arr_conf', fields: { 确认状态: '待确认' } }],
    purchaseRequest: [{ record_id: 'req_1', fields: { 报货批次号: ['batch_1'], 编号: ['prod_1'], 尺码: sizeLink(36), 数量: 2 } }],
    purchaseInbound: [],
  };
  const { service, store, gateway } = makeService({ inventory, gateway: makeGateway(records) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_conf',
    arrivalRecordId: 'arr_conf',
    actual: [arrivalActual()],
    requests: (await gateway.listAll('purchaseRequest')),
  });

  const result = await service.confirmArrival(task.task_id, task, 'ou_1');
  assert.ok(result.toast.content.includes('采购已入库'));

  const inbounds = await gateway.listAll('purchaseInbound');
  assert.equal(inbounds.length, 1);
  assert.deepEqual(inbounds[0].fields.尺码, sizeLink(36));
  assert.equal(inbounds[0].fields.数量, 1);
  assert.deepEqual(inbounds[0].fields.采购申请, ['req_1'], '入库记录要挂回对应的采购申请行');
  assert.equal((await gateway.get('purchaseRequest', 'req_1')).fields.到货状态, '部分到货');
  assert.equal((await gateway.get('purchaseArrival', 'arr_conf')).fields.确认状态, '已确认');
  assert.equal(inventory.calls.length, 1, '库存要跟着加一次');
});

test('入库：同一货品+尺码的两条明细合成一条入库（数量 2），重复确认不重复写', async () => {
  const inventory = makeInventory();
  const records = {
    purchaseArrival: [{ record_id: 'arr_two', fields: { 确认状态: '待确认' } }],
    purchaseRequest: [{ record_id: 'req_1', fields: { 编号: ['prod_1'], 尺码: sizeLink(36), 数量: 2 } }],
    purchaseInbound: [],
  };
  const { service, store, gateway } = makeService({ inventory, gateway: makeGateway(records) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_two',
    arrivalRecordId: 'arr_two',
    actual: [arrivalActual(), arrivalActual()],
    requests: (await gateway.listAll('purchaseRequest')),
  });

  await service.confirmArrival(task.task_id, task, 'ou_1');
  // 再确认一次：读**最新**任务（已经是 posted），直接返回，不重复写。
  await service.confirmArrival(task.task_id, await store.get(task.task_id), 'ou_1');

  const inbounds = await gateway.listAll('purchaseInbound');
  assert.equal(inbounds.length, 1);
  assert.equal(inbounds[0].fields.数量, 2);
  assert.equal(inventory.calls.length, 1);
  assert.equal(inventory.calls[0].quantity, 2);
  assert.equal((await gateway.get('purchaseRequest', 'req_1')).fields.到货状态, '全部到货');
});

test('入库：真的调 inventory.applyPurchase（带采购入库记录 id 作为幂等来源）', async () => {
  const inventory = makeInventory();
  const records = {
    purchaseArrival: [{ record_id: 'arr_inv', fields: { 确认状态: '待确认' } }],
    purchaseInbound: [],
  };
  const { service, store } = makeService({ inventory, gateway: makeGateway(records) });
  const task = await seedArrivalTask(store, { taskId: 'purchase_arrival_inv', arrivalRecordId: 'arr_inv', actual: [arrivalActual()] });

  await service.confirmArrival(task.task_id, task, 'ou_1');
  assert.equal(inventory.calls.length, 1);
  assert.equal(inventory.calls[0].productRecordId, 'prod_1');
  assert.equal(inventory.calls[0].size, 36);
  assert.equal(inventory.calls[0].quantity, 1);
  assert.ok(inventory.calls[0].purchaseInboundRecordId, '库存的幂等来源是采购入库记录 id');
});

test('入库：没有报货批次（供应商直接送货）照样入库，不写任何申请状态', async () => {
  const inventory = makeInventory();
  const records = { purchaseArrival: [{ record_id: 'arr_direct', fields: { 确认状态: '待确认' } }], purchaseInbound: [] };
  const { service, store, gateway } = makeService({ inventory, gateway: makeGateway(records) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_direct',
    arrivalRecordId: 'arr_direct',
    actual: [arrivalActual()],
  });

  const result = await service.confirmArrival(task.task_id, task, 'ou_1');
  assert.ok(result.toast.content.includes('采购已入库'));
  assert.equal((await gateway.listAll('purchaseInbound')).length, 1);
  assert.equal(inventory.calls.length, 1, '直接到货也要真的入库');
  assert.equal((await gateway.listAll('purchaseRequest')).length, 0);
});

test('入库：写库中途失败后重试不重复写第一条，也不重复加库存', async () => {
  const inventory = makeInventory();
  const records = {
    purchaseArrival: [{ record_id: 'arr_partial', fields: { 确认状态: '待确认' } }],
    purchaseInbound: [],
  };
  let inboundCreateCount = 0;
  let failOnSecondCreate = true;
  const baseGateway = makeGateway(records);
  const gateway = {
    ...baseGateway,
    create: async (tableKey, semanticValues) => {
      if (tableKey === 'purchaseInbound') {
        inboundCreateCount += 1;
        if (failOnSecondCreate && inboundCreateCount === 2) throw new Error('模拟入库写入中途失败');
      }
      return baseGateway.create(tableKey, semanticValues);
    },
  };
  const { service, store } = makeService({ inventory, gateway });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_partial',
    arrivalRecordId: 'arr_partial',
    actual: [arrivalActual(), arrivalActual({ size: 37 })],
  });

  await assert.rejects(
    () => service.confirmArrival(task.task_id, task, 'ou_1'),
    /模拟入库写入中途失败/,
  );
  assert.equal((await gateway.listAll('purchaseInbound')).length, 1, '失败后应只有 1 条入库记录');
  assert.equal(inventory.calls.length, 1, '失败后应只有 1 次库存更新');
  assert.notEqual((await store.get(task.task_id)).status, 'posted', '失败后任务不应标记为 posted');

  failOnSecondCreate = false;
  const result = await service.confirmArrival(task.task_id, await store.get(task.task_id), 'ou_1');
  assert.ok(result.toast.content.includes('采购已入库'), result.toast.content);

  const inbounds = await gateway.listAll('purchaseInbound');
  assert.equal(inbounds.length, 2, '重试补齐第二条，不重复第一条');
  assert.equal(inventory.calls.length, 2);
  assert.deepEqual(inbounds.map((row) => row.fields.尺码[0]).sort(), sizeLinks(36, 37));
  assert.equal((await store.get(task.task_id)).status, 'posted');
});

test('入库：飞书列表延迟时靠任务里落盘的 inbound_created 防重复', async () => {
  const inventory = makeInventory();
  const records = {
    purchaseArrival: [{ record_id: 'arr_latency', fields: { 确认状态: '待确认' } }],
    purchaseInbound: [],
  };
  let inboundCreateCount = 0;
  let failOnSecondCreate = true;
  let simulateListLatency = false;
  const baseGateway = makeGateway(records);
  const gateway = {
    ...baseGateway,
    listAll: async (tableKey) => {
      if (tableKey === 'purchaseInbound' && simulateListLatency) return [];
      return baseGateway.listAll(tableKey);
    },
    create: async (tableKey, semanticValues) => {
      if (tableKey === 'purchaseInbound') {
        inboundCreateCount += 1;
        if (failOnSecondCreate && inboundCreateCount === 2) throw new Error('模拟入库写入中途失败');
      }
      return baseGateway.create(tableKey, semanticValues);
    },
  };
  const { service, store } = makeService({ inventory, gateway });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_latency',
    arrivalRecordId: 'arr_latency',
    actual: [arrivalActual(), arrivalActual({ size: 37 })],
  });

  await assert.rejects(
    () => service.confirmArrival(task.task_id, task, 'ou_1'),
    /模拟入库写入中途失败/,
  );
  const afterFirst = await store.get(task.task_id);
  assert.ok(afterFirst.draft?.inbound_created, '失败后应已持久化 inbound_created');
  assert.equal(Object.keys(afterFirst.draft.inbound_created).length, 1, '只持久化第 1 条成功的记录');
  assert.ok(Object.keys(afterFirst.draft.inbound_created)[0].includes('36'), '持久化的应是 36 码那条');

  simulateListLatency = true;
  failOnSecondCreate = false;
  await service.confirmArrival(task.task_id, afterFirst, 'ou_1');

  const inbounds = await baseGateway.listAll('purchaseInbound');
  assert.equal(inbounds.length, 2, '即使 listAll 返回空，36 码也不能重复');
  assert.equal(inventory.calls.length, 2);
});

test('入库：库存更新失败后重试继续补上，不重复建入库记录', async () => {
  let inventoryCallCount = 0;
  const inventoryCalls = [];
  let failInventory = true;
  const inventory = {
    applyPurchase: async (input) => {
      inventoryCallCount += 1;
      inventoryCalls.push(input);
      if (failInventory && inventoryCallCount === 1) throw new Error('模拟库存更新失败');
      return { stockKey: `${input.productRecordId}|${input.size}`, ledgerRecordId: 'ledger_1', liveRecordIds: ['live_1'], movementQuantity: input.quantity, direction: '增加', quantity: input.quantity };
    },
  };
  const records = {
    purchaseArrival: [{ record_id: 'arr_invfail', fields: { 确认状态: '待确认' } }],
    purchaseInbound: [],
  };
  const { service, store, gateway } = makeService({ inventory, gateway: makeGateway(records) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_invfail',
    arrivalRecordId: 'arr_invfail',
    actual: [arrivalActual(), arrivalActual({ size: 37 })],
  });

  await assert.rejects(
    () => service.confirmArrival(task.task_id, task, 'ou_1'),
    /模拟库存更新失败/,
  );
  const inboundsAfterFirst = await gateway.listAll('purchaseInbound');
  assert.equal(inboundsAfterFirst.length, 1, '第一次失败后应只有 36 码那条入库记录');
  assert.equal(inventoryCallCount, 1);
  const entry36 = Object.values((await store.get(task.task_id)).draft.inbound_created)
    .find((entry) => entry.recordId === inboundsAfterFirst[0].record_id);
  assert.equal(entry36.inventoryApplied, false, '库存更新失败后 inventoryApplied 应为 false');

  failInventory = false;
  await service.confirmArrival(task.task_id, await store.get(task.task_id), 'ou_1');

  assert.equal((await gateway.listAll('purchaseInbound')).length, 2, '36 码不重复创建，37 码正常创建');
  assert.equal(inventoryCallCount, 3, '36 码失败 1 次 + 36 码重试 + 37 码');
  const inbound36Id = inboundsAfterFirst[0].record_id;
  assert.equal(inventoryCalls.filter((call) => call.purchaseInboundRecordId === inbound36Id).length, 2);
});

test('A2 同时确认同一个采购到货：每个逻辑入库只有一条，库存只加一次', async () => {
  // 这条并发断言原先靠 handleCardAction 的 confirmationQueue 串行提供。到货卡片动作已删，
  // 串行保证原样挪进了 confirmArrival（见方法头的注释）——所以这里直接并发调它。
  const inventory = makeInventory();
  const records = {
    purchaseArrival: [{ record_id: 'arr_race', fields: { 确认状态: '待确认' } }],
    purchaseInbound: [],
  };
  const { service, store, gateway } = makeService({ inventory, gateway: slowCreates(makeGateway(records)) });
  const task = await seedArrivalTask(store, { taskId: 'purchase_arrival_race', arrivalRecordId: 'arr_race', actual: [arrivalActual()] });

  await Promise.all([
    service.confirmArrival(task.task_id, task, 'ou_1'),
    service.confirmArrival(task.task_id, task, 'ou_1'),
  ]);

  assert.equal((await gateway.listAll('purchaseInbound')).length, 1, '并发确认不得创建第二条采购入库');
  assert.equal(inventory.calls.length, 1, '库存只应增加一次');
  assert.equal((await store.get(task.task_id)).status, 'posted');
});

// ─── 建档 + 成本（ensureArrivalProducts / ensureArrivalProduct / applyArrivalCost）──

test('建档：未知货号+颜色建一条货品，带上货号 / 颜色关联 / 供应商 / 类别', async () => {
  const records = {
    product: [],
    color: [{ record_id: 'color_black', fields: { 颜色: '黑' } }],
    supplier: [{ record_id: 'sup_9', fields: { 供应商名称: '一代千金' } }],
  };
  const { service, store, gateway } = makeService({
    gateway: makeGateway(records),
    references: makeReferences({ resolveSupplier: async () => ({ recordId: 'sup_9', record: records.supplier[0] }) }),
  });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_create',
    pendingCreation: [{ item_no: '3602', color: '黑色', supplier: '一代千金', gender: '女' }],
  });

  const result = await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  assert.equal(result.state, 'done');
  assert.equal(records.product.length, 1, '同一「货号+颜色」只建一条');
  assert.equal(records.product[0].fields.货号, '3602');
  assert.deepEqual(records.product[0].fields.颜色, ['color_black']);
  assert.deepEqual(records.product[0].fields.供应商, ['sup_9']);
  assert.equal(records.product[0].fields.类别, 'B', '标签上是女鞋 → 类别 B');
  assert.equal('编号' in records.product[0].fields, false, '「编号」是飞书公式字段，不能写');
});

test('建档：货号+颜色命中多条时只建一条，链接回填草稿', async () => {
  const records = {
    product: [],
    color: [{ record_id: 'color_black', fields: { 颜色: '黑' } }],
    supplier: [],
  };
  const { service, store } = makeService({ gateway: makeGateway(records) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_idem',
    pendingCreation: [
      // 同一 货号+颜色 的两个尺码：建档按 货号+颜色 去重。
      { item_no: '1366-31', color: '黑色' },
      { item_no: '1366-31', color: '黑色' },
      { item_no: '1366-32', color: '黑色' },
    ],
  });

  const result = await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  assert.equal(result.created, 2, '两个货号各一条');
  assert.equal(records.product.length, 2);
  const saved = await store.get(task.task_id);
  assert.equal(saved.draft.created_products.length, 2);
  assert.match(saved.draft.created_products[0].url, /record=/, '链接要回填到草稿');
  assert.match(saved.draft.created_products[0].url, new RegExp(`record=${records.product[0].record_id}`));

  // 幂等：再跑一次不能多建一条。
  const again = await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  assert.equal(again.state, 'done');
  assert.equal(records.product.length, 2, '重复跑建档不能多建一条');
});

test('建档：颜色表缺色时补一条；同类颜色只补一次', async () => {
  const records = { product: [], color: [], supplier: [] };
  const { service, store } = makeService({ gateway: makeGateway(records) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_color',
    pendingCreation: [
      { item_no: '3602', color: '香芋紫' },
      { item_no: '3603', color: '香芋紫色' },
    ],
  });

  await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  // normalizeColor 会去掉末尾的「色」：两个写法算同一个颜色，只补一条。
  assert.equal(records.color.length, 1, '同一颜色（去尾「色」后同名）只补一条');
  assert.equal(records.color[0].fields.颜色, '香芋紫');
  assert.deepEqual(records.product[0].fields.颜色, [records.color[0].record_id]);
});

test('建档：供应商表里没有这个名字就留空，不新建、不猜', async () => {
  const records = { product: [], color: [{ record_id: 'color_black', fields: { 颜色: '黑' } }], supplier: [] };
  const { service, store } = makeService({
    gateway: makeGateway(records),
    references: makeReferences({ resolveSupplier: async () => { throw new Error('找不到供应商'); } }),
  });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_sup',
    pendingCreation: [{ item_no: '3602', color: '黑色', supplier: '不存在的供应商' }],
  });

  await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  assert.equal(records.supplier.length, 0, '不在供应商表里就不新建');
  assert.equal('供应商' in records.product[0].fields, false, '找不到就留空，绝不猜一个关联');
});

test('建档：标签没有男/女信息时类别留空', async () => {
  const records = { product: [], color: [], supplier: [] };
  const { service, store } = makeService({ gateway: makeGateway(records) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_nogender',
    pendingCreation: [{ item_no: '3602', color: '黑' }],
  });

  await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  assert.equal('类别' in records.product[0].fields, false, '认不出男/女就留空——默认成 A 会把女鞋写进男鞋');
});

test('建档：缺失字段（公式 + 样例图）只落在草稿和日志里', async () => {
  const records = { product: [], color: [{ record_id: 'color_black', fields: { 颜色: '黑' } }], supplier: [] };
  const gateway = makeGateway(records);
  const originalGet = gateway.get;
  // 「缺失信息说明」是飞书公式，后端只负责读：齐备时是「齐备」，否则是缺的字段名。
  // 「样例图」是附件字段、不在公式里，要单独看。
  gateway.get = async (tableKey, recordId) => {
    if (tableKey === 'product') {
      return { record_id: recordId, fields: { 货号: '3602', 颜色: ['color_black'], 缺失信息说明: '成本、品类', 样例图: [] } };
    }
    return originalGet(tableKey, recordId);
  };
  const { service, store } = makeService({ gateway });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_gaps',
    pendingCreation: [{ item_no: '3602', color: '黑色' }],
  });

  await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  const saved = await store.get(task.task_id);
  assert.deepEqual(saved.draft.created_products[0].missing, ['成本', '品类']);
  assert.equal(saved.draft.created_products[0].missing_sample_image, true);
  assert.equal(saved.draft.created_products[0].completeness_readable, true);
});

test('建档失败可重试：已经建好的那条不重复建，重试只补缺的', async () => {
  const records = { product: [], color: [{ record_id: 'color_black', fields: { 颜色: '黑色' } }], supplier: [] };
  // 第一次建档：第一条成功、第二条失败——模拟"建了一半"。
  // 成功那条的 record_id 会随任务落盘（arrival_created_products），重试必须复用它。
  let createCalls = 0;
  const gateway = makeGateway(records);
  const innerCreate = gateway.create;
  gateway.create = async (tableKey, semanticValues) => {
    if (tableKey === 'product') {
      createCalls += 1;
      if (createCalls === 2) throw new Error('模拟第二条建档失败');
    }
    return innerCreate(tableKey, semanticValues);
  };
  const { service, store } = makeService({ gateway });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_retry',
    pendingCreation: [
      { item_no: '3602', color: '黑色' },
      { item_no: '3603', color: '黑色' },
    ],
  });

  const first = await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  assert.equal(first.state, 'failed', '有一条没建成功，状态要标失败（不能静默）');
  const afterFirst = await store.get(task.task_id);
  assert.match(afterFirst.draft.creation_error, /模拟第二条建档失败/, '失败原因要写进草稿');
  assert.equal(records.product.length, 1, '第一条已经建好了');
  assert.equal(records.product[0].fields.货号, '3602');

  const retry = await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  assert.equal(retry.state, 'done');
  assert.equal(records.product.length, 2, '重试只补建缺的那条，不重复建第一条');
  assert.equal(createCalls, 3, '第一次 2 次（1 成功 1 失败）+ 重试 1 次');
});

test('建档一直失败：草稿给出原因，且 confirmArrival 拒绝假装入库', async () => {
  const records = { product: [], color: [{ record_id: 'color_black', fields: { 颜色: '黑色' } }], supplier: [], purchaseArrival: [{ record_id: 'arr_create_fail', fields: { 确认状态: '待确认' } }], purchaseInbound: [] };
  const gateway = makeGateway(records);
  gateway.create = async (tableKey, semanticValues) => {
    if (tableKey === 'product') throw new Error('模拟建档总失败');
    return makeGateway(records).create(tableKey, semanticValues);
  };
  const { service, store } = makeService({ gateway });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_create_fail',
    arrivalRecordId: 'arr_create_fail',
    pendingCreation: [{ item_no: '3602', color: '黑色' }],
  });

  const failed = await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  assert.equal(failed.state, 'failed');
  assert.match((await store.get(task.task_id)).draft.creation_error, /模拟建档总失败/);

  const failedTask = await store.get(task.task_id);
  await assert.rejects(
    () => service.confirmArrival(failedTask.task_id, failedTask, 'ou_1'),
    /新品建档没成功/,
    '建档失败必须明确告诉她原因，不能静默',
  );
  assert.equal((await gateway.listAll('purchaseInbound')).length, 0, '建不出货品就不能入库，更不能假装入了');

  // 失败可重试：修好之后再确认一次，走同一条幂等路径。
  gateway.create = makeGateway(records).create;
  const result = await service.confirmArrival(task.task_id, await store.get(task.task_id), 'ou_1');
  assert.ok(result.toast.content.includes('采购已入库'), '修好之后要能成功入库');
  assert.equal(records.product.length, 1);
});

test('成本：货品「成本」为空时写进去', async () => {
  const records = { product: [{ record_id: 'prod_cost', fields: { 编号: '1366-31棕色', 供应商: ['sup_A'] } }] };
  const { service, store } = makeService({ gateway: makeGateway(records) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_cost_empty',
    actual: [{ product_record_id: 'prod_cost', item_no: '1366-31', color: '棕色', size: 36, quantity: 1, created_product: false }],
    recognized: [{ item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: 199 }],
  });

  const { result } = await captureWarn(async () => service.ensureArrivalProducts(task.task_id, { reason: 'test' }));
  assert.equal(result.state, 'done');
  assert.equal(records.product.length, 1, '已经匹配到老货品的行不建新货品，只补成本');
  assert.equal(records.product[0].fields.成本, 199, '到货单价要写进货品成本');
  assert.equal(result.cost_written_count, 1);
});

test('成本：货品已有成本时不覆盖，只记一条带三要素的 warn', async () => {
  const records = { product: [{ record_id: 'prod_keep', fields: { 编号: '1366-31棕色', 供应商: ['sup_A'], 成本: 100 } }] };
  const { service, store } = makeService({ gateway: makeGateway(records) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_cost_kept',
    actual: [{ product_record_id: 'prod_keep', item_no: '1366-31', color: '棕色', size: 36, quantity: 1, created_product: false }],
    recognized: [{ item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: 199 }],
  });

  const { lines } = await captureWarn(async () => service.ensureArrivalProducts(task.task_id, { reason: 'test' }));
  assert.equal(records.product[0].fields.成本, 100, '已有成本一律不覆盖');
  const warn = lines.find((line) => line.event === 'purchase.arrival.cost_kept');
  assert.ok(warn, `必须有 cost_kept warn，实际日志：${JSON.stringify(lines)}`);
  assert.equal(warn.item_no, '1366-31');
  assert.equal(String(warn.existing_cost), '100');
  assert.equal(warn.recognized_cost, 199);
});

test('成本：同一货号多行价格不一致时整条不写，只 warn 一次', async () => {
  const records = { product: [{ record_id: 'prod_conflict', fields: { 编号: '1366-31棕色', 供应商: ['sup_A'] } }] };
  const { service, store } = makeService({ gateway: makeGateway(records) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_cost_conflict',
    actual: [
      { product_record_id: 'prod_conflict', item_no: '1366-31', color: '棕色', size: 36, quantity: 1, created_product: false },
      { product_record_id: 'prod_conflict', item_no: '1366-31', color: '棕色', size: 37, quantity: 1, created_product: false },
    ],
    recognized: [
      { item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: 199 },
      { item_no: '1366-31', color: '棕色', size: 37, quantity: 1, unit_cost: 209 },
    ],
  });

  const { lines } = await captureWarn(async () => service.ensureArrivalProducts(task.task_id, { reason: 'test' }));
  assert.equal('成本' in records.product[0].fields, false, '价格不一致时一个值都不能写');
  assert.equal(lines.filter((line) => line.event === 'purchase.arrival.cost_kept').length, 0, '不能把冲突当成"已有成本"报 warn');
  const conflict = lines.filter((line) => line.event === 'purchase.arrival.cost_conflict');
  assert.equal(conflict.length, 1, '冲突只 warn 一次：不能每个尺码都报一遍');
  assert.equal(conflict[0].item_no, '1366-31');
  assert.deepEqual(conflict[0].prices, [199, 209]);
});

test('成本：重复跑建档不重复写成本（costApplied 落盘）', async () => {
  const records = { product: [{ record_id: 'prod_retry', fields: { 编号: '1366-31棕色', 供应商: ['sup_A'] } }] };
  const gateway = makeGateway(records);
  const costUpdates = [];
  const realUpdate = gateway.update;
  gateway.update = async (tableKey, recordId, semanticValues) => {
    if (tableKey === 'product' && semanticValues && semanticValues.cost !== undefined) {
      costUpdates.push({ recordId, cost: semanticValues.cost });
    }
    return realUpdate(tableKey, recordId, semanticValues);
  };
  const { service, store } = makeService({ gateway });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_cost_retry',
    actual: [{ product_record_id: 'prod_retry', item_no: '1366-31', color: '棕色', size: 36, quantity: 1, created_product: false }],
    recognized: [{ item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: 199 }],
  });

  await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  assert.equal(costUpdates.length, 1, '第一次要写成本');
  assert.equal(records.product[0].fields.成本, 199);

  // 再跑一次（相当于新流程的兜底/重试）：靠任务里落盘的 arrival_cost_written 幂等。
  await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  assert.equal(costUpdates.length, 1, '不能写第二遍成本');
  assert.equal(records.product[0].fields.成本, 199);
});

test('成本：写成本失败只记 warn，不挡住入库', async () => {
  const records = {
    product: [{ record_id: 'prod_fail', fields: { 编号: '1366-31棕色', 供应商: ['sup_A'] } }],
    purchaseArrival: [{ record_id: 'arr_cost_fail', fields: { 确认状态: '待确认' } }],
    purchaseInbound: [],
  };
  const gateway = makeGateway(records);
  gateway.update = async (tableKey, recordId, semanticValues) => {
    if (tableKey === 'product' && semanticValues && semanticValues.cost !== undefined) {
      throw new Error('模拟成本字段写不进去');
    }
    return { record_id: recordId };
  };
  const { service, store } = makeService({ gateway });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_cost_fail',
    arrivalRecordId: 'arr_cost_fail',
    actual: [{ product_record_id: 'prod_fail', item_no: '1366-31', color: '棕色', size: 36, quantity: 1, created_product: false }],
    recognized: [{ item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: 199 }],
  });

  const { result: creation, lines } = await captureWarn(async () => service.ensureArrivalProducts(task.task_id, { reason: 'test' }));
  assert.equal(creation.state, 'done', '成本写不进去不算建档失败');
  assert.ok(lines.some((line) => line.event === 'purchase.arrival.cost_write_failed'));

  // 货已经到了：成本写不进去不能把整批到货卡住。
  const result = await service.confirmArrival(task.task_id, await store.get(task.task_id), 'ou_1');
  assert.ok(result.toast.content.includes('采购已入库'));
  assert.equal((await gateway.listAll('purchaseInbound')).length, 1);
});

test('成本：新品建档顺带写成本；单据上没有价格就不写成本字段', async () => {
  const withCost = { product: [], color: [{ record_id: 'color_brown', fields: { 颜色: '棕色' } }], supplier: [] };
  const { service, store } = makeService({ gateway: makeGateway(withCost) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_new_cost',
    pendingCreation: [{ item_no: '1366-31', color: '棕色' }],
    recognized: [{ item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: '￥199.00' }],
  });
  await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  assert.equal(withCost.product.length, 1, '新品只建一条');
  assert.equal(withCost.product[0].fields.货号, '1366-31');
  assert.equal(withCost.product[0].fields.成本, 199, '新品建档要顺带写成本');

  const noCost = { product: [], color: [{ record_id: 'color_brown', fields: { 颜色: '棕色' } }], supplier: [] };
  const second = makeService({ gateway: makeGateway(noCost) });
  const task2 = await seedArrivalTask(second.store, {
    taskId: 'purchase_arrival_new_nocost',
    pendingCreation: [{ item_no: '1366-31', color: '棕色' }],
    recognized: [{ item_no: '1366-31', color: '棕色', size: 36, quantity: 1 }],
  });
  await second.service.ensureArrivalProducts(task2.task_id, { reason: 'test' });
  assert.equal(noCost.product.length, 1);
  assert.equal('成本' in noCost.product[0].fields, false, '没有可信价格就不许写成本');
});

// ─── 通用守卫（与到货链路无关，但原先挂在到货用例上）────────────────────────

test('invalid record_id is rejected', async () => {
  const { service } = makeService();
  // 原先传的 kind 是 'arrival'；入口已摘掉，改用仍然在跑的报单链路来验同一个守卫。
  await assert.rejects(() => service.accept('supplier-report', 'invalid id!'), /缺少有效 record_id/);
});

test('采购卡片：只有原始填写人能确认（操作人校验仍在）', async () => {
  // 原先这条用「确认入库」卡片验。到货卡片动作已随识别链路删除，改用仍然在跑的
  // 采购申请卡片验同一个校验（它在 handleCardActionLocked 的最前面，与动作无关）。
  const { service, store } = makeService({
    gateway: makeGateway({ purchaseReport: [reportRecord('rep_auth', { 尺码: sizeLink(36), 编号: ['prod_1'] })] }),
  });
  const accepted = await service.accept('supplier-report', 'rep_auth');
  await waitForProcessed(store, accepted.taskId);

  await assert.rejects(
    () => service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_request' }, 'ou_other'),
    /只能由原始填写人确认/,
  );
});

// ─── 供应商报单批次聚合链路 ───

test('供应商报单带批次号：解析完免确认直接生成采购申请（不判「到齐」，也不等 30 秒窗口）', async () => {
  const { service, store, gateway } = makeService({
    gateway: makeGateway({
      purchaseReport: [reportRecord('rep_batch_1', { 尺码: sizeLink(36), 编号: ['prod_1'], 报货批次号: 'BATCH-001'})],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
  });
  const result = await service.accept('supplier-report', 'rep_batch_1');
  assert.equal(result.accepted, true);
  const task = await waitForProcessed(store, result.taskId);
  assert.equal(task.status, 'posted');
  assert.equal((await gateway.get('purchaseReport', 'rep_batch_1')).fields.处理状态, '已生成申请');
  assert.equal((await gateway.listAll('purchaseRequest')).length, 1);
});

test('同一个批次的多条报单合成一个批次任务，全部标记已生成申请、只出一张图', async () => {
  const { service, store, gateway, images } = makeService({
    gateway: makeGateway({
      purchaseReport: [
        reportRecord('rep_c1', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'], 报货批次号: 'BATCH-CONF'}),
        reportRecord('rep_c2', { 尺码: sizeLink(37), 数量说明: '37码1双', 编号: ['prod_1'], 报货批次号: 'BATCH-CONF'}),
      ],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async (text) => (text.includes('36') ? [{ size: 36, quantity: 2 }] : [{ size: 37, quantity: 1 }]) }),
  });
  const first = await service.accept('supplier-report', 'rep_c1');
  const second = await service.accept('supplier-report', 'rep_c2');
  await waitForBatchPosted(gateway, 'BATCH-CONF');
  // 批次处理者是先开窗口的那条记录的任务（这里谁先跑由调度决定，不假设顺序）：
  // 用"哪个任务的草稿装配了整批明细"来定位它。
  let task;
  await waitFor('批次任务装配好草稿', async () => {
    const tasks = await Promise.all([store.get(first.taskId), store.get(second.taskId)]);
    task = tasks.find((item) => Array.isArray(item?.draft?.items) && item.draft.items.length > 0);
    return Boolean(task);
  });
  assert.equal(task.status, 'posted');
  assert.equal(task.draft.is_batch, true);
  assert.equal(task.draft.items.length, 2);
  const requests = await gateway.listAll('purchaseRequest');
  assert.equal(requests.length, 2);
  assert.equal((await gateway.get('purchaseReport', 'rep_c1')).fields.处理状态, '已生成申请');
  assert.equal((await gateway.get('purchaseReport', 'rep_c2')).fields.处理状态, '已生成申请');
  assert.equal((await gateway.listAll('purchaseOrderBatch')).length, 1, '一个批次只建一条报货批次');
  // 附件写回是出图的最后一步，等它落定再断言"只出了一张图"
  await waitForAttachments(gateway, 1);
  assert.equal(images.calls.length, 1, '同一供应商只出一张图');
});

// ─── 归批：一次表单提交 = 一批（只处理一次、只出一份申请）──────────────────
//
// 业务负责人 2026-10-05 删掉了「合计数量」并明确「不加判断的逻辑」——不再判「到齐」。
// 现在决定"什么时候处理"的是**归批**：
//   · 首选：webhook 的同一包（同一 action_list 里的多个 record_added 一起交进来）；
//   · 兜底：飞书拆包时，按「报货批次号」在短窗口内归集，窗口到点处理一次。
// 所以下面所有用例都不写「合计数量」，窗口压到 20ms（见 makeService）；
// 需要验证窗口本身的用例显式传更大的值。

// 有些用例要断言"窗口没到之前一次写入都没有发生"：给 gateway 加上写调用计数。
// 判定写行为的依据是**有没有调用**（而不是数据长什么样）——后者会被
// "写入和原值相同"骗过去，前者不会。
const countGatewayWrites = (gateway) => {
  const writes = [];
  const realCreate = gateway.create.bind(gateway);
  const realUpdate = gateway.update.bind(gateway);
  gateway.create = async (tableKey, values) => { writes.push({ op: 'create', tableKey }); return realCreate(tableKey, values); };
  gateway.update = async (tableKey, recordId, values) => { writes.push({ op: 'update', tableKey }); return realUpdate(tableKey, recordId, values); };
  return writes;
};

test('不再依赖「合计数量」：表里没有这个字段也能正常处理（记录不再是"永远不处理"）', async () => {
  const { service, store, gateway } = makeService({
    gateway: makeGateway({
      purchaseReport: [reportRecord('rep_no_total', { 尺码: sizeLink(36), 数量说明: '36码1双', 编号: ['prod_1'], 报货批次号: 'BATCH-NO-TOTAL' })],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 1 }] }),
  });
  // 先钉住前提：字段确实没有（表结构里连映射都不该有）。
  assert.equal(V1_BITABLE_SCHEMA.tables.purchaseReport.fields.totalQuantity, undefined,
    '「合计数量」已从表里删除，schema 不应再留映射（否则部署闸门会因字段不存在直接失败）');
  const accepted = await service.accept('supplier-report', 'rep_no_total');
  const task = await waitForProcessed(store, accepted.taskId);
  assert.equal(task.status, 'posted');
  assert.equal(task.result.status, 'posted');
  assert.equal((await gateway.listAll('purchaseRequest')).length, 1, '没有「合计数量」也要生成采购申请');
  assert.equal((await gateway.get('purchaseReport', 'rep_no_total')).fields.处理状态, '已生成申请');
});

test('采购申请一条：编号 + 尺码 + 数量说明 → 正确解析成尺码/数量', async () => {
  const { service, store, gateway } = makeService({
    gateway: makeGateway({
      purchaseReport: [reportRecord('rep_req_1', {
        尺码: sizeLinks(36, 37), 数量说明: '36码2双，37码3双', 编号: ['prod_1'], 报货批次号: 'BATCH-REQ',
      })],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 2 }, { size: 37, quantity: 3 }] }),
  });
  const accepted = await service.accept('supplier-report', 'rep_req_1');
  const task = await waitForProcessed(store, accepted.taskId);
  assert.equal(task.status, 'posted');
  const requests = await gateway.listAll('purchaseRequest');
  assert.equal(requests.length, 2, '每个尺码一条采购申请');
  // 尺码以**关联**写入（不是数字）；数量来自数量说明的解析结果。
  const bySize = new Map(requests.map((row) => [String(row.fields['尺码']), row.fields['数量']]));
  assert.deepEqual([...bySize.keys()].sort(), ['size_36', 'size_37']);
  assert.deepEqual([bySize.get('size_36'), bySize.get('size_37')], [2, 3]);
});

test('采购退货一条：编号 + 数量（number）→ 正确解析，且不写尺码', async () => {
  const { service, store, gateway } = makeService({
    gateway: makeGateway({
      purchaseReport: [reportRecord('rep_return_1', {
        编号: ['prod_1'], 数量: 4, 报货批次号: 'BATCH-RETURN', 采购行为: ['beh_return'],
      })],
      behavior: [{ record_id: 'beh_return', fields: { 行为名称: '采购退货', 行为编码: 'PURCHASE_RETURN' } }],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
  });
  const accepted = await service.accept('supplier-report', 'rep_return_1');
  const task = await waitForProcessed(store, accepted.taskId);
  assert.equal(task.status, 'posted');
  const requests = await gateway.listAll('purchaseRequest');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].fields['数量'], 4, '数量取自「数量」字段，不解析「数量说明」');
  assert.equal(requests[0].fields['尺码'], undefined, '采购退货没有尺码，绝不能凭空补一个');
  assert.deepEqual(requests[0].fields['采购行为'], ['beh_return'], '行为原样写到采购申请上，供后续区分');
});

test('一次提交多条（同一包）→ 只处理一次、只出一份申请、只出一张图', async () => {
  const records = {
    purchaseReport: [
      reportRecord('rep_pkg_1', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'], 报货批次号: 'BATCH-PKG' }),
      reportRecord('rep_pkg_2', { 尺码: sizeLink(37), 数量说明: '37码1双', 编号: ['prod_1'], 报货批次号: 'BATCH-PKG' }),
      reportRecord('rep_pkg_3', { 尺码: sizeLink(36), 数量说明: '36码1双', 编号: ['prod_1'], 报货批次号: 'BATCH-PKG' }),
    ],
    purchaseOrderBatch: [],
    purchaseRequest: [],
    supplier: SUPPLIERS,
  };
  const { service, gateway, images } = makeService({
    gateway: makeGateway(records),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async (text) => [{ size: text.includes('36') ? 36 : 37, quantity: text.includes('36码2') ? 2 : 1 }] }),
  });
  // 首选信号：明确把这一包的三条一起交出去（真实入口见 larkEvents 的 acceptMany）。
  await service.acceptMany('supplier-report', ['rep_pkg_1', 'rep_pkg_2', 'rep_pkg_3']);
  await waitForBatchPosted(gateway, 'BATCH-PKG');
  await waitForAttachments(gateway, 1);
  await waitForIdle(service);

  assert.equal(records.purchaseOrderBatch.length, 1, '一包只建一个报货批次');
  assert.equal(records.purchaseRequest.length, 3, '三条明细都要写进去（不是 3 份申请）');
  assert.equal(images.calls.length, 1, '同一供应商只出一张图，绝不是 N 张');
});

test('一包里有一条 record_id 不合法：不连累同包其它记录（逐条隔离）', async () => {
  const { service, gateway } = makeService({
    gateway: makeGateway({
      purchaseReport: [reportRecord('rep_pkg_ok', { 尺码: sizeLink(36), 数量说明: '36码1双', 编号: ['prod_1'], 报货批次号: 'BATCH-PKG-PARTIAL' })],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 1 }] }),
  });
  const result = await service.acceptMany('supplier-report', ['bad id!', 'rep_pkg_ok']);
  assert.equal(result.accepted, false);
  assert.deepEqual(result.failed.map((item) => item.record_id), ['bad id!']);
  assert.equal(result.records.length, 1, '合法的那条要正常受理');
  await waitForBatchPosted(gateway, 'BATCH-PKG-PARTIAL');
  assert.equal((await gateway.listAll('purchaseRequest')).length, 1, '合法的那条照样处理');
});

test('拆包兜底：同一批的记录分两次到达 → 仍算一批，只处理一次', async () => {
  const records = {
    purchaseReport: [
      reportRecord('rep_split_a', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'], 报货批次号: 'BATCH-SPLIT' }),
      reportRecord('rep_split_b', { 尺码: sizeLink(37), 数量说明: '37码1双', 编号: ['prod_1'], 报货批次号: 'BATCH-SPLIT' }),
    ],
    purchaseOrderBatch: [],
    purchaseRequest: [],
    supplier: SUPPLIERS,
  };
  const { service, gateway, images } = makeService({
    gateway: makeGateway(records),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async (text) => [{ size: text.includes('36') ? 36 : 37, quantity: text.includes('36') ? 2 : 1 }] }),
    // 窗口 300ms：第二条在窗口内到达，两条仍归成一批。
    reportBatchWindowMs: 300,
  });
  await service.accept('supplier-report', 'rep_split_a');
  await wait(60); // 模拟飞书把一包拆成两次推送
  await service.accept('supplier-report', 'rep_split_b');
  await waitForBatchPosted(gateway, 'BATCH-SPLIT');
  await waitForAttachments(gateway, 1);
  await waitForIdle(service);

  assert.equal(records.purchaseOrderBatch.length, 1);
  assert.equal(records.purchaseRequest.length, 2, '拆包也必须写全两条');
  assert.equal(images.calls.length, 1, '拆包也只出一张图');
});

test('窗口到点才处理：窗口没到之前一次远端写入都不发生', async () => {
  const gateway = makeGateway({
    purchaseReport: [reportRecord('rep_window', { 尺码: sizeLink(36), 数量说明: '36码1双', 编号: ['prod_1'], 报货批次号: 'BATCH-WINDOW' })],
    purchaseOrderBatch: [],
    purchaseRequest: [],
    supplier: SUPPLIERS,
  });
  const writes = countGatewayWrites(gateway);
  const { service, store } = makeService({
    gateway,
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 1 }] }),
    reportBatchWindowMs: 250,
  });
  const accepted = await service.accept('supplier-report', 'rep_window');
  // 任务登记进窗口后立刻返回，落在"等窗口"这个非终态上。
  await waitFor('任务停在等窗口', async () => (await store.get(accepted.taskId))?.status === 'batch_waiting');
  await wait(80);
  assert.deepEqual(writes, [], '窗口没到点不得有任何远端写入');
  assert.equal((await gateway.listAll('purchaseRequest')).length, 0);
  assert.equal((await gateway.get('purchaseReport', 'rep_window')).fields.处理状态, '待解析', '没处理完之前处理状态不能被改');

  // 窗口到点 → 处理一次，记录进入终态。
  await waitForBatchPosted(gateway, 'BATCH-WINDOW');
  assert.equal((await gateway.listAll('purchaseRequest')).length, 1);
});

test('同一次提交里混着采购申请和采购退货 → 两类明细各自按自己的格式解析', async () => {
  const { service, store, gateway } = makeService({
    gateway: makeGateway({
      purchaseReport: [
        reportRecord('rep_mix_req', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'], 报货批次号: 'BATCH-MIX', 采购行为: ['beh_req'] }),
        reportRecord('rep_mix_ret', { 编号: ['prod_1'], 数量: 5, 报货批次号: 'BATCH-MIX', 采购行为: ['beh_return'] }),
      ],
      behavior: [
        { record_id: 'beh_req', fields: { 行为名称: '采购申请', 行为编码: 'PURCHASE_REQUEST' } },
        { record_id: 'beh_return', fields: { 行为名称: '采购退货', 行为编码: 'PURCHASE_RETURN' } },
      ],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 2 }] }),
  });
  const accepted = await service.acceptMany('supplier-report', ['rep_mix_req', 'rep_mix_ret']);
  const tasks = await waitForProcessed(store, accepted.records.map((item) => item.taskId));
  assert.ok(tasks.some((task) => task.status === 'posted'));

  const requests = await gateway.listAll('purchaseRequest');
  assert.equal(requests.length, 2, '两条记录各写一条采购申请');
  const reqRow = requests.find((row) => row.fields['采购行为']?.[0] === 'beh_req');
  const retRow = requests.find((row) => row.fields['采购行为']?.[0] === 'beh_return');
  assert.ok(reqRow && retRow, `两条的行为必须各自正确，实际：${JSON.stringify(requests.map((r) => r.fields['采购行为']))}`);
  assert.equal(reqRow.fields['数量'], 2);
  assert.deepEqual(reqRow.fields['尺码'], ['size_36']);
  assert.equal(retRow.fields['数量'], 5);
  assert.equal(retRow.fields['尺码'], undefined, '退货行不能带尺码');
});

test('重复投递（同一批的明细 webhook 重投）→ 不重复建单、不重复发图', async () => {
  const records = {
    purchaseReport: [
      reportRecord('rep_dup_batch_a', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'], 报货批次号: 'BATCH-DUP'}),
      reportRecord('rep_dup_batch_b', { 尺码: sizeLink(37), 数量说明: '37码1双', 编号: ['prod_1'], 报货批次号: 'BATCH-DUP'}),
    ],
    purchaseOrderBatch: [],
    purchaseRequest: [],
    supplier: SUPPLIERS,
  };
  const { service, store, gateway, images } = makeService({
    gateway: makeGateway(records),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async (text) => [{ size: text.includes('36') ? 36 : 37, quantity: text.includes('36') ? 2 : 1 }] }),
  });
  await Promise.all([
    service.accept('supplier-report', 'rep_dup_batch_a'),
    service.accept('supplier-report', 'rep_dup_batch_b'),
  ]);
  // 不变量是"这一批的两条记录都被处理到终态"；单看某个任务的 status 会读到
  // 「另一条明细正在处理，所以这条停在中间态」的正常现象。
  await waitForBatchPosted(gateway, 'BATCH-DUP');
  await waitForIdle(service);
  const snapshot = () => [records.purchaseOrderBatch.length, records.purchaseRequest.length, images.calls.length].join('/');
  const before = snapshot();

  // 重投两条（飞书重投会连 action_list 一起重来），并且顺序反过来。
  const againB = await service.accept('supplier-report', 'rep_dup_batch_b');
  const againA = await service.accept('supplier-report', 'rep_dup_batch_a');
  await waitForIdle(service);
  assert.equal(againB.duplicate, true, '已 posted 的任务要按重复投递拦掉');
  assert.equal(againA.duplicate, true);
  assert.equal(snapshot(), before, '重复投递不得新增批次/采购申请/出图');
});

test('并发到达（两条明细几乎同时）→ 只处理一次，不重复建单、不重复发图（P0 回归）', async () => {
  const records = {
    purchaseReport: [
      reportRecord('rep_race_batch_a', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'], 报货批次号: 'BATCH-RACE'}),
      reportRecord('rep_race_batch_b', { 尺码: sizeLink(37), 数量说明: '37码1双', 编号: ['prod_1'], 报货批次号: 'BATCH-RACE'}),
    ],
    purchaseOrderBatch: [],
    purchaseRequest: [],
    supplier: SUPPLIERS,
  };
  const { service, store, gateway, images } = makeService({
    gateway: makeGateway(records),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async (text) => [{ size: text.includes('36') ? 36 : 37, quantity: text.includes('36') ? 2 : 1 }] }),
  });
  const [first, second] = await Promise.all([
    service.accept('supplier-report', 'rep_race_batch_a'),
    service.accept('supplier-report', 'rep_race_batch_b'),
  ]);
  await waitForBatchPosted(gateway, 'BATCH-RACE');
  await waitForIdle(service);

  assert.equal(records.purchaseOrderBatch.length, 1, '并发到达只能建一个报货批次');
  assert.equal(records.purchaseRequest.length, 2, '并发到达只能写出一套采购申请（2 个尺码 = 2 条）');
  assert.equal(images.calls.length, 1, '并发到达只能出一张图');
  assert.deepEqual(
    records.purchaseRequest.map((row) => row.fields.数量).sort(),
    [1, 2],
    '两条明细都要写进去，不能只写一条',
  );
});

test('「未到齐」告警彻底退场：不判到齐之后不再发任何告警，记录照常处理', async () => {
  const messages = [];
  const logs = [];
  const originals = { log: console.log, warn: console.warn };
  const push = (line) => { try { logs.push(JSON.parse(line)); } catch { /* 非 JSON 行不关心 */ } };
  console.log = push;
  console.warn = push;
  try {
    const { service, store, gateway } = makeService({
      client: makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } }),
      gateway: makeGateway({
        purchaseReport: [reportRecord('rep_no_alert', {
          尺码: sizeLink(36), 数量说明: '36码3双', 编号: ['prod_1'], 报货批次号: 'BATCH-NO-ALERT', 报单时间: Date.now(),
        })],
        purchaseOrderBatch: [],
        purchaseRequest: [],
        supplier: SUPPLIERS,
      }),
      references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
      recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 3 }] }),
      // 以前这里会压到 20ms 复现"5 分钟未到齐 → 告警"；现在整条告警链路已删除，
      // 传了也不会有人读它。
      reportBatchWindowMs: 20,
    });
    const accepted = await service.accept('supplier-report', 'rep_no_alert');
    await waitForProcessed(store, accepted.taskId);
    // 给她的一定只有出图/说明，不会再有「你说 0 双，我只收到 N 双」那种奇怪告警。
    const texts = textMessages(messages);
    assert.ok(!texts.some((text) => /我只收到|是不是还有明细没提交/.test(text)), `不得再发未到齐告警，实际：${JSON.stringify(texts)}`);
    assert.ok(!logs.some((line) => String(line.event || '').startsWith('purchase.report.alert.')), '告警链路的日志事件也不该再出现');
    // 告警那套内存结构连同它的方法一起删掉了：留着就意味着"还会有人再挂上去"。
    assert.equal(service.pendingReportAlerts, undefined);
    assert.equal(service.sweepBatchAlerts, undefined);
    assert.equal(service.scheduleBatchAlert, undefined);
    assert.equal((await gateway.listAll('purchaseRequest')).length, 1, '不告警 ≠ 不处理：该生成的采购申请照常生成');
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
  }
});

test('异常 → 不静默丢单：任务落成可重试的 failed，记录处理状态保持不变', async () => {
  // 让「解析货品」这一步先失败（模型/读表故障的典型长相），再在下一次投递时恢复。
  let failResolve = true;
  const records = {
    purchaseReport: [reportRecord('rep_retry', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'], 报货批次号: 'BATCH-RETRY'})],
    purchaseOrderBatch: [],
    purchaseRequest: [],
    supplier: SUPPLIERS,
  };
  const { service, store } = makeService({
    gateway: makeGateway(records),
    references: referencesFor({
      prod_1: productFields('8088', '黑色', 'sup_A'),
    }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 2 }] }),
  });
  // 包一层注入进来的 resolver：它才是 processSupplierBatch 真正调用的那份
  // （服务内部对 references 包了超时代理，事后换 service.references 是换不掉的）。
  const proxy = service.references;
  const realResolveProduct = proxy.resolveProduct.bind(proxy);
  proxy.resolveProduct = async (input) => {
    if (failResolve) throw new Error('模拟解析货品失败');
    return realResolveProduct(input);
  };
  const accepted = await service.accept('supplier-report', 'rep_retry');
  const task = await waitForTask(store, accepted.taskId, ['failed']);
  assert.equal(task.status, 'failed', '异常要能被重试，不能卡在 processing');
  assert.equal(task.result, undefined, '失败的批次没有 result');
  // 关键：记录的处理状态**不能**被标成「解析失败」——那是终态，等于把货丢了。
  assert.equal(records.purchaseReport[0].fields.处理状态, '待解析', '异常时记录状态必须保持可重试');

  // 修复后重投 webhook：必须能真正跑出采购申请（证明可重试）。
  failResolve = false;
  const retry = await service.accept('supplier-report', 'rep_retry');
  assert.equal(retry.duplicate, false, 'failed 的任务要允许重跑');
  await waitFor('重试后重新 posted', async () => (await store.get(accepted.taskId))?.status === 'posted');
  assert.equal(records.purchaseRequest.length, 1, '重试要补齐这批货，不能静默丢掉');
  assert.equal(records.purchaseReport[0].fields.处理状态, '已生成申请');
});

test('批次早已生成：再到达的新明细不会重复建单，也不会永远停在待解析', async () => {
  const records = {
    purchaseReport: [
      // 这一批之前已经处理过（记录已是终态）。
      reportRecord('rep_done_a', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'], 报货批次号: 'BATCH-DONE', 处理状态: '已生成申请' }),
      // 事后才补录进来的一条：它自己不该触发第二次采购申请。
      reportRecord('rep_done_b', { 尺码: sizeLink(37), 数量说明: '37码1双', 编号: ['prod_1'], 报货批次号: 'BATCH-DONE'}),
    ],
    purchaseOrderBatch: [],
    purchaseRequest: [],
    supplier: SUPPLIERS,
  };
  const { service, store, images } = makeService({
    gateway: makeGateway(records),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 37, quantity: 1 }] }),
  });
  const accepted = await service.accept('supplier-report', 'rep_done_b');
  await waitFor('事后补录的记录被识别为"早已生成"', async () => (await store.get(accepted.taskId))?.result?.status === 'already_posted');
  const task = await store.get(accepted.taskId);
  assert.equal(task.status, 'completed');
  assert.deepEqual(records.purchaseRequest, [], '早已生成的批次不得再写采购申请');
  assert.equal(images.calls.length, 0, '不得再出图');
  assert.equal(records.purchaseReport[1].fields.处理状态, '已生成申请', '新到的明细要补上终态，不能停在待解析');
});

test('product without supplier association throws clear error', async () => {
  const { service, store } = makeService({
    gateway: makeGateway({
      purchaseReport: [reportRecord('rep_nosup', { 尺码: sizeLink(36), 编号: ['prod_nosup'] })],
    }),
    references: makeReferences({
      resolveProduct: async () => ({ recordId: 'prod_nosup', record: { record_id: 'prod_nosup', fields: { 编号: '8088灰' } } }),
    }),
  });
  const result = await service.accept('supplier-report', 'rep_nosup');
  const task = await waitForTask(store, result.taskId);
  assert.equal(task.status, 'failed');
  assert.ok(task.error.includes('货品信息中未关联供应商'));
});

// ─── 并发确认与幂等恢复（Main Merge Blocker A / B）───

// 让 create 之间出现真实的时间窗口：没有并发保护的实现会在这个窗口里
// 两次读到同一个 awaiting_confirmation 状态。
const slowCreates = (gateway, pause = 5) => {
  const originalCreate = gateway.create;
  gateway.create = async (tableKey, values) => {
    await wait(pause);
    return originalCreate(tableKey, values);
  };
  return gateway;
};

// 模拟「远端写入成功、本地落盘失败」：只让第一次匹配的 update 抛错。
const failingOnceStore = (inner, shouldFail) => {
  let armed = true;
  return {
    create: (...args) => inner.create(...args),
    get: (...args) => inner.get(...args),
    list: (...args) => inner.list(...args),
    update: async (recordId, patch) => {
      if (armed && shouldFail(patch)) {
        armed = false;
        throw new Error('模拟本地落盘失败');
      }
      return inner.update(recordId, patch);
    },
  };
};

const multiSizeReport = (recordId) => reportRecord(recordId, { 尺码: sizeLinks(36, 37), 数量说明: '36码2双，37码1双', 编号: ['prod_1'] });
const twoSizes = makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 2 }, { size: 37, quantity: 1 }] });
const purchaseRecords = (recordId) => ({ purchaseReport: [multiSizeReport(recordId)], purchaseOrderBatch: [], purchaseRequest: [], supplier: SUPPLIERS });

// 处理队列（accept 把工作丢进 setImmediate + 串行队列）清空之前，断言可能会读到"第一条刚写完、
// 第二条还没被守卫拦下"的中间态。并发用例统一等队列空了再断言。
const waitForIdle = async (service) => {
  await waitFor('处理队列清空', async () => service.queues.size === 0, { attempts: 600, pause: 5 });
};

test('A1 并发重收同一条报单 webhook：只生成一个批次和一套采购申请，也不重复发图', async () => {
  const records = purchaseRecords('rep_race');
  const { service, store, images } = makeService({
    gateway: slowCreates(makeGateway(records)),
    recognizer: twoSizes,
  });
  // 飞书重投：同一个 record_id 几乎同时进来两次
  const [first, second] = await Promise.all([
    service.accept('supplier-report', 'rep_race'),
    service.accept('supplier-report', 'rep_race'),
  ]);
  assert.equal(first.taskId, second.taskId);
  await waitForTask(store, first.taskId, ['posted', 'failed']);
  await waitForIdle(service);

  assert.equal(records.purchaseOrderBatch.length, 1, '并发投递不得创建第二个报货批次');
  assert.equal(records.purchaseRequest.length, 2, '并发投递不得把采购申请翻倍');
  const task = await store.get(first.taskId);
  assert.equal(task.status, 'posted');
  assert.equal(task.request_ids.length, 2);
  assert.equal(images.calls.length, 1, '并发投递不得把图重复发一遍');
});


test('A3 已 posted 的报单任务重复投递：不再产生任何写入，也不重复发图', async () => {
  const records = purchaseRecords('rep_done');
  const { service, store, images } = makeService({
    gateway: makeGateway(records),
    recognizer: twoSizes,
  });
  const accepted = await service.accept('supplier-report', 'rep_done');
  await waitForTask(store, accepted.taskId);
  await waitForIdle(service);

  const snapshot = () => [records.purchaseOrderBatch.length, records.purchaseRequest.length].join('/');
  const before = snapshot();
  const imagesBefore = images.calls.length;
  const again = await service.accept('supplier-report', 'rep_done');
  assert.equal(again.duplicate, true);
  await waitForIdle(service);
  assert.equal(snapshot(), before, '重复投递不得新增批次或采购申请');
  assert.equal(images.calls.length, imagesBefore, '重复投递不得重复发图');
});

test('B1 批次已写入远端但本地阶段未落盘：重试只复用，不新建第二个批次', async () => {
  const records = purchaseRecords('rep_crash_batch');
  const dir = tempDir();
  const realStore = new JsonTaskStore({ dir });
  const { service, store } = makeService({
    dir,
    store: failingOnceStore(realStore, (patch) => patch.posting_stage === 'batch_created'),
    gateway: makeGateway(records),
    recognizer: twoSizes,
  });
  const first = await service.accept('supplier-report', 'rep_crash_batch');
  const crashed = await waitForTask(store, first.taskId, ['failed', 'posted']);
  assert.equal(crashed.status, 'failed', '落盘失败后任务必须能重试，不能卡在中间态');
  assert.equal(records.purchaseOrderBatch.length, 1, '第一次已经写出批次');

  // 重收 webhook 重跑：必须复用已有批次，不新建
  const retry = await service.accept('supplier-report', 'rep_crash_batch');
  assert.equal(retry.duplicate, false, 'failed 的任务要允许重跑');
  // 不能直接等 ['posted','failed']：刚 accept 时读到的还是上一次留下的 failed，
  // 会误判成"重试又失败了"。这里明确等它重新走到 posted。
  await waitFor('重试后任务重新 posted', async () => (await store.get(first.taskId))?.status === 'posted');
  assert.equal(records.purchaseOrderBatch.length, 1, '重试必须复用已有批次');
  assert.equal(records.purchaseRequest.length, 2);
});

test('B2 第一条采购申请写完后崩溃：重试补齐其余，且不会重复第一条', async () => {
  const records = purchaseRecords('rep_crash_req');
  const dir = tempDir();
  const realStore = new JsonTaskStore({ dir });
  const { service, store } = makeService({
    dir,
    store: failingOnceStore(realStore, (patch) => String(patch.posting_stage || '').startsWith('request_created:')),
    gateway: makeGateway(records),
    recognizer: twoSizes,
  });
  const first = await service.accept('supplier-report', 'rep_crash_req');
  const crashed = await waitForTask(store, first.taskId, ['failed', 'posted']);
  assert.equal(crashed.status, 'failed');
  assert.equal(records.purchaseRequest.length, 1, '第一次只写出了第一条采购申请');

  await service.accept('supplier-report', 'rep_crash_req');
  await waitFor('重试后任务重新 posted', async () => (await store.get(first.taskId))?.status === 'posted');
  assert.equal(records.purchaseRequest.length, 2, '最终每条明细正好一条采购申请');
  const keys = records.purchaseRequest.map((row) => row.fields.幂等键).sort();
  assert.deepEqual(keys, [
    `purchase_request:${first.taskId}:0`,
    `purchase_request:${first.taskId}:1`,
  ]);
});

test('B3 远端写入成功但响应丢失：按幂等键找回，不创建第二条', async () => {
  const records = {
    purchaseReport: [reportRecord('rep_lost', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'] })],
    purchaseOrderBatch: [],
    purchaseRequest: [],
    supplier: SUPPLIERS,
  };
  const gateway = makeGateway(records);
  const originalCreate = gateway.create;
  gateway.create = async (tableKey, values) => {
    const created = await originalCreate(tableKey, values);
    // 飞书已经写入，但客户端收到的是超时：必须按幂等键回查，不能盲目重发。
    if (tableKey === 'purchaseRequest') throw new Error('socket hang up');
    return created;
  };
  const { service, store } = makeService({
    gateway,
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 2 }] }),
  });
  const accepted = await service.accept('supplier-report', 'rep_lost');
  const task = await waitForTask(store, accepted.taskId, ['posted', 'failed']);
  assert.equal(task.status, 'posted');
  assert.equal(records.purchaseRequest.length, 1, '响应丢失不得产生第二条采购申请');
  assert.equal(records.purchaseOrderBatch.length, 1);
});

test('B4 远端出现两条相同幂等键：停止自动处理并转人工核对', async () => {
  const records = purchaseRecords('rep_dup_key');
  const dir = tempDir();
  const realStore = new JsonTaskStore({ dir });
  // 计划一落盘就注入"人工已经写出两条同键记录"：此时还没创建任何采购申请。
  let injected = false;
  const store = {
    create: (...args) => realStore.create(...args),
    get: (...args) => realStore.get(...args),
    list: (...args) => realStore.list(...args),
    update: async (recordId, patch) => {
      if (!injected && patch.posting_stage === 'posting_plan_created') {
        injected = true;
        const duplicateKey = `purchase_request:${recordId}:0`;
        records.purchaseRequest.push(
          { record_id: 'dup_1', fields: { 幂等键: duplicateKey, 编号: ['prod_1'] } },
          { record_id: 'dup_2', fields: { 幂等键: duplicateKey, 编号: ['prod_1'] } },
        );
      }
      return realStore.update(recordId, patch);
    },
  };
  const { service } = makeService({
    dir,
    store,
    gateway: makeGateway(records),
    recognizer: twoSizes,
  });
  const accepted = await service.accept('supplier-report', 'rep_dup_key');
  const task = await waitForTask(store, accepted.taskId, ['posted', 'failed']);
  assert.equal(task.status, 'failed', '重复业务事实必须停下来，不能挑一条继续');
  assert.ok(String(task.error).includes('命中 2 条记录'), `实际错误：${task.error}`);
  assert.equal(records.purchaseRequest.length, 2, '停止后不得再写出新的采购申请');
});

