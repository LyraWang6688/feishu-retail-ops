const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const { InventoryService } = require('../src/services/inventoryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { RETURN_TITLE } = require('../src/services/purchaseRequestImageService');

// ⚠️ 这一组用例钉的是**业务负责人 2026-10-07 的口径**（逐字见
//    `docs/todo-purchase-return-unified-parsing.md` 与
//    `docs/purchase-return-unified-parsing-2026-10-07.md`）：
//
//   「不分报货还是退货，都是按照同样的逻辑：如果数量说明不写，数量就默认为一双。
//     你需要把退货原有的那个解析路线删掉，然后再把采购的那个加上退货就可以了」
//   「它除了是删数量映射，它也删除了"不需要再去实时库存表里找数量有哪些尺码"的逻辑」
//   库存不够时：「按照这个」= 退能退的 + 把差额回报给她。
//
// 库存那一段用**真的 InventoryService**（不是桩）：能不能扣、扣几双、扣哪些状态，
// 只有在真实现上才测得出来。

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';
process.env.PURCHASE_CHAT_ID = process.env.PURCHASE_CHAT_ID || 'oc_test_purchase_group';

const SERVER_ROOT = path.join(__dirname, '..');
const table = (key) => V1_BITABLE_SCHEMA.tables[key];
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-return-unified-'));

const SIZE_RECORDS = [36, 37, 38, 39, 40, 41]
  .map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));

// 只为让用例自己说得清"数量说明里写了什么"：**确定性**地解析「N码M双」。
// 模型那一步在单测里永远是桩，但**桩也得按说明文字给答案**，
// 否则测不出"数量来自数量说明"这件事（返回写死的一组数等于没测）。
const parseQtyText = (text) => {
  const out = [];
  const pattern = /(\d+)\s*码\s*(\d+)\s*双/g;
  let match;
  while ((match = pattern.exec(String(text || ''))) !== null) {
    out.push({ size: Number(match[1]), quantity: Number(match[2]) });
  }
  return out;
};

const makeGateway = (records = {}) => {
  let seq = 0;
  const uploads = [];
  const data = records;
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
      const record = (data[tableKey] || []).find((row) => row.record_id === recordId);
      if (record) record.fields = { ...record.fields, ...patch };
      return record || { record_id: recordId };
    },
    delete: async (tableKey, recordId) => {
      data[tableKey] = (data[tableKey] || []).filter((row) => row.record_id !== recordId);
      return true;
    },
    uploadAttachment: async (filePath) => {
      uploads.push(filePath);
      return `file_token_${uploads.length}`;
    },
  };
};

const makeClient = (messages) => ({
  im: {
    image: { create: async () => ({ image_key: `img_${messages.length + 1}` }) },
    message: {
      create: async (params) => {
        messages.push(params);
        const messageId = `om_${messages.length}`;
        params.__messageId = messageId;
        return { code: 0, msg: 'success', data: { message_id: messageId } };
      },
      reply: async (params) => {
        messages.push(params);
        const messageId = `om_${messages.length}`;
        params.__messageId = messageId;
        return {
          code: 0, msg: 'success',
          data: { message_id: messageId, thread_id: 'omt_purchase_thread' },
        };
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

const BEHAVIORS = [
  { record_id: 'beh_request', fields: { 行为名称: '采购申请', 行为编码: 'STOCK_PURCHASE_INCREASE', 库存方向: '增加', 是否启用: true } },
  { record_id: 'beh_return', fields: { 行为名称: '采购退货', 行为编码: 'STOCK_PURCHASE_DECREASE', 库存方向: '减少', 是否启用: true } },
];

const productFields = (itemNo, color, supplierId = 'sup_A') => ({
  货号: itemNo, 颜色: [{ text: color }], 编号: `${itemNo}${color}`, 供应商: [supplierId],
});
const SUPPLIERS = [{ record_id: 'sup_A', fields: { 供应商名称: '金猴' } }];

const liveRow = (recordId, state, size, productRecordId = 'prod_1') => ({
  record_id: recordId,
  fields: { 编号: [productRecordId], 尺码: [`size_${size}`], 所属状态: state },
});

// 一条**新口径**的「采购退货」记录：尺码（多选）+ 数量说明（**没有「数量」这一列了**）。
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
    // 模型那一步在这里是**确定性桩**：按「数量说明」原文解析（见 parseQtyText）。
    recognizer: { parsePurchaseReportText: async (text) => parseQtyText(text) },
    enableReportAlertBootstrap: false,
    disableBatchAlertTimers: true,
    batchReadMaxRetries: 1,
    batchReadRetryDelay: 0,
    purchaseReturnBatchWindowMs: 10_000,
  });
  return { service, store, gateway, messages, images, inventoryStore };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForTaskSettled = async (store, taskId, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = await store.get(taskId);
    if (task && !['queued', 'processing', 'batch_waiting'].includes(task.status)) return task;
    if (Date.now() > deadline) return task;
    await sleep(10);
  }
};

// 走**生产同一条入口**（process → 按行为分流 → 解析/写单据/扣库存）。
const runRecord = async (options) => {
  const ctx = makeService(options);
  const recordId = options.recordId || 'rep_1';
  const taskId = `task_${recordId}`;
  await ctx.store.create({ task_id: taskId, kind: 'supplier-report', record_id: recordId, status: 'queued' });
  let result = null;
  let error = null;
  try {
    result = await ctx.service.process('supplier-report', recordId, taskId);
    if (result?.status === 'batch_waiting') {
      const settled = await waitForTaskSettled(ctx.store, taskId);
      result = settled?.result ?? result;
    }
  } catch (thrown) {
    error = thrown;
  }
  return { ...ctx, taskId, result, error, task: await ctx.store.get(taskId) };
};

const textMessages = (messages) => messages
  .filter((message) => message.data?.msg_type === 'text')
  .map((message) => JSON.parse(message.data.content).text);

const rowsOf = (gateway, tableKey) => gateway.records[tableKey] || [];
const requestsOf = (gateway) => rowsOf(gateway, 'purchaseRequest');
const ledgerOf = (gateway) => rowsOf(gateway, 'inventoryLedger');
const liveOf = (gateway) => rowsOf(gateway, 'liveInventory');

const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/([^:])\/\/.*$/gm, '$1');

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'data') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};

// ═══════════════════════════════════════════════════════════════════════════
// ① 一行多尺码 → 展开成多条退货明细（图上也是一尺码一行）
// ═══════════════════════════════════════════════════════════════════════════

test('① 退货一行勾了 3 个尺码（多选）→ 展开成 3 条退货明细，一尺码一行单据', async () => {
  const gateway = makeGateway({
    purchaseReport: [returnRecord('rep_multi', { 尺码: ['size_38', 'size_40', 'size_41'] })],
    liveInventory: [
      liveRow('live_38', '门盒', 38), liveRow('live_40', '样品', 40), liveRow('live_41', '仓库', 41),
    ],
    behavior: BEHAVIORS,
    supplier: SUPPLIERS,
    purchaseRequest: [],
    purchaseOrderBatch: [],
  });
  const { task, gateway: gw, images } = await runRecord({
    gateway, recordId: 'rep_multi', products: { prod_1: productFields('8088', '黑色') },
  });

  assert.equal(task.status, 'posted');
  assert.equal(task.result.is_return, true);
  // 3 个尺码 → 3 行「具体信息」（一尺码一行），各 1 双
  const requests = requestsOf(gw);
  assert.equal(requests.length, 3, '多选尺码要展开成多条退货明细');
  assert.deepEqual(
    requests.map((row) => [row.fields.尺码[0], row.fields.数量]).sort(),
    [['size_38', 1], ['size_40', 1], ['size_41', 1]],
  );
  assert.deepEqual(requests.map((row) => row.fields.幂等键).sort(), [
    'purchase_return:rep_multi:38', 'purchase_return:rep_multi:40', 'purchase_return:rep_multi:41',
  ]);
  // 库存：三个状态各退 1 双（仓库也在内），一行不剩
  assert.deepEqual(liveOf(gw), []);
  assert.deepEqual(
    ledgerOf(gw).map((row) => [row.fields.尺码[0], row.fields.变动数量]).sort(),
    [['size_38', 1], ['size_40', 1], ['size_41', 1]],
  );
  // 图上也是一尺码一行
  assert.equal(images.calls.length, 1);
  assert.equal(images.calls[0].title, RETURN_TITLE);
  assert.deepEqual(
    images.calls[0].items.map((item) => [item.size, item.quantity]),
    [[38, 1], [40, 1], [41, 1]],
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 数量从「数量说明」解析；**没写 ⇒ 每个勾选尺码默认一双**
// ═══════════════════════════════════════════════════════════════════════════

test('② 数量说明不写 ⇒ 每个勾选尺码默认一双；写了 ⇒ 按说明里的数', async () => {
  // (a) 不写：两个尺码各 1 双
  const blank = makeGateway({
    purchaseReport: [returnRecord('rep_blank', { 尺码: ['size_38', 'size_40'] })],
    liveInventory: [liveRow('live_38', '门盒', 38), liveRow('live_40', '门盒', 40)],
    behavior: BEHAVIORS, supplier: SUPPLIERS, purchaseRequest: [], purchaseOrderBatch: [],
  });
  const blankRun = await runRecord({
    gateway: blank, recordId: 'rep_blank', products: { prod_1: productFields('8088', '黑色') },
  });
  assert.equal(blankRun.task.status, 'posted');
  assert.deepEqual(
    requestsOf(blank).map((row) => [row.fields.尺码[0], row.fields.数量]).sort(),
    [['size_38', 1], ['size_40', 1]],
    '数量说明不写 ⇒ 每个勾选尺码默认一双',
  );

  // (b) 写「38码2双」：38 码 2 双、没提到的 40 码照旧 1 双
  const withText = makeGateway({
    purchaseReport: [returnRecord('rep_text', { 尺码: ['size_38', 'size_40'], 数量说明: '38码2双' })],
    liveInventory: [
      liveRow('live_t_38a', '门盒', 38), liveRow('live_t_38b', '样品', 38), liveRow('live_t_40', '门盒', 40),
    ],
    behavior: BEHAVIORS, supplier: SUPPLIERS, purchaseRequest: [], purchaseOrderBatch: [],
  });
  const textRun = await runRecord({
    gateway: withText, recordId: 'rep_text', products: { prod_1: productFields('8088', '黑色') },
  });
  assert.equal(textRun.task.status, 'posted');
  assert.deepEqual(
    requestsOf(withText).map((row) => [row.fields.尺码[0], row.fields.数量]).sort(),
    [['size_38', 2], ['size_40', 1]],
    '数量来自「数量说明」；说明里没提到的尺码仍默认一双',
  );
  assert.deepEqual(liveOf(withText), [], '两个尺码的库存都被退掉');
});

test('② 退货**不再读「数量」这一列**：表上残留一个「数量」值也影响不了解析', async () => {
  // 生产表里「数量」这一列**已经被她删掉**。这里故意在原始字段里塞一个「数量」，
  // 证明解析**不看它**：结论只由「尺码（多选）+ 数量说明」决定。
  const gateway = makeGateway({
    purchaseReport: [returnRecord('rep_ignores_qty', { 尺码: ['size_36'], 数量: 99 })],
    liveInventory: [liveRow('live_36', '门盒', 36)],
    behavior: BEHAVIORS, supplier: SUPPLIERS, purchaseRequest: [], purchaseOrderBatch: [],
  });
  const { task, gateway: gw } = await runRecord({
    gateway, recordId: 'rep_ignores_qty', products: { prod_1: productFields('8088', '黑色') },
  });

  assert.equal(task.status, 'posted');
  assert.equal(task.result.declared, 1, '声明数来自「尺码 + 数量说明」（1 双），不是那列「数量」（99）');
  assert.deepEqual(
    requestsOf(gw).map((row) => [row.fields.尺码[0], row.fields.数量]),
    [['size_36', 1]],
    '数量说明没写 ⇒ 一双；绝不去读那列「数量」（99 不生效）',
  );
  assert.equal(ledgerOf(gw)[0].fields.变动数量, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ 库存不够 → 退能退的 + 把差额回报给她（既有业务行为保留）
// ═══════════════════════════════════════════════════════════════════════════

test('④ 她说退 3 双、库存只有 2 双 ⇒ 退 2 双 + 把「差 1 双」回报给她', async () => {
  const gateway = makeGateway({
    purchaseReport: [returnRecord('rep_short', { 尺码: ['size_38'], 数量说明: '38码3双' })],
    liveInventory: [liveRow('live_s38a', '门盒', 38), liveRow('live_s38b', '仓库', 38)],
    behavior: BEHAVIORS, supplier: SUPPLIERS, purchaseRequest: [], purchaseOrderBatch: [],
  });
  const { task, gateway: gw, messages } = await runRecord({
    gateway, recordId: 'rep_short', products: { prod_1: productFields('8088', '黑色') },
  });

  assert.equal(task.result.declared, 3);
  assert.equal(task.result.available, 2);
  assert.equal(task.result.taken, 2);
  assert.equal(task.result.shortfall, 1);
  // 退能退的：2 双真扣掉了
  assert.deepEqual(liveOf(gw), []);
  assert.equal(ledgerOf(gw).length, 1);
  assert.equal(ledgerOf(gw)[0].fields.变动数量, 2);
  assert.deepEqual(requestsOf(gw).map((row) => row.fields.数量), [2]);
  // 差额明确回报给她
  const notice = textMessages(messages).find((text) => text.includes('对不上'));
  assert.ok(notice, '必须把差额说出来');
  assert.match(notice, /8088黑色（38 码）/);
  assert.match(notice, /你说要退 3 双，实时库存里只有 2 双/);
  assert.match(notice, /先按能对上的 2 双处理了，差的 1 双对不上/);
});

test('④ 多尺码各自核对：有货的那一码照退，没货的那一码只回报差额', async () => {
  const gateway = makeGateway({
    purchaseReport: [returnRecord('rep_part', { 尺码: ['size_38', 'size_40'], 数量说明: '38码1双、40码1双' })],
    // 40 码一双都没有
    liveInventory: [liveRow('live_p38', '门盒', 38)],
    behavior: BEHAVIORS, supplier: SUPPLIERS, purchaseRequest: [], purchaseOrderBatch: [],
  });
  const { task, gateway: gw, messages } = await runRecord({
    gateway, recordId: 'rep_part', products: { prod_1: productFields('8088', '黑色') },
  });

  assert.equal(task.result.taken, 1, '能退的那一码照退');
  assert.equal(task.result.shortfall, 1);
  assert.deepEqual(liveOf(gw), [], '38 码那一双退了');
  // 只写退得掉的那一码（40 码没有单据可写）
  assert.deepEqual(requestsOf(gw).map((row) => row.fields.尺码[0]), ['size_38']);
  const notice = textMessages(messages).find((text) => text.includes('对不上'));
  assert.match(notice, /8088黑色（40 码）/);
  assert.match(notice, /你说要退 1 双，实时库存里只有 0 双/);
});

test('④ 库存一双都没有：不写单据、不出图、不标终态，明确告诉她没处理', async () => {
  const messages = [];
  const images = makeImages();
  const gateway = makeGateway({
    purchaseReport: [returnRecord('rep_none', { 尺码: ['size_38', 'size_40'], 数量说明: '38码1双' })],
    liveInventory: [],
    behavior: BEHAVIORS, supplier: SUPPLIERS, purchaseRequest: [], purchaseOrderBatch: [],
  });
  const { task, gateway: gw } = await runRecord({
    gateway, recordId: 'rep_none', messages, images,
    products: { prod_1: productFields('8088', '黑色') },
  });

  assert.equal(task.result.taken, 0);
  assert.equal(requestsOf(gw).length, 0);
  assert.equal(ledgerOf(gw).length, 0);
  assert.equal(images.calls.length, 0);
  assert.match(textMessages(messages).join('\n'), /一双都没有/);
  assert.equal((await gw.get('purchaseReport', 'rep_none')).fields.处理状态, '待解析',
    '什么都没处理就不该标成终态——她要能看出这条还欠着');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 报货侧行为不变（哨兵）+ 两条链路"怎么解析"是同一段
// ═══════════════════════════════════════════════════════════════════════════

test('⑤ 同一行输入（尺码多选 + 数量说明）在两条链路上解析出**同一组**（尺码, 数量）', async () => {
  const fields = { 尺码: ['size_38', 'size_40'], 数量说明: '38码2双' };
  const { service } = makeService({ gateway: makeGateway() });
  const reportFields = {
    编号: ['prod_1'], ...fields,
  };
  const parsed = await service.parseReportQuantities(reportFields, table('purchaseReport'));
  assert.deepEqual(
    parsed.map((item) => [item.size, item.quantity, item.size_record_id]).sort(),
    [[38, 2, 'size_38'], [40, 1, 'size_40']],
    '统一解析：多选尺码逐个展开 + 数量说明（没写=1双）',
  );
});

test('⑤ 采购申请那条链路行为不变（出采购申请、不碰库存、不是退货单）', async () => {
  const gateway = makeGateway({
    purchaseReport: [{
      record_id: 'rep_apply',
      fields: {
        处理状态: '待解析', 采购行为: ['beh_request'], 经办人: [{ id: 'ou_user_1' }],
        编号: ['prod_1'], 尺码: ['size_36'], 数量说明: '36码2双', 报货批次号: '',
      },
    }],
    liveInventory: [liveRow('live_36', '门盒', 36)],
    behavior: BEHAVIORS, supplier: SUPPLIERS, purchaseRequest: [], purchaseOrderBatch: [],
  });
  const { task, gateway: gw, images } = await runRecord({
    gateway, recordId: 'rep_apply', products: { prod_1: productFields('8088', '黑色') },
  });

  assert.equal(task.status, 'posted');
  assert.equal(task.result.is_return, undefined, '不是退货分支');
  assert.deepEqual(requestsOf(gw).map((row) => row.fields.数量), [2], '采购申请按数量说明写 2 双');
  assert.equal(requestsOf(gw)[0].fields.采购行为[0], 'beh_request');
  assert.equal(liveOf(gw).length, 1, '采购申请不动库存');
  assert.equal(images.calls[0].title, undefined, '采购申请图不传 title（渲染器默认标题）');
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ ⑥ 守门：全仓不再引用「信息填写.数量」/ 不再有"从实时库存反推尺码"
// ═══════════════════════════════════════════════════════════════════════════

test('③ 守门：schema 里没有「信息填写.数量」；全仓没有对它的读取点', () => {
  const report = V1_BITABLE_SCHEMA.tables.purchaseReport.fields;
  assert.equal(Object.prototype.hasOwnProperty.call(report, 'quantity'), false,
    '「信息填写.数量」已被她从生产表删除 ⇒ 映射必须删（否则部署闸门必红）');
  assert.equal(report.quantity, undefined);
  // 「具体信息」（采购申请/退货明细）那一列**还在**，不受影响
  assert.equal(V1_BITABLE_SCHEMA.tables.purchaseRequest.fields.quantity, '数量');

  // ⭐ 守门：`.fields.quantity` 的读取点**逐个点名**（数量写死，多一处/少一处都红）。
  //    这两处读的都是「**具体信息**」那张表的「数量」，与「信息填写」无关：
  const allowed = {
    'services/purchaseQueryService.js': 1, // 工作台采购查询：具体信息的双数
    'services/purchaseArrivalConversationService.js': 1, // 到货核对明细：具体信息的双数
  };
  const files = walk(path.join(SERVER_ROOT, 'src')).filter((file) => file.endsWith('.js'));
  const counts = new Map();
  for (const file of files) {
    const hits = (stripComments(fs.readFileSync(file, 'utf8')).match(/\.fields\.quantity\b/g) || []).length;
    if (hits) counts.set(path.relative(path.join(SERVER_ROOT, 'src'), file).split(path.sep).join('/'), hits);
  }
  assert.deepEqual(Object.fromEntries(counts), allowed,
    '「信息填写.数量」没了：src 里只允许读「具体信息.数量」那两处（新增读取点必须在这里写明理由）');
  // 允许的两处必须确实读的是「具体信息」，不是「信息填写」
  for (const [file, hint] of [
    ['services/purchaseQueryService.js', /tables\.purchaseRequest\.fields\.quantity/],
    ['services/purchaseArrivalConversationService.js', /table\('purchaseRequest'\)/],
  ]) {
    assert.match(fs.readFileSync(path.join(SERVER_ROOT, 'src', file), 'utf8'), hint,
      `${file} 读的必须是「具体信息.数量」`);
  }
});

test('⑥ 守门：不再有"从实时库存反推尺码"的计划器；退货计划器的尺码只来自表单', () => {
  const files = walk(path.join(SERVER_ROOT, 'src')).filter((file) => file.endsWith('.js'));
  const offenders = files
    .filter((file) => /planPurchaseReturn|parseReportReturnQuantities|parseReturnQuantity/
      .test(stripComments(fs.readFileSync(file, 'utf8'))))
    .map((file) => path.relative(SERVER_ROOT, file).split(path.sep).join('/'));
  assert.deepEqual(offenders, [],
    '退货原有的解析路线与"捞实时库存行反推 bySize"的计划器都必须删干净');

  const { service } = makeService({ gateway: makeGateway() });
  for (const gone of ['planPurchaseReturn', 'parseReportReturnQuantities', 'parseReportItems', 'parseReturnQuantity']) {
    assert.equal(typeof service[gone], 'undefined', `方法 ${gone} 必须已删除`);
  }
  assert.equal(typeof service.planReturnFromItems, 'function',
    '新的退货计划器：尺码/数量来自表单，实时库存只回答"能退几双"');
});
