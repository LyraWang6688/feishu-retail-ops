const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const { InventoryService } = require('../src/services/inventoryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { RETURN_TITLE, TITLE } = require('../src/services/purchaseRequestImageService');

// ⚠️ 这一组用例钉的是「采购退货」那条链路的**业务口径**（业务负责人 2026-10-05 给的）：
//   供应商对接表单（编号 + 数量；退货不填尺码）→ 免确认 → 直接扣实时库存
//   （样品 + 门盒 + 仓库，状态一律不看）→ 出「邯美皮鞋采购退货单」→ 只写 4 张表。
// 库存那一段用的是**真的 InventoryService**（不是桩）：重复扣减、仓库能不能扣、
// 流水写不写来源，都只有在真实现上才测得出来。

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';
// ⚠️ 合并 #85 之后采购单**只发群**：没配 PURCHASE_CHAT_ID 时服务会「大声跳过」
//（这是有意的：绝不回落到经办人私聊）。这组用例要验的正是"出退货单 → 发出去 → 写回附件"
// 这条收尾链路，所以这里显式给一个测试群（和 purchaseWebhookService.test.js 同款做法）。
process.env.PURCHASE_CHAT_ID = process.env.PURCHASE_CHAT_ID || 'oc_test_purchase_group';

const table = (key) => V1_BITABLE_SCHEMA.tables[key];
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-return-'));

const SIZE_RECORDS = [36, 37, 38, 39].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));

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
    // 直接按中文列名改（模拟她在表里手工改了状态），不经过语义名映射。
    updateRaw: async (tableKey, recordId, patch) => {
      const record = (data[tableKey] || []).find((row) => row.record_id === recordId);
      if (record) record.fields = { ...record.fields, ...patch };
      return record;
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
        return { code: 0, msg: 'success' };
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

// 「行为管理」里两条行为：采购申请（采购入库）和采购退货（采购减少）。
// 退货那条的编码就是业务负责人核实过的 STOCK_PURCHASE_DECREASE。
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

// 一条「采购退货」格式的供应商对接记录：编号 + 数量，**没有尺码**。
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
    // 真的库存服务：这里要验的就是"扣库存"这件事本身。
    inventory: new InventoryService({ gateway, store: inventoryStore }),
    references: {
      resolveProduct: async ({ productRecordId }) => {
        const fields = (options.products || {})[productRecordId];
        if (!fields) throw new Error(`找不到货品记录：${productRecordId}`);
        return { recordId: productRecordId, record: { record_id: productRecordId, fields } };
      },
    },
    recognizer: {
      parsePurchaseReportText: async () => options.parsedQuantities || [{ size: 36, quantity: 1 }],
    },
    enableReportAlertBootstrap: false,
    disableBatchAlertTimers: true,
    batchReadMaxRetries: 1,
    batchReadRetryDelay: 0,
  });
  return { service, store, gateway, messages, images, inventoryStore };
};

const runReturn = async (options) => {
  const ctx = makeService(options);
  const recordId = options.recordId || 'rep_1';
  const taskId = `task_${recordId}`;
  await ctx.store.create({ task_id: taskId, kind: 'supplier-report', record_id: recordId, status: 'queued' });
  let result = null;
  let error = null;
  try {
    result = await ctx.service.process('supplier-report', recordId, taskId);
  } catch (thrown) {
    // process() 会把失败落成可重试的 failed 之后再把异常抛出去；这里照样拿任务状态断言。
    error = thrown;
  }
  return { ...ctx, taskId, result, error, task: await ctx.store.get(taskId) };
};

const textMessages = (messages) => messages
  .filter((message) => message.data?.msg_type === 'text')
  .map((message) => JSON.parse(message.data.content).text);

// 直接看假表的记录：表还没被写过时就是空数组。
const rowsOf = (gateway, tableKey) => gateway.records[tableKey] || [];
const requestsOf = (gateway) => rowsOf(gateway, 'purchaseRequest');
const ledgerOf = (gateway) => rowsOf(gateway, 'inventoryLedger');
const liveOf = (gateway) => rowsOf(gateway, 'liveInventory');

// ─── A 情况：只填数量（= 该 货号+颜色 全退），不看状态 ──────────────────────

test('A 情况对得上：样品+门盒+仓库全部退掉，一行一个尺码写单据信息、一条一条写流水、出退货单', async () => {
  const gateway = makeGateway({
    purchaseReport: [returnRecord('rep_1', { 数量: 3, 报货批次号: 'B-1' })],
    liveInventory: [liveRow('live_36', '门盒', 36), liveRow('live_37', '样品', 37), liveRow('live_38', '仓库', 38)],
    behavior: BEHAVIORS,
    supplier: SUPPLIERS,
    purchaseRequest: [],
  });
  const { task, gateway: gw, messages, images } = await runReturn({
    gateway, recordId: 'rep_1', products: { prod_1: productFields('8088', '黑色') },
  });

  // ④ 直接扣库存：三个状态都被退掉（仓库也在内），一条不剩
  assert.deepEqual(liveOf(gw), []);
  assert.equal(task.result.taken, 3);
  assert.equal(task.result.shortfall, 0);
  assert.equal(task.result.surplus, 0);

  // 「库存流水」：一行一个尺码，行为=采购退货那条、变动数量为正、**没有来源关联**
  //（库存流水没有能关联「单据信息」的字段；不加一个指向错表的 id）。
  const ledger = ledgerOf(gw);
  assert.equal(ledger.length, 3);
  for (const row of ledger) {
    assert.equal(row.fields.变动数量, 1);
    assert.deepEqual(row.fields.库存行为, ['beh_return']);
    assert.deepEqual(row.fields.编号, ['prod_1']);
    assert.equal(Object.hasOwn(row.fields, '关联采购'), false, '退货流水不该写「关联采购」');
    assert.equal(Object.hasOwn(row.fields, '关联销售'), false, '退货流水不该写「关联销售」');
  }

  // 「单据信息」：一行一个尺码，数量=实际退的双数，幂等键可追溯回供应商对接记录
  const requests = requestsOf(gw);
  assert.deepEqual(requests.map((row) => [row.fields.尺码[0], row.fields.数量]).sort(),
    [['size_36', 1], ['size_37', 1], ['size_38', 1]]);
  assert.deepEqual(requests.map((row) => row.fields.幂等键).sort(), [
    'purchase_return:rep_1:36', 'purchase_return:rep_1:37', 'purchase_return:rep_1:38',
  ]);
  assert.ok(requests.every((row) => JSON.stringify(row.fields.采购行为) === JSON.stringify(['beh_return'])));
  // ③ 不走进货/入库：3 张业务表之外没有别的写入
  assert.equal(gw.records.purchaseInbound, undefined, '退货不写采购入库');
  assert.equal(gw.records.purchaseArrival, undefined, '退货不写采购到货');
  assert.equal(gw.records.purchaseOrderBatch, undefined, '退货不建报货批次（第 5 张表）');

  // 供应商对接记录进入终态并双向可追溯
  const report = await gw.get('purchaseReport', 'rep_1');
  assert.equal(report.fields.处理状态, '已生成申请');
  assert.deepEqual(report.fields.关联采购申请, requests.map((row) => row.record_id).sort());

  // ⑤ 出图：标题是「邯美皮鞋采购退货单」，其余排版复用采购申请那一套
  assert.equal(images.calls.length, 1);
  assert.equal(images.calls[0].title, RETURN_TITLE);
  assert.deepEqual(images.calls[0].items.map((item) => [item.item_no, item.color, item.size, item.quantity]),
    [['8088', '黑色', 36, 1], ['8088', '黑色', 37, 1], ['8088', '黑色', 38, 1]]);
  // 先发图、再写回附件（和采购申请同序）
  assert.deepEqual(messages.map((message) => message.data.msg_type), ['image', 'text']);
  assert.match(textMessages(messages)[0], /金猴 这批 3 条（共 3 双）/);
  // 对得上时不发差额提醒（图本身就是回执）
  assert.equal(textMessages(messages).length, 1);
  assert.equal(requests.filter((row) => (row.fields.采购申请单 || []).length === 1).length, 1);
  assert.match(gw.uploads[0], /采购退货单\.png$/);

  assert.equal(task.status, 'posted');
  assert.equal(task.result.is_return, true);
});

test('A 情况数量比库存多：能对上的先退，差额明确告诉她', async () => {
  const gateway = makeGateway({
    purchaseReport: [returnRecord('rep_short', { 数量: 5 })],
    liveInventory: [liveRow('live_36', '门盒', 36), liveRow('live_37', '仓库', 37)],
    behavior: BEHAVIORS,
    supplier: SUPPLIERS,
    purchaseRequest: [],
  });
  const { task, gateway: gw, messages } = await runReturn({
    gateway, recordId: 'rep_short', products: { prod_1: productFields('8088', '黑色') },
  });

  // 尽力处理：库存里有的 2 双都退了（不是"一处不对就整单不动"）
  assert.equal(task.result.declared, 5);
  assert.equal(task.result.available, 2);
  assert.equal(task.result.taken, 2);
  assert.equal(task.result.shortfall, 3);
  assert.deepEqual(liveOf(gw), []);
  assert.equal(ledgerOf(gw).length, 2);
  assert.equal(requestsOf(gw).length, 2);

  const notice = textMessages(messages).find((text) => text.includes('对不上'));
  assert.ok(notice, '必须把差额说出来');
  assert.match(notice, /你说要退 5 双，实时库存里只有 2 双/);
  assert.match(notice, /先按能对上的 2 双处理了，差的 3 双对不上/);
});

test('A 情况数量比库存少：按她填的数量退，并告诉她还有多少没退', async () => {
  const gateway = makeGateway({
    purchaseReport: [returnRecord('rep_surplus', { 数量: 2 })],
    liveInventory: [liveRow('live_36', '门盒', 36), liveRow('live_37', '样品', 37), liveRow('live_38', '仓库', 38)],
    behavior: BEHAVIORS,
    supplier: SUPPLIERS,
    purchaseRequest: [],
  });
  const { task, gateway: gw, messages } = await runReturn({
    gateway, recordId: 'rep_surplus', products: { prod_1: productFields('8088', '黑色') },
  });

  assert.equal(task.result.taken, 2);
  assert.equal(task.result.surplus, 1);
  assert.equal(liveOf(gw).length, 1, '她只填了 2 双，剩下那双不动');
  const notice = textMessages(messages).find((text) => text.includes('还剩'));
  assert.match(notice, /还剩 1 双没退（总数是 3 双）/);
});

// ─── B 情况：填了尺码 + 数量 → 按 货号+颜色+尺码 找 ─────────────────────────

test('B 情况：只退勾选尺码的库存，别的尺码按兵不动', async () => {
  const gateway = makeGateway({
    purchaseReport: [returnRecord('rep_size', { 数量: 1, 尺码: ['size_36'] })],
    liveInventory: [liveRow('live_36', '门盒', 36), liveRow('live_37', '仓库', 37)],
    behavior: BEHAVIORS,
    supplier: SUPPLIERS,
    purchaseRequest: [],
  });
  const { task, gateway: gw, messages } = await runReturn({
    gateway, recordId: 'rep_size', products: { prod_1: productFields('8088', '黑色') },
  });

  assert.equal(task.result.taken, 1);
  assert.equal(task.result.available, 1, 'B 情况的"库存里有多少"只算勾选的那个尺码');
  assert.deepEqual(liveOf(gw).map((row) => row.record_id), ['live_37'], '37 码不动');
  const requests = requestsOf(gw);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].fields.尺码, ['size_36']);
  // 对得上就不发差额提醒：图 + 一句"可以转给供应商"就是回执
  assert.equal(textMessages(messages).length, 1);
});

test('B 情况库存不足：能对上的先退，差额说清是哪个尺码', async () => {
  const gateway = makeGateway({
    purchaseReport: [returnRecord('rep_b_short', { 数量: 3, 尺码: ['size_38'] })],
    liveInventory: [liveRow('live_38a', '门盒', 38), liveRow('live_38b', '样品', 38), liveRow('live_36', '门盒', 36)],
    behavior: BEHAVIORS,
    supplier: SUPPLIERS,
    purchaseRequest: [],
  });
  const { task, gateway: gw, messages } = await runReturn({
    gateway, recordId: 'rep_b_short', products: { prod_1: productFields('8088', '黑色') },
  });

  assert.equal(task.result.available, 2);
  assert.equal(task.result.taken, 2);
  assert.equal(task.result.shortfall, 1);
  assert.deepEqual(liveOf(gw).map((row) => row.record_id), ['live_36']);
  const notice = textMessages(messages).find((text) => text.includes('对不上'));
  assert.match(notice, /8088黑色（38 码）\s*你说要退 3 双/);
});

test('尺码选了多个（字段被改成多选）时停下来告诉她要拆记录，不动任何库存', async () => {
  const gateway = makeGateway({
    purchaseReport: [returnRecord('rep_multi_size', { 数量: 1, 尺码: ['size_36', 'size_37'] })],
    liveInventory: [liveRow('live_36', '门盒', 36)],
    behavior: BEHAVIORS,
    supplier: SUPPLIERS,
    purchaseRequest: [],
  });
  const { task, gateway: gw } = await runReturn({
    gateway, recordId: 'rep_multi_size', products: { prod_1: productFields('8088', '黑色') },
  });
  assert.equal(task.status, 'failed');
  assert.match(task.error, /「尺码」只能选一个/);
  assert.equal(liveOf(gw).length, 1);
  assert.equal(ledgerOf(gw).length, 0);
});

// ─── 重复扣库存的防线 ───────────────────────────────────────────────────────

test('同一份退货重复处理：不重复扣库存、不重复写单据信息与流水', async () => {
  const gateway = makeGateway({
    purchaseReport: [returnRecord('rep_dup', { 数量: 2 })],
    liveInventory: [liveRow('live_36', '门盒', 36), liveRow('live_37', '样品', 37)],
    behavior: BEHAVIORS,
    supplier: SUPPLIERS,
    purchaseRequest: [],
  });
  const ctx = await runReturn({ gateway, recordId: 'rep_dup', products: { prod_1: productFields('8088', '黑色') } });
  assert.deepEqual(liveOf(gateway), []);
  assert.equal(ledgerOf(gateway).length, 2);

  // 第一道：任务已是 posted，重复投递直接跳过（飞书重投/双击走的就是这里）
  const second = await ctx.service.process('supplier-report', 'rep_dup', ctx.taskId);
  assert.equal(second.status, 'posted');
  assert.equal(ledgerOf(gateway).length, 2);

  // 第二道：即使把任务状态和记录的处理状态都手动改回未处理（模拟"状态没写上"），
  // 单据信息的幂等键 + 库存操作的 operationId 也保证不会扣第二遍。
  await gateway.updateRaw('purchaseReport', 'rep_dup', { 处理状态: '待解析' });
  await ctx.store.update(ctx.taskId, { status: 'processing', result: undefined });
  await ctx.service.process('supplier-report', 'rep_dup', ctx.taskId);
  assert.equal(liveOf(gateway).length, 0, '库存不能被扣第二遍');
  assert.equal(ledgerOf(gateway).length, 2, '流水不能多写');
  assert.equal(requestsOf(gateway).length, 2, '单据信息不能多写');
  // 而且报单记录仍被推回终态、仍关联同一批单据信息行
  const report = await gateway.get('purchaseReport', 'rep_dup');
  assert.equal(report.fields.处理状态, '已生成申请');
  assert.equal(report.fields.关联采购申请.length, 2);
});

// ─── 对不上的极端：一双都没有 ───────────────────────────────────────────────

test('库存里一双都没有：不写单据信息、不出图，明确告诉她没处理', async () => {
  const messages = [];
  const images = makeImages();
  const gateway = makeGateway({
    purchaseReport: [returnRecord('rep_none', { 数量: 2 })],
    liveInventory: [],
    behavior: BEHAVIORS,
    supplier: SUPPLIERS,
    purchaseRequest: [],
  });
  const { task, gateway: gw } = await runReturn({
    gateway, messages, images, recordId: 'rep_none', products: { prod_1: productFields('8088', '黑色') },
  });

  assert.equal(task.result.taken, 0);
  assert.equal(requestsOf(gw).length, 0);
  assert.equal(ledgerOf(gw).length, 0);
  assert.equal(images.calls.length, 0);
  assert.match(textMessages(messages).join('\n'), /一双都没有/);
  // 什么都没处理就不该标成「已生成申请」——她要能看出这条还欠着
  assert.equal((await gw.get('purchaseReport', 'rep_none')).fields.处理状态, '待解析');
  assert.equal(task.status, 'posted');
});

// ─── 分流回归：采购申请那条链路一个字都没变 ─────────────────────────────────

test('采购行为=采购申请的记录仍走原来那条链路（不被退货分流带走）', async () => {
  const gateway = makeGateway({
    purchaseReport: [{
      record_id: 'rep_apply',
      fields: {
        处理状态: '待解析', 采购行为: ['beh_request'], 经办人: [{ id: 'ou_user_1' }],
        编号: ['prod_1'], 尺码: ['size_36'], 数量说明: '36码1双', 报货批次号: '',
      },
    }],
    liveInventory: [liveRow('live_36', '门盒', 36)],
    behavior: BEHAVIORS,
    supplier: SUPPLIERS,
    purchaseRequest: [],
    purchaseOrderBatch: [],
  });
  const { task, gateway: gw, images } = await runReturn({
    gateway, recordId: 'rep_apply', products: { prod_1: productFields('8088', '黑色') },
  });

  assert.equal(task.status, 'posted');
  assert.equal(task.result.is_return, undefined, '不是退货分支');
  assert.equal(requestsOf(gw).length, 1);
  assert.deepEqual(requestsOf(gw)[0].fields.采购行为, ['beh_request']);
  assert.equal(images.calls[0].title, undefined, '采购申请图不传 title（渲染器默认标题）');
  assert.equal(liveOf(gw).length, 1, '采购申请不动库存');
});

test('采购行为读不到（行为记录被删/读失败）时退回采购申请，不会误扣库存', async () => {
  const gateway = makeGateway({
    // 记录指向的行为记录已经不在「行为管理」里（被删了 / 读失败）
    purchaseReport: [returnRecord('rep_nobehavior', { 数量: 2, 采购行为: ['beh_gone'] })],
    liveInventory: [liveRow('live_36', '门盒', 36)],
    behavior: BEHAVIORS,
    supplier: SUPPLIERS,
    purchaseRequest: [],
  });
  const { task, gateway: gw } = await runReturn({
    gateway, recordId: 'rep_nobehavior', products: { prod_1: productFields('8088', '黑色') },
  });
  // 退回采购申请 → 这条记录没有尺码，报货解析在"读尺码"这一步就明确失败（可重试，
  // 报单记录不会被打成终态），库存一动不动。宁可这样大声失败，也不要把普通报货当退货扣库存。
  assert.equal(task.status, 'failed');
  assert.match(task.error, /尺码/);
  assert.equal(liveOf(gw).length, 1);
  assert.equal(ledgerOf(gw).length, 0);
});

// ─── 出图：退货单与采购申请单共用同一套排版 ────────────────────────────────

test('退货单与采购申请单排版一致，只有标题不同', () => {
  const { buildPurchaseRequestSvg } = require('../src/services/purchaseRequestImageService');
  const items = [{ item_no: '8088', color: '黑色', size: 36, quantity: 2 }];
  const request = buildPurchaseRequestSvg({ supplierName: '金猴', batchNo: 'B-1', items });
  const returned = buildPurchaseRequestSvg({ supplierName: '金猴', batchNo: 'B-1', items, title: RETURN_TITLE });
  assert.ok(request.includes(`>${TITLE}</text>`));
  assert.ok(returned.includes(`>${RETURN_TITLE}</text>`));
  // 只差标题那一段：其余排版逐字节相同（列宽/合计/截断规则不会被复制成两份）
  assert.equal(returned.replace(RETURN_TITLE, TITLE), request);
});
