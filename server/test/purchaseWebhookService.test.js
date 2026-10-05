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
  });
  return { service, store, gateway, references, recognizer, inventory, client, images, dir };
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// accept() 返回时后台处理并没有结束：它把工作丢进 setImmediate，之后还要解析、
// 写卡片、等批次窗口，耗时取决于机器。固定 sleep 在慢机器上会读到 processing
// 这类中间状态（CI 上就这样失败过），所以统一改为轮询到任务进入稳定状态。
const SETTLED_STATUSES = ['awaiting_confirmation', 'failed', 'cancelled', 'posted', 'completed'];
const waitForTask = async (store, taskId, statuses = SETTLED_STATUSES, { attempts = 300, pause = 10 } = {}) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const task = await store.get(taskId);
    if (task && statuses.includes(task.status)) return task;
    await wait(pause);
  }
  const last = await store.get(taskId);
  throw new Error(`等待任务进入 ${statuses.join('/')} 超时，当前状态：${last?.status}`);
};

const waitFor = async (label, check, { attempts = 300, pause = 10 } = {}) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await wait(pause);
  }
  throw new Error(`等待「${label}」超时`);
};

// ─── 供应商报单链路（免确认 → 按供应商出图 → 发图 → 写回附件）───

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
        reportRecord('rep_merge_1', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'], 报货批次号: 'BATCH-MERGE' }),
        reportRecord('rep_merge_2', { 尺码: sizeLink(37), 数量说明: '37码1双', 编号: ['prod_1'], 报货批次号: 'BATCH-MERGE' }),
      ],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async (text) => (text.includes('36') ? [{ size: 36, quantity: 2 }] : [{ size: 37, quantity: 1 }]) }),
  });
  service.BATCH_WAIT_MS = 20;
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
        reportRecord('rep_two_1', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_A'], 报货批次号: 'BATCH-TWO' }),
        reportRecord('rep_two_2', { 尺码: sizeLink(37), 数量说明: '37码1双', 编号: ['prod_B'], 报货批次号: 'BATCH-TWO' }),
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
  service.BATCH_WAIT_MS = 20;
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
  await waitFor('到货明细卡片发出', async () => messages.length === 1);
  assert.equal(messages.length, 1);
  const cardText = JSON.stringify(JSON.parse(messages[0].data.content).elements);
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
  await waitFor('到货明细卡片发出', async () => messages.length === 1);
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
  await waitFor('到货明细卡片发出', async () => messages.length === 1);
  const cardElements = JSON.parse(messages[0].data.content).elements;
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

  await waitFor('到货明细卡片发出', async () => messages.length === 1);
  const cardText = JSON.stringify(JSON.parse(messages[0].data.content).elements);
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

  await waitFor('到货明细卡片发出', async () => messages.length === 1);
  const cardText = JSON.stringify(JSON.parse(messages[0].data.content).elements);
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

  await waitFor('到货明细卡片发出', async () => messages.length === 1);
  const cardText = JSON.stringify(JSON.parse(messages[0].data.content).elements);
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
  // 第一次跑到发卡片才失败：建档已经写进远端并落盘，任务落 failed，重收 webhook 会重跑。
  let failCard = true;
  const client = makeClient();
  client.im.message.create = async () => {
    if (failCard) throw new Error('模拟卡片发送失败');
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

test('供应商报单带批次号：先进入 batch_waiting，等待窗口结束后免确认直接 posted', async () => {
  const { service, store, gateway } = makeService({
    gateway: makeGateway({
      purchaseReport: [reportRecord('rep_batch_1', { 尺码: sizeLink(36), 编号: ['prod_1'], 报货批次号: 'BATCH-001' })],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
  });
  service.BATCH_WAIT_MS = 20;
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
        reportRecord('rep_c1', { 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'], 报货批次号: 'BATCH-CONF' }),
        reportRecord('rep_c2', { 尺码: sizeLink(37), 数量说明: '37码1双', 编号: ['prod_1'], 报货批次号: 'BATCH-CONF' }),
      ],
      purchaseOrderBatch: [],
      purchaseRequest: [],
      supplier: SUPPLIERS,
    }),
    references: referencesFor({ prod_1: productFields('8088', '黑色', 'sup_A') }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async (text) => (text.includes('36') ? [{ size: 36, quantity: 2 }] : [{ size: 37, quantity: 1 }]) }),
  });
  service.BATCH_WAIT_MS = 20;
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
  await waitFor('到货明细卡片发出', async () => messages.length === 1);
  const cardElements = JSON.parse(messages[0].data.content).elements;
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
