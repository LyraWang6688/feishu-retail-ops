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
    // 报货「未到齐」告警窗口：测试可以压到几十毫秒，验证的是逻辑而不是等 5 分钟。
    reportAlertDelayMs: options.reportAlertDelayMs,
    // 重启重建告警会在构造时读一次报单表。生产上必须开（重启不丢告警），
    // 但单测里这是纯粹的后台噪声，所以默认关掉，只让专门测它的用例打开。
    enableReportAlertBootstrap: options.enableReportAlertBootstrap ?? false,
    // 只挂号不装定时器：让用例明确地自己决定"什么时候到点"，避免和异步处理抢时间。
    disableBatchAlertTimers: options.disableBatchAlertTimers ?? false,
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

// ─── 批次「到齐」判据（不再是 30 秒窗口）────────────────────────────────────
//
// 30 秒合并窗口已经整体删除：现在的判据是「Σ(每条明细解析出的双数) >= 合计数量」，
// 到齐就立刻处理、未到齐就什么都不做。所以这些用例**不需要**再靠等待时间对齐——
// 触发处理的唯一条件是"双数凑够了"，只要在最后一条明细上把「合计数量」写足，
// 处理就是确定性的。
//
// 等待方式也统一改成轮询不变量（waitFor / waitForTask），不用固定 sleep 卡时间。

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

// 带「合计数量」的批次报单：判据的申报值就写在这里。
const batchReportRecord = (recordId, fields) => {
  const total = fields['合计数量'];
  return reportRecord(recordId, { 合计数量: total, ...fields });
};

// 批次真正完成的不变量：这一批的**所有**报单记录都被推到了终态
//（处理状态「已生成申请」是 confirmPurchaseRequest 在最后一步写的）。
// 比"等某个任务的 status"可靠：批次里每条明细各有一个任务，先到的那条合法地停在
// 「未到齐」，后到的那条才是真正跑完的那条。
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
        batchReportRecord('rep_merge_1', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'], 报货批次号: 'BATCH-MERGE', 合计数量: 3 }),
        batchReportRecord('rep_merge_2', { 尺码: sizeLink(37), 数量说明: '37码1双', 编号: ['prod_1'], 报货批次号: 'BATCH-MERGE', 合计数量: 3 }),
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
        batchReportRecord('rep_two_1', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_A'], 报货批次号: 'BATCH-TWO', 合计数量: 3 }),
        batchReportRecord('rep_two_2', { 尺码: sizeLink(37), 数量说明: '37码1双', 编号: ['prod_B'], 报货批次号: 'BATCH-TWO', 合计数量: 3 }),
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
  const task = await waitForTask(store, accepted.taskId);
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

test('arrival creates a missing color record and tells the user about it', async () => {
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
  const task = await waitForTask(store, accepted.taskId);
  assert.equal(task.status, 'awaiting_confirmation');

  assert.equal(records.color.length, 1, '颜色表没有的颜色要自动补一条');
  assert.equal(records.color[0].fields.颜色, '香芋紫');
  assert.deepEqual(records.product[0].fields.颜色, [records.color[0].record_id]);
  assert.deepEqual(task.draft.created_colors, ['香芋紫']);
  assert.equal(task.draft.created_products[0].color_created, true);

  await waitFor('到货明细卡片发出', async () => cardMessages(messages).length === 1);
  const cardText = JSON.stringify(JSON.parse(cardMessages(messages)[0].data.content).elements);
  assert.ok(cardText.includes('香芋紫'), '卡片要说明颜色表补了一条');
  assert.ok(cardText.includes('我给你加了一条'), `卡片文案应说明补颜色，实际：${cardText}`);
  assert.ok(cardText.includes('新品'), '卡片要把新品单独讲清楚');
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
  const task = await waitForTask(store, accepted.taskId);
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
  await waitForTask(store, accepted.taskId);
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
  const task = await waitForTask(store, accepted.taskId);
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
  const task = await waitForTask(store, accepted.taskId);
  assert.equal(task.status, 'awaiting_confirmation');
  assert.equal(records.product.length, 1, '老货品不能建新记录');
  assert.equal(records.color.length, 1, '老货品不能动颜色表');
  assert.deepEqual(task.draft.created_products, []);
  assert.deepEqual(task.draft.created_colors, []);
  assert.equal(task.draft.actual[0].created_product, false);
  assert.equal(task.draft.actual[0].product_number, '8088灰', '仍然用表里的完整编号');
});

test('arrival tells the user what a new product still lacks, read from the 缺失信息说明 formula', async () => {
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
  const task = await waitForTask(store, accepted.taskId);
  assert.deepEqual(task.draft.created_products[0].missing, ['成本', '品类']);
  assert.equal(task.draft.created_products[0].missing_sample_image, true);
  assert.equal(task.draft.created_products[0].completeness_readable, true);

  await waitFor('到货明细卡片发出', async () => cardMessages(messages).length === 1);
  const cardText = JSON.stringify(JSON.parse(cardMessages(messages)[0].data.content).elements);
  assert.ok(cardText.includes('还差 成本 / 品类 / 样例图'), `卡片应列出缺口，实际：${cardText}`);
});

test('re-processing a failed arrival reuses the persisted new product instead of creating a second', async () => {
  const records = {
    purchaseArrival: [{ record_id: 'arr_retry_new', fields: { 确认状态: '待确认', 识别状态: '待识别', 图片: [{ file_token: 'tok_1' }], 验收人: [{ id: 'ou_1' }] } }],
    purchaseInbound: [],
    product: [],
    color: [],
    supplier: [],
  };
  // 第一次跑到发「确认卡片」才失败：建档已经写进远端并落盘，任务落 failed，重收 webhook 会重跑。
  //
  // 这里必须**只**让卡片（interactive）失败，不能见消息就抛：到货链路现在在识别之前
  // 还会先发一条「收到到货申请，正在识别图片～」的文字提示（msg_type: 'text'），
  // 那条提示和确认卡片走的是同一个 `im.message.create`。早先这个桩写成"一律抛错"，
  // 结果失败点被顶到建档**之前**，这条用例就再也验证不到"复用已建货品"了。
  // 见下面「收到即提示发失败不能中断到货识别」那条用例，它专门钉住提示与卡片的分工。
  let failCard = true;
  const client = makeClient();
  client.im.message.create = async (params) => {
    if (failCard && params?.data?.msg_type === 'interactive') throw new Error('模拟卡片发送失败');
    return { code: 0 };
  };
  const { service, store } = makeService({
    gateway: makeGateway(records),
    client,
    references: makeReferences({
      resolveProduct: async ({ itemNo, color }) => { throw productNotFound(itemNo, color); },
    }),
    recognizer: makeRecognizer({
      recognizeLabels: async () => [{ item_no: '3602', color: '黑色', size: 36, quantity: 1 }],
    }),
  });

  const first = await service.accept('arrival', 'arr_retry_new');
  await waitForTask(store, first.taskId, ['failed']);
  assert.equal(records.product.length, 1, '第一次已经建了一条货品');
  assert.equal(records.color.length, 1, '第一次已经建了一条颜色');

  failCard = false;
  await service.accept('arrival', 'arr_retry_new');
  const retried = await waitForTask(store, first.taskId, ['awaiting_confirmation']);
  assert.equal(retried.status, 'awaiting_confirmation');
  assert.equal(records.product.length, 1, '重试必须复用已落盘的建档记录');
  assert.equal(records.color.length, 1, '重试不能再建一条颜色');
  assert.equal(retried.draft.created_products.length, 1, '重试后卡片仍要说明这批有新品');
  assert.equal(retried.draft.created_products[0].product_record_id, records.product[0].record_id);
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
  const task = await waitForTask(store, accepted.taskId);

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

test('供应商报单带批次号：合计数量到齐就免确认直接生成采购申请（不需要等窗口）', async () => {
  const { service, store, gateway } = makeService({
    gateway: makeGateway({
      purchaseReport: [batchReportRecord('rep_batch_1', { 尺码: sizeLink(36), 编号: ['prod_1'], 报货批次号: 'BATCH-001', 合计数量: 1 })],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
  });
  const result = await service.accept('supplier-report', 'rep_batch_1');
  assert.equal(result.accepted, true);
  const task = await waitForTask(store, result.taskId, ['posted', 'failed']);
  assert.equal(task.status, 'posted');
  assert.equal((await gateway.get('purchaseReport', 'rep_batch_1')).fields.处理状态, '已生成申请');
  assert.equal((await gateway.listAll('purchaseRequest')).length, 1);
});

test('同一个批次的多条报单合成一个批次任务，全部标记已生成申请、只出一张图', async () => {
  const { service, store, gateway, images } = makeService({
    gateway: makeGateway({
      purchaseReport: [
        batchReportRecord('rep_c1', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'], 报货批次号: 'BATCH-CONF', 合计数量: 3 }),
        batchReportRecord('rep_c2', { 尺码: sizeLink(37), 数量说明: '37码1双', 编号: ['prod_1'], 报货批次号: 'BATCH-CONF', 合计数量: 3 }),
      ],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async (text) => (text.includes('36') ? [{ size: 36, quantity: 2 }] : [{ size: 37, quantity: 1 }]) }),
  });
  const first = await service.accept('supplier-report', 'rep_c1');
  await service.accept('supplier-report', 'rep_c2');
  const task = await waitForTask(store, first.taskId, ['posted', 'failed']);
  assert.equal(task.status, 'posted');
  assert.ok(task.draft.is_batch === true);
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

// ─── 「到齐」判据直接生效：未到齐不处理、到齐才处理、幂等、5 分钟告警 ───
//
// 判据：Σ(每条明细解析出的双数) >= 「合计数量」。
// 下面每个用例都刻意只用一个批次号 + 明确的合计数量，让"什么时候该处理"完全确定，
// 不再依赖任何等待窗口。

// 有些用例要断言"一次写入都没有发生"：给 gateway 加上写调用计数。
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

// 未到齐的用例统一用这个：处理是否"什么都没做"的判据是任务停在
// awaiting_completeness（而不是 posted/failed），并且没有任何写调用。
const waitForUnprocessed = async (store, taskId) => {
  await waitFor('任务停在「未到齐」', async () => (await store.get(taskId))?.status === 'awaiting_completeness');
  return store.get(taskId);
};

test('到齐（单条就够）：一条明细 1 双 + 合计数量 1 → 生成采购申请并把记录标成已生成申请', async () => {
  const { service, store, gateway } = makeService({
    gateway: makeGateway({
      purchaseReport: [batchReportRecord('rep_ready_1', { 尺码: sizeLink(36), 数量说明: '36码1双', 编号: ['prod_1'], 报货批次号: 'BATCH-READY-1', 合计数量: 1 })],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 1 }] }),
  });
  const accepted = await service.accept('supplier-report', 'rep_ready_1');
  const task = await waitForProcessed(store, accepted.taskId);
  assert.equal(task.status, 'posted');
  assert.equal(task.result.status, 'posted');
  assert.equal(task.result.batch_no, 'BATCH-READY-1');
  assert.equal((await gateway.listAll('purchaseRequest')).length, 1);
  assert.equal((await gateway.get('purchaseReport', 'rep_ready_1')).fields.处理状态, '已生成申请');
});

test('到齐（多条累加）：两条明细 2+3 双、合计数量 5 → 两条合成一个批次一次处理', async () => {
  const { service, store, gateway, images } = makeService({
    gateway: makeGateway({
      purchaseReport: [
        batchReportRecord('rep_ready_2a', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'], 报货批次号: 'BATCH-READY-2', 合计数量: 5 }),
        batchReportRecord('rep_ready_2b', { 尺码: sizeLink(37), 数量说明: '37码3双', 编号: ['prod_1'], 报货批次号: 'BATCH-READY-2', 合计数量: 5 }),
      ],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async (text) => [{ size: text.includes('36') ? 36 : 37, quantity: text.includes('36') ? 2 : 3 }] }),
  });
  const accepted = await Promise.all([
    service.accept('supplier-report', 'rep_ready_2a'),
    service.accept('supplier-report', 'rep_ready_2b'),
  ]);
  // 两条明细各有一个任务，谁先到不影响判据：先到的那条读到"没到齐"会停下，
  // 后到的那条看到整批齐了才处理。这里等的是**两个任务都真的跑完**（result 已落盘）——
  // 「处理状态=已生成申请」在写采购申请那一步就落盘了，之后还要出图、写回附件、落 result，
  // 所以只等它会在慢机器上读到半成品。
  const tasks = await waitForProcessed(store, accepted.map((item) => item.taskId));
  // 真正跑完这一批的是**装配了草稿**的那个任务（它可能是两条里任意一条——
  // 先到的那条只拿到 2 双，判未到齐就停下了；后到的才凑够 5 双）。
  const task = tasks.find((item) => Array.isArray(item.draft?.items) && item.draft.items.length > 0);
  assert.ok(task, `应有任务装配出批次草稿，实际：${JSON.stringify(tasks.map((t) => [t.status, t.result?.status]))}`);
  assert.equal(task.status, 'posted');
  assert.equal(task.draft.items.length, 2);
  assert.equal(task.draft.items.reduce((sum, item) => sum + item.quantity, 0), 5);
  assert.equal((await gateway.listAll('purchaseRequest')).length, 2, '每个尺码一条采购申请');
  assert.equal((await gateway.get('purchaseReport', 'rep_ready_2a')).fields.处理状态, '已生成申请');
  assert.equal((await gateway.get('purchaseReport', 'rep_ready_2b')).fields.处理状态, '已生成申请');
  await waitForAttachments(gateway, 1);
  assert.equal(images.calls.length, 1, '同一供应商只出一张图');
});

test('一条明细里含多双：3+2=5、只有 2 条明细，也判到齐（判的是双数不是条数）', async () => {
  const { service, store, gateway } = makeService({
    gateway: makeGateway({
      purchaseReport: [
        batchReportRecord('rep_pairs_a', { 尺码: sizeLink(36), 数量说明: '36码3双', 编号: ['prod_1'], 报货批次号: 'BATCH-PAIRS', 合计数量: 5 }),
        batchReportRecord('rep_pairs_b', { 尺码: sizeLink(37), 数量说明: '37码2双', 编号: ['prod_1'], 报货批次号: 'BATCH-PAIRS', 合计数量: 5 }),
      ],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async (text) => [{ size: text.includes('36') ? 36 : 37, quantity: text.includes('36') ? 3 : 2 }] }),
  });
  const accepted = await Promise.all([
    service.accept('supplier-report', 'rep_pairs_a'),
    service.accept('supplier-report', 'rep_pairs_b'),
  ]);
  const tasks = await waitForProcessed(store, accepted.map((item) => item.taskId));
  const task = tasks.find((item) => item.result?.status === 'posted');
  assert.ok(task, `应有一个任务产出批次结果，实际：${JSON.stringify(tasks.map((t) => t.status))}`);
  assert.equal(task.status, 'posted', '3+2=5 在只有 2 条明细时也算到齐');
  const quantities = task.draft.items.map((item) => item.quantity).sort();
  assert.deepEqual(quantities, [2, 3]);
  // 注意：报单表里其实是一条记录里塞了两个尺码（3 双 + 2 双），判据用的是双数之和。
  assert.equal(task.result.item_count, 2);
});

test('多报（收到的比申报的多）仍判到齐，不把批次卡死', async () => {
  const { service, store, gateway } = makeService({
    gateway: makeGateway({
      purchaseReport: [
        batchReportRecord('rep_over_a', { 尺码: sizeLink(36), 数量说明: '36码3双', 编号: ['prod_1'], 报货批次号: 'BATCH-OVER', 合计数量: 5 }),
        batchReportRecord('rep_over_b', { 尺码: sizeLink(37), 数量说明: '37码4双', 编号: ['prod_1'], 报货批次号: 'BATCH-OVER', 合计数量: 5 }),
      ],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async (text) => [{ size: text.includes('36') ? 36 : 37, quantity: text.includes('36') ? 3 : 4 }] }),
  });
  const accepted = await Promise.all([
    service.accept('supplier-report', 'rep_over_a'),
    service.accept('supplier-report', 'rep_over_b'),
  ]);
  const tasks = await waitForProcessed(store, accepted.map((item) => item.taskId));
  assert.ok(tasks.some((item) => item.status === 'posted'), `应有一个任务产出批次结果，实际：${JSON.stringify(tasks.map((t) => t.status))}`);
  assert.equal((await gateway.get('purchaseReport', 'rep_over_a')).fields.处理状态, '已生成申请');
});

test('未到齐 → 什么都不做：不处理、不写任何表、不改处理状态', async () => {
  const gateway = makeGateway({
    purchaseReport: [batchReportRecord('rep_wait_1', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'], 报货批次号: 'BATCH-WAIT', 合计数量: 5 })],
    purchaseOrderBatch: [],
    purchaseRequest: [],
    supplier: SUPPLIERS,
  });
  const writes = countGatewayWrites(gateway);
  const { service, store } = makeService({
    gateway,
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 2 }] }),
  });
  const accepted = await service.accept('supplier-report', 'rep_wait_1');
  const task = await waitForUnprocessed(store, accepted.taskId);
  assert.equal(task.status, 'awaiting_completeness');
  assert.equal(task.result.receivedQuantity, 2);
  assert.equal(task.result.declaredTotal, 5);
  assert.equal(task.result.missingQuantity, 3);
  assert.deepEqual(writes, [], '未到齐不得有任何写入');
  assert.equal((await gateway.listAll('purchaseRequest')).length, 0, '未到齐不得生成采购申请');
  assert.equal((await gateway.get('purchaseReport', 'rep_wait_1')).fields.处理状态, '待解析', '未到齐不是失败，处理状态保持不动');
});

test('「合计数量」缺失/非法 → 不崩、不处理（按未到齐等待）', async () => {
  for (const [label, declared] of [['缺失', undefined], ['零', 0], ['负数', -3], ['非数字文本', 'abc']]) {
    const gateway = makeGateway({
      purchaseReport: [reportRecord('rep_bad_total', {
        尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'], 报货批次号: 'BATCH-BAD',
        ...(declared === undefined ? {} : { 合计数量: declared }),
      })],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    });
    const writes = countGatewayWrites(gateway);
    const { service, store } = makeService({
      gateway,
      references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
      recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 2 }] }),
    });
    const accepted = await service.accept('supplier-report', 'rep_bad_total');
    const task = await waitForUnprocessed(store, accepted.taskId);
    assert.equal(task.status, 'awaiting_completeness', `合计数量${label}时要停下等，不能崩`);
    assert.equal(task.result.reason, 'no_declared_total', `合计数量${label}要给 no_declared_total`);
    assert.equal(task.result.complete, false);
    assert.deepEqual(writes, [], `合计数量${label}时不得有任何写入`);
    assert.equal((await gateway.get('purchaseReport', 'rep_bad_total')).fields.处理状态, '待解析');
  }
});

test('同批「合计数量」不一致 → 标出来但不卡死，按第一条合法值继续判', async () => {
  const logs = [];
  const originalWarn = console.warn;
  console.warn = (line) => { try { logs.push(JSON.parse(line)); } catch { /* 非 JSON 行不关心 */ } };
  try {
    const { service, store, gateway } = makeService({
      gateway: makeGateway({
        purchaseReport: [
          batchReportRecord('rep_inc_a', { 尺码: sizeLink(36), 数量说明: '36码5双', 编号: ['prod_1'], 报货批次号: 'BATCH-INC', 合计数量: 5 }),
          batchReportRecord('rep_inc_b', { 尺码: sizeLink(37), 数量说明: '37码2双', 编号: ['prod_1'], 报货批次号: 'BATCH-INC', 合计数量: 4 }),
        ],
        purchaseOrderBatch: [],
        purchaseRequest: [],
        supplier: SUPPLIERS,
      }),
      references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
      recognizer: makeRecognizer({ parsePurchaseReportText: async (text) => [{ size: text.includes('36') ? 36 : 37, quantity: text.includes('36') ? 5 : 2 }] }),
    });
    const accepted = await Promise.all([
      service.accept('supplier-report', 'rep_inc_a'),
      service.accept('supplier-report', 'rep_inc_b'),
    ]);
    const tasks = await waitForSettled(store, accepted.map((item) => item.taskId));
    // 取第一条合法值 5；收到的 7 双 >= 5，照常处理（不因为数据异常把货卡住）。
    assert.ok(tasks.some((item) => item.status === 'posted'), '数据异常不该把货卡住');
    const inconsistent = logs.find((line) => line.event === 'purchase.batch.declared_total_inconsistent');
    assert.ok(inconsistent, `必须标出同批合计数量不一致，实际日志：${logs.map((line) => line.event).join(',')}`);
    assert.deepEqual(inconsistent.declared_totals.sort(), [4, 5]);
  } finally {
    console.warn = originalWarn;
  }
});

test('重复投递（同一批的明细 webhook 重投）→ 不重复建单、不重复发图', async () => {
  const records = {
    purchaseReport: [
      batchReportRecord('rep_dup_batch_a', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'], 报货批次号: 'BATCH-DUP', 合计数量: 3 }),
      batchReportRecord('rep_dup_batch_b', { 尺码: sizeLink(37), 数量说明: '37码1双', 编号: ['prod_1'], 报货批次号: 'BATCH-DUP', 合计数量: 3 }),
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
      batchReportRecord('rep_race_batch_a', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'], 报货批次号: 'BATCH-RACE', 合计数量: 3 }),
      batchReportRecord('rep_race_batch_b', { 尺码: sizeLink(37), 数量说明: '37码1双', 编号: ['prod_1'], 报货批次号: 'BATCH-RACE', 合计数量: 3 }),
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

test('5 分钟未到齐 → 只发一条人话告警，处理状态不变', async () => {
  const messages = [];
  const { service, store, gateway } = makeService({
    client: makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } }),
    gateway: makeGateway({
      purchaseReport: [batchReportRecord('rep_slow', {
        尺码: sizeLink(36), 数量说明: '36码3双', 编号: ['prod_1'], 报货批次号: 'BATCH-SLOW', 合计数量: 5, 报单时间: Date.now(),
      })],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 3 }] }),
    // 5 分钟太久：把告警窗口压到 20ms，验证的是"到点仍未到齐 → 发一条消息"这条逻辑。
    reportAlertDelayMs: 20,
  });
  const accepted = await service.accept('supplier-report', 'rep_slow');
  await waitForUnprocessed(store, accepted.taskId);
  await waitFor('未到齐告警发出', async () => messages.length === 1);

  assert.equal(messages[0].data.msg_type, 'text', '告警走纯文字，不发卡片');
  assert.equal(messages[0].data.receive_id, 'ou_user_1');
  const text = JSON.parse(messages[0].data.content).text;
  assert.ok(text.includes('5 双') && text.includes('3 双'), `告警要说清楚申报和实收，实际：${text}`);
  assert.ok(/是不是还有明细没提交/.test(text), `告警要给下一步动作，实际：${text}`);

  // 只告警、不改状态：处理状态必须原样停在「待解析」。
  assert.equal((await gateway.get('purchaseReport', 'rep_slow')).fields.处理状态, '待解析');
  assert.equal((await store.get(accepted.taskId)).status, 'awaiting_completeness');
  assert.equal((await gateway.listAll('purchaseRequest')).length, 0);
  // 告警只发一次，不重复轰炸。
  await wait(50);
  assert.equal(messages.length, 1, '同一次未到齐只提醒一次');
});

test('告警到点时刚好补齐 → 不再打扰她（重新读表重算判据）', async () => {
  const messages = [];
  const records = {
    purchaseReport: [batchReportRecord('rep_just_intime', {
      尺码: sizeLink(36), 数量说明: '36码3双', 编号: ['prod_1'], 报货批次号: 'BATCH-JIT', 合计数量: 5, 报单时间: Date.now(),
    })],
    purchaseOrderBatch: [],
    purchaseRequest: [],
    supplier: SUPPLIERS,
  };
  const { service, store } = makeService({
    client: makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } }),
    gateway: makeGateway(records),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 3 }] }),
    reportAlertDelayMs: 20,
    // 不装定时器：否则 20ms 的闹钟可能抢在下面那行改写之前触发，
    // 用例就变成"看谁跑得快"，而不是在验证"到点复查"这件事。
    disableBatchAlertTimers: true,
  });
  const accepted = await service.accept('supplier-report', 'rep_just_intime');
  await waitForUnprocessed(store, accepted.taskId);
  // 到点前把「合计数量」改成已经满足（模拟"其实早就补齐了"），到点复查应发现已到齐。
  records.purchaseReport[0].fields.合计数量 = 3;
  const swept = await service.sweepBatchAlerts(Date.now() + 1000);
  assert.equal(swept.checked, 1, '到点应该复查这一批');
  assert.equal(swept.alerted, 0, '到点复查发现已到齐，不该告警');
  await wait(20);
  assert.deepEqual(messages, [], '到点复查发现已到齐就不该再发告警');
  assert.equal((await store.get(accepted.taskId)).status, 'awaiting_completeness', '告警撤掉不改任何状态');
});

test('重启后告警不丢：从表里的「报单时间」重建未到齐的告警', async () => {
  const records = {
    purchaseReport: [batchReportRecord('rep_restart', {
      尺码: sizeLink(36), 数量说明: '36码3双', 编号: ['prod_1'], 报货批次号: 'BATCH-RESTART', 合计数量: 5,
      // 报单时间是 10 分钟前：早就过了 5 分钟，重启后必须马上提醒（而不是重新计时）。
      报单时间: Date.now() - 10 * 60 * 1000,
    })],
    purchaseOrderBatch: [],
    purchaseRequest: [],
    supplier: SUPPLIERS,
  };
  const logs = [];
  const originals = { log: console.log, warn: console.warn };
  const push = (line) => { try { logs.push(JSON.parse(line)); } catch { /* 非 JSON 行不关心 */ } };
  console.log = push;
  console.warn = push;
  let service;
  try {
    ({ service } = makeService({
      gateway: makeGateway(records),
      references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
      recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 3 }] }),
      reportAlertDelayMs: 5 * 60 * 1000,
      // 生产上构造函数自己会做这件事（enableReportAlertBootstrap 默认 true）：
      // 这里打开它，验证的正是「重启后自动重建」，而不是手工调用。
      enableReportAlertBootstrap: true,
    }));
    // 重启后自动挂号：起算点是表里的「报单时间」（10 分钟前），
    // 所以到点时间应该正好是「报单时间 + 5 分钟」，而不是"重启时刻 + 5 分钟"。
    await waitFor('重启后自动重建告警', async () => logs.some((line) => line.event === 'purchase.report.alert.bootstrap'));
    const scheduled = logs.find((line) => line.event === 'purchase.report.alert.scheduled');
    assert.ok(scheduled, `重建时要重新挂号，实际日志：${logs.map((line) => line.event).join(',')}`);
    const expectedDueAt = records.purchaseReport[0].fields.报单时间 + 5 * 60 * 1000;
    assert.equal(Date.parse(scheduled.due_at), expectedDueAt, '到点时间必须由表里的报单时间推出来');
    // 已经过期：重建后的定时器会立即触发，发出告警（而不是重新等 5 分钟）。
    await waitFor('重建后的告警发出', async () => logs.some((line) => line.event === 'purchase.report.alert.incomplete'));
    const alerted = logs.find((line) => line.event === 'purchase.report.alert.incomplete');
    assert.equal(alerted.batch_no, 'BATCH-RESTART');
    assert.equal(alerted.sent, true);
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
  }
});

test('异常 → 不静默丢单：任务落成可重试的 failed，记录处理状态保持不变', async () => {
  // 让「解析货品」这一步先失败（模型/读表故障的典型长相），再在下一次投递时恢复。
  let failResolve = true;
  const records = {
    purchaseReport: [batchReportRecord('rep_retry', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'], 报货批次号: 'BATCH-RETRY', 合计数量: 2 })],
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
      batchReportRecord('rep_done_a', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'], 报货批次号: 'BATCH-DONE', 合计数量: 3, 处理状态: '已生成申请' }),
      // 事后才补录进来的一条：它自己不该触发第二次采购申请。
      batchReportRecord('rep_done_b', { 尺码: sizeLink(37), 数量说明: '37码1双', 编号: ['prod_1'], 报货批次号: 'BATCH-DONE', 合计数量: 3 }),
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
  const task = await waitForTask(store, accepted.taskId);
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
    return waitForTask(store, accepted.taskId);
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
    return waitForTask(store, accepted.taskId);
  });
  assert.equal('成本' in records.product[0].fields, false, '价格不一致时一个值都不能写');
  const warn = lines.find((line) => line.event === 'purchase.arrival.cost_conflict');
  assert.ok(warn, `必须有 cost_conflict warn，实际日志：${JSON.stringify(lines.map((line) => line.event))}`);
  assert.equal(warn.item_no, '1366-31');
  assert.deepEqual(warn.prices, [199, 209]);
  // 只 warn 一次：不能每个尺码都报一遍。
  assert.equal(lines.filter((line) => line.event === 'purchase.arrival.cost_conflict').length, 1);
});

test('到货单价格即成本：重试不重复写（第一次已写成功，只是发卡片失败）', async () => {
  const records = {
    purchaseArrival: [arrivalDocumentRecord('arr_cost_retry')],
    product: [{ record_id: 'prod_retry', fields: { 编号: '1366-31棕色', 供应商: ['sup_A'] } }],
    supplier: SUPPLIERS,
  };
  let failCard = true;
  const client = makeClient();
  client.im.message.create = async () => {
    if (failCard) throw new Error('模拟卡片发送失败');
    return { code: 0 };
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
    client,
    references: makeReferences({
      resolveProduct: async () => ({ recordId: 'prod_retry', record: records.product[0] }),
    }),
    recognizer: documentRecognizer([{ item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: 199 }]),
  });

  const first = await service.accept('arrival', 'arr_cost_retry');
  await waitForTask(store, first.taskId, ['failed']);
  assert.equal(costUpdates.length, 1, '第一次要写成本');
  assert.equal(records.product[0].fields.成本, 199);

  failCard = false;
  await service.accept('arrival', 'arr_cost_retry');
  const retried = await waitForTask(store, first.taskId, ['awaiting_confirmation']);
  assert.equal(retried.status, 'awaiting_confirmation');
  assert.equal(costUpdates.length, 1, '重试不能再写一次成本（写没写靠任务里落盘的 arrival_cost_written 判断）');
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
    return waitForTask(store, accepted.taskId);
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
  const task = await waitForTask(store, accepted.taskId);
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
  await waitForTask(store, accepted.taskId);
  assert.equal(records.product.length, 1);
  assert.equal('成本' in records.product[0].fields, false, '没有可信价格就不许写成本');
});
