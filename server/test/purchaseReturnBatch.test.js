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
const {
  DEFAULT_PURCHASE_RETURN_BATCH_WINDOW_MS,
  PURCHASE_RETURN_BATCH_WINDOW_ENV_KEY,
  resolvePurchaseReturnBatchWindowMs,
} = require('../src/config/purchaseReturnBatchWindow');

// ⚠️ 这一组用例钉的是**业务负责人 2026-10-06 拍板的两个改动**（采购退货）：
//   ① 按「报货批次号」归批，窗口 30 秒 → 一次提交只出 1 张单、只发 1 次群
//   ② 发群改成「一条开话题 + 后面的回复它」→ 图文挂在同一个话题下
// 验收标准原文与逐条对照见 docs/purchase-return-batch-and-topic-acceptance-2026-10-06.md。
//
// 形状就是今天生产实测的那个：一次表单 2 条记录、同一个报货批次号、**分两次推过来**
//（实测相隔 16 秒；单测里按比例缩小成 60ms/300ms，不去真的等 16 秒——
//  "30 秒 > 16 秒"由配置用例直接钉住）。
//
// 库存那一段用**真的 InventoryService**（不是桩）：重复扣减只有真实现才测得出来。

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';
// 采购单只发群（合并 #85 起）：没配群时会「大声跳过」，这组用例要验的正是发群那一段。
process.env.PURCHASE_CHAT_ID = process.env.PURCHASE_CHAT_ID || 'oc_test_purchase_group';

const table = (key) => V1_BITABLE_SCHEMA.tables[key];
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-return-batch-'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (label, check, { attempts = 1500, pause = 10 } = {}) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await wait(pause);
  }
  throw new Error(`等待「${label}」超时`);
};

const SIZE_RECORDS = [36, 37, 38, 39, 40, 41, 42, 43]
  .map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));

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
  const data = records;
  return {
    records: data,
    uploads: [],
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
    uploadAttachment: async () => `file_token_${(data.__uploads = (data.__uploads || 0) + 1)}`,
  };
};

/**
 * 假飞书 client。**照飞书的话题语义建模**（这是本组用例的前提假设，必须在真机上核过）：
 *   · 顶层消息（`im.message.create`，receive_id_type=chat_id）在话题群里**自己就是一个话题**，
 *     响应里带回该话题的 thread_id；
 *   · `im.message.reply` 回复谁，就落在**谁的话题**里，响应里带回同一个 thread_id。
 * ⇒ 于是"第 1 条（图）+ 回复它的文字"必然共用一个 topic id，能直接断言"同一个话题"。
 * （私聊通知 message.create 不产生话题，thread_id 为空。）
 */
const makeClient = (messages) => {
  const threadOf = new Map();
  return {
    im: {
      image: { create: async () => ({ image_key: `img_${messages.length + 1}` }) },
      message: {
        create: async (params) => {
          const messageId = `om_${messages.length + 1}`;
          const toGroup = params.params?.receive_id_type === 'chat_id';
          const threadId = toGroup ? `omt_topic_${messageId}` : '';
          threadOf.set(messageId, threadId);
          messages.push({
            kind: 'create', toGroup, messageId, threadId,
            payload: params, data: params.data,
          });
          return { code: 0, msg: 'success', data: { message_id: messageId, thread_id: threadId } };
        },
        reply: async (params) => {
          const messageId = `om_${messages.length + 1}`;
          // 飞书规则：回复谁就落在谁的话题里（回复话题内任一消息都算该话题）。
          const threadId = threadOf.get(params.path?.message_id) || '';
          threadOf.set(messageId, threadId);
          messages.push({
            kind: 'reply', toGroup: true, messageId, threadId,
            path: params.path, data: params.data,
          });
          return { code: 0, msg: 'success', data: { message_id: messageId, thread_id: threadId } };
        },
      },
    },
  };
};

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
  { record_id: 'beh_return', fields: { 行为名称: '采购退货', 行为编码: 'STOCK_PURCHASE_DECREASE', 库存方向: '减少', 是否启用: true } },
  { record_id: 'beh_request', fields: { 行为名称: '采购申请', 行为编码: 'STOCK_PURCHASE_INCREASE', 库存方向: '增加', 是否启用: true } },
];

const productFields = (itemNo, color, supplierId = 'sup_A') => ({
  货号: itemNo, 颜色: [{ text: color }], 编号: `${itemNo}${color}`, 供应商: [supplierId],
});
const SUPPLIERS = [{ record_id: 'sup_A', fields: { 供应商名称: '金猴' } }];

// 今天实测那两条：2070-9 6 双 / 66851 7 双，同一个报货批次号。
const PRODUCTS = {
  prod_9: productFields('2070-9', '黑色'),
  prod_66851: productFields('66851', '棕色'),
};

const liveRow = (recordId, state, size, productRecordId) => ({
  record_id: recordId,
  fields: { 编号: [productRecordId], 尺码: [`size_${size}`], 所属状态: state },
});

const returnRecord = (recordId, productRecordId, fields = {}) => ({
  record_id: recordId,
  fields: {
    处理状态: '待解析',
    采购行为: ['beh_return'],
    经办人: [{ id: 'ou_user_1' }],
    编号: [productRecordId],
    ...fields,
  },
});

const makeService = (options = {}) => {
  const dir = options.dir || tempDir();
  const store = options.store || new JsonTaskStore({ dir });
  const gateway = options.gateway || makeGateway();
  const messages = options.messages || [];
  const images = options.images || makeImages();
  const inventoryStore = options.inventoryStore || new JsonTaskStore({ dir: tempDir(), idField: 'operation_id' });
  const service = new PurchaseWebhookService({
    gateway,
    store,
    client: makeClient(messages),
    images,
    inventory: new InventoryService({ gateway, store: inventoryStore }),
    references: {
      resolveProduct: async ({ productRecordId }) => {
        const fields = (options.products || PRODUCTS)[productRecordId];
        if (!fields) throw new Error(`找不到货品记录：${productRecordId}`);
        return { recordId: productRecordId, record: { record_id: productRecordId, fields } };
      },
    },
    recognizer: { parsePurchaseReportText: async () => options.parsedQuantities || [{ size: 36, quantity: 1 }] },
    batchReadMaxRetries: 1,
    batchReadRetryDelay: 0,
    // 生产默认 30 秒；用例里缩到几百毫秒（不去真的等 30 秒）。
    purchaseReturnBatchWindowMs: options.purchaseReturnBatchWindowMs ?? 300,
    // 报货那条链路的窗口（4 秒）在这里只是"混着采购申请"那条用例的必经之路：
    // 也压小，免得一条用例白等 4 秒。退货链路**不读**这个值。
    reportBatchWindowMs: options.reportBatchWindowMs ?? 50,
  });
  return { service, store, gateway, messages, images, inventoryStore, dir };
};

const rowsOf = (gateway, tableKey) => gateway.records[tableKey] || [];
const requestsOf = (gateway) => rowsOf(gateway, 'purchaseRequest');
const ledgerOf = (gateway) => rowsOf(gateway, 'inventoryLedger');
const liveOf = (gateway) => rowsOf(gateway, 'liveInventory');
const groupMessages = (messages) => messages.filter((message) => message.toGroup);

// 今天实测那个形状的假表：一次提交 2 条、同一个批次号，货号不同、供应商相同。
const twoRecordFixture = (batchNo = '202610061') => makeGateway({
  purchaseReport: [
    returnRecord('rep_2070', 'prod_9', { 数量: 6, 报货批次号: batchNo }),
    returnRecord('rep_66851', 'prod_66851', { 数量: 7, 报货批次号: batchNo }),
  ],
  liveInventory: [
    // 2070-9：6 双（36 码 3 双 / 37 码 3 双）
    liveRow('live_9_36a', '门盒', 36, 'prod_9'),
    liveRow('live_9_36b', '门盒', 36, 'prod_9'),
    liveRow('live_9_36c', '样品', 36, 'prod_9'),
    liveRow('live_9_37a', '仓库', 37, 'prod_9'),
    liveRow('live_9_37b', '门盒', 37, 'prod_9'),
    liveRow('live_9_37c', '样品', 37, 'prod_9'),
    // 66851：7 双（40 码 4 双 / 41 码 3 双）
    liveRow('live_66_40a', '门盒', 40, 'prod_66851'),
    liveRow('live_66_40b', '门盒', 40, 'prod_66851'),
    liveRow('live_66_40c', '样品', 40, 'prod_66851'),
    liveRow('live_66_40d', '仓库', 40, 'prod_66851'),
    liveRow('live_66_41a', '门盒', 41, 'prod_66851'),
    liveRow('live_66_41b', '样品', 41, 'prod_66851'),
    liveRow('live_66_41c', '仓库', 41, 'prod_66851'),
  ],
  behavior: BEHAVIORS,
  supplier: SUPPLIERS,
  purchaseRequest: [],
});

// 这一批的**全部**报单记录都进入终态（= 整批真的处理完了）。
const waitForRecordsPosted = async (gateway, recordIds) => {
  await waitFor('这一批的记录全部进入「已生成申请」', async () => {
    for (const recordId of recordIds) {
      const record = await gateway.get('purchaseReport', recordId);
      if (record?.fields?.['处理状态'] !== '已生成申请') return false;
    }
    return true;
  });
};

// 这一批的**任务**都落终态（posted / completed）。
// ⚠️ 记录状态是 runReturnBatch 中途写的，而任务终态是 flushReturnBatch 收尾才写的。
// 只等记录状态会有两个坑：① 重复投递读到还在 queued/processing 的任务 → duplicate=false；
// ② 测试刚把状态改回未处理，又被收尾的那次写盘覆盖回终态。
//（报货那条链路的重复投递用例踩过同一个坑，那里也留了这段等待。）
const waitForTasksTerminal = async (service, store, recordIds) => {
  await waitFor('整批任务落终态', async () => {
    for (const recordId of recordIds) {
      const task = await store.get(service.purchaseTaskId('supplier-report', recordId));
      if (!['posted', 'completed'].includes(task?.status)) return false;
    }
    return true;
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// ① 归批窗口的配置（生产默认 30 秒 / 16 秒兜得住 / 显式取值，不写 || fallback）
// ─────────────────────────────────────────────────────────────────────────────

test('退货归批窗口：生产默认 30 秒，比实测的 16 秒拆包间隔宽；可显式覆盖，写错回落默认值', () => {
  // 业务负责人 2026-10-06 拍板的值。
  assert.equal(DEFAULT_PURCHASE_RETURN_BATCH_WINDOW_MS, 30_000);
  assert.equal(resolvePurchaseReturnBatchWindowMs({}, {}), 30_000);
  // 生产实测：两条相隔 16 秒 → 窗口必须比它宽，否则还是会被拆成两批。
  assert.ok(
    resolvePurchaseReturnBatchWindowMs({}, {}) > 16_000,
    '窗口必须兜得住实测的 16 秒拆包间隔',
  );
  // 环境变量覆盖（单测传 env，不动全局 process.env，避免并发用例互相污染）。
  assert.equal(resolvePurchaseReturnBatchWindowMs({}, { [PURCHASE_RETURN_BATCH_WINDOW_ENV_KEY]: '45000' }), 45_000);
  // 构造入参优先于环境变量（测试/沙箱用）。
  assert.equal(resolvePurchaseReturnBatchWindowMs({ purchaseReturnBatchWindowMs: 5 }, { [PURCHASE_RETURN_BATCH_WINDOW_ENV_KEY]: '45000' }), 5);
  // 0 是合法值（"窗口一开就到点"）。
  assert.equal(resolvePurchaseReturnBatchWindowMs({ purchaseReturnBatchWindowMs: 0 }, {}), 0);
  // 写错/清空 → 回落默认值（**不是**变成"不等待"）：负数、非数字、空白串一个都不认。
  assert.equal(resolvePurchaseReturnBatchWindowMs({ purchaseReturnBatchWindowMs: -1 }, {}), 30_000);
  assert.equal(resolvePurchaseReturnBatchWindowMs({ purchaseReturnBatchWindowMs: 'abc' }, {}), 30_000);
  assert.equal(resolvePurchaseReturnBatchWindowMs({ purchaseReturnBatchWindowMs: '   ' }, {}), 30_000);
  assert.equal(resolvePurchaseReturnBatchWindowMs({}, { [PURCHASE_RETURN_BATCH_WINDOW_ENV_KEY]: '' }), 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// ① ② ③ ④ ⑤：一次提交 2 条（同批次、分两次到达）→ 1 张单 / 1 张图 + 1 条文字 @ / 同一个话题
// ─────────────────────────────────────────────────────────────────────────────

test('① 一次提交 2 条（同批次、分两次到达）→ 只出 1 张退货单、一次发群；两条明细在同一张表里', async () => {
  const gateway = twoRecordFixture();
  const messages = [];
  const images = makeImages();
  const { service } = makeService({ gateway, messages, images, purchaseReturnBatchWindowMs: 300 });

  // 飞书**分两次推**（实测形状）：第 1 条到达后隔一小会儿第 2 条才到。
  await service.accept('supplier-report', 'rep_2070');
  await wait(60);
  await service.accept('supplier-report', 'rep_66851');
  await waitForRecordsPosted(gateway, ['rep_2070', 'rep_66851']);

  // ① 只出一张图（＝一张退货单），两个货号都在这张单上。
  assert.equal(images.calls.length, 1, '整批只渲染 1 张退货单');
  assert.equal(images.calls[0].title, RETURN_TITLE);
  const itemNos = new Set(images.calls[0].items.map((item) => item.item_no));
  assert.deepEqual([...itemNos].sort(), ['2070-9', '66851'], '两个货号必须在同一张单上');
  assert.deepEqual(
    images.calls[0].items.map((item) => [item.item_no, item.size, item.quantity]),
    [['2070-9', 36, 3], ['2070-9', 37, 3], ['66851', 40, 4], ['66851', 41, 3]],
    '明细与尺码顺序稳定（明细ID → 尺码）',
  );
  assert.equal(images.calls[0].batchNo, '202610061');

  // ⑤ 单据信息：一尺码一行、两个货号的单据都在同一批里、行为都是采购退货。
  const requests = requestsOf(gateway);
  assert.equal(requests.length, 4, '一尺码一行：3+3 与 4+3 各合成一行');
  assert.ok(requests.every((row) => JSON.stringify(row.fields.采购行为) === JSON.stringify(['beh_return'])));
  assert.deepEqual(
    requests.map((row) => [row.fields.尺码[0], row.fields.数量]).sort(),
    [['size_36', 3], ['size_37', 3], ['size_40', 4], ['size_41', 3]],
  );
  assert.deepEqual(
    requests.map((row) => row.fields.幂等键).sort(),
    [
      'purchase_return:rep_2070:36', 'purchase_return:rep_2070:37',
      'purchase_return:rep_66851:40', 'purchase_return:rep_66851:41',
    ],
  );
  const productLinks = new Set(requests.map((row) => String(row.fields.编号)));
  assert.equal(productLinks.size, 2, '两个货号的单据都在（不是只写了第一条）');
  // 两条报单记录都进终态、各自关联到自己的单据。
  const reportA = await gateway.get('purchaseReport', 'rep_2070');
  const reportB = await gateway.get('purchaseReport', 'rep_66851');
  assert.equal(reportA.fields.处理状态, '已生成申请');
  assert.equal(reportB.fields.处理状态, '已生成申请');
  assert.equal(reportA.fields.关联采购申请.length, 2);
  assert.equal(reportB.fields.关联采购申请.length, 2);
});

test('② 群里只有 1 张图 + 1 条文字 @，且文字是回复第 1 条（同一个话题）', async () => {
  const gateway = twoRecordFixture();
  const messages = [];
  const { service } = makeService({ gateway, messages, purchaseReturnBatchWindowMs: 300 });

  await service.accept('supplier-report', 'rep_2070');
  await wait(60);
  await service.accept('supplier-report', 'rep_66851');
  await waitForRecordsPosted(gateway, ['rep_2070', 'rep_66851']);
  await waitFor('群消息发完', async () => groupMessages(messages).length === 2);

  const group = groupMessages(messages);
  assert.equal(group.length, 2, '一条提交只发 2 条群消息（以前是 4 条：2 图 + 2 文字）');
  const [image, text] = group;
  assert.equal(image.kind, 'create', '第 1 条（图）照常顶层发');
  assert.equal(image.data.msg_type, 'image');
  // ⚠️ 假 client 记的是**整包参数**（`{ params, data }`），所以顶层消息的
  // receive_id 在 `image.payload.params` 上；回复消息没有 params（走 path.message_id）。
  assert.equal(image.payload.params.receive_id_type, 'chat_id');
  assert.equal(image.payload.data.receive_id, 'oc_test_purchase_group');
  // 后续每条都用 im.message.reply 回复**第 1 条**（不是发顶层、也不是回复上一条）。
  assert.equal(text.kind, 'reply', '文字必须用 reply，不能再发顶层消息');
  assert.equal(text.path.message_id, image.messageId, '必须回复第 1 条（图）');
  assert.equal(text.data.msg_type, 'text');
  assert.match(JSON.parse(text.data.content).text, /^<at user_id="ou_user_1"><\/at> /);
  // 同一个话题：回复落在第 1 条的话题里。
  assert.ok(image.threadId, '话题群里顶层图片自带话题 id');
  assert.equal(text.threadId, image.threadId, '图与文字必须挂在同一个话题下（1 个话题 / 2 条消息）');
});

test('③ ④ 库存流水按实际数扣（一尺码一行、行为=采购减少），实时库存扣到 0（行消失）', async () => {
  const gateway = twoRecordFixture();
  const { service } = makeService({ gateway, purchaseReturnBatchWindowMs: 300 });

  await service.accept('supplier-report', 'rep_2070');
  await wait(60);
  await service.accept('supplier-report', 'rep_66851');
  await waitForRecordsPosted(gateway, ['rep_2070', 'rep_66851']);

  // ④ 实时库存：13 行全部扣掉（扣完的行消失），没有多扣也没有漏扣。
  assert.deepEqual(liveOf(gateway), []);

  // ③ 库存流水：一尺码一行，行为 = 采购退货（采购减少），变动数量 = 实际退掉的双数。
  const ledger = ledgerOf(gateway);
  assert.equal(ledger.length, 4, '一尺码一行（36/37/40/41），不是 13 行');
  assert.deepEqual(
    ledger.map((row) => [row.fields.尺码[0], row.fields.变动数量]).sort(),
    [['size_36', 3], ['size_37', 3], ['size_40', 4], ['size_41', 3]],
  );
  assert.ok(ledger.every((row) => JSON.stringify(row.fields.库存行为) === JSON.stringify(['beh_return'])));
  assert.ok(ledger.every((row) => JSON.stringify(row.fields.编号).includes('prod_9') || JSON.stringify(row.fields.编号).includes('prod_66851')));
  // 退货不写别的表：不建报货批次、不写采购到货/入库。
  assert.equal(gateway.records.purchaseOrderBatch, undefined);
  assert.equal(gateway.records.purchaseArrival, undefined);
  assert.equal(gateway.records.purchaseInbound, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ 跨批不误合
// ─────────────────────────────────────────────────────────────────────────────

test('⑥ 不同「报货批次号」的两条：窗口内先后到达也不能合成一张单', async () => {
  const gateway = makeGateway({
    purchaseReport: [
      returnRecord('rep_batch_a', 'prod_9', { 数量: 3, 报货批次号: 'BATCH-A' }),
      returnRecord('rep_batch_b', 'prod_66851', { 数量: 4, 报货批次号: 'BATCH-B' }),
    ],
    liveInventory: [
      liveRow('live_a_36', '门盒', 36, 'prod_9'),
      liveRow('live_a_37', '门盒', 37, 'prod_9'),
      liveRow('live_a_38', '门盒', 38, 'prod_9'),
      liveRow('live_b_40', '门盒', 40, 'prod_66851'),
      liveRow('live_b_41', '门盒', 41, 'prod_66851'),
      liveRow('live_b_42', '门盒', 42, 'prod_66851'),
      liveRow('live_b_43', '门盒', 43, 'prod_66851'),
    ],
    behavior: BEHAVIORS,
    supplier: SUPPLIERS,
    purchaseRequest: [],
  });
  const images = makeImages();
  const { service } = makeService({ gateway, images, purchaseReturnBatchWindowMs: 300 });

  await service.accept('supplier-report', 'rep_batch_a');
  await wait(60);
  await service.accept('supplier-report', 'rep_batch_b');
  await waitForRecordsPosted(gateway, ['rep_batch_a', 'rep_batch_b']);
  // 记录进终态 ≠ 图已经出完（出图在 applySupplierReturn 之后的收尾里）。等两批都出图再断言。
  await waitFor('两批都出图', async () => images.calls.length === 2);

  // 两批 → 两张单、两张图；各自只扣自己的库存。
  assert.equal(images.calls.length, 2, '两个批次号必须各出一张单');
  // 每张图上的**去重货号**（一条明细可能跨多个尺码，所以先 Set 再比）。
  assert.deepEqual(
    images.calls.map((call) => [...new Set(call.items.map((item) => item.item_no))].join('+')).sort(),
    ['2070-9', '66851'],
  );
  const requests = requestsOf(gateway);
  assert.equal(requests.length, 7, '一批 3 个尺码 + 另一批 4 个尺码 = 7 行单据（一尺码一行）');
  const docIdsFor = async (recordId) => (await gateway.get('purchaseReport', recordId)).fields.关联采购申请;
  const docsA = await docIdsFor('rep_batch_a');
  const docsB = await docIdsFor('rep_batch_b');
  assert.equal(docsA.length, 3, 'A 批 3 双 → 3 行');
  assert.equal(docsB.length, 4, 'B 批 4 双 → 4 行');
  assert.notDeepEqual(docsA, docsB, '两个批次不能共用同一张单据');
  assert.deepEqual(liveOf(gateway), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑦ 超时不漏
// ─────────────────────────────────────────────────────────────────────────────

test('⑦ 单独一条（窗口内没有同伴）：窗口到点前一次远端写入都没有，到点后照常出单出图', async () => {
  const gateway = makeGateway({
    purchaseReport: [returnRecord('rep_alone', 'prod_9', { 数量: 2, 报货批次号: 'BATCH-ALONE' })],
    liveInventory: [liveRow('live_alone_36', '门盒', 36, 'prod_9'), liveRow('live_alone_37', '门盒', 37, 'prod_9')],
    behavior: BEHAVIORS,
    supplier: SUPPLIERS,
    purchaseRequest: [],
  });
  const images = makeImages();
  const { service, store } = makeService({ gateway, images, purchaseReturnBatchWindowMs: 250 });

  const accepted = await service.accept('supplier-report', 'rep_alone');
  // 窗口没到点：任务停在等窗口，业务表一个字都没写。
  await waitFor('任务停在等窗口', async () => (await store.get(accepted.taskId))?.status === 'batch_waiting');
  await wait(80);
  assert.equal(requestsOf(gateway).length, 0, '窗口没到点不得写单据');
  assert.equal(ledgerOf(gateway).length, 0, '窗口没到点不得扣库存');
  assert.equal(images.calls.length, 0, '窗口没到点不得出图');
  assert.equal((await gateway.get('purchaseReport', 'rep_alone')).fields.处理状态, '待解析');

  // 窗口到点：照常出单、出图、扣库存（"没有同伴"不是丢单的理由）。
  await waitForRecordsPosted(gateway, ['rep_alone']);
  assert.equal(requestsOf(gateway).length, 2);
  assert.equal(images.calls.length, 1);
  assert.deepEqual(liveOf(gateway), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑧ 幂等
// ─────────────────────────────────────────────────────────────────────────────

test('⑧ 同一批的记录重复投递（含顺序颠倒）：不重复出单、不重复扣库存、不重复发图', async () => {
  const gateway = twoRecordFixture();
  const messages = [];
  const images = makeImages();
  const { service, store } = makeService({ gateway, messages, images, purchaseReturnBatchWindowMs: 200 });

  await service.accept('supplier-report', 'rep_2070');
  await wait(60);
  await service.accept('supplier-report', 'rep_66851');
  await waitForRecordsPosted(gateway, ['rep_2070', 'rep_66851']);
  await waitFor('群消息发完', async () => groupMessages(messages).length === 2);
  // ⚠️ 必须再等**任务终态写盘**：flushReturnBatch 是在 runReturnBatch 跑完之后才逐个写
  // status（posted / completed），而记录状态是 runReturnBatch 中途写的。少这一等，
  // 重投会读到还在 queued/processing 的任务 → 走一遍窗口 → duplicate=false
  //（报货那条链路的重复投递用例踩过同一个坑，那里也留了这段等待）。
  await waitFor('整批任务落终态', async () => {
    for (const recordId of ['rep_2070', 'rep_66851']) {
      const task = await store.get(service.purchaseTaskId('supplier-report', recordId));
      if (!['posted', 'completed'].includes(task?.status)) return false;
    }
    return true;
  });

  const snapshot = () => JSON.stringify({
    requests: requestsOf(gateway).length,
    ledger: ledgerOf(gateway).length,
    live: liveOf(gateway).length,
    images: images.calls.length,
    group: groupMessages(messages).length,
  });
  const before = snapshot();

  // 飞书重投（连 action_list 一起重来），顺序反过来。
  const againB = await service.accept('supplier-report', 'rep_66851');
  const againA = await service.accept('supplier-report', 'rep_2070');
  assert.equal(againB.duplicate, true, '已处理的任务要按重复投递拦掉');
  assert.equal(againA.duplicate, true);
  await wait(300);
  assert.equal(snapshot(), before, '重复投递不得新增单据/流水/库存/图/群消息');
});

test('⑧ 状态没写上（任务与记录都被改回未处理）时复跑：幂等键 + 库存 operationId 保证不扣第二遍', async () => {
  const gateway = twoRecordFixture();
  const { service, store } = makeService({ gateway, purchaseReturnBatchWindowMs: 200 });

  await service.accept('supplier-report', 'rep_2070');
  await wait(60);
  await service.accept('supplier-report', 'rep_66851');
  await waitForRecordsPosted(gateway, ['rep_2070', 'rep_66851']);
  const ledgerBefore = ledgerOf(gateway).length;
  const requestsBefore = requestsOf(gateway).length;

  // 模拟"状态丢了"：两条记录的处理状态、两个任务的终态全部改回未处理。
  for (const recordId of ['rep_2070', 'rep_66851']) {
    await gateway.update('purchaseReport', recordId, { status: '待解析', request: [] });
  }
  // ⚠️ 任务退回 **failed**（可重试态）而不是 queued：`accept()` 对 queued/processing
  // 这类"还在处理中"的状态一律按重复投递拦掉（报货那条链路就是这个口径）——
  // 用 queued 就根本不会复跑，也就测不到幂等。failed 才是"重收 webhook 能救回来"的状态。
  for (const recordId of ['rep_2070', 'rep_66851']) {
    await store.update(service.purchaseTaskId('supplier-report', recordId), { status: 'failed', result: undefined });
  }
  // 重新投递 → 再走一遍窗口 → 整批复跑。
  await service.accept('supplier-report', 'rep_2070');
  await wait(60);
  await service.accept('supplier-report', 'rep_66851');
  await waitForRecordsPosted(gateway, ['rep_2070', 'rep_66851']);

  assert.equal(liveOf(gateway).length, 0, '库存不能被扣第二遍');
  assert.equal(ledgerOf(gateway).length, ledgerBefore, '流水不能多写');
  assert.equal(requestsOf(gateway).length, requestsBefore, '单据信息不能多写');
});

test('⑧ 已到终态的记录混在批次里：跳过它，只处理没处理过的那条', async () => {
  const gateway = twoRecordFixture();
  const images = makeImages();
  const { service } = makeService({ gateway, images, purchaseReturnBatchWindowMs: 200 });

  await service.accept('supplier-report', 'rep_2070');
  await wait(60);
  await service.accept('supplier-report', 'rep_66851');
  await waitForRecordsPosted(gateway, ['rep_2070', 'rep_66851']);
  const requestsBefore = requestsOf(gateway).length;

  // 把 rep_2070 改回未处理（模拟它单独重投、而同伴已经是终态），再只重投它。
  // 任务退回 failed（可重试态）：queued 会被 accept() 当成"还在处理"而拦掉，不会复跑。
  await gateway.update('purchaseReport', 'rep_2070', { status: '待解析', request: [] });
  await service.store.update(service.purchaseTaskId('supplier-report', 'rep_2070'), { status: 'failed', result: undefined });
  await service.accept('supplier-report', 'rep_2070');
  await waitForRecordsPosted(gateway, ['rep_2070']);
  await wait(200);

  // 同伴（rep_66851）已是终态 → 这一批不会因为"同伴在"而重写它的单据。
  assert.equal(requestsOf(gateway).length, requestsBefore, '已终态的同伴不被重写、也不重复写单据');
});

// ─────────────────────────────────────────────────────────────────────────────
// 与报货链路互不干扰（同一次提交里混着采购申请与采购退货）
// ─────────────────────────────────────────────────────────────────────────────

test('混着采购申请与采购退货（同一批次号）：退货批不会给采购申请记录补终态、也不会把它写成退货单', async () => {
  const gateway = makeGateway({
    purchaseReport: [
      returnRecord('rep_mix_ret', 'prod_9', { 数量: 2, 报货批次号: 'BATCH-MIX' }),
      {
        record_id: 'rep_mix_req',
        fields: {
          处理状态: '待解析', 采购行为: ['beh_request'], 经办人: [{ id: 'ou_user_1' }],
          编号: ['prod_9'], 尺码: ['size_36'], 数量说明: '36码1双', 报货批次号: 'BATCH-MIX',
        },
      },
    ],
    liveInventory: [liveRow('live_mix_36', '门盒', 36, 'prod_9'), liveRow('live_mix_37', '门盒', 37, 'prod_9')],
    behavior: BEHAVIORS,
    supplier: SUPPLIERS,
    purchaseRequest: [],
  });
  const images = makeImages();
  const { service } = makeService({
    gateway, images, purchaseReturnBatchWindowMs: 200,
    recognizer: { parsePurchaseReportText: async () => [{ size: 36, quantity: 1 }] },
  });

  await service.acceptMany('supplier-report', ['rep_mix_ret', 'rep_mix_req']);
  await waitForRecordsPosted(gateway, ['rep_mix_ret', 'rep_mix_req']);
  await wait(200);

  // 退货那条：按退货口径扣 2 双（数量 2 摊到两个尺码：36/37 各 1 双 → 一尺码一行单据），
  // 出退货单。
  assert.equal(images.calls.filter((call) => call.title === RETURN_TITLE).length, 1);
  // 采购申请那条：走报货那条链路（4 秒窗口，单测里 20ms）写它自己的单据，行为是采购申请。
  const requests = requestsOf(gateway);
  const returnDocs = requests.filter((row) => JSON.stringify(row.fields.采购行为) === JSON.stringify(['beh_return']));
  const requestDocs = requests.filter((row) => JSON.stringify(row.fields.采购行为) === JSON.stringify(['beh_request']));
  assert.equal(returnDocs.length, 2, '退货那条 2 双摊到 36/37 两个尺码 → 一尺码一行');
  assert.equal(requestDocs.length, 1, '采购申请那条照旧写单据（没被退货批吞掉）');
  // 退货批绝不能因为"同一批次号"就把采购申请记录当成退货处理。
  assert.deepEqual(
    returnDocs.map((row) => row.fields.幂等键).sort(),
    ['purchase_return:rep_mix_ret:36', 'purchase_return:rep_mix_ret:37'],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 持久化：PM2 重启后，还在等窗口的退货会自动重开窗口继续处理
// ─────────────────────────────────────────────────────────────────────────────

test('重启不丢：等窗口的退货任务落在 JsonTaskStore，新进程起来后自动重开窗口并处理完', async () => {
  const dir = tempDir();
  const gateway = twoRecordFixture();
  const messages = [];
  const images = makeImages();
  const inventoryStore = new JsonTaskStore({ dir: tempDir(), idField: 'operation_id' });
  // 第一个"进程"：窗口给得很长，受理后任务停在 batch_waiting（还没到点）。
  const first = makeService({
    dir, gateway, messages, images, inventoryStore, purchaseReturnBatchWindowMs: 60_000,
  });
  const accepted = await first.service.accept('supplier-report', 'rep_2070');
  await waitFor('任务落在等窗口状态', async () => (await first.store.get(accepted.taskId))?.status === 'batch_waiting');
  const stored = await first.store.get(accepted.taskId);
  assert.equal(stored.batch_kind, 'purchase-return', '落盘的任务必须带批次类型标记（恢复时靠它认出来）');
  assert.equal(stored.batch_no, '202610061');
  assert.equal(requestsOf(gateway).length, 0, '第一个进程什么都没写就"挂了"');
  // 模拟进程退出：窗口定时器丢失（任务还在磁盘上）。
  clearTimeout(first.service.pendingReturnBatches.get('202610061').timer);
  first.service.pendingReturnBatches.clear();

  // 第二个"进程"：同一个 store 目录、新的服务实例 → 构造后自动恢复。
  const second = makeService({
    dir, store: new JsonTaskStore({ dir }), gateway, messages, images, inventoryStore,
    purchaseReturnBatchWindowMs: 100,
  });
  await waitFor('重启后自动重开窗口', async () => second.service.pendingReturnBatches.has('202610061'));
  // ⚠️ 恢复后的处理者**重新读表**：这一批在表里的**全部**退货记录都会被处理，
  // 不只是"第一个进程受理过的那一条"（这正是 runReturnBatch「处理前重新读表」的口径——
  // webhook 没投到的同伴也以表里的记录为准，不会漏）。所以这里两条都进终态。
  await waitForRecordsPosted(gateway, ['rep_2070', 'rep_66851']);
  await wait(150);
  assert.equal(requestsOf(gateway).length, 4, '重启后按表里的整批记录出单：3+3 与 4+3 → 4 个尺码行');
  assert.deepEqual(liveOf(gateway), [], '两条退货的库存都按实际数扣到 0');
});
