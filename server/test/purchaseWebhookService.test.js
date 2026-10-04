const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
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

const makeGateway = (records = {}) => ({
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
});

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
  const service = new PurchaseWebhookService({
    gateway, references, recognizer, inventory: inventory.applyPurchase ? inventory : undefined,
    client, store, enablePurchaseInventory: options.enablePurchaseInventory ?? true,
    batchReadMaxRetries: options.batchReadMaxRetries ?? 1,
    batchReadRetryDelay: options.batchReadRetryDelay ?? 0,
  });
  return { service, store, gateway, references, recognizer, inventory, client, dir };
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

// ─── 供应商报单链路 ───

test('supplier report webhook accepts and processes to awaiting_confirmation', async () => {
  const messages = [];
  const { service, store, gateway } = makeService({
    client: makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } }),
    gateway: makeGateway({
      purchaseReport: [{ record_id: 'rep_1', fields: { 处理状态: '待解析', 尺码: sizeLinks(36, 37), 数量说明: '36码2双，37码1双', 编号: ['prod_1'], 采购行为: ['beh_1'], 供应商: '测试供应商', 经办人: [{ id: 'ou_user_1' }] } }],
    }),
  });
  const result = await service.accept('supplier-report', 'rep_1');
  assert.equal(result.accepted, true);
  assert.equal(result.duplicate, false);
  const task = await waitForTask(store, result.taskId);
  assert.equal(task.status, 'awaiting_confirmation');
  assert.ok(task.draft);
  assert.equal(task.draft.items.length, 2);
  // 任务是先落库状态、再发确认卡片的，所以不能只等状态：
  // 状态一到就断言卡片，慢机器上卡片可能还没发出去。
  await waitFor('确认卡片发出', async () => messages.length === 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].data.receive_id, 'ou_user_1');
  const updated = await gateway.get('purchaseReport', 'rep_1');
  assert.equal(updated.fields.处理状态, '待确认');
});

test('supplier report duplicate webhook is ignored', async () => {
  const { service, store } = makeService({
    gateway: makeGateway({
      purchaseReport: [{ record_id: 'rep_dup', fields: { 处理状态: '待解析', 尺码: sizeLink(36), 编号: ['prod_1'], 经办人: [{ id: 'ou_1' }] } }],
    }),
  });
  const first = await service.accept('supplier-report', 'rep_dup');
  await waitForTask(store, first.taskId);
  const second = await service.accept('supplier-report', 'rep_dup');
  assert.equal(second.duplicate, true);
  const task = await store.get(first.taskId);
  assert.equal(task.status, 'awaiting_confirmation');
});

test('supplier report confirm generates purchase order batch and requests', async () => {
  const { service, store, gateway } = makeService({
    gateway: makeGateway({
      purchaseReport: [{ record_id: 'rep_conf', fields: { 处理状态: '待确认', 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'], 采购行为: ['beh_1'], 供应商: '测试供应商', 经办人: [{ id: 'ou_1' }] } }],
      purchaseOrderBatch: [],
      purchaseRequest: [],
    }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 2 }] }),
  });
  const accepted = await service.accept('supplier-report', 'rep_conf');
  await waitForTask(store, accepted.taskId);
  const result = await service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_request' }, 'ou_1');
  assert.ok(result.toast.content.includes('采购申请已生成'));
  const batches = await gateway.listAll('purchaseOrderBatch');
  assert.equal(batches.length, 1);
  assert.ok(batches[0].fields.报货批次号.startsWith('BH-'));
  const requests = await gateway.listAll('purchaseRequest');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].fields.报货批次号, [batches[0].record_id]);
  assert.deepEqual(requests[0].fields.尺码, sizeLink(36));
  const updatedReport = await gateway.get('purchaseReport', 'rep_conf');
  assert.equal(updatedReport.fields.处理状态, '已生成申请');
});

test('multi-size report confirm writes one request per size with linked sizes and quantities', async () => {
  const { service, store, gateway } = makeService({
    gateway: makeGateway({
      purchaseReport: [{ record_id: 'rep_multi', fields: { 处理状态: '待确认', 尺码: sizeLinks(36, 37), 数量说明: '36码2双，37码1双', 编号: ['prod_1'], 采购行为: ['beh_1'], 供应商: '测试供应商', 经办人: [{ id: 'ou_1' }] } }],
      purchaseOrderBatch: [],
      purchaseRequest: [],
    }),
  });
  const accepted = await service.accept('supplier-report', 'rep_multi');
  const task = await waitForTask(store, accepted.taskId);
  assert.equal(task.draft.items.length, 2);

  const result = await service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_request' }, 'ou_1');
  assert.ok(result.toast.content.includes('采购申请已生成'));

  const batches = await gateway.listAll('purchaseOrderBatch');
  const requests = await gateway.listAll('purchaseRequest');
  assert.equal(requests.length, 2);
  // 数量说明只描述例外：36 码两双、37 码默认一双。
  const quantityBySize = new Map(requests.map((row) => [row.fields.尺码[0], row.fields.数量]));
  assert.deepEqual([...quantityBySize.entries()].sort(), [['size_36', 2], ['size_37', 1]]);
  for (const request of requests) {
    // 尺码与报货批次都必须以关联形式写入，不能再写数字或纯文本。
    assert.equal(request.fields.尺码.length, 1);
    assert.ok(String(request.fields.尺码[0]).startsWith('size_'), `尺码应为关联 ID，实际：${request.fields.尺码[0]}`);
    assert.deepEqual(request.fields.报货批次号, [batches[0].record_id]);
  }
});

test('supplier report cancel updates status', async () => {
  const { service, store, gateway } = makeService({
    gateway: makeGateway({
      purchaseReport: [{ record_id: 'rep_cancel', fields: { 处理状态: '待确认', 尺码: sizeLink(36), 编号: ['prod_1'], 经办人: [{ id: 'ou_1' }] } }],
    }),
  });
  const accepted = await service.accept('supplier-report', 'rep_cancel');
  await waitForTask(store, accepted.taskId);
  await service.handleCardAction({ draft_id: accepted.taskId, action: 'cancel_purchase_request' }, 'ou_1');
  const updated = await gateway.get('purchaseReport', 'rep_cancel');
  assert.equal(updated.fields.处理状态, '已取消');
});

// ─── 采购到货链路 ───

test('arrival webhook accepts, recognizes images, and sends comparison card', async () => {
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
  assert.equal(task.draft.differences.length, 1);
  assert.equal(task.draft.differences[0].label, '少1');
  // 同上：先落库状态，再发卡片。
  await waitFor('到货对比卡片发出', async () => messages.length === 1);
  assert.equal(messages.length, 1);
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
  // 到货单同样要和该批次的采购申请比对，流程与鞋盒完全一致。
  assert.equal(task.draft.differences.find((row) => row.size === 36).label, '少1');
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

test('arrival without a batch number is a direct arrival: no error, no comparison, still inbound', async () => {
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
  // 没有申请可比就不生成差异行：否则每一行都会被算成「多N」，反而误导她。
  assert.deepEqual(task.draft.differences, []);
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

test('arrival with a batch number still compares against that batch requests', async () => {
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
  assert.equal(task.draft.differences.length, 1);
  assert.equal(task.draft.differences[0].label, '少2');
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
      recognizeLabels: async () => [{ item_no: '3602', color: '黑色', size: 36, quantity: 1, gender: '女', supplier: '一代千金' }],
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
  // 只写确定知道的字段：公式字段（编号/货品状态/缺失信息说明）一个都不能写。
  assert.deepEqual([...Object.keys(created.fields)].sort(), ['供应商', '类别', '颜色', '货号'].sort());
  assert.equal(created.fields.货号, '3602');
  assert.deepEqual(created.fields.颜色, ['color_black'], '「黑」要复用颜色表已有记录');
  assert.deepEqual(created.fields.供应商, ['sup_9']);
  assert.equal(created.fields.类别, 'B', '品名是女鞋 → B');

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
  assert.equal(draft.differences[0].label, '一致');
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

test('supplier report with batch number enters batch_waiting state', async () => {
  const { service, store } = makeService({
    gateway: makeGateway({
      purchaseReport: [{ record_id: 'rep_batch_1', fields: { 处理状态: '待解析', 尺码: sizeLink(36), 编号: ['prod_1'], 采购行为: ['beh_1'], 报货批次号: 'BATCH-001', 经办人: [{ id: 'ou_1' }] } }],
    }),
  });
  service.BATCH_WAIT_MS = 10;
  const result = await service.accept('supplier-report', 'rep_batch_1');
  assert.equal(result.accepted, true);
  const task = await waitForTask(store, result.taskId, ['batch_waiting', 'awaiting_confirmation']);
  assert.ok(['batch_waiting', 'awaiting_confirmation'].includes(task.status), `实际状态: ${task.status}`);
});

test('batch aggregation processes all records in same batch and sends one card', async () => {
  const messages = [];
  const { service, gateway } = makeService({
    client: makeClient({ sendMessage: async (params) => { messages.push(params); return { code: 0 }; } }),
    gateway: makeGateway({
      purchaseReport: [
        { record_id: 'rep_b1', fields: { 处理状态: '待解析', 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'], 采购行为: ['beh_1'], 报货批次号: 'BATCH-MULTI', 经办人: [{ id: 'ou_1' }] } },
        { record_id: 'rep_b2', fields: { 处理状态: '待解析', 尺码: sizeLink(37), 数量说明: '37码1双', 编号: ['prod_1'], 采购行为: ['beh_1'], 报货批次号: 'BATCH-MULTI', 经办人: [{ id: 'ou_1' }] } },
      ],
    }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async (text) => text.includes('36') ? [{ size: 36, quantity: 2 }] : [{ size: 37, quantity: 1 }] }),
  });
  service.BATCH_WAIT_MS = 20;
  await service.accept('supplier-report', 'rep_b1');
  await service.accept('supplier-report', 'rep_b2');
  await waitFor('批量确认卡发出', async () => messages.length === 1);
  assert.equal(messages.length, 1, `应只发1张批量确认卡，实际发了${messages.length}张`);
  const cardContent = JSON.parse(messages[0].data.content);
  const allText = JSON.stringify(cardContent.elements);
  assert.ok(allText.includes('BATCH-MULTI'), '确认卡应包含批次号');
  assert.ok(allText.includes('36码'), '确认卡应包含36码明细');
  assert.ok(allText.includes('37码'), '确认卡应包含37码明细');
});

test('batch confirm generates requests and updates all report records', async () => {
  const { service, store, gateway } = makeService({
    gateway: makeGateway({
      purchaseReport: [
        { record_id: 'rep_c1', fields: { 处理状态: '待解析', 尺码: sizeLink(36), 数量说明: '36码2双', 编号: ['prod_1'], 采购行为: ['beh_1'], 报货批次号: 'BATCH-CONF', 经办人: [{ id: 'ou_1' }] } },
        { record_id: 'rep_c2', fields: { 处理状态: '待解析', 尺码: sizeLink(37), 数量说明: '37码1双', 编号: ['prod_1'], 采购行为: ['beh_1'], 报货批次号: 'BATCH-CONF', 经办人: [{ id: 'ou_1' }] } },
      ],
      purchaseOrderBatch: [],
      purchaseRequest: [],
    }),
    recognizer: makeRecognizer({ parsePurchaseReportText: async (text) => text.includes('36') ? [{ size: 36, quantity: 2 }] : [{ size: 37, quantity: 1 }] }),
  });
  service.BATCH_WAIT_MS = 20;
  const first = await service.accept('supplier-report', 'rep_c1');
  await service.accept('supplier-report', 'rep_c2');
  const task = await waitForTask(store, first.taskId);
  assert.equal(task.status, 'awaiting_confirmation');
  assert.ok(task.draft.is_batch === true);
  assert.equal(task.draft.items.length, 2);
  const result = await service.handleCardAction({ draft_id: first.taskId, action: 'confirm_purchase_request' }, 'ou_1');
  assert.ok(result.toast.content.includes('采购申请已生成'));
  const requests = await gateway.listAll('purchaseRequest');
  assert.equal(requests.length, 2);
  const r1 = await gateway.get('purchaseReport', 'rep_c1');
  const r2 = await gateway.get('purchaseReport', 'rep_c2');
  assert.equal(r1.fields.处理状态, '已生成申请');
  assert.equal(r2.fields.处理状态, '已生成申请');
});

test('supplier report without batch number falls back to single processing', async () => {
  const { service, store } = makeService({
    gateway: makeGateway({
      purchaseReport: [{ record_id: 'rep_nobatch', fields: { 处理状态: '待解析', 尺码: sizeLink(36), 编号: ['prod_1'], 经办人: [{ id: 'ou_1' }] } }],
    }),
  });
  const result = await service.accept('supplier-report', 'rep_nobatch');
  const task = await waitForTask(store, result.taskId);
  assert.equal(task.status, 'awaiting_confirmation');
  assert.ok(!task.draft.is_batch);
});

test('product without supplier association throws clear error', async () => {
  const { service, store } = makeService({
    gateway: makeGateway({
      purchaseReport: [{ record_id: 'rep_nosup', fields: { 处理状态: '待解析', 尺码: sizeLink(36), 编号: ['prod_nosup'], 经办人: [{ id: 'ou_1' }] } }],
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

const multiSizeReport = (recordId) => ({
  record_id: recordId,
  fields: {
    处理状态: '待确认', 尺码: sizeLinks(36, 37), 数量说明: '36码2双，37码1双',
    编号: ['prod_1'], 采购行为: ['beh_1'], 经办人: [{ id: 'ou_1' }],
  },
});

test('A1 同时确认同一个采购申请：只生成一个批次和一套采购申请', async () => {
  const records = { purchaseReport: [multiSizeReport('rep_race')], purchaseOrderBatch: [], purchaseRequest: [] };
  const { service, store, gateway } = makeService({
    gateway: slowCreates(makeGateway(records)),
    recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 2 }, { size: 37, quantity: 1 }] }),
  });
  const accepted = await service.accept('supplier-report', 'rep_race');
  await waitForTask(store, accepted.taskId);

  await Promise.all([
    service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_request' }, 'ou_1'),
    service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_request' }, 'ou_1'),
  ]);

  assert.equal(records.purchaseOrderBatch.length, 1, '并发确认不得创建第二个报货批次');
  assert.equal(records.purchaseRequest.length, 2, '并发确认不得把采购申请翻倍');
  const task = await store.get(accepted.taskId);
  assert.equal(task.status, 'posted');
  assert.equal(task.request_ids.length, 2);
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

test('A3 已 posted 的任务再次确认：不再产生任何写入', async () => {
  const records = { purchaseReport: [multiSizeReport('rep_done')], purchaseOrderBatch: [], purchaseRequest: [] };
  const { service, store } = makeService({
    gateway: makeGateway(records),
    recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 2 }, { size: 37, quantity: 1 }] }),
  });
  const accepted = await service.accept('supplier-report', 'rep_done');
  await waitForTask(store, accepted.taskId);
  await service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_request' }, 'ou_1');

  const snapshot = () => [records.purchaseOrderBatch.length, records.purchaseRequest.length].join('/');
  const before = snapshot();
  await service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_request' }, 'ou_1');
  await service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_request' }, 'ou_1');
  assert.equal(snapshot(), before, '重复确认不得新增批次或采购申请');
});

test('B1 批次已写入远端但本地阶段未落盘：重试只复用，不新建第二个批次', async () => {
  const records = { purchaseReport: [multiSizeReport('rep_crash_batch')], purchaseOrderBatch: [], purchaseRequest: [] };
  const dir = tempDir();
  const realStore = new JsonTaskStore({ dir });
  const { service, store } = makeService({
    dir,
    store: failingOnceStore(realStore, (patch) => patch.posting_stage === 'batch_created'),
    gateway: makeGateway(records),
    recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 2 }, { size: 37, quantity: 1 }] }),
  });
  const accepted = await service.accept('supplier-report', 'rep_crash_batch');
  await waitForTask(store, accepted.taskId);

  await assert.rejects(
    service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_request' }, 'ou_1'),
    /模拟本地落盘失败/,
  );
  assert.equal(records.purchaseOrderBatch.length, 1, '第一次已经写出批次');
  assert.equal((await store.get(accepted.taskId)).status, 'posting', '崩溃后停在可恢复的 posting，而不是 posted');

  await service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_request' }, 'ou_1');
  assert.equal(records.purchaseOrderBatch.length, 1, '重试必须复用已有批次');
  assert.equal(records.purchaseRequest.length, 2);
});

test('B2 第一条采购申请写完后崩溃：重试补齐其余，且不会重复第一条', async () => {
  const records = { purchaseReport: [multiSizeReport('rep_crash_req')], purchaseOrderBatch: [], purchaseRequest: [] };
  const dir = tempDir();
  const realStore = new JsonTaskStore({ dir });
  const { service, store } = makeService({
    dir,
    store: failingOnceStore(realStore, (patch) => String(patch.posting_stage || '').startsWith('request_created:')),
    gateway: makeGateway(records),
    recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 2 }, { size: 37, quantity: 1 }] }),
  });
  const accepted = await service.accept('supplier-report', 'rep_crash_req');
  await waitForTask(store, accepted.taskId);

  await assert.rejects(
    service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_request' }, 'ou_1'),
    /模拟本地落盘失败/,
  );
  assert.equal(records.purchaseRequest.length, 1, '第一次只写出了第一条采购申请');

  await service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_request' }, 'ou_1');
  assert.equal(records.purchaseRequest.length, 2, '最终每条明细正好一条采购申请');
  const keys = records.purchaseRequest.map((row) => row.fields.幂等键).sort();
  assert.deepEqual(keys, [
    `purchase_request:${accepted.taskId}:0`,
    `purchase_request:${accepted.taskId}:1`,
  ]);
  assert.equal((await store.get(accepted.taskId)).status, 'posted');
});

test('B3 远端写入成功但响应丢失：按幂等键找回，不创建第二条', async () => {
  const records = {
    purchaseReport: [{
      record_id: 'rep_lost',
      fields: {
        处理状态: '待确认', 尺码: sizeLink(36), 数量说明: '36码2双',
        编号: ['prod_1'], 采购行为: ['beh_1'], 经办人: [{ id: 'ou_1' }],
      },
    }],
    purchaseOrderBatch: [],
    purchaseRequest: [],
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
    recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 2 }] }),
  });
  const accepted = await service.accept('supplier-report', 'rep_lost');
  await waitForTask(store, accepted.taskId);

  const [first, second] = await Promise.all([
    service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_request' }, 'ou_1'),
    service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_request' }, 'ou_1'),
  ]);
  assert.ok(first.toast.content.includes('采购申请已生成'));
  assert.ok(second.toast.content.includes('采购申请已生成'));
  assert.equal(records.purchaseRequest.length, 1, '响应丢失不得产生第二条采购申请');
  assert.equal(records.purchaseOrderBatch.length, 1);
  assert.equal((await store.get(accepted.taskId)).status, 'posted');
});

test('B4 远端出现两条相同幂等键：停止自动处理并转人工核对', async () => {
  const records = { purchaseReport: [multiSizeReport('rep_dup_key')], purchaseOrderBatch: [], purchaseRequest: [] };
  const { service, store } = makeService({
    gateway: makeGateway(records),
    recognizer: makeRecognizer({ parsePurchaseReportText: async () => [{ size: 36, quantity: 2 }, { size: 37, quantity: 1 }] }),
  });
  const accepted = await service.accept('supplier-report', 'rep_dup_key');
  await waitForTask(store, accepted.taskId);

  // 人工（或历史重试）已经写出两条同键记录：不能再挑一条继续。
  const duplicateKey = `purchase_request:${accepted.taskId}:0`;
  records.purchaseRequest.push(
    { record_id: 'dup_1', fields: { 幂等键: duplicateKey, 编号: ['prod_1'] } },
    { record_id: 'dup_2', fields: { 幂等键: duplicateKey, 编号: ['prod_1'] } },
  );

  await assert.rejects(
    service.handleCardAction({ draft_id: accepted.taskId, action: 'confirm_purchase_request' }, 'ou_1'),
    /命中 2 条记录.*人工核对/,
  );
  assert.equal(records.purchaseRequest.length, 2, '停止后不得再写出新的采购申请');
  assert.equal((await store.get(accepted.taskId)).status, 'posting');
});
