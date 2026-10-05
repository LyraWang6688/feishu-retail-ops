const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const { V1ReferenceResolver } = require('../src/services/v1ReferenceResolver');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { PurchaseBatchLocator } = require('../src/services/purchaseBatchLocator');

// 新品的记录链接要用 Base token 拼。本地/CI 没有真配置时给个测试值，
// 才能断言「链接带上了正确的 record_id」。（每个测试文件是独立进程，不会污染别的用例。）
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

// 采购单现在**发到群**（业务负责人：「不用再看经办人了」），群 id 从配置读、**没有默认值**。
// 这个文件里绝大多数用例真正关心的是"采购事实写没写、附件写没写回"，出图/发图是它们的
// 必经步骤，所以在这里给一个测试群 id。
// ⚠️ 「没配群 id 时会怎样」是单独一条用例，它走构造入参 `sandboxChatId` 显式覆盖，
// 不靠改这个全局值（同进程里并发跑用例时改全局会互相污染）。
process.env.PURCHASE_CHAT_ID = process.env.PURCHASE_CHAT_ID || 'oc_test_purchase_group';

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

const makeRecognizer = (overrides = {}) => ({
  parsePurchaseReportText: overrides.parsePurchaseReportText || (async () => [{ size: 36, quantity: 2 }, { size: 37, quantity: 1 }]),
  recognizeLabels: overrides.recognizeLabels || (async () => [{ item_no: '8088', color: '灰色', size: 36, quantity: 1 }]),
  // 到货单识别是可选的：只有「类型 = 到货单」的记录才会调用它，
  // 鞋盒记录的 fake 不需要提供这个方法（和注入式 fake 的真实形态一致）。
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
  drive: {
    media: {
      download: overrides.downloadMedia || (async () => ({ writeFile: async (filePath) => { await fs.promises.writeFile(filePath, 'fake-image'); } })),
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
    // 对外调用的超时：undefined 时用服务自己的默认值，只有超时相关的用例会传。
    mediaTimeoutMs: options.mediaTimeoutMs,
    recognitionTimeoutMs: options.recognitionTimeoutMs,
    imTimeoutMs: options.imTimeoutMs,
    gatewayTimeoutMs: options.gatewayTimeoutMs,
    failureWriteAttempts: options.failureWriteAttempts,
    failureWriteRetryDelayMs: options.failureWriteRetryDelayMs,
    // 到货「等待与提示」的四个阈值：生产上读环境变量，测试里走构造入参用毫秒级复现
    // 「每 1 分钟 / 2 分钟 / 3 分钟」。
    arrivalNoticeIntervalMs: options.arrivalNoticeIntervalMs,
    arrivalAbandonWaitMs: options.arrivalAbandonWaitMs,
    arrivalFailAfterMs: options.arrivalFailAfterMs,
    arrivalNoticeMaxCount: options.arrivalNoticeMaxCount,
    // 报货「归批窗口」：生产默认 4000ms（读 REPORT_BATCH_WINDOW_MS），
    // 单测里压到 20ms —— 验证的是"同一批次号的记录归成一批、窗口到点才处理"，
    // 而不是真的等 4 秒。需要验证窗口本身的用例会显式传更大的值。
    reportBatchWindowMs: options.reportBatchWindowMs ?? 20,
    // 群聊定位器（发到群后写 message_id ↔ 批次映射）指向临时目录：
    // 不传的话服务会自建 data/purchase_group_messages，用例之间会互相看见对方的映射。
    batchLocatorStore: options.batchLocatorStore,
    batchLocator: options.batchLocator,
  });
  return { service, store, gateway, references, recognizer, inventory, client, images, dir };
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// accept() 返回时后台处理并没有结束：它把工作丢进 setImmediate，之后还要解析、
// 写卡片、等批次窗口，耗时取决于机器。固定 sleep 在慢机器上会读到 processing
// 这类中间状态（CI 上就这样失败过），所以统一改为轮询到任务进入稳定状态。
const SETTLED_STATUSES = ['awaiting_confirmation', 'failed', 'cancelled', 'posted', 'completed'];
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

// 到货链路现在会先发一条「收到到货申请，正在识别图片～」的文字提示，再发确认卡片。
// 断言卡片就只看卡片——按消息条数断点会被那条提示带偏。
const cardMessages = (messages) => messages.filter((message) => message.data?.msg_type === 'interactive');
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
  // 采购单发到群、不再是经办人私聊（业务负责人：「不用再看经办人了」）。
  assert.equal(image.params.receive_id_type, 'chat_id');
  assert.equal(image.data.receive_id, 'oc_test_purchase_group');
  assert.equal(text.data.msg_type, 'text');
  assert.equal(text.params.receive_id_type, 'chat_id');
  assert.equal(text.data.receive_id, 'oc_test_purchase_group');
  // @经办人：挂在那条文字说明上（图片消息没有正文，@ 只能跟着文字走）。
  // 业务负责人明确改过：不再 @所有人，只 @这条记录的经办人。
  assert.equal(
    JSON.parse(text.data.content).text,
    '<at user_id="ou_user_1"></at> 金猴 这批 2 条（共 3 双），图可以直接转给供应商。',
  );
  assert.ok(!JSON.parse(text.data.content).text.includes('user_id="all"'), '不允许再 @所有人');

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
  assert.equal(
    JSON.parse(messages[1].data.content).text,
    '<at user_id="ou_user_1"></at> 金猴 这批 2 条（共 3 双），图可以直接转给供应商。',
  );
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
    '<at user_id="ou_user_1"></at> 奥康 这批 1 条（共 1 双），图可以直接转给供应商。',
    '<at user_id="ou_user_1"></at> 金猴 这批 1 条（共 2 双），图可以直接转给供应商。',
  ]);
  // 每条都发到群，没有一个漏到私聊。
  assert.ok(
    messages.every((m) => m.data.receive_id === 'oc_test_purchase_group'),
    '采购单不能有任何一条发到私聊',
  );
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

// ─── 采购到货链路 ───

test('arrival webhook accepts, recognizes images, and sends the arrival detail card', async () => {
  const messages = [];
  const { service, store, gateway } = makeService({
    client: makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } }),
    gateway: makeGateway({
      purchaseArrival: [{ record_id: 'arr_1', fields: { 确认状态: '待确认', 识别状态: '待识别', 报货批次号: ['batch_1'], 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
      purchaseOrderBatch: [{ record_id: 'batch_1', fields: { 报货批次号: 'BH-20260925-0001', 供应商: ['sup_1'] } }],
      purchaseRequest: [{ record_id: 'req_1', fields: { 报货批次号: ['batch_1'], 编号: ['prod_1'], 尺码: sizeLink(36), 数量: 2 } }],
    }),
  });
  const result = await service.accept('arrival', 'arr_1');
  assert.equal(result.accepted, true);
  const task = await waitForTask(store, result.taskId);
  assert.equal(task.status, 'awaiting_confirmation');
  assert.ok(task.draft);
  assert.equal(task.draft.actual.length, 1);
  // 采购差异比对已整体移除：草稿里不再有 differences 这个字段。
  assert.equal(task.draft.differences, undefined, '采购链路不再产生差异');
  // 同上：先落库状态，再发卡片。
  // 只数卡片：到货链路现在还会先发一条「收到，识别中」的文字提示，
  // 用 messages.length 会把那条也算进来。
  await waitFor('到货明细卡片发出', async () => cardMessages(messages).length === 1);
  assert.equal(cardMessages(messages).length, 1);
  const cardText = JSON.stringify(JSON.parse(cardMessages(messages)[0].data.content).elements);
  assert.ok(!cardText.includes('差异'), '卡片上不应再出现差异');
  assert.ok(!cardText.includes('实到'), '卡片上不应再出现申请/实到对比');
  const updated = await gateway.get('purchaseArrival', 'arr_1');
  assert.equal(updated.fields.识别状态, '识别成功');
  assert.equal(updated.fields.确认状态, '待确认');
});

test('arrival with 类型=到货单 uses document recognition and flattens rows into details', async () => {
  const messages = [];
  const calls = { boxes: 0, documents: 0 };
  const { service, store } = makeService({
    client: makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } }),
    recognizer: makeRecognizer({
      recognizeLabels: async () => { calls.boxes += 1; return []; },
      recognizePurchaseDocument: async (filePath) => {
        calls.documents += 1;
        assert.ok(filePath, '单据识别必须拿到已下载到本地的图片路径');
        // 单据上一行一个款号+颜色，尺码矩阵里的数字才是数量；这里模拟模型已经摊平。
        return [
          { item_no: '1366-31', color: '棕色', size: 36, quantity: 1 },
          { item_no: '1366-31', color: '棕色', size: 37, quantity: 2 },
        ];
      },
    }),
    gateway: makeGateway({
      purchaseArrival: [{ record_id: 'arr_doc', fields: { 类型: '到货单', 确认状态: '待确认', 识别状态: '待识别', 报货批次号: ['batch_1'], 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
      purchaseOrderBatch: [{ record_id: 'batch_1', fields: { 报货批次号: 'BH-001' } }],
      purchaseRequest: [{ record_id: 'req_1', fields: { 报货批次号: ['batch_1'], 编号: ['prod_1'], 尺码: sizeLink(36), 数量: 2 } }],
    }),
  });
  const accepted = await service.accept('arrival', 'arr_doc');
  const task = await waitForTask(store, accepted.taskId);
  assert.equal(task.status, 'awaiting_confirmation');
  assert.equal(calls.documents, 1, '类型=到货单 必须走单据识别');
  assert.equal(calls.boxes, 0, '类型=到货单 不能再走鞋盒识别');
  // 摊平后的明细按 货品+尺码 聚合，尺码与数量都要落到 actual 上。
  const quantityBySize = new Map(task.draft.actual.map((item) => [item.size, item.quantity]));
  assert.deepEqual([...quantityBySize.entries()].sort((a, b) => a[0] - b[0]), [[36, 1], [37, 2]]);
  // 到货单与鞋盒走同一条流程；差异比对已移除。
  assert.equal(task.draft.differences, undefined);
  assert.equal(task.draft.direct_arrival, false);
  await waitFor('到货明细卡片发出', async () => cardMessages(messages).length === 1);
});

test('arrival with 类型=鞋盒 or an empty type keeps the original shoe-box recognition', async () => {
  const cases = [
    { label: '鞋盒', recordId: 'arr_type_box', type: '鞋盒' },
    { label: '空值', recordId: 'arr_type_empty', type: undefined },
  ];
  for (const { label, recordId, type } of cases) {
    const calls = { boxes: 0, documents: 0 };
    const fields = { 确认状态: '待确认', 识别状态: '待识别', 报货批次号: ['batch_1'], 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] };
    if (type) fields.类型 = type;
    const { service, store } = makeService({
      recognizer: makeRecognizer({
        recognizeLabels: async () => { calls.boxes += 1; return [{ item_no: '8088', color: '灰色', size: 36, quantity: 1 }]; },
        recognizePurchaseDocument: async () => { calls.documents += 1; return []; },
      }),
      gateway: makeGateway({
        purchaseArrival: [{ record_id: recordId, fields }],
        purchaseOrderBatch: [{ record_id: 'batch_1', fields: { 报货批次号: 'BH-001' } }],
        purchaseRequest: [],
      }),
    });
    const accepted = await service.accept('arrival', recordId);
    const task = await waitForTask(store, accepted.taskId);
    assert.equal(task.status, 'awaiting_confirmation', `类型=${label} 应识别成功`);
    assert.equal(calls.boxes, 1, `类型=${label} 必须走鞋盒识别`);
    assert.equal(calls.documents, 0, `类型=${label} 不能走单据识别`);
    assert.equal(task.draft.actual.length, 1);
  }
});

test('arrival without a batch number is a direct arrival: no error, still inbound', async () => {
  const messages = [];
  const inventory = makeInventory();
  const { service, store, gateway } = makeService({
    inventory,
    client: makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } }),
    gateway: makeGateway({
      purchaseArrival: [{ record_id: 'arr_direct', fields: { 确认状态: '待确认', 识别状态: '待识别', 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
      purchaseInbound: [],
    }),
  });
  const accepted = await service.accept('arrival', 'arr_direct');
  const task = await waitForTask(store, accepted.taskId);
  assert.equal(task.status, 'awaiting_confirmation', '没有报货批次号不再是错误');
  assert.equal(task.draft.direct_arrival, true);
  // 差异比对已移除，不再有「多N」这种误导行。
  assert.equal(task.draft.differences, undefined);
  assert.equal(task.draft.actual.length, 1);
  await waitFor('到货明细卡片发出', async () => cardMessages(messages).length === 1);
  const cardElements = JSON.parse(cardMessages(messages)[0].data.content).elements;
  assert.ok(JSON.stringify(cardElements).includes('无申请直接到货'), '卡片上必须写清楚这是直接到货');

  const result = await service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_arrival' }, 'ou_1');
  assert.ok(result.toast.content.includes('采购已入库'));
  const inbounds = await gateway.listAll('purchaseInbound');
  assert.equal(inbounds.length, 1);
  assert.equal(inbounds[0].fields.数量, 1);
  assert.equal(inventory.calls.length, 1, '直接到货也要真的入库');
});

test('arrival with a batch number loads that batch requests but no longer compares differences', async () => {
  const { service, store } = makeService({
    gateway: makeGateway({
      purchaseArrival: [{ record_id: 'arr_compare', fields: { 确认状态: '待确认', 识别状态: '待识别', 报货批次号: ['batch_1'], 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
      purchaseOrderBatch: [{ record_id: 'batch_1', fields: { 报货批次号: 'BH-001' } }],
      purchaseRequest: [{ record_id: 'req_1', fields: { 报货批次号: ['batch_1'], 编号: ['prod_1'], 尺码: sizeLink(36), 数量: 3 } }],
    }),
  });
  const accepted = await service.accept('arrival', 'arr_compare');
  const task = await waitForTask(store, accepted.taskId);
  assert.equal(task.draft.direct_arrival, false);
  assert.equal(task.draft.batch_no, 'BH-001');
  // 申请明细仍然读出来（入库要挂回采购申请、回写到货状态），但不再算差异。
  assert.equal(task.draft.requests.length, 1);
  assert.equal(task.draft.differences, undefined);
});

// ─── 到货新品自动建档 ───

// 货品表里确实没有这条：resolveProduct 抛带 code 的错，到货链路才敢自动建档。
// 「货号对应多个颜色」这类歧义不带这个 code，必须留给她核对。
const productNotFound = (itemNo, color) => Object.assign(new Error(`找不到货品：${itemNo}${color}`), { code: 'PRODUCT_NOT_FOUND' });

const arrivalWithNewProduct = ({ records, references, recognizer, inventory = makeInventory() } = {}) => makeService({
  inventory,
  gateway: makeGateway(records),
  references,
  recognizer,
});

test('arrival auto-creates the product record for an unknown 货号+颜色 and still inbounds it', async () => {
  const inventory = makeInventory();
  const records = {
    purchaseArrival: [{ record_id: 'arr_new', fields: { 确认状态: '待确认', 识别状态: '待识别', 报货批次号: ['batch_1'], 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
    purchaseOrderBatch: [{ record_id: 'batch_1', fields: { 报货批次号: 'BH-001' } }],
    purchaseRequest: [],
    purchaseInbound: [],
    product: [],
    color: [{ record_id: 'color_black', fields: { 颜色: '黑' } }],
    supplier: [{ record_id: 'sup_9', fields: { 供应商名称: '一代千金' } }],
  };
  const { service, store, gateway } = arrivalWithNewProduct({
    records,
    inventory,
    recognizer: makeRecognizer({
      recognizeLabels: async () => [{ item_no: '3602', color: '黑色', size: 36, quantity: 1, gender: '女', supplier: '一代千金', cost: 128 }],
    }),
    references: makeReferences({
      resolveProduct: async ({ itemNo, color }) => {
        if (itemNo === '3602' && color === '黑色') throw productNotFound(itemNo, color);
        return { recordId: 'prod_1', record: { record_id: 'prod_1', fields: { 编号: '8088灰', 供应商: ['sup_1'] } } };
      },
      resolveSupplier: async (name) => ({ recordId: 'sup_9', record: { record_id: 'sup_9', fields: { 供应商名称: name } } }),
    }),
  });

  const accepted = await service.accept('arrival', 'arr_new');
  // 建档在发完卡片之后才做：等 result 落盘才是这一批真的跑完了。
  const task = await waitForProcessed(store, accepted.taskId);
  assert.equal(task.status, 'awaiting_confirmation');

  assert.equal(records.product.length, 1, '识别到的新品要自动建一条货品记录');
  const created = records.product[0];
  // 五项建档内容一个都不能少：货号 / 颜色 / 供应商 / 类别 / 成本。
  // 只写确定知道的字段：公式字段（编号/货品状态/缺失信息说明）一个都不能写。
  assert.deepEqual([...Object.keys(created.fields)].sort(), ['供应商', '类别', '颜色', '货号', '成本'].sort());
  assert.equal(created.fields.货号, '3602');
  assert.deepEqual(created.fields.颜色, ['color_black'], '「黑」要复用颜色表已有记录');
  assert.deepEqual(created.fields.供应商, ['sup_9']);
  assert.equal(created.fields.类别, 'B', '品名是女鞋 → B');
  assert.equal(created.fields.成本, 128, '识别到价格才写成本');

  // 建档不影响入库：草稿里标出新品，确认后照常写入采购入库和库存。
  assert.equal(task.draft.actual.length, 1);
  assert.equal(task.draft.actual[0].created_product, true);
  assert.equal(task.draft.created_products.length, 1);
  assert.equal(task.draft.created_products[0].product_record_id, created.record_id);
  assert.equal(task.draft.created_products[0].label, '3602黑色');
  assert.match(task.draft.created_products[0].url, new RegExp(`record=${created.record_id}`));

  const result = await service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_arrival' }, 'ou_1');
  assert.ok(result.toast.content.includes('采购已入库'));
  assert.equal((await gateway.listAll('purchaseInbound')).length, 1);
  assert.equal(inventory.calls.length, 1, '新品也要真的入库');
});

test('到货新品：颜色表缺色时后台补一条；卡片只说「已建好」，不再提颜色和缺口', async () => {
  const messages = [];
  const records = {
    purchaseArrival: [{ record_id: 'arr_newcolor', fields: { 确认状态: '待确认', 识别状态: '待识别', 报货批次号: ['batch_1'], 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
    purchaseOrderBatch: [{ record_id: 'batch_1', fields: { 报货批次号: 'BH-001' } }],
    purchaseRequest: [],
    purchaseInbound: [],
    product: [],
    color: [],
    supplier: [],
  };
  const { service, store, client } = arrivalWithNewProduct({
    records,
    recognizer: makeRecognizer({
      recognizeLabels: async () => [{ item_no: '627', color: '香芋紫', size: 37, quantity: 1 }],
    }),
    references: makeReferences({
      resolveProduct: async ({ itemNo, color }) => { throw productNotFound(itemNo, color); },
    }),
  });
  client.im.message.create = async (params) => { messages.push(params); return { code: 0 }; };

  const accepted = await service.accept('arrival', 'arr_newcolor');
  // 建档挪到「发完卡片之后」了：等 result 落盘才是"这一批真的跑完了"。
  const task = await waitForProcessed(store, accepted.taskId);
  assert.equal(task.status, 'awaiting_confirmation');

  assert.equal(records.color.length, 1, '颜色表没有的颜色要自动补一条');
  assert.equal(records.color[0].fields.颜色, '香芋紫');
  assert.deepEqual(records.product[0].fields.颜色, [records.color[0].record_id]);
  assert.deepEqual(task.draft.created_colors, ['香芋紫']);
  assert.equal(task.draft.created_products[0].color_created, true);

  await waitFor('到货明细卡片发出', async () => cardMessages(messages).length === 1);
  const cardText = JSON.stringify(JSON.parse(cardMessages(messages)[0].data.content).elements);
  // 那段独立的「颜色表原本没有…我给你加了一条」按产品负责人要求整段删掉了：
  // 颜色照建，只是不在这张卡片上提。
  assert.ok(!cardText.includes('我给你加了一条'), `卡片不该再提补颜色：${cardText}`);
  assert.ok(!cardText.includes('颜色表原本没有'), `卡片不该再提补颜色：${cardText}`);
  assert.ok(cardText.includes('新品'), '卡片要把新品标出来');
  assert.ok(cardText.includes('已建好基础资料'), '卡片只给结论：基础资料已建好');
  assert.ok(!cardText.includes('还差'), `卡片上不写还差什么：${cardText}`);
});

test('arrival leaves 供应商 empty when the recognized name is not in the supplier table', async () => {
  const records = {
    purchaseArrival: [{ record_id: 'arr_nosup', fields: { 确认状态: '待确认', 识别状态: '待识别', 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
    purchaseInbound: [],
    product: [],
    color: [{ record_id: 'color_black', fields: { 颜色: '黑' } }],
    supplier: [],
  };
  const { service, store } = arrivalWithNewProduct({
    records,
    recognizer: makeRecognizer({
      recognizeLabels: async () => [{ item_no: '3602', color: '黑色', size: 36, quantity: 1, supplier: '查无此厂' }],
    }),
    references: makeReferences({
      resolveProduct: async ({ itemNo, color }) => { throw productNotFound(itemNo, color); },
      resolveSupplier: async (name) => { throw new Error(`供应商管理中找不到：${name}`); },
    }),
  });

  const accepted = await service.accept('arrival', 'arr_nosup');
  const task = await waitForProcessed(store, accepted.taskId);
  assert.equal(task.status, 'awaiting_confirmation', '供应商找不到不能报错');
  assert.equal(records.supplier.length, 0, '不新建供应商');
  assert.equal(records.product[0].fields.供应商, undefined, '找不到就留空，不猜');
});

test('arrival leaves 类别 empty when the label has no 男/女 information', async () => {
  const records = {
    purchaseArrival: [{ record_id: 'arr_nogender', fields: { 确认状态: '待确认', 识别状态: '待识别', 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
    purchaseInbound: [],
    product: [],
    color: [{ record_id: 'color_black', fields: { 颜色: '黑' } }],
    supplier: [],
  };
  const { service, store } = arrivalWithNewProduct({
    records,
    recognizer: makeRecognizer({
      recognizeLabels: async () => [{ item_no: '3602', color: '黑色', size: 36, quantity: 1 }],
    }),
    references: makeReferences({
      resolveProduct: async ({ itemNo, color }) => { throw productNotFound(itemNo, color); },
    }),
  });

  const accepted = await service.accept('arrival', 'arr_nogender');
  await waitForProcessed(store, accepted.taskId);
  assert.equal(records.product.length, 1);
  assert.equal(records.product[0].fields.类别, undefined, '认不出性别就留空，不能默认成 A');
  assert.equal(records.product[0].fields.成本, undefined, '认不出价格就留空，不能瞎填成本');
});

// ─── 真实匹配器 + 到货链路（端到端跑 货号+颜色 → 命中/建档）───
//
// 上面的测试都注入假 resolveProduct，只验到货链路本身；这一组接上真的 V1ReferenceResolver，
// 验「货号+颜色」主路径：编号残缺能命中、颜色对不上要建档、命中多条取第一条并标注。
// 货品表的「颜色」是关联字段，飞书 GET 返回的是 [{ text: '棕', record_ids: [...] }]，这里照实模拟。

const realReferences = (gateway) => {
  const resolver = new V1ReferenceResolver(gateway);
  return {
    resolveProduct: (input) => resolver.resolveProduct(input),
    resolveSupplier: (name) => resolver.resolveSupplier(name),
  };
};

const colorCell = (text, recordId) => [{ text, record_ids: [recordId] }];

test('真实匹配器：单据没有类别（编号残缺）时，货号+颜色照样命中现有货品', async () => {
  const records = {
    purchaseArrival: [{ record_id: 'arr_real_hit', fields: { 确认状态: '待确认', 识别状态: '待识别', 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
    purchaseInbound: [],
    product: [{ record_id: 'prod_1366', fields: { 编号: '1366-31|棕|女鞋', 货号: '1366-31', 颜色: colorCell('棕', 'color_brown') } }],
    color: [{ record_id: 'color_brown', fields: { 颜色: '棕' } }],
    supplier: [],
  };
  const gateway = makeGateway(records);
  const { service, store } = makeService({
    gateway,
    references: realReferences(gateway),
    recognizer: makeRecognizer({
      // 单据上只有款号+颜色，没有类别 → 不可能靠「编号」命中，只能走货号+颜色主路径。
      recognizeLabels: async () => [{ item_no: '1366-31', color: '棕色', size: 36, quantity: 1 }],
    }),
  });

  const accepted = await service.accept('arrival', 'arr_real_hit');
  const task = await waitForTask(store, accepted.taskId);
  assert.equal(task.status, 'awaiting_confirmation');
  assert.equal(task.draft.actual[0].product_record_id, 'prod_1366', '缺类别的单据也要能匹配上');
  assert.equal(task.draft.actual[0].created_product, false);
  assert.equal(records.product.length, 1, '命中现有货品就不该再建档');
  assert.equal(task.draft.actual[0].ambiguous_match, null);
});

test('真实匹配器：货号在但颜色对不上 → 仍然建档，不做「提示核对」的保护', async () => {
  const records = {
    purchaseArrival: [{ record_id: 'arr_real_newcolor', fields: { 确认状态: '待确认', 识别状态: '待识别', 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
    purchaseInbound: [],
    product: [{ record_id: 'prod_brown', fields: { 编号: '8088-26|棕|女鞋', 货号: '8088-26', 颜色: colorCell('棕', 'color_brown') } }],
    color: [{ record_id: 'color_brown', fields: { 颜色: '棕' } }],
    supplier: [],
  };
  const gateway = makeGateway(records);
  const { service, store } = makeService({
    gateway,
    references: realReferences(gateway),
    recognizer: makeRecognizer({
      recognizeLabels: async () => [{ item_no: '8088-26', color: '红', size: 36, quantity: 1 }],
    }),
  });

  const accepted = await service.accept('arrival', 'arr_real_newcolor');
  const task = await waitForProcessed(store, accepted.taskId);
  assert.equal(task.status, 'awaiting_confirmation', '颜色对不上不能报错');
  assert.equal(records.product.length, 2, '货号在、颜色对不上也要新建一条');
  assert.equal(records.product[1].fields.货号, '8088-26');
  assert.equal(records.color.length, 2, '颜色表没有「红」就补一条');
  assert.equal(records.color[1].fields.颜色, '红');
  assert.equal(task.draft.actual[0].created_product, true);
});

test('真实匹配器：货号+颜色命中多条 → 取第一条、不报错，并在卡片上标注条数', async () => {
  const messages = [];
  const records = {
    purchaseArrival: [{ record_id: 'arr_real_amb', fields: { 确认状态: '待确认', 识别状态: '待识别', 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
    purchaseInbound: [],
    // 男/女鞋共用同一货号+颜色——产品负责人已知的小概率情况。
    product: [
      { record_id: 'prod_women', fields: { 编号: '8088-26|棕|女鞋', 货号: '8088-26', 颜色: colorCell('棕', 'color_brown') } },
      { record_id: 'prod_men', fields: { 编号: '8088-26|棕|男鞋', 货号: '8088-26', 颜色: colorCell('棕', 'color_brown') } },
    ],
    color: [{ record_id: 'color_brown', fields: { 颜色: '棕' } }],
    supplier: [],
  };
  const gateway = makeGateway(records);
  const { service, store } = makeService({
    gateway,
    client: makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } }),
    references: realReferences(gateway),
    recognizer: makeRecognizer({
      recognizeLabels: async () => [{ item_no: '8088-26', color: '棕色', size: 36, quantity: 1 }],
    }),
  });

  const accepted = await service.accept('arrival', 'arr_real_amb');
  const task = await waitForTask(store, accepted.taskId);
  assert.equal(task.status, 'awaiting_confirmation', '命中多条不能报错、不能停下');
  assert.equal(records.product.length, 2, '命中多条时不能建档');
  assert.equal(task.draft.actual[0].product_record_id, 'prod_women', '取第一条');
  assert.deepEqual(task.draft.actual[0].ambiguous_match, { count: 2, color: '棕', number: '808826棕女鞋' });

  // 只数卡片：到货链路现在还会先发一条「收到，识别中」的文字提示。
  await waitFor('到货明细卡片发出', async () => cardMessages(messages).length === 1);
  const cardText = JSON.stringify(JSON.parse(cardMessages(messages)[0].data.content).elements);
  assert.ok(cardText.includes('匹配到 2 条'), `卡片要标注匹配到几条：${cardText}`);
  assert.ok(cardText.includes('已取'), `卡片要标注取了哪一条：${cardText}`);
});

test('arrival for a known product creates nothing and behaves exactly as before', async () => {
  const records = {
    purchaseArrival: [{ record_id: 'arr_known', fields: { 确认状态: '待确认', 识别状态: '待识别', 报货批次号: ['batch_1'], 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
    purchaseOrderBatch: [{ record_id: 'batch_1', fields: { 报货批次号: 'BH-001' } }],
    purchaseRequest: [],
    purchaseInbound: [],
    product: [{ record_id: 'prod_1', fields: { 货号: '8088', 颜色: ['color_gray'], 编号: '8088灰' } }],
    color: [{ record_id: 'color_gray', fields: { 颜色: '灰' } }],
    supplier: [],
  };
  const { service, store } = makeService({
    gateway: makeGateway(records),
    references: makeReferences({
      resolveProduct: async () => ({ recordId: 'prod_1', record: records.product[0] }),
    }),
  });

  const accepted = await service.accept('arrival', 'arr_known');
  const task = await waitForProcessed(store, accepted.taskId);
  assert.equal(task.status, 'awaiting_confirmation');
  assert.equal(records.product.length, 1, '老货品不能建新记录');
  assert.equal(records.color.length, 1, '老货品不能动颜色表');
  assert.deepEqual(task.draft.created_products, []);
  assert.deepEqual(task.draft.created_colors, []);
  assert.equal(task.draft.actual[0].created_product, false);
  assert.equal(task.draft.actual[0].product_number, '8088灰', '仍然用表里的完整编号');
});

test('到货新品：缺失字段只落在草稿/日志里，卡片上不写"还差什么"', async () => {
  const messages = [];
  const records = {
    purchaseArrival: [{ record_id: 'arr_gaps', fields: { 确认状态: '待确认', 识别状态: '待识别', 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
    purchaseInbound: [],
    product: [],
    color: [{ record_id: 'color_black', fields: { 颜色: '黑' } }],
    supplier: [],
  };
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
  const { service, store, client } = makeService({
    gateway,
    references: makeReferences({
      resolveProduct: async ({ itemNo, color }) => { throw productNotFound(itemNo, color); },
    }),
    recognizer: makeRecognizer({
      recognizeLabels: async () => [{ item_no: '3602', color: '黑色', size: 36, quantity: 1 }],
    }),
  });
  client.im.message.create = async (params) => { messages.push(params); return { code: 0 }; };

  const accepted = await service.accept('arrival', 'arr_gaps');
  const task = await waitForProcessed(store, accepted.taskId);
  // 缺口照旧算出来（日志和草稿排查要用），但产品负责人的要求是**不上卡片**。
  assert.deepEqual(task.draft.created_products[0].missing, ['成本', '品类']);
  assert.equal(task.draft.created_products[0].missing_sample_image, true);
  assert.equal(task.draft.created_products[0].completeness_readable, true);

  await waitFor('到货明细卡片发出', async () => cardMessages(messages).length === 1);
  const cardText = JSON.stringify(JSON.parse(cardMessages(messages)[0].data.content).elements);
  assert.ok(!cardText.includes('还差'), `卡片不能写"还差什么"：${cardText}`);
  assert.ok(!cardText.includes('点记录去补'), `卡片不能引导她去补字段：${cardText}`);
  assert.ok(!cardText.includes('成本'), `缺口字段名不该出现在卡片上：${cardText}`);
  assert.ok(cardText.includes('已建好基础资料'), `卡片只给结论，实际：${cardText}`);
});

test('建档失败可重试：已经建好的那条不重复建，她点确认时补齐剩下的再入库', async () => {
  const records = {
    purchaseArrival: [{ record_id: 'arr_retry_new', fields: { 确认状态: '待确认', 识别状态: '待识别', 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
    purchaseInbound: [],
    product: [],
    color: [{ record_id: 'color_black', fields: { 颜色: '黑色' } }],
    supplier: [],
  };
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
  const { service, store } = makeService({
    gateway,
    references: makeReferences({
      resolveProduct: async ({ itemNo, color }) => { throw productNotFound(itemNo, color); },
    }),
    recognizer: makeRecognizer({
      recognizeLabels: async () => [
        { item_no: '3602', color: '黑色', size: 36, quantity: 1 },
        { item_no: '3603', color: '黑色', size: 36, quantity: 1 },
      ],
    }),
  });

  const accepted = await service.accept('arrival', 'arr_retry_new');
  const first = await waitForProcessed(store, accepted.taskId);
  assert.equal(first.draft.creation_state, 'failed', '有一条没建成功，状态要标失败（不能静默）');
  assert.match(first.draft.creation_error, /模拟第二条建档失败/, '失败原因要写进草稿给她看');
  assert.equal(records.product.length, 1, '第一条已经建好了');
  assert.equal(records.product[0].fields.货号, '3602');

  // 她点确认：先补齐没建好的那条，再入库；已经建好的那条不能变成第二条货品。
  const result = await service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_arrival' }, 'ou_1');
  assert.ok(result.toast.content.includes('采购已入库'));
  assert.equal(records.product.length, 2, '重试只补建缺的那条，不重复建第一条');
  assert.equal(createCalls, 3, '第一次 2 次（1 次成功 1 次失败）+ 重试 1 次');
  assert.equal((await gateway.listAll('purchaseInbound')).length, 2, '两条明细都要入库');
});

test('建档一直失败：明确告诉她原因，且不会假装入库', async () => {
  const records = {
    purchaseArrival: [{ record_id: 'arr_create_fail', fields: { 确认状态: '待确认', 识别状态: '待识别', 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
    purchaseInbound: [],
    product: [],
    color: [{ record_id: 'color_black', fields: { 颜色: '黑色' } }],
    supplier: [],
  };
  const gateway = makeGateway(records);
  gateway.create = async (tableKey, semanticValues) => {
    if (tableKey === 'product') throw new Error('模拟建档总失败');
    return makeGateway(records).create(tableKey, semanticValues);
  };
  const { service, store } = makeService({
    gateway,
    references: makeReferences({
      resolveProduct: async ({ itemNo, color }) => { throw productNotFound(itemNo, color); },
    }),
    recognizer: makeRecognizer({
      recognizeLabels: async () => [{ item_no: '3602', color: '黑色', size: 36, quantity: 1 }],
    }),
  });

  const accepted = await service.accept('arrival', 'arr_create_fail');
  const task = await waitForProcessed(store, accepted.taskId);
  assert.equal(task.draft.creation_state, 'failed');
  assert.match(task.draft.creation_error, /模拟建档总失败/);

  // 卡片发失败不成立——识别本身是成功的：记录不能停在「识别失败」。
  assert.notEqual(records.purchaseArrival[0].fields.识别状态, '识别失败');

  await assert.rejects(
    () => service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_arrival' }, 'ou_1'),
    /新品建档没成功|模拟建档总失败/,
    '建档失败必须明确告诉她原因，不能静默',
  );
  assert.equal((await gateway.listAll('purchaseInbound')).length, 0, '建不出货品就不能入库，更不能假装入了');

  // 失败可重试：确认失败之后再点一次，仍然是走同一条幂等路径。
  gateway.create = makeGateway(records).create;
  const result = await service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_arrival' }, 'ou_1');
  assert.ok(result.toast.content.includes('采购已入库'), '修好之后点确认要能成功入库');
  assert.equal(records.product.length, 1);
});

// 合并 #57（报单免确认 + 出图）时踩到的坑：两条链路各加了一个同名 `sendText`，
// #57 的那个失败即抛错、#58 的这个只记日志。JS 类体里**后定义的覆盖先定义的**，
// 于是到货的「收到即提示」被换成了会抛错的实现——只要那条提示发不出去（IM 限流、
// 缺权限、网络抖动），整条到货识别就在建档之前被打断：货品没建、明细没识别，
// 用户只看到「识别失败」。这条用例钉住「提示是尽力而为，不能反过来把识别搞失败」。
test('「收到即提示」发失败不能中断到货识别：货照样识别、照样建档、卡片照样发', async () => {
  const records = { purchaseArrival: [arrivalRecord('arr_notice_fail')], purchaseInbound: [], product: [], color: [], supplier: [] };
  const messages = [];
  const client = makeClient({
    sendMessage: async (params) => {
      messages.push(params);
      // 只让文字提示失败；确认卡片走同一个 im.message.create，必须成功。
      if (params?.data?.msg_type === 'text') throw new Error('模拟提示发送失败');
      return { code: 0 };
    },
  });
  const { service, store } = makeService({
    client,
    gateway: makeGateway(records),
    references: makeReferences({
      resolveProduct: async ({ itemNo, color }) => { throw productNotFound(itemNo, color); },
    }),
    recognizer: makeRecognizer({
      recognizeLabels: async () => [{ item_no: '3602', color: '黑色', size: 36, quantity: 1 }],
    }),
  });

  const accepted = await service.accept('arrival', 'arr_notice_fail');
  const task = await waitForProcessed(store, accepted.taskId);

  // 提示发不出去，但流程必须照常走完。
  assert.equal(task.status, 'awaiting_confirmation', '提示失败不能让整条到货识别失败');
  assert.equal(records.product.length, 1, '提示失败也必须建好货品');
  assert.equal(records.color.length, 1, '提示失败也必须建好颜色');
  assert.equal(cardMessages(messages).length, 1, '确认卡片必须照发');
  // 记录不能被写成「识别失败」——它其实识别成功了。
  assert.notEqual(records.purchaseArrival[0].fields.识别状态, '识别失败');
});

test('arrival duplicate webhook is ignored', async () => {
  const { service, store } = makeService({
    gateway: makeGateway({
      purchaseArrival: [{ record_id: 'arr_dup', fields: { 确认状态: '待确认', 报货批次号: ['batch_1'], 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
      purchaseOrderBatch: [{ record_id: 'batch_1', fields: { 报货批次号: 'BH-001' } }],
      purchaseRequest: [],
    }),
  });
  const first = await service.accept('arrival', 'arr_dup');
  await waitForTask(store, first.taskId);
  const second = await service.accept('arrival', 'arr_dup');
  assert.equal(second.duplicate, true);
});

test('arrival confirm creates inbound records and updates request arrival status', async () => {
  const inventory = makeInventory();
  const { service, store, gateway } = makeService({
    inventory,
    gateway: makeGateway({
      purchaseArrival: [{ record_id: 'arr_conf', fields: { 确认状态: '待确认', 报货批次号: ['batch_1'], 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
      purchaseOrderBatch: [{ record_id: 'batch_1', fields: { 报货批次号: 'BH-001' } }],
      purchaseRequest: [{ record_id: 'req_1', fields: { 报货批次号: ['batch_1'], 编号: ['prod_1'], 尺码: sizeLink(36), 数量: 2 } }],
      purchaseInbound: [],
    }),
  });
  const accepted = await service.accept('arrival', 'arr_conf');
  await waitForTask(store, accepted.taskId);
  const result = await service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_arrival' }, 'ou_1');
  assert.ok(result.toast.content.includes('采购已入库'));
  const inbounds = await gateway.listAll('purchaseInbound');
  assert.equal(inbounds.length, 1);
  assert.deepEqual(inbounds[0].fields.尺码, sizeLink(36));
  assert.equal(inbounds[0].fields.数量, 1);
  const request = await gateway.get('purchaseRequest', 'req_1');
  assert.equal(request.fields.到货状态, '部分到货');
  const arrival = await gateway.get('purchaseArrival', 'arr_conf');
  assert.equal(arrival.fields.确认状态, '已确认');
});

test('two identical product sizes in one arrival create one inbound for two pairs, including on retry', async () => {
  const inventory = makeInventory();
  const { service, store, gateway } = makeService({
    inventory,
    recognizer: makeRecognizer({ recognizeLabels: async () => [
      { item_no: '8088', color: '灰色', size: 36, quantity: 1 },
      { item_no: '8088', color: '灰色', size: 36, quantity: 1 },
    ] }),
    gateway: makeGateway({
      purchaseArrival: [{ record_id: 'arr_two_same', fields: { 确认状态: '待确认', 报货批次号: ['batch_1'], 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
      purchaseOrderBatch: [{ record_id: 'batch_1', fields: { 报货批次号: 'BH-001' } }],
      purchaseRequest: [{ record_id: 'req_1', fields: { 报货批次号: ['batch_1'], 编号: ['prod_1'], 尺码: sizeLink(36), 数量: 2 } }],
      purchaseInbound: [],
    }),
  });
  const accepted = await service.accept('arrival', 'arr_two_same');
  const draft = (await waitForTask(store, accepted.taskId)).draft;
  assert.equal(draft.actual.length, 1);
  assert.equal(draft.actual[0].quantity, 2);
  await service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_arrival' }, 'ou_1');
  await service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_arrival' }, 'ou_1');
  const inbounds = await gateway.listAll('purchaseInbound');
  assert.equal(inbounds.length, 1);
  assert.equal(inbounds[0].fields.数量, 2);
  assert.equal(inventory.calls.length, 1);
  assert.equal(inventory.calls[0].quantity, 2);
  assert.equal((await gateway.get('purchaseRequest', 'req_1')).fields.到货状态, '全部到货');
});

test('arrival confirm with inventory enabled actually calls inventory.applyPurchase', async () => {
  const inventory = makeInventory();
  const { service, store } = makeService({
    inventory,
    enablePurchaseInventory: true,
    gateway: makeGateway({
      purchaseArrival: [{ record_id: 'arr_inv', fields: { 确认状态: '待确认', 报货批次号: ['batch_1'], 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
      purchaseOrderBatch: [{ record_id: 'batch_1', fields: { 报货批次号: 'BH-001' } }],
      purchaseRequest: [],
      purchaseInbound: [],
    }),
  });
  const accepted = await service.accept('arrival', 'arr_inv');
  await waitForTask(store, accepted.taskId);
  await service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_arrival' }, 'ou_1');
  assert.equal(inventory.calls.length, 1);
  assert.equal(inventory.calls[0].productRecordId, 'prod_1');
  assert.equal(inventory.calls[0].size, 36);
  assert.equal(inventory.calls[0].quantity, 1);
  assert.ok(inventory.calls[0].purchaseInboundRecordId);
});


test('arrival confirm is idempotent — second confirm does not create duplicate inbound', async () => {
  const inventory = makeInventory();
  const { service, store, gateway } = makeService({
    inventory,
    gateway: makeGateway({
      purchaseArrival: [{ record_id: 'arr_idem', fields: { 确认状态: '待确认', 报货批次号: ['batch_1'], 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
      purchaseOrderBatch: [{ record_id: 'batch_1', fields: { 报货批次号: 'BH-001' } }],
      purchaseRequest: [],
      purchaseInbound: [],
    }),
  });
  const accepted = await service.accept('arrival', 'arr_idem');
  await waitForTask(store, accepted.taskId);
  await service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_arrival' }, 'ou_1');
  const firstCount = (await gateway.listAll('purchaseInbound')).length;
  await service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_arrival' }, 'ou_1');
  const secondCount = (await gateway.listAll('purchaseInbound')).length;
  assert.equal(firstCount, 1);
  assert.equal(secondCount, 1);
});

test('arrival cancel updates confirm status', async () => {
  const { service, store, gateway } = makeService({
    gateway: makeGateway({
      purchaseArrival: [{ record_id: 'arr_cancel', fields: { 确认状态: '待确认', 报货批次号: ['batch_1'], 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
      purchaseOrderBatch: [{ record_id: 'batch_1', fields: { 报货批次号: 'BH-001' } }],
      purchaseRequest: [],
    }),
  });
  const accepted = await service.accept('arrival', 'arr_cancel');
  await waitForTask(store, accepted.taskId);
  await service.handleCardAction({ draft_id: accepted.taskId, action: 'cancel_purchase_arrival' }, 'ou_1');
  const updated = await gateway.get('purchaseArrival', 'arr_cancel');
  assert.equal(updated.fields.确认状态, '已取消');
});

test('arrival with no images throws recognition failure', async () => {
  const { service, store, gateway } = makeService({
    gateway: makeGateway({
      purchaseArrival: [{ record_id: 'arr_noimg', fields: { 确认状态: '待确认', 识别状态: '待识别', 报货批次号: ['batch_1'], 图片: [], 验收人: [{ id: 'ou_1' }] } }],
      purchaseOrderBatch: [{ record_id: 'batch_1', fields: { 报货批次号: 'BH-001' } }],
      purchaseRequest: [],
    }),
  });
  const accepted = await service.accept('arrival', 'arr_noimg');
  const task = await waitForTask(store, accepted.taskId);
  assert.equal(task.status, 'failed');
  assert.ok(task.error.includes('没有鞋盒图片'));
  // process() 的失败分支是先落任务终态、再补写远端记录的，所以「任务已经 failed」
  // 不等于「到货记录已经标成识别失败」：中间还有一个很短的窗口，慢机器上直接读
  // 会读到中间态「识别中」（CI 上撞到过一次）。这里断言的是记录，就等到记录为止。
  await waitFor('到货记录标记识别失败', async () => {
    const record = await gateway.get('purchaseArrival', 'arr_noimg');
    return record?.fields?.识别状态 === '识别失败';
  });
  const updated = await gateway.get('purchaseArrival', 'arr_noimg');
  assert.equal(updated.fields.识别状态, '识别失败');
});

// ─── 到货识别不能卡死：超时/异常必须失败得看得见 ───
//
// 线上 2026-10-05：一条到货记录被写成「识别中」之后就再也没有任何输出——进程没崩、
// 健康检查还能秒回，是某个 await 永远不返回（飞书 SDK 的 HTTP 客户端不设 timeout，
// 模型客户端默认 10 分钟且重试 2 次，最坏能挂半小时）。
// 下面这几条钉住两件事：**卡死不可能发生**、**失败一定看得见**（记录 + 消息）。

const never = () => new Promise(() => {});

const arrivalRecord = (recordId, extra = {}) => ({
  record_id: recordId,
  fields: {
    确认状态: '待确认', 识别状态: '待识别', 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }], ...extra,
  },
});

test('图片下载超时：记录写成识别失败（用字段里真实存在的选项），并告诉用户重传', async () => {
  const messages = [];
  const { service, store, gateway } = makeService({
    mediaTimeoutMs: 20,
    client: makeClient({
      sendMessage: async (params) => { messages.push(params); return { code: 0 }; },
      // 下载挂住：飞书 SDK 的 HTTP 客户端没有 timeout，现实里就是这样卡住的。
      downloadMedia: async () => never(),
    }),
    gateway: makeGateway({ purchaseArrival: [arrivalRecord('arr_download_timeout')] }),
  });

  const accepted = await service.accept('arrival', 'arr_download_timeout');
  const task = await waitForTask(store, accepted.taskId, ['failed']);
  assert.match(task.error, /下载到货图片超时/);

  await waitFor('到货记录标记识别失败', async () => {
    const record = await gateway.get('purchaseArrival', 'arr_download_timeout');
    return record?.fields?.识别状态 === '识别失败';
  });
  const record = await gateway.get('purchaseArrival', 'arr_download_timeout');
  assert.equal(record.fields.识别状态, '识别失败');
  // 「识别失败原因」要是人话，不是 axios/OpenAI 的原始报错。
  assert.equal(record.fields.识别失败原因, '识别超时');

  await waitFor('失败提示发出', async () => textMessages(messages).some((text) => text.includes('识别没成功')));
  assert.equal(
    textMessages(messages).find((text) => text.includes('识别没成功')),
    '到货图片识别没成功（识别超时），请重传一次图片，或直接在记录里手工填写～',
  );
});

test('模型识别超时（到货单分支）：记录写成识别失败，并告诉用户重传', async () => {
  const messages = [];
  const { service, store, gateway } = makeService({
    recognitionTimeoutMs: 20,
    client: makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } }),
    // 线上卡住的就是这条分支：类型=到货单 → recognizePurchaseDocument。
    recognizer: makeRecognizer({ recognizePurchaseDocument: async () => never() }),
    gateway: makeGateway({ purchaseArrival: [arrivalRecord('arr_model_timeout', { 类型: '到货单' })] }),
  });

  const accepted = await service.accept('arrival', 'arr_model_timeout');
  const task = await waitForTask(store, accepted.taskId, ['failed']);
  assert.match(task.error, /识别到货单超时/);

  await waitFor('到货记录标记识别失败', async () => {
    const record = await gateway.get('purchaseArrival', 'arr_model_timeout');
    return record?.fields?.识别状态 === '识别失败';
  });
  const record = await gateway.get('purchaseArrival', 'arr_model_timeout');
  assert.equal(record.fields.识别状态, '识别失败');
  assert.equal(record.fields.识别失败原因, '识别超时');
  await waitFor('失败提示发出', async () => textMessages(messages).some((text) => text.includes('识别没成功')));
});

test('模型客户端自己先超时（英文报错）也写成「识别超时」这一句人话', async () => {
  const messages = [];
  const { service, store, gateway } = makeService({
    client: makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } }),
    // OpenAI SDK 自己的超时错误长这样：APIConnectionTimeoutError + "Request timed out."
    // 原文直接写进「识别失败原因」就是一列英文，她看不懂。
    recognizer: makeRecognizer({
      recognizeLabels: async () => {
        throw Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });
      },
    }),
    gateway: makeGateway({ purchaseArrival: [arrivalRecord('arr_sdk_timeout')] }),
  });

  const accepted = await service.accept('arrival', 'arr_sdk_timeout');
  await waitForTask(store, accepted.taskId, ['failed']);
  await waitFor('到货记录标记识别失败', async () => {
    const record = await gateway.get('purchaseArrival', 'arr_sdk_timeout');
    return record?.fields?.识别状态 === '识别失败';
  });
  const record = await gateway.get('purchaseArrival', 'arr_sdk_timeout');
  assert.equal(record.fields.识别失败原因, '识别超时');
  await waitFor('失败提示发出', async () => textMessages(messages).some((text) => text.includes('识别没成功')));
});

test('未预期异常：状态从「识别中」被推出去，不会永远停在识别中', async () => {
  const messages = [];
  const statuses = [];
  const base = makeGateway({ purchaseArrival: [arrivalRecord('arr_boom', { 类型: '到货单' })] });
  const gateway = {
    ...base,
    update: async (tableKey, recordId, values) => {
      // 记下这条记录被写过的每一个识别状态，用来证明「识别中」确实写出去过、之后被推出去了。
      if (tableKey === 'purchaseArrival' && values.recognitionStatus) statuses.push(values.recognitionStatus);
      return base.update(tableKey, recordId, values);
    },
  };
  const { service, store } = makeService({
    client: makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } }),
    recognizer: makeRecognizer({
      recognizePurchaseDocument: async () => { throw new Error('模型返回了预期之外的东西'); },
    }),
    gateway,
  });

  const accepted = await service.accept('arrival', 'arr_boom');
  const task = await waitForTask(store, accepted.taskId, ['failed']);
  assert.match(task.error, /预期之外/);
  await waitFor('到货记录离开识别中', async () => {
    const record = await base.get('purchaseArrival', 'arr_boom');
    return record?.fields?.识别状态 && record.fields.识别状态 !== '识别中';
  });
  const record = await base.get('purchaseArrival', 'arr_boom');
  assert.deepEqual(statuses, ['识别中', '识别失败'], '先写识别中，异常后必须写成失败态');
  assert.equal(record.fields.识别状态, '识别失败');
  assert.ok(record.fields.识别失败原因, '失败原因不能空着');
  await waitFor('失败提示发出', async () => textMessages(messages).some((text) => text.includes('识别没成功')));
});

test('失败态第一次写不出去会重试：记录仍然不会停在「识别中」', async () => {
  const records = { purchaseArrival: [arrivalRecord('arr_retry_write')] };
  const base = makeGateway(records);
  let failureWrites = 0;
  const gateway = {
    ...base,
    update: async (tableKey, recordId, values) => {
      if (tableKey === 'purchaseArrival' && values.recognitionStatus === '识别失败') {
        failureWrites += 1;
        // 第一次模拟飞书写入抖动：不重试的话记录就永远停在「识别中」。
        if (failureWrites === 1) throw new Error('模拟飞书写入抖动');
      }
      return base.update(tableKey, recordId, values);
    },
  };
  const { service, store } = makeService({
    recognizer: makeRecognizer({ recognizeLabels: async () => { throw new Error('识别炸了'); } }),
    gateway,
  });

  const accepted = await service.accept('arrival', 'arr_retry_write');
  await waitForTask(store, accepted.taskId, ['failed']);
  await waitFor('到货记录标记识别失败', async () => {
    const record = await base.get('purchaseArrival', 'arr_retry_write');
    return record?.fields?.识别状态 === '识别失败';
  });
  assert.equal(failureWrites, 2, '第一次写入失败后必须重试');
});

test('确认有图片后立刻发「已收到，正在识别图片～」，在下载和识别之前', async () => {
  const messages = [];
  const order = [];
  const { service, store } = makeService({
    client: makeClient({
      sendMessage: async (params) => {
        messages.push(params);
        order.push(`send:${params.data.msg_type}`);
        return { code: 0 };
      },
      downloadMedia: async () => {
        order.push('download');
        return { writeFile: async () => { order.push('write'); } };
      },
    }),
    recognizer: makeRecognizer({
      recognizeLabels: async () => {
        order.push('recognize');
        // 识别开始时「已收到」必须已经发出去了——这就是「刚开始处理时」的定义。
        assert.deepEqual(textMessages(messages), ['收到到货申请，正在识别图片～']);
        return [{ item_no: '8088', color: '灰色', size: 36, quantity: 1 }];
      },
    }),
    gateway: makeGateway({ purchaseArrival: [arrivalRecord('arr_ack')] }),
  });

  const accepted = await service.accept('arrival', 'arr_ack');
  const task = await waitForTask(store, accepted.taskId);
  assert.equal(task.status, 'awaiting_confirmation');
  assert.deepEqual(order, ['send:text', 'download', 'write', 'recognize', 'send:interactive']);
  // 一条提示 + 一张卡片；提示只发一次。
  assert.deepEqual(textMessages(messages), ['收到到货申请，正在识别图片～']);
  assert.equal(cardMessages(messages).length, 1);
});

// ─── 到货「等待与提示」：每 1 分钟补发 / 2 分钟放弃等待 / 3 分钟判失败＋迟到结果救回 ───
//
// 产品负责人看完一次真实的到货识别（82 秒，比她设的 60 秒超时长）后定的六条规则。
// 这组用例一律**轮询到不变量成立**（waitFor / waitForTask），不用固定 sleep 卡机器速度：
// 这个仓库已经因为时序敏感挂过好几次 CI。
//
// 阈值全部走构造入参（等价于环境变量），毫秒级，让"1 分钟/2 分钟/3 分钟"能在测试里秒级复现。

const ARRIVAL_RECEIVED = '收到到货申请，正在识别图片～';
const ARRIVAL_WAITING = '还在识别中，请稍等～';
const waitingNotices = (messages) => textMessages(messages).filter((text) => text === ARRIVAL_WAITING);

// 可由测试手动放行的 Promise：用来制造"识别还在跑"的中间态，
// 断言的是"到某个点之前/之后发生了什么"，而不是"睡了多久"。
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

// 结构化日志的出口就是 console.log/warn/error（src/utils/logger.js）。
// 捕获它们就能断言"放弃等待只记了日志、没有别的动作"这类约定。
const captureLogs = () => {
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => { lines.push(args.map((value) => String(value)).join(' ')); };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  return {
    lines,
    events: (event) => lines.filter((line) => line.includes(`"event":"${event}"`)),
    restore: () => { console.log = originals.log; console.warn = originals.warn; console.error = originals.error; },
  };
};

test('配套项：「写识别中」和「发提示」并行——串行实现下第二个根本不会开始，这条会超时', async () => {
  const noticeGate = deferred();
  const statusGate = deferred();
  let noticeStarted = false;
  let statusWriteStarted = false;
  const messages = [];
  const base = makeGateway({ purchaseArrival: [arrivalRecord('arr_parallel')] });
  const gateway = {
    ...base,
    update: async (tableKey, recordId, values) => {
      if (tableKey === 'purchaseArrival' && values.recognitionStatus === '识别中') {
        statusWriteStarted = true;
        // 卡住不写：只有"并行"才会轮到后面那个也开始。
        await statusGate.promise;
      }
      return base.update(tableKey, recordId, values);
    },
  };
  const { service, store } = makeService({
    gateway,
    client: makeClient({
      sendMessage: async (params) => {
        messages.push(params);
        if (params?.data?.msg_type === 'text') {
          noticeStarted = true;
          await noticeGate.promise;
        }
        return { code: 0 };
      },
    }),
  });

  const accepted = await service.accept('arrival', 'arr_parallel');
  // 两边都"发起"了才算并行：提示发到一半时，写识别中也必须已经在路上。
  await waitFor('提示与写状态同时发起', () => noticeStarted && statusWriteStarted, { attempts: 300, pause: 5 });
  noticeGate.resolve();
  statusGate.resolve();
  const task = await waitForTask(store, accepted.taskId);
  assert.equal(task.status, 'awaiting_confirmation');
  assert.deepEqual(textMessages(messages), [ARRIVAL_RECEIVED]);
});

test('② 每 1 分钟补发「还在识别中」；处理完成后立刻停止，不再补发', async () => {
  const release = deferred();
  const messages = [];
  const { service, store } = makeService({
    arrivalNoticeIntervalMs: 20,
    client: makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } }),
    recognizer: makeRecognizer({
      recognizeLabels: async () => {
        await release.promise;
        return [{ item_no: '8088', color: '灰色', size: 36, quantity: 1 }];
      },
    }),
    gateway: makeGateway({ purchaseArrival: [arrivalRecord('arr_repeat_notice')] }),
  });

  const accepted = await service.accept('arrival', 'arr_repeat_notice');
  await waitFor('收到提示', () => textMessages(messages).includes(ARRIVAL_RECEIVED));
  // 轮询到"补发确实发生过"（而不是死等一个固定时长）。
  await waitFor('补发到 3 条', () => waitingNotices(messages).length >= 3, { attempts: 600, pause: 5 });

  release.resolve();
  const task = await waitForTask(store, accepted.taskId);
  assert.equal(task.status, 'awaiting_confirmation');
  // ⑥ 处理完成 → 定时器立刻清掉：服务里不残留任何等待点（这是最强的"停止了"证据）。
  assert.equal(service.arrivalWaits.size, 0, '处理完成后不能残留等待定时器');

  const afterDone = waitingNotices(messages).length;
  // 静默期检查：留够 3 个间隔。定时器没清掉的话这里一定会多出好几条。
  await wait(60);
  assert.equal(waitingNotices(messages).length, afterDone, '处理完成后不能再补发');
  assert.equal(cardMessages(messages).length, 1);
});

test('③ 2 分钟放弃等待 ≠ 失败：只记日志，不取消请求、不写失败态，结果回来照常处理', async () => {
  const release = deferred();
  const logs = captureLogs();
  try {
    let recognizeCalls = 0;
    const messages = [];
    const { service, store, gateway } = makeService({
      arrivalAbandonWaitMs: 20,
      arrivalFailAfterMs: 60_000, // 这条用例里到不了判失败
      client: makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } }),
      recognizer: makeRecognizer({
        recognizeLabels: async () => {
          recognizeCalls += 1;
          await release.promise;
          return [{ item_no: '8088', color: '灰色', size: 36, quantity: 1 }];
        },
      }),
      gateway: makeGateway({ purchaseArrival: [arrivalRecord('arr_abandon')], purchaseInbound: [] }),
    });

    const accepted = await service.accept('arrival', 'arr_abandon');
    await waitFor('放弃等待日志', () => logs.events('purchase.arrival.wait.abandoned').length === 1);
    const abandoned = JSON.parse(logs.events('purchase.arrival.wait.abandoned')[0]);
    assert.equal(abandoned.record_id, 'arr_abandon');
    assert.match(abandoned.note, /不判失败/);

    // 放弃等待那一刻：没有失败写入、没有失败消息、没有卡片、更没有入库。
    assert.notEqual((await gateway.get('purchaseArrival', 'arr_abandon')).fields.识别状态, '识别失败');
    assert.equal(textMessages(messages).some((text) => text.includes('识别没成功')), false);
    assert.equal(cardMessages(messages).length, 0);
    assert.equal((await gateway.listAll('purchaseInbound')).length, 0);

    // 请求没有被取消也没有重跑：放行之后，结果照常走完匹配/建档/出卡。
    release.resolve();
    const task = await waitForTask(store, accepted.taskId);
    assert.equal(task.status, 'awaiting_confirmation');
    const record = await gateway.get('purchaseArrival', 'arr_abandon');
    assert.equal(record.fields.识别状态, '识别成功');
    assert.equal(cardMessages(messages).length, 1);
    assert.equal(recognizeCalls, 1, '放弃等待不能取消/重启请求');
    assert.equal(service.arrivalWaits.size, 0);
  } finally {
    logs.restore();
  }
});

test('④ 请求报错 → 判失败 + 告诉她原因；等待定时器同时停掉，不会再补发也不会再判一次', async () => {
  const logs = captureLogs();
  try {
    const messages = [];
    const { service, store, gateway } = makeService({
      arrivalNoticeIntervalMs: 10,
      arrivalAbandonWaitMs: 30,
      arrivalFailAfterMs: 40,
      client: makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } }),
      recognizer: makeRecognizer({ recognizeLabels: async () => { throw new Error('模型服务 502'); } }),
      gateway: makeGateway({ purchaseArrival: [arrivalRecord('arr_request_error')] }),
    });

    const accepted = await service.accept('arrival', 'arr_request_error');
    const task = await waitForTask(store, accepted.taskId, ['failed']);
    assert.match(task.error, /模型服务 502/);
    await waitFor('到货记录标记识别失败', async () =>
      (await gateway.get('purchaseArrival', 'arr_request_error')).fields.识别状态 === '识别失败');
    const record = await gateway.get('purchaseArrival', 'arr_request_error');
    assert.equal(record.fields.识别失败原因, '模型服务 502', '失败原因要说人话且带上是哪一出错');
    await waitFor('失败提示发出', () => textMessages(messages).some((text) => text.includes('识别没成功')));
    assert.ok(
      textMessages(messages).find((text) => text.includes('识别没成功')).includes('模型服务 502'),
      '失败提示必须带上原因，不能只说"失败了"',
    );

    // 判失败 → 停止：不残留定时器；等过所有阈值也不再多发消息、多判一次。
    assert.equal(service.arrivalWaits.size, 0);
    const messageCount = messages.length;
    await wait(80); // > interval + abandon + failAfter
    assert.equal(messages.length, messageCount, '判失败后不能再补发提示');
    assert.equal(logs.events('purchase.arrival.wait.abandoned').length, 0, '已经判失败了就不该再走放弃等待');
    assert.equal(logs.events('purchase.arrival.failure_notice').length, 1, '失败提示只能发一次');
  } finally {
    logs.restore();
  }
});

test('⑤ 3 分钟判失败后结果才到：状态改回成功 + 出卡 + 发说明 + 不重复写入库', async () => {
  const release = deferred();
  const logs = captureLogs();
  try {
    const inventory = makeInventory();
    const messages = [];
    const { service, store, gateway } = makeService({
      inventory,
      arrivalNoticeIntervalMs: 10,
      arrivalAbandonWaitMs: 20,
      arrivalFailAfterMs: 50,
      client: makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } }),
      recognizer: makeRecognizer({
        recognizeLabels: async () => {
          await release.promise;
          return [{ item_no: '8088', color: '灰色', size: 36, quantity: 2 }];
        },
      }),
      gateway: makeGateway({ purchaseArrival: [arrivalRecord('arr_rescue')], purchaseInbound: [] }),
    });

    const accepted = await service.accept('arrival', 'arr_rescue');
    // 先确认"确实判了失败"（记录写成失败 + 失败提示已经发出），再把迟到的结果放出来。
    await waitFor('判失败落盘', async () =>
      (await gateway.get('purchaseArrival', 'arr_rescue')).fields.识别状态 === '识别失败');
    await waitFor('失败提示发出', () => textMessages(messages).some((text) => text.includes('识别没成功')));

    release.resolve();
    const task = await waitForTask(store, accepted.taskId);
    assert.equal(task.status, 'awaiting_confirmation', '迟到结果必须把任务从 failed 救回来');

    const record = await gateway.get('purchaseArrival', 'arr_rescue');
    assert.equal(record.fields.识别状态, '识别成功', '状态必须改回成功');
    assert.equal(record.fields.确认状态, '待确认');
    assert.equal(record.fields.识别失败原因, '', '失败原因要清掉，别留着误导她');
    assert.equal(cardMessages(messages).length, 1, '照常出卡片');

    const rescued = textMessages(messages).find((text) => text.includes('后来识别出来了'));
    assert.ok(rescued, '必须补一条「后来识别出来了」的说明');
    assert.match(rescued, /已经按识别结果处理好，你可以直接确认入库～/);

    // 救回只出卡片：**入库永远要她点确认**，所以这一刻一条入库记录都不该有。
    assert.equal((await gateway.listAll('purchaseInbound')).length, 0, '救回不能自动写入库');
    assert.equal(inventory.calls.length, 0);

    // 她点确认：走既有幂等路径（inbound_created 落盘 + 按到货记录回查远端）；连点两次也只入一次。
    await service.handleCardAction({ draft_id: task.task_id, action: 'confirm_purchase_arrival' }, 'ou_1');
    await service.handleCardAction({ draft_id: task.task_id, action: 'confirm_purchase_arrival' }, 'ou_1');
    const inbounds = await gateway.listAll('purchaseInbound');
    assert.equal(inbounds.length, 1, '每个「货品+尺码」只能有一条采购入库');
    assert.equal(inbounds[0].fields.数量, 2);
    assert.equal(inventory.calls.length, 1, '库存只能加一次——迟到结果不能重复扣库存');

    assert.equal(logs.events('purchase.arrival.failure_notice').length, 1, '失败提示只能发一次');
    assert.equal(logs.events('purchase.arrival.timeout.rescued').length, 1);
    assert.equal(service.arrivalWaits.size, 0);
  } finally {
    logs.restore();
  }
});

test('「识别中」写得很慢时，判失败不会被它盖掉：写入顺序仍是有序的，迟到结果照样救回', async () => {
  const release = deferred();
  const statusGate = deferred();
  const statuses = [];
  let statusWriteStarted = false;
  const messages = [];
  const base = makeGateway({ purchaseArrival: [arrivalRecord('arr_slow_status')], purchaseInbound: [] });
  const gateway = {
    ...base,
    update: async (tableKey, recordId, values) => {
      if (tableKey === 'purchaseArrival' && values.recognitionStatus === '识别中') {
        statusWriteStarted = true;
        // 卡住不写：等待定时器必须等它写完才启动，否则失败态会先写、再被「识别中」盖掉。
        await statusGate.promise;
      }
      if (tableKey === 'purchaseArrival' && values.recognitionStatus) statuses.push(values.recognitionStatus);
      return base.update(tableKey, recordId, values);
    },
  };
  const { service, store } = makeService({
    gateway,
    arrivalAbandonWaitMs: 20,
    arrivalFailAfterMs: 20,
    client: makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } }),
    recognizer: makeRecognizer({
      recognizeLabels: async () => {
        await release.promise;
        return [{ item_no: '8088', color: '灰色', size: 36, quantity: 1 }];
      },
    }),
  });

  const accepted = await service.accept('arrival', 'arr_slow_status');
  await waitFor('「识别中」写入发起', () => statusWriteStarted);
  // 写入还挂着：这时候一个失败态都不该写出去。
  assert.deepEqual(statuses, [], '「识别中」还没写成之前不能判失败');

  statusGate.resolve();
  await waitFor('判失败落盘', async () =>
    (await gateway.get('purchaseArrival', 'arr_slow_status')).fields.识别状态 === '识别失败');
  assert.deepEqual(statuses, ['识别中', '识别失败'], '失败态必须晚于「识别中」，否则会被它盖掉，记录永远停在识别中');

  // 迟到的结果把状态救回来。
  release.resolve();
  const task = await waitForTask(store, accepted.taskId);
  assert.equal(task.status, 'awaiting_confirmation');
  assert.deepEqual(statuses, ['识别中', '识别失败', '识别成功']);
});

test('③ 补发次数上限兜底：到上限只记一条日志，不再刷屏', async () => {
  const release = deferred();
  const logs = captureLogs();
  try {
    const messages = [];
    const { service, store } = makeService({
      arrivalNoticeIntervalMs: 10,
      arrivalNoticeMaxCount: 2,
      arrivalAbandonWaitMs: 60_000,
      arrivalFailAfterMs: 60_000,
      client: makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } }),
      recognizer: makeRecognizer({
        recognizeLabels: async () => {
          await release.promise;
          return [{ item_no: '8088', color: '灰色', size: 36, quantity: 1 }];
        },
      }),
      gateway: makeGateway({ purchaseArrival: [arrivalRecord('arr_capped')] }),
    });

    const accepted = await service.accept('arrival', 'arr_capped');
    await waitFor('到达补发上限', () => logs.events('purchase.arrival.wait.notice_capped').length === 1, { attempts: 600, pause: 5 });
    assert.equal(waitingNotices(messages).length, 2);

    // 上限之后每过一个间隔都不该再发（这里等 6 个间隔）。
    await wait(60);
    assert.equal(waitingNotices(messages).length, 2, '到上限只记日志，不刷屏');

    release.resolve();
    const task = await waitForTask(store, accepted.taskId);
    assert.equal(task.status, 'awaiting_confirmation');
    assert.equal(service.arrivalWaits.size, 0);
  } finally {
    logs.restore();
  }
});

test('识别超时后重试：不重复写采购入库，也不重复加库存', async () => {
  const inventory = makeInventory();
  let attempts = 0;
  const { service, store, gateway } = makeService({
    inventory,
    recognitionTimeoutMs: 20,
    recognizer: makeRecognizer({
      recognizeLabels: async () => {
        attempts += 1;
        // 第一次卡住（超时），第二次正常返回同一批货。
        if (attempts === 1) return never();
        return [{ item_no: '8088', color: '灰色', size: 36, quantity: 2 }];
      },
    }),
    gateway: makeGateway({ purchaseArrival: [arrivalRecord('arr_timeout_retry')], purchaseInbound: [] }),
  });

  const first = await service.accept('arrival', 'arr_timeout_retry');
  await waitForTask(store, first.taskId, ['failed']);
  assert.equal((await gateway.listAll('purchaseInbound')).length, 0, '识别失败时一条入库都不该写');

  // 重收 webhook（用户重传图片）会重跑这次识别：任务落 failed 是可重跑的。
  const second = await service.accept('arrival', 'arr_timeout_retry');
  const retried = await waitForTask(store, second.taskId, ['awaiting_confirmation']);
  assert.equal(retried.draft.actual.length, 1);

  // 确认两次（超时重试 + 双击确认）：入库和库存都只能发生一次。
  await service.handleCardAction({ draft_id: retried.task_id, action: 'confirm_purchase_arrival' }, 'ou_1');
  await service.handleCardAction({ draft_id: retried.task_id, action: 'confirm_purchase_arrival' }, 'ou_1');
  const inbounds = await gateway.listAll('purchaseInbound');
  assert.equal(inbounds.length, 1, '每个「货品+尺码」只能有一条采购入库');
  assert.equal(inbounds[0].fields.数量, 2);
  assert.equal(inventory.calls.length, 1, '库存只能加一次');
});

test('invalid record_id is rejected', async () => {
  const { service } = makeService();
  await assert.rejects(() => service.accept('arrival', 'invalid id!'), /缺少有效 record_id/);
});

test('only original operator can confirm', async () => {
  const { service, store } = makeService({
    gateway: makeGateway({
      purchaseArrival: [{ record_id: 'arr_auth', fields: { 确认状态: '待确认', 报货批次号: ['batch_1'], 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_owner' }] } }],
      purchaseOrderBatch: [{ record_id: 'batch_1', fields: { 报货批次号: 'BH-001' } }],
      purchaseRequest: [],
    }),
  });
  const accepted = await service.accept('arrival', 'arr_auth');
  await waitForTask(store, accepted.taskId);
  await assert.rejects(
    () => service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_arrival' }, 'ou_other'),
    /只能由原始填写人确认/,
  );
});

test('arrival confirm retries after partial failure without duplicating inbound or inventory', async () => {
  const inventory = makeInventory();
  const records = {
    purchaseArrival: [{ record_id: 'arr_partial', fields: { 确认状态: '待确认', 识别状态: '识别成功', 报货批次号: ['batch_1'], 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
    purchaseOrderBatch: [{ record_id: 'batch_1', fields: { 报货批次号: 'BH-001' } }],
    purchaseRequest: [],
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
  const { service, store } = makeService({
    inventory,
    gateway,
    recognizer: makeRecognizer({ recognizeLabels: async () => [
      { item_no: '8088', color: '灰色', size: 36, quantity: 1 },
      { item_no: '8088', color: '灰色', size: 37, quantity: 1 },
    ] }),
  });
  const accepted = await service.accept('arrival', 'arr_partial');
  await waitForTask(store, accepted.taskId);

  // 第一次确认：第1条入库成功，第2条失败
  await assert.rejects(
    () => service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_arrival' }, 'ou_1'),
    /模拟入库写入中途失败/,
  );
  const inboundsAfterFirst = await gateway.listAll('purchaseInbound');
  assert.equal(inboundsAfterFirst.length, 1, '第一次失败后应只有1条入库记录');
  assert.equal(inventory.calls.length, 1, '第一次失败后应只有1次库存更新');
  const taskAfterFirst = await store.get(accepted.taskId);
  assert.notEqual(taskAfterFirst.status, 'posted', '失败后 task 不应标记为 posted');

  // 重试：不再失败
  failOnSecondCreate = false;
  const result = await service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_arrival' }, 'ou_1');
  assert.ok(result.toast.content.includes('采购已入库'), result.toast.content);

  // 验证不重复创建
  const inboundsAfterRetry = await gateway.listAll('purchaseInbound');
  assert.equal(inboundsAfterRetry.length, 2, '重试后应总共2条入库记录，不重复第1条');
  assert.equal(inventory.calls.length, 2, '重试后应总共2次库存更新，不重复第1条');

  const sizes = inboundsAfterRetry.map((r) => r.fields.尺码[0]).sort();
  assert.deepEqual(sizes, sizeLinks(36, 37));

  const taskAfterRetry = await store.get(accepted.taskId);
  assert.equal(taskAfterRetry.status, 'posted');
});

test('arrival confirm retry survives feishu list latency — persisted inbound_created prevents duplicate', async () => {
  // 模拟飞书写入后立即读取有延迟：重试时 listAll('purchaseInbound') 返回空，
  // 但 task.draft.inbound_created 已持久化第1条记录，验证不会重复创建。
  const inventory = makeInventory();
  const records = {
    purchaseArrival: [{ record_id: 'arr_latency', fields: { 确认状态: '待确认', 识别状态: '识别成功', 报货批次号: ['batch_1'], 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
    purchaseOrderBatch: [{ record_id: 'batch_1', fields: { 报货批次号: 'BH-001' } }],
    purchaseRequest: [],
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
  const { service, store } = makeService({
    inventory,
    gateway,
    recognizer: makeRecognizer({ recognizeLabels: async () => [
      { item_no: '8088', color: '灰色', size: 36, quantity: 1 },
      { item_no: '8088', color: '灰色', size: 37, quantity: 1 },
    ] }),
  });
  const accepted = await service.accept('arrival', 'arr_latency');
  await waitForTask(store, accepted.taskId);

  // 第一次确认：第1条（36码）成功并持久化到 inbound_created，第2条（37码）失败
  await assert.rejects(
    () => service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_arrival' }, 'ou_1'),
    /模拟入库写入中途失败/,
  );
  const taskAfterFirst = await store.get(accepted.taskId);
  assert.ok(taskAfterFirst.draft?.inbound_created, '失败后应已持久化 inbound_created');
  const persistedKeys = Object.keys(taskAfterFirst.draft.inbound_created);
  assert.equal(persistedKeys.length, 1, '应只持久化第1条成功的记录');
  assert.ok(persistedKeys[0].includes('36'), '持久化的应是36码的记录');

  // 重试：开启 listAll 延迟模拟（返回空），不再失败
  simulateListLatency = true;
  failOnSecondCreate = false;
  const result = await service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_arrival' }, 'ou_1');
  assert.ok(result.toast.content.includes('采购已入库'), result.toast.content);

  // 验证：即使 listAll 返回空，因为 inbound_created 持久化了第1条，也不会重复创建
  const inboundsAfterRetry = await baseGateway.listAll('purchaseInbound');
  assert.equal(inboundsAfterRetry.length, 2, '重试后应总共2条入库记录，36码不重复');
  assert.equal(inventory.calls.length, 2, '重试后应总共2次库存更新，36码不重复');

  const sizes = inboundsAfterRetry.map((r) => r.fields.尺码[0]).sort();
  assert.deepEqual(sizes, sizeLinks(36, 37));
});

test('arrival confirm retries after inventory update failure — continues applying inventory for existing inbound', async () => {
  // 场景：第1条入库记录创建成功，但库存更新失败；重试时应继续执行第1条的库存更新，不重复创建入库记录
  let inventoryCallCount = 0;
  let failInventory = true;
  const inventoryCalls = [];
  const inventory = {
    applyPurchase: async (input) => {
      inventoryCallCount += 1;
      inventoryCalls.push(input);
      if (failInventory && inventoryCallCount === 1) throw new Error('模拟库存更新失败');
      return { stockKey: `${input.productRecordId}|${input.size}`, ledgerRecordId: 'ledger_1', liveRecordIds: ['live_1'], movementQuantity: input.quantity, direction: '增加', quantity: input.quantity };
    },
  };
  const records = {
    purchaseArrival: [{ record_id: 'arr_invfail', fields: { 确认状态: '待确认', 识别状态: '识别成功', 报货批次号: ['batch_1'], 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
    purchaseOrderBatch: [{ record_id: 'batch_1', fields: { 报货批次号: 'BH-001' } }],
    purchaseRequest: [],
    purchaseInbound: [],
  };
  const { service, store, gateway } = makeService({
    inventory,
    gateway: makeGateway(records),
    recognizer: makeRecognizer({ recognizeLabels: async () => [
      { item_no: '8088', color: '灰色', size: 36, quantity: 1 },
      { item_no: '8088', color: '灰色', size: 37, quantity: 1 },
    ] }),
  });
  const accepted = await service.accept('arrival', 'arr_invfail');
  await waitForTask(store, accepted.taskId);

  // 第一次确认：36码入库创建成功，但库存更新失败
  await assert.rejects(
    () => service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_arrival' }, 'ou_1'),
    /模拟库存更新失败/,
  );
  const inboundsAfterFirst = await gateway.listAll('purchaseInbound');
  assert.equal(inboundsAfterFirst.length, 1, '第一次失败后应只有1条入库记录（36码）');
  assert.equal(inventoryCallCount, 1, '第一次应只调用1次库存更新（36码，失败）');
  const taskAfterFirst = await store.get(accepted.taskId);
  const entry36 = Object.values(taskAfterFirst.draft.inbound_created).find((e) => e.recordId === inboundsAfterFirst[0].record_id);
  assert.equal(entry36.inventoryApplied, false, '库存更新失败后 inventoryApplied 应为 false');

  // 重试：库存更新不再失败
  failInventory = false;
  const result = await service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_arrival' }, 'ou_1');
  assert.ok(result.toast.content.includes('采购已入库'), result.toast.content);

  // 验证：36码不重复创建，但库存更新被重新执行；37码正常创建和更新
  const inboundsAfterRetry = await gateway.listAll('purchaseInbound');
  assert.equal(inboundsAfterRetry.length, 2, '重试后应总共2条入库记录，36码不重复');
  assert.equal(inventoryCallCount, 3, '重试后应总共3次库存更新：36码第1次失败 + 36码重试 + 37码');

  // 验证36码的库存更新被重试了（用同一个 purchaseInboundRecordId）
  const inbound36Id = inboundsAfterFirst[0].record_id;
  const retryCallsFor36 = inventoryCalls.filter((c) => c.purchaseInboundRecordId === inbound36Id);
  assert.equal(retryCallsFor36.length, 2, '36码的库存更新应被调用2次（第1次失败，重试成功）');

  const sizes = inboundsAfterRetry.map((r) => r.fields.尺码[0]).sort();
  assert.deepEqual(sizes, sizeLinks(36, 37));
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

test('采购退货一条（编号 + 数量）→ 交给退货链路、不走报货归批；数量取自「数量」字段', async () => {
  // ⚠️ 合并 #81 与 #83 时定的归属：**采购退货不在归批窗口里处理**，由它自己那条
  // 链路负责（processSupplierReturn：按实时库存逐尺码扣减 + 出「采购退货单」）。
  // 所以这条用例钉的是"分流正确 + 数量口径正确 + 不建批次/不走进货"；
  // 库存那一侧（能对上就退、对不上把差额说清）由 purchaseReturn.test.js
  // 用真的 InventoryService 钉住，这里不重复。
  const { service, store, gateway } = makeService({
    gateway: makeGateway({
      purchaseReport: [reportRecord('rep_return_1', {
        编号: ['prod_1'], 数量: 4, 数量说明: '36码9双', 报货批次号: 'BATCH-RETURN', 采购行为: ['beh_return'],
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
  assert.equal(task.result.is_return, true, '必须走退货链路，不能被归批当成报货明细');
  assert.equal(task.result.declared, 4, '数量取自「数量」字段，不解析「数量说明」里的 9 双');
  // 这个假表里没有实时库存：能对上的 0 双 → 如实报差额、一张单据都不写
  assert.equal(task.result.available, 0);
  assert.equal(task.result.taken, 0);
  assert.equal(task.result.shortfall, 4);
  assert.deepEqual(task.result.doc_ids, []);
  assert.equal((await gateway.listAll('purchaseRequest')).length, 0);
  // 退货不建「报货批次」、不写采购到货/入库（那是采购申请 → 到货那条链路的事）
  assert.equal((await gateway.listAll('purchaseOrderBatch')).length, 0);
  assert.equal((await gateway.listAll('purchaseArrival')).length, 0);
  assert.equal((await gateway.listAll('purchaseInbound')).length, 0);
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

test('同一次提交里混着采购申请和采购退货 → 各走各的链路，退货不被归批顺手写成单据', async () => {
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

  // 采购申请那条：归批 → 一条单据信息、带上它自己的尺码与数量
  const requests = await gateway.listAll('purchaseRequest');
  assert.equal(requests.length, 1, '只有采购申请那条会被归批写单据');
  assert.deepEqual(requests[0].fields['尺码'], ['size_36']);
  assert.equal(requests[0].fields['数量'], 2);

  // 采购退货那条：走退货链路（这个假表里没有实时库存 → 如实报差额、一张单据都不写）。
  // ⚠️ 关键回归：归批**不能**给退货记录补「已生成申请」终态——补了就等于把退货吞掉，
  // 退货链路再也不会跑（库存永远扣不掉）。
  const returnTask = tasks.find((task) => task.record_id === 'rep_mix_ret');
  assert.equal(returnTask.result.is_return, true, '退货必须走退货链路');
  assert.equal(returnTask.result.declared, 5);
  assert.deepEqual(returnTask.result.doc_ids, []);
  const returnReport = await gateway.get('purchaseReport', 'rep_mix_ret');
  assert.notEqual(returnReport.fields['处理状态'], '已生成申请', '退货没写成，不能被归批补上终态');
  assert.equal((await gateway.listAll('purchaseOrderBatch')).length, 1, '只有采购申请那条会开批次');
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
  // 先等出图收尾落定，再取快照：否则快照可能记下"图还没发完"的中间值，
  // 后面重投时那条还在跑的收尾会把计数推上去，看起来像"重投多发了一张"。
  await waitForImageDelivery(images, 1);
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

// ⚠️ 队列清空 ≠ 出图发完。图与说明是 process() 里「采购申请已经写成」之后的收尾动作
// （先发图再写附件），队列这时候可能已经空了。用例如果要断言"一共出了几张图"，
// 必须再等这一步落定，否则会读到"发了一半"的中间值（改群发之后这条用例就这样偶发挂过）。
const waitForImageDelivery = async (images, expected) => {
  await waitFor(`出图 ${expected} 次`, async () => images.calls.length === expected, { attempts: 600, pause: 5 });
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

test('A2 同时确认同一个采购到货：每个逻辑入库只有一条，库存只加一次', async () => {
  const inventory = makeInventory();
  const { service, store, gateway } = makeService({
    inventory,
    gateway: slowCreates(makeGateway({
      purchaseArrival: [{ record_id: 'arr_race', fields: { 确认状态: '待确认', 报货批次号: ['batch_1'], 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
      purchaseOrderBatch: [{ record_id: 'batch_1', fields: { 报货批次号: 'BH-001' } }],
      purchaseRequest: [{ record_id: 'req_1', fields: { 报货批次号: ['batch_1'], 编号: ['prod_1'], 尺码: sizeLink(36), 数量: 1 } }],
      purchaseInbound: [],
    })),
  });
  const accepted = await service.accept('arrival', 'arr_race');
  await waitForTask(store, accepted.taskId);

  await Promise.all([
    service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_arrival' }, 'ou_1'),
    service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_arrival' }, 'ou_1'),
  ]);

  const inbounds = await gateway.listAll('purchaseInbound');
  assert.equal(inbounds.length, 1, '并发确认不得创建第二条采购入库');
  assert.equal(inventory.calls.length, 1, '库存只应增加一次');
  assert.equal((await store.get(accepted.taskId)).status, 'posted');
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

// ─── 到货单价格 → 货品「成本」───
//
// 产品负责人的口径：「如果有的到货单上有价格的，那就是成本。」
// 写入规则一律保守：只在成本为空时写、已有成本不覆盖只 warn、
// 同货号价格不一致不写只 warn、重试不重复写、新品建档顺带带成本。

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

const arrivalDocumentRecord = (recordId) => ({
  record_id: recordId,
  fields: { 类型: '到货单', 确认状态: '待确认', 识别状态: '待识别', 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] },
});

const documentRecognizer = (rows) => makeRecognizer({ recognizePurchaseDocument: async () => rows });

test('到货单价格即成本：货品「成本」为空时写进去，并在卡片尺码格上显示价格供她核对', async () => {
  const messages = [];
  const records = {
    purchaseArrival: [arrivalDocumentRecord('arr_cost_empty')],
    product: [{ record_id: 'prod_cost', fields: { 编号: '1366-31棕色', 供应商: ['sup_A'] } }],
    supplier: SUPPLIERS,
  };
  const { service, store } = makeService({
    gateway: makeGateway(records),
    client: makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } }),
    references: makeReferences({
      resolveProduct: async () => ({ recordId: 'prod_cost', record: records.product[0] }),
    }),
    recognizer: documentRecognizer([
      { item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: 199 },
      { item_no: '1366-31', color: '棕色', size: 37, quantity: 2, unit_cost: 199 },
    ]),
  });
  const accepted = await service.accept('arrival', 'arr_cost_empty');
  const task = await waitForProcessed(store, accepted.taskId);
  assert.equal(task.status, 'awaiting_confirmation');
  assert.equal(records.product[0].fields.成本, 199, '识别到的单据单价要写进货品成本');
  // 只数卡片：到货链路现在还会先发一条「收到，识别中」的文字提示。
  await waitFor('到货明细卡片发出', async () => cardMessages(messages).length === 1);
  const cardElements = JSON.parse(cardMessages(messages)[0].data.content).elements;
  assert.ok(JSON.stringify(cardElements).includes('￥199'), '尺码格上要显示识别到的单价，方便她核对成本');
});

test('到货单价格即成本：货品已有成本时不覆盖，只记一条带三要素的 warn', async () => {
  const records = {
    purchaseArrival: [arrivalDocumentRecord('arr_cost_kept')],
    product: [{ record_id: 'prod_keep', fields: { 编号: '1366-31棕色', 供应商: ['sup_A'], 成本: 100 } }],
    supplier: SUPPLIERS,
  };
  const { service, store } = makeService({
    gateway: makeGateway(records),
    references: makeReferences({
      resolveProduct: async () => ({ recordId: 'prod_keep', record: records.product[0] }),
    }),
    recognizer: documentRecognizer([{ item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: 199 }]),
  });
  const { result: task, lines } = await captureWarn(async () => {
    const accepted = await service.accept('arrival', 'arr_cost_kept');
    return waitForProcessed(store, accepted.taskId);
  });
  assert.equal(records.product[0].fields.成本, 100, '已有成本一律不覆盖');
  const warn = lines.find((line) => line.event === 'purchase.arrival.cost_kept');
  assert.ok(warn, `必须有 cost_kept warn，实际日志：${JSON.stringify(lines)}`);
  assert.equal(warn.item_no, '1366-31');
  assert.equal(String(warn.existing_cost), '100');
  assert.equal(warn.recognized_cost, 199);
});

test('到货单价格即成本：同一货号多行价格不一致时整条不写，记一条 warn', async () => {
  const records = {
    purchaseArrival: [arrivalDocumentRecord('arr_cost_conflict')],
    product: [{ record_id: 'prod_conflict', fields: { 编号: '1366-31棕色', 供应商: ['sup_A'] } }],
    supplier: SUPPLIERS,
  };
  const { service, store } = makeService({
    gateway: makeGateway(records),
    references: makeReferences({
      resolveProduct: async () => ({ recordId: 'prod_conflict', record: records.product[0] }),
    }),
    recognizer: documentRecognizer([
      { item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: 199 },
      { item_no: '1366-31', color: '棕色', size: 37, quantity: 1, unit_cost: 209 },
    ]),
  });
  const { lines } = await captureWarn(async () => {
    const accepted = await service.accept('arrival', 'arr_cost_conflict');
    return waitForProcessed(store, accepted.taskId);
  });
  assert.equal('成本' in records.product[0].fields, false, '价格不一致时一个值都不能写');
  const warn = lines.find((line) => line.event === 'purchase.arrival.cost_conflict');
  assert.ok(warn, `必须有 cost_conflict warn，实际日志：${JSON.stringify(lines.map((line) => line.event))}`);
  assert.equal(warn.item_no, '1366-31');
  assert.deepEqual(warn.prices, [199, 209]);
  // 只 warn 一次：不能每个尺码都报一遍。
  assert.equal(lines.filter((line) => line.event === 'purchase.arrival.cost_conflict').length, 1);
});

test('到货单价格即成本：她点确认时兜底那次不再重复写成本', async () => {
  const records = {
    purchaseArrival: [arrivalDocumentRecord('arr_cost_retry')],
    product: [{ record_id: 'prod_retry', fields: { 编号: '1366-31棕色', 供应商: ['sup_A'] } }],
    supplier: SUPPLIERS,
  };
  const gateway = makeGateway(records);
  const costUpdates = [];
  const realUpdate = gateway.update;
  gateway.update = async (tableKey, recordId, semanticValues) => {
    if (tableKey === 'product' && semanticValues && semanticValues.cost !== undefined) {
      costUpdates.push({ recordId, cost: semanticValues.cost });
    }
    return realUpdate(tableKey, recordId, semanticValues);
  };
  const { service, store } = makeService({
    gateway,
    references: makeReferences({
      resolveProduct: async () => ({ recordId: 'prod_retry', record: records.product[0] }),
    }),
    recognizer: documentRecognizer([{ item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: 199 }]),
  });

  const accepted = await service.accept('arrival', 'arr_cost_retry');
  // 成本现在是在「发完卡片之后」写的，所以要等这一批真正跑完（result 落盘）。
  await waitForProcessed(store, accepted.taskId);
  assert.equal(costUpdates.length, 1, '第一次要写成本');
  assert.equal(records.product[0].fields.成本, 199);

  // 她点确认：建档/成本会兜底再跑一次（幂等），成本不能再写第二遍。
  await service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_arrival' }, 'ou_1');
  assert.equal(costUpdates.length, 1, '确认兜底那次不能再写一次成本（写没写靠任务里落盘的 arrival_cost_written 判断）');
  assert.equal(records.product[0].fields.成本, 199);
});

test('到货单价格即成本：写成本失败只记 warn，不挡住到货入库', async () => {
  const records = {
    purchaseArrival: [arrivalDocumentRecord('arr_cost_write_fail')],
    product: [{ record_id: 'prod_fail', fields: { 编号: '1366-31棕色', 供应商: ['sup_A'] } }],
    supplier: SUPPLIERS,
  };
  const gateway = makeGateway(records);
  gateway.update = async (tableKey, recordId, semanticValues) => {
    if (tableKey === 'product' && semanticValues && semanticValues.cost !== undefined) {
      throw new Error('模拟成本字段写不进去');
    }
    return { record_id: recordId };
  };
  const { service, store } = makeService({
    gateway,
    references: makeReferences({
      resolveProduct: async () => ({ recordId: 'prod_fail', record: records.product[0] }),
    }),
    recognizer: documentRecognizer([{ item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: 199 }]),
  });
  const { result: task, lines } = await captureWarn(async () => {
    const accepted = await service.accept('arrival', 'arr_cost_write_fail');
    return waitForProcessed(store, accepted.taskId);
  });
  assert.equal(task.status, 'awaiting_confirmation', '货已经到了：成本写不进去不能把整批到货卡住');
  assert.ok(lines.some((line) => line.event === 'purchase.arrival.cost_write_failed'));
});

test('到货新品建档：顺带把成本一起写进去', async () => {
  const records = {
    purchaseArrival: [arrivalDocumentRecord('arr_new_with_cost')],
    purchaseInbound: [],
    product: [],
    color: [{ record_id: 'color_brown', fields: { 颜色: '棕色' } }],
    supplier: [],
  };
  const { service, store } = makeService({
    gateway: makeGateway(records),
    references: makeReferences({
      resolveProduct: async ({ itemNo, color }) => { throw productNotFound(itemNo, color); },
    }),
    recognizer: documentRecognizer([
      { item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: '￥199.00' },
      { item_no: '1366-31', color: '棕色', size: 37, quantity: 1, unit_cost: 199 },
    ]),
  });
  const accepted = await service.accept('arrival', 'arr_new_with_cost');
  const task = await waitForProcessed(store, accepted.taskId);
  assert.equal(task.status, 'awaiting_confirmation');
  assert.equal(records.product.length, 1, '新品只建一条');
  // 建档一次带齐：货号 / 颜色 / 供应商（识别不到就留空）/ 类别（认不出留空）/ 成本。
  assert.equal(records.product[0].fields.货号, '1366-31');
  assert.equal(records.product[0].fields.成本, 199, '新品建档要顺带写成本');
});

test('到货新品建档：单据上没有价格时，建档不带成本字段', async () => {
  const records = {
    purchaseArrival: [arrivalDocumentRecord('arr_new_no_cost')],
    purchaseInbound: [],
    product: [],
    color: [{ record_id: 'color_brown', fields: { 颜色: '棕色' } }],
    supplier: [],
  };
  const { service, store } = makeService({
    gateway: makeGateway(records),
    references: makeReferences({
      resolveProduct: async ({ itemNo, color }) => { throw productNotFound(itemNo, color); },
    }),
    recognizer: documentRecognizer([{ item_no: '1366-31', color: '棕色', size: 36, quantity: 1 }]),
  });
  const accepted = await service.accept('arrival', 'arr_new_no_cost');
  await waitForProcessed(store, accepted.taskId);
  assert.equal(records.product.length, 1);
  assert.equal('成本' in records.product[0].fields, false, '没有可信价格就不许写成本');
});

// ─── 顺序：发确认卡片之前不建档、不写成本；发完之后才建档 ───
//
// 产品负责人 2026-10-05 的四条决定：「删掉独立的新品段」「新品按货号级标在明细里」
// 「卡片不写还差什么」「发确认卡片之前不做创建，发完之后同步做，点确认之后再给链接」。

// 卡片上标了 🆕 新品的货号（用来和"实际建了哪几个"对账）。
const newProductItemNosOnCard = (card) => card.elements
  .filter((element) => element.tag === 'markdown' && element.content.includes('🆕 新品'))
  .map((element) => element.content.replace(/^\*\*(?:🏷️?|⚠️?)\s*/u, '').split(' · ')[0]);

test('到货顺序：发确认卡片之前一次货品写入都没有，卡片发出之后才建档、才写成本', async () => {
  const writes = [];
  const messages = [];
  // cardSent 是判据本身：卡片（interactive 消息）发出去之前 afterCard=false，之后 true。
  let cardSent = false;
  const records = {
    purchaseArrival: [arrivalDocumentRecord('arr_order')],
    purchaseInbound: [],
    product: [],
    color: [{ record_id: 'color_black', fields: { 颜色: '黑色' } }],
    supplier: [],
  };
  const gateway = makeGateway(records);
  const innerCreate = gateway.create;
  const innerUpdate = gateway.update;
  gateway.create = async (tableKey, semanticValues) => {
    writes.push({ op: 'create', table: tableKey, afterCard: cardSent });
    return innerCreate(tableKey, semanticValues);
  };
  gateway.update = async (tableKey, recordId, semanticValues) => {
    writes.push({ op: 'update', table: tableKey, afterCard: cardSent });
    return innerUpdate(tableKey, recordId, semanticValues);
  };
  const { service, store } = makeService({
    gateway,
    client: makeClient({
      sendMessage: async (params) => {
        messages.push(params);
        if (params?.data?.msg_type === 'interactive') cardSent = true;
        return { code: 0 };
      },
    }),
    references: makeReferences({
      resolveProduct: async ({ itemNo, color }) => { throw productNotFound(itemNo, color); },
    }),
    recognizer: documentRecognizer([
      { item_no: '1366-31', color: '黑色', size: 36, quantity: 1, unit_cost: 199 },
    ]),
  });

  const accepted = await service.accept('arrival', 'arr_order');
  const task = await waitForProcessed(store, accepted.taskId);
  assert.equal(task.status, 'awaiting_confirmation');

  const productWrites = writes.filter((item) => item.table === 'product');
  assert.ok(productWrites.length > 0, '发完卡片之后必须真的建档/写成本（否则这条用例什么都没验到）');
  assert.deepEqual(productWrites.filter((item) => !item.afterCard), [],
    '发确认卡片之前一次货品写入都不能有（"发卡片之前不做创建"）');
  assert.ok(productWrites.every((item) => item.afterCard), '所有货品写入都必须发生在卡片发出之后');

  // 确认卡片上不出现记录链接：链接只给"确认之后"的结果卡片。
  const card = JSON.parse(cardMessages(messages)[0].data.content);
  assert.deepEqual(newProductItemNosOnCard(card), ['1366-31'], '新品在明细里按货号标出来');
  assert.ok(!JSON.stringify(card.elements).includes('record='), '确认卡片上不给记录链接');
});

test('到货新品：卡片标的新品货号 = 实际建档的货号；建档幂等，链接回填草稿', async () => {
  const patches = [];
  const messages = [];
  const records = {
    purchaseArrival: [arrivalDocumentRecord('arr_idem_new')],
    purchaseInbound: [],
    product: [],
    color: [{ record_id: 'color_black', fields: { 颜色: '黑色' } }],
    supplier: [],
  };
  const client = makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } });
  // 结果卡片是 patch 出来的：记下 patch 内容才能断言「确认之后给了链接」。
  client.im.v1 = { message: { patch: async (params) => { patches.push(params); return { code: 0, msg: 'success' }; } } };
  const { service, store, gateway } = makeService({
    client,
    gateway: makeGateway(records),
    references: makeReferences({
      resolveProduct: async ({ itemNo, color }) => { throw productNotFound(itemNo, color); },
    }),
    recognizer: documentRecognizer([
      // 同一货号+颜色两个尺码 + 另一个新货号：建档按 货号+颜色 去重。
      { item_no: '1366-31', color: '黑色', size: 36, quantity: 1, unit_cost: 199 },
      { item_no: '1366-31', color: '黑色', size: 37, quantity: 1, unit_cost: 199 },
      { item_no: '1366-32', color: '黑色', size: 36, quantity: 1 },
    ]),
  });

  const accepted = await service.accept('arrival', 'arr_idem_new');
  const task = await waitForProcessed(store, accepted.taskId);

  const card = JSON.parse(cardMessages(messages)[0].data.content);
  const markedItemNos = newProductItemNosOnCard(card).sort();
  const pendingItemNos = [...new Set(task.draft.pending_creation.map((item) => item.item_no))].sort();
  const createdItemNos = [...new Set(task.draft.created_products.map((item) => item.item_no))].sort();
  assert.deepEqual(markedItemNos, ['1366-31', '1366-32'], '卡片按货号标新品');
  assert.deepEqual(pendingItemNos, markedItemNos, '待建档清单必须是卡片上标的那几个货号');
  assert.deepEqual(createdItemNos, markedItemNos, '实际建档的必须就是卡片上标的那几个货号');
  assert.equal(records.product.length, 2, '同一货号+颜色的两个尺码只建一条货品，另一个新货号各一条');
  assert.equal(task.draft.created_products.length, 2);
  assert.match(task.draft.created_products[0].url, /record=/, '链接要回填到草稿');
  assert.match(task.draft.created_products[0].url, new RegExp(`record=${records.product[0].record_id}`));

  // 幂等：她点确认时会再跑一次建档（同一条路），不能建出第二条。
  const again = await service.ensureArrivalProducts(accepted.taskId, { reason: 'test' });
  assert.equal(again.state, 'done');
  assert.equal(records.product.length, 2, '重复跑建档不能多建一条');

  await service.handleCardAction(
    { draft_id: accepted.taskId, action: 'confirm_purchase_arrival' },
    'ou_1',
    { context: { open_message_id: 'om_idem_new' } },
  );
  const resultCardText = patches.map((params) => params.data.content).join('\n');
  assert.ok(resultCardText.includes('已入库'), '结果卡片要更新成已入库');
  for (const record of records.product) {
    assert.ok(resultCardText.includes(`record=${record.record_id}`),
      `确认之后的结果卡片要给到创建好的链接：${resultCardText}`);
  }
  assert.ok((await gateway.listAll('purchaseInbound')).length === 3, '三个尺码格各自入库');
});

test('到货取消：不撤销已经建好的新品（保持改动前的口径），取消卡片也不给链接', async () => {
  const patches = [];
  const messages = [];
  const records = {
    purchaseArrival: [arrivalDocumentRecord('arr_cancel_new')],
    purchaseInbound: [],
    product: [],
    color: [{ record_id: 'color_black', fields: { 颜色: '黑色' } }],
    supplier: [],
  };
  const client = makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } });
  client.im.v1 = { message: { patch: async (params) => { patches.push(params); return { code: 0, msg: 'success' }; } } };
  const { service, store } = makeService({
    client,
    gateway: makeGateway(records),
    references: makeReferences({
      resolveProduct: async ({ itemNo, color }) => { throw productNotFound(itemNo, color); },
    }),
    recognizer: documentRecognizer([{ item_no: '1366-31', color: '黑色', size: 36, quantity: 1 }]),
  });

  const accepted = await service.accept('arrival', 'arr_cancel_new');
  await waitForProcessed(store, accepted.taskId);
  assert.equal(records.product.length, 1, '建档在卡片之后已经跑完了');

  await service.handleCardAction(
    { draft_id: accepted.taskId, action: 'cancel_purchase_arrival' },
    'ou_1',
    { context: { open_message_id: 'om_cancel_new' } },
  );
  assert.equal(records.product.length, 1, '取消的是"这一批要不要入库"，不是"这个货品存不存在"：不撤销建档');
  const cancelCard = patches.map((params) => params.data.content).join('\n');
  assert.ok(cancelCard.includes('已取消'));
  assert.ok(!cancelCard.includes('record='), '取消卡片不塞新品链接');
});

test('卡片发送失败：什么都不建档；重收 webhook 之后只建一条（建档不能因为重试变两条）', async () => {
  const records = {
    purchaseArrival: [arrivalDocumentRecord('arr_card_fail')],
    purchaseInbound: [],
    product: [],
    color: [{ record_id: 'color_black', fields: { 颜色: '黑色' } }],
    supplier: [],
  };
  // 只让确认卡片（interactive）失败：到货链路在识别之前还会发一条文字提示，
  // 那条和卡片走同一个 im.message.create——"一律抛错"会把失败点顶到识别之前，验不到这条。
  let failCard = true;
  const messages = [];
  const client = makeClient();
  client.im.message.create = async (params) => {
    // 先抛再记：失败的这一次不算"发出去的卡片"，最后断言的是真正送达的条数。
    if (failCard && params?.data?.msg_type === 'interactive') throw new Error('模拟卡片发送失败');
    messages.push(params);
    return { code: 0 };
  };
  const { service, store } = makeService({
    client,
    gateway: makeGateway(records),
    references: makeReferences({
      resolveProduct: async ({ itemNo, color }) => { throw productNotFound(itemNo, color); },
    }),
    recognizer: documentRecognizer([{ item_no: '1366-31', color: '黑色', size: 36, quantity: 1 }]),
  });

  const first = await service.accept('arrival', 'arr_card_fail');
  await waitForTask(store, first.taskId, ['failed']);
  assert.equal(records.product.length, 0, '卡片都没发出去，就不该有建档动作（"发完之后才建"）');

  failCard = false;
  await service.accept('arrival', 'arr_card_fail');
  // ⚠️ 不能用 waitForProcessed：第一次失败留下的 status='failed' 会让它立刻返回（那是旧的终态）。
  // 这里等的是"这次重试真的跑完"——状态回到待确认 + 建档状态落成 done。
  await waitForTask(store, first.taskId, ['awaiting_confirmation']);
  await waitFor('重试后建档跑完', async () => {
    const task = await store.get(first.taskId);
    return task?.draft?.creation_state === 'done' && task.draft.created_products?.length === 1;
  });
  const retried = await store.get(first.taskId);
  assert.equal(retried.status, 'awaiting_confirmation');
  assert.equal(records.product.length, 1, '重试之后只建一条货品');
  assert.equal(retried.draft.created_products.length, 1);
  assert.equal(retried.draft.creation_state, 'done');
  assert.equal(cardMessages(messages).length, 1, '重试把确认卡片补发了（第一次那条失败了）');
});

// ─────────────────────────────────────────────────────────────────────────────
// A：采购单发到群 + @经办人（不再 @所有人）+ 把「那条消息 / 那条话题 ↔ 哪一批」落成本地记录
// ─────────────────────────────────────────────────────────────────────────────

// 定位器指向临时目录，才能在本文件里断言"映射真的落盘了"，
// 且不会让别的用例看见这一条映射。
const locatorStoreFor = (dir) => new JsonTaskStore({
  dir: path.join(dir, 'group_messages'), idField: 'task_id',
});

const makeGroupPurchaseService = (options = {}) => {
  const dir = options.dir || tempDir();
  const batchLocatorStore = options.batchLocatorStore || locatorStoreFor(dir);
  const sent = [];
  const built = makeService({
    dir,
    gateway: makeGateway({
      purchaseReport: [reportRecord(options.recordId || 'rep_group', {
        尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'],
        // operator: '' → 报单记录没填经办人（专门验证"不 @任何人"那条路）。
        ...(options.operator === undefined ? {} : { 经办人: options.operator ? [{ id: options.operator }] : [] }),
      })],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 2 }] }),
    client: makeClient({
      sendMessage: async (params) => {
        sent.push(params);
        return {
          code: 0,
          data: {
            message_id: `om_sent_${sent.length}`,
            // 话题群：飞书发消息的响应里直接带这条消息所属的话题 id（真机实测有这个字段）。
            // 只给文字那条带上：图片那条为空，正好覆盖"有的消息有话题、有的没有"。
            thread_id: params.data.msg_type === 'text' ? 'omt_sent_thread' : '',
          },
        };
      },
    }),
    batchLocatorStore,
  });
  return { ...built, sent, batchLocatorStore };
};

test('A：采购单发到群 PURCHASE_CHAT_ID 并 @经办人；消息/话题 ↔ 批次落进本地记录', async () => {
  const { service, store, batchLocatorStore, sent, gateway } = makeGroupPurchaseService();
  const accepted = await service.accept('supplier-report', 'rep_group');
  const task = await waitForTask(store, accepted.taskId);
  assert.equal(task.status, 'posted');

  await waitFor('采购单发到群', async () => sent.length === 2);
  const [image, text] = sent;
  // 发到群（chat_id），不是经办人私聊。
  assert.equal(image.params.receive_id_type, 'chat_id');
  assert.equal(image.data.receive_id, 'oc_test_purchase_group');
  assert.equal(image.data.msg_type, 'image');
  assert.equal(text.params.receive_id_type, 'chat_id');
  assert.equal(text.data.receive_id, 'oc_test_purchase_group');
  // @经办人（不是 @所有人）：业务负责人改的口径。
  const textContent = JSON.parse(text.data.content).text;
  assert.match(textContent, /^<at user_id="ou_user_1"><\/at> /);
  assert.ok(!textContent.includes('user_id="all"'), '不允许再 @所有人');
  // 群里发的两条消息，一条不漏地落成「消息 ↔ 批次」记录（C 靠它反查）。
  const mappings = await batchLocatorStore.list();
  assert.equal(mappings.length, 2);
  assert.deepEqual(mappings.map((m) => m.message_id).sort(), ['om_sent_1', 'om_sent_2']);
  assert.ok(mappings.every((m) => m.batch_no), '每条映射都要带批次号');
  assert.ok(mappings.every((m) => m.chat_id === 'oc_test_purchase_group'));
  // 飞书回了 thread_id 的那条要把它记下来（话题定位的落点）。
  assert.deepEqual(
    mappings.map((m) => m.thread_id).sort(),
    ['', 'omt_sent_thread'],
  );
  // 采购事实本身不受影响：采购申请照写、报单进终态。
  assert.equal((await gateway.listAll('purchaseRequest')).length, 1);
});

test('A：未配置 PURCHASE_CHAT_ID → 大声跳过（记 skipped 日志），绝不悄悄发私聊', async () => {
  const logs = captureLogs();
  try {
    const { service, store, sent, gateway } = makeGroupPurchaseService();
    service.resolvePurchaseGroupTarget = () => ({ chatId: '', sandbox: false, reason: 'chat_id_unconfigured' });
    const accepted = await service.accept('supplier-report', 'rep_group');
    const task = await waitForTask(store, accepted.taskId);
    // 采购事实照常写成——群没配只影响"发没发出去"，不能反过来把采购判失败。
    assert.equal(task.status, 'posted');
    assert.equal((await gateway.listAll('purchaseRequest')).length, 1);
    // 一条 IM 消息都不许发（尤其不许回落到经办人私聊）。
    assert.deepEqual(sent, [], '未配置群时必须一条都不发');
    const skipped = logs.events('purchase.request.image.skipped');
    assert.equal(skipped.length, 1, '必须留下可排查的跳过日志');
    assert.ok(skipped[0].includes('purchase_chat_id_unconfigured'));
  } finally {
    logs.restore();
  }
});

test('C：发到群的两条消息都能用 message_id 反查回批次（引用定位的落点）', async () => {
  const { service, store, batchLocatorStore, sent } = makeGroupPurchaseService();
  const accepted = await service.accept('supplier-report', 'rep_group');
  await waitForTask(store, accepted.taskId);
  await waitFor('采购单发到群', async () => sent.length === 2);

  const locator = new PurchaseBatchLocator({ store: batchLocatorStore });
  const first = await locator.resolve({ parentId: 'om_sent_1' });
  const second = await locator.resolve({ parentId: 'om_sent_2' });
  assert.equal(first.status, 'matched');
  assert.equal(second.status, 'matched');
  assert.equal(first.batchNo, second.batchNo);
  assert.ok(first.batchNo, '反查回来的批次号不能为空');
  assert.equal(first.batch.request_ids.length, 1);
  // 引用一条**不是我们发的**消息：明确认不出，绝不猜最近一笔。
  const unknown = await locator.resolve({ parentId: 'om_someone_else' });
  assert.equal(unknown.status, 'not_found');
});

test('C：话题 id 能直接反查回批次（不引用机器人那条也能定位）', async () => {
  const { service, store, batchLocatorStore, sent } = makeGroupPurchaseService();
  const accepted = await service.accept('supplier-report', 'rep_group');
  await waitForTask(store, accepted.taskId);
  await waitFor('采购单发到群', async () => sent.length === 2);

  const locator = new PurchaseBatchLocator({ store: batchLocatorStore });
  // 话题里后续消息只带 thread_id（parent_id 可能是她自己的消息）——必须只靠它命中。
  const inThread = await locator.resolve({ threadId: 'omt_sent_thread', text: '这批货到了' });
  assert.equal(inThread.status, 'matched');
  assert.equal(inThread.source, 'thread_id');
  assert.ok(inThread.batchNo, '话题反查回来的批次号不能为空');
  // 没记过的话题 id：明确认不出，绝不猜。
  const unknown = await locator.resolve({ threadId: 'omt_never_seen' });
  assert.equal(unknown.status, 'not_found');
  assert.equal(unknown.source, 'thread_id');
});

test('A：拿不到经办人 open_id → 不 @任何人（也不退回 @所有人）', async () => {
  const logs = captureLogs();
  try {
    const { service, store, sent } = makeGroupPurchaseService({ operator: '' });
    const accepted = await service.accept('supplier-report', 'rep_group');
    await waitForTask(store, accepted.taskId);
    await waitFor('采购单发到群', async () => sent.length >= 2);
    const text = sent.find((m) => m.data.msg_type === 'text');
    assert.ok(text, '正文仍要发出去');
    assert.ok(!JSON.parse(text.data.content).text.includes('<at '), '拿不到经办人时一个 @ 都不加');
    assert.equal(logs.events('purchase.request.image.operator_missing').length, 1);
  } finally {
    logs.restore();
  }
});
