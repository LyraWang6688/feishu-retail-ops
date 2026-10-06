/**
 * 「采购到货：群话题对话式核对」的验收测试。
 *
 * 这个文件里的每一条用例都对应**业务负责人 2026-10-06 逐字定的验收标准**
 * （见 docs/arrival-conversation-acceptance-2026-10-06.md），标题里标出来：
 *   □ 核对期间：只记录，一张业务表都不写
 *   □ 话题里免 @
 *   □ 三类差异（完全一样 / 比申请多 / 比申请少）都能解析对
 *   □ 说「完毕」→ 发卡片，卡片上有「是」和「否」
 *   □ 点「是」→「采购到货」新增一行（原话；**到货日由飞书自动填，代码不写**）
 *   □ 点「是」→「采购入库」按实际数、「库存流水」/「实时库存」跟着变
 *   □ 「单据信息」（采购申请表）一个字都没变 —— **断言钉住，不是文档里说说**
 *   □ 重复点「是」→ 幂等
 *   □ 点「否」→ 零写入 + 一句话
 *   □ 不为「实际为 0」写规则
 *
 * 测试栈：**真的**跑 `PurchaseWebhookService.confirmArrival`（入库那一段是既有能力，
 * 不重写、也不打桩），只把"远端"（多维表格 gateway / 库存 / IM）换成记录型的假实现，
 * 于是"写了哪几张表、写了什么"可以直接断言。
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
const { LarkMvpService } = require('../src/services/larkMvpService');
const { PurchaseBatchLocator } = require('../src/services/purchaseBatchLocator');
const { SalesGroupThreadLocator } = require('../src/services/salesGroupThreadLocator');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const {
  ARRIVAL_CONVERSATION_ACTIONS,
  ARRIVAL_BATCH_KINDS,
  parseExplicitBoolean,
} = require('../src/config/arrivalConversation');

// 记录链接要用 Base token 拼（本地/CI 给个测试值）。
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const table = (key) => V1_BITABLE_SCHEMA.tables[key];
const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const SIZE_RECORDS = [37, 38, 39, 40].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));
const sizeLink = (size) => [`size_${size}`];

const BATCH_NO = 'BH-20261006-0001';
const BATCH_RECORD_ID = 'batch_1';
const PRODUCT_1 = 'prod_1';
const PRODUCT_2 = 'prod_2';

/**
 * 记录型 gateway：
 *   · 读：按 tableKey 从 records 里取（`sizeManagement` 默认给 SIZE_RECORDS）；
 *   · 写：**每一次 create / update / delete 都记进 writes** —— 这就是
 *     「哪几张表被写了 / 一个字都没变」这类断言的唯一依据。
 *   · `semantic` 只做语义键 → 中文字段名的映射（跟真 gateway 一样）。
 */
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
  const gateway = {
    writes,
    table,
    get: async (tableKey, recordId) => (records[tableKey] || []).find((item) => item.record_id === recordId) || null,
    listAll: async (tableKey) => {
      if (tableKey === 'sizeManagement') return SIZE_RECORDS;
      if (tableKey === 'behavior' && !records.behavior) {
        return [{ record_id: 'bhv_in', fields: { 行为名称: '采购入库', 行为编码: 'PURCHASE_IN', 库存方向: '增加', 是否启用: true } }];
      }
      return records[tableKey] || [];
    },
    create: async (tableKey, semanticValues) => {
      const fields = mapFields(tableKey, semanticValues);
      writes.push({ op: 'create', tableKey, values: fields });
      const recordId = `new_${tableKey}_${(records[tableKey] || []).length + 1}`;
      const record = { record_id: recordId, fields };
      (records[tableKey] ||= []).push(record);
      // 回读到的记录形状与真飞书一致：字段名是中文，值原样。
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
  return gateway;
};

/** 到货的既有能力：真的 PurchaseWebhookService（只把库存与 gateway 换成假的）。 */
const makeWebhookService = ({ gateway, inventory, store }) => new PurchaseWebhookService({
  client: {},
  gateway,
  store,
  inventory,
  images: { render: async () => Buffer.from('png') },
});

const makeInventory = () => ({
  calls: [],
  async applyPurchase(payload) {
    this.calls.push(payload);
    return { ledgerRecordId: `led_${this.calls.length}`, liveRecordIds: [`live_${this.calls.length}`] };
  },
});

/** 模型桩：按脚本返回，同时留下"模型到底看到了什么"的证据。 */
const makeRecognizer = (responses) => ({
  calls: [],
  async parseArrivalReconciliation(input) {
    this.calls.push(input);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  },
});

/** 采购申请明细：38 码 2 双、39 码 2 双（两个尺码，便于验证"只改说的那一行"）。 */
const defaultRecords = () => ({
  purchaseOrderBatch: [{ record_id: BATCH_RECORD_ID, fields: { 报货批次号: BATCH_NO } }],
  product: [
    { record_id: PRODUCT_1, fields: { 货号: 'XHB8095', 颜色: '黑' } },
    { record_id: PRODUCT_2, fields: { 货号: 'XHB8096', 颜色: '棕' } },
  ],
  purchaseRequest: [
    { record_id: 'req_38', fields: { 报货批次号: [BATCH_RECORD_ID], 编号: [PRODUCT_1], 尺码: sizeLink(38), 数量: 2 } },
    { record_id: 'req_39', fields: { 报货批次号: [BATCH_RECORD_ID], 编号: [PRODUCT_1], 尺码: sizeLink(39), 数量: 2 } },
  ],
  purchaseArrival: [],
  purchaseInbound: [],
});

const defaultBatch = (overrides = {}) => ({
  batch_no: BATCH_NO,
  batch_kind: ARRIVAL_BATCH_KINDS.PURCHASE_REQUEST,
  request_ids: ['req_38', 'req_39'],
  chat_id: 'oc_test_group',
  ...overrides,
});

const makeHarness = ({ records = defaultRecords(), responses = [], config } = {}) => {
  const gateway = makeGateway(records);
  const inventory = makeInventory();
  const store = new JsonTaskStore({ dir: tempDir('arrival-conv-test-'), idField: 'task_id' });
  const webhook = makeWebhookService({ gateway, inventory, store });
  const recognizer = makeRecognizer(responses);
  const replied = [];
  const cards = [];
  const updated = [];
  const service = new PurchaseArrivalConversationService({
    gateway,
    store,
    recognizer,
    sizeReferences: webhook.getSizeReferences,
    confirmArrival: (taskId, task, operatorOpenId) => webhook.confirmArrival(taskId, task, operatorOpenId),
    replyText: async (messageId, content) => { replied.push({ messageId, content }); return 'om_reply'; },
    replyCard: async (messageId, card) => { cards.push({ messageId, card }); return `om_card_${cards.length}`; },
    updateCard: async (messageId, card) => { updated.push({ messageId, card }); return true; },
    config,
  });
  return { gateway, inventory, store, webhook, recognizer, replied, cards, updated, service, records };
};

const writesTo = (gateway, tableKey) => gateway.writes.filter((item) => item.tableKey === tableKey);

/** 卡片上的按钮（column_set → column → button）：返回 [{label, action}]。 */
const cardButtons = (card) => (card.elements || [])
  .filter((element) => element.tag === 'column_set')
  .flatMap((element) => element.columns || [])
  .flatMap((column) => column.elements || [])
  .filter((element) => element.tag === 'button')
  .map((button) => ({ label: button.text.content, action: button.value.action }));

// ═══════════════════════════════════════════════════════════════════════════
// □ 核对期间（还没点「是」）
// ═══════════════════════════════════════════════════════════════════════════

test('核对期间①：话题里说的话只记录 —— 一张业务表都不写，也不发卡片', async () => {
  const harness = makeHarness({ responses: [{ complete: false, same: false, differences: [] }] });

  const result = await harness.service.handleTopicMessage({
    batch: defaultBatch(), text: '38 码少了两双', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });

  assert.equal(result.handled, true);
  assert.equal(result.complete, false);
  assert.equal(harness.gateway.writes.length, 0, '核对期间不允许有任何一次业务表写入');
  assert.equal(harness.cards.length, 0, '她还没说「完毕」就不该发卡片');
  assert.deepEqual(harness.replied, [], '核对期间只记录，不回话（群里回话会刷屏）');
  const task = await harness.store.get(taskIdForBatch(BATCH_NO));
  assert.equal(task.status, 'collecting');
  assert.deepEqual(task.transcript.map((item) => item.text), ['38 码少了两双']);
});

test('核对期间②：分多次说 —— 每次只说一部分，模型看到的是**累积的原话**', async () => {
  const harness = makeHarness({
    responses: [
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 2 }] },
      { complete: false, same: false, differences: [] },
    ],
  });
  await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '38 码少了两双', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1' });
  await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '39 码多一双', messageId: 'om_2', threadId: 'omt_1', senderOpenId: 'ou_1' });

  assert.equal(harness.gateway.writes.length, 0);
  // 第二次调用时模型必须同时看到两句话（"可以一次说完，也可以分多次说完"）。
  assert.deepEqual(harness.recognizer.calls[1].messages, ['38 码少了两双', '39 码多一双']);
  // 模型也要看到这批采购申请的明细（货号/颜色/尺码/申请数），否则对不上具体行。
  assert.deepEqual(harness.recognizer.calls[0].rows, [
    { item_no: 'XHB8095', color: '黑', size: 38, quantity: 2 },
    { item_no: 'XHB8095', color: '黑', size: 39, quantity: 2 },
  ]);
});

test('核对期间③：同一条消息被飞书重投 —— 只记一次，不重复喂给模型', async () => {
  const harness = makeHarness({ responses: [{ complete: false, same: false, differences: [] }] });
  await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '38 码少了两双', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1' });
  const twice = await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '38 码少了两双', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1' });

  assert.equal(twice.reason, 'duplicate_message');
  assert.equal(harness.recognizer.calls.length, 1, '重复投递不该再调一次模型');
  assert.equal(harness.gateway.writes.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// □ 三类差异：完全一样 / 比申请多 / 比申请少
// ═══════════════════════════════════════════════════════════════════════════

test('三类差异①：**完全一样** —— 实际数 = 申请数', async () => {
  const harness = makeHarness({ responses: [{ complete: true, same: true, differences: [] }] });
  await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '都到了，跟单子一样，完毕', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1' });

  const task = await harness.store.get(taskIdForBatch(BATCH_NO));
  assert.deepEqual(task.plan.map((row) => [row.size, row.quantity, row.actual]), [[38, 2, 2], [39, 2, 2]]);
  assert.equal(harness.cards.length, 1);
});

test('三类差异②：**实际比申请多** —— 实际数 = 申请数 + 她说的双数', async () => {
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 39, type: 'more', quantity: 2 }] }],
  });
  await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '39 码到了 4 双，完毕', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1' });

  const task = await harness.store.get(taskIdForBatch(BATCH_NO));
  // 只改她说的那一行：38 码维持 2，39 码 2+2=4。
  assert.deepEqual(task.plan.map((row) => [row.size, row.quantity, row.actual]), [[38, 2, 2], [39, 2, 4]]);
  assert.deepEqual(task.differences, [{
    item_no: 'XHB8095', color: '黑', size: 39, type: 'more', quantity: 2, request_record_id: 'req_39',
  }]);
});

test('三类差异③：**实际比申请少** —— 实际数 = 申请数 − 她说的双数', async () => {
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] }],
  });
  await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '38 码少一双，核对完了', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1' });

  const task = await harness.store.get(taskIdForBatch(BATCH_NO));
  assert.deepEqual(task.plan.map((row) => [row.size, row.quantity, row.actual]), [[38, 2, 1], [39, 2, 2]]);
});

test('三类差异④：她说的话对不上明细 → 不入库、不发卡片，回一句让她重说', async () => {
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 41, type: 'less', quantity: 1 }] }],
  });
  const result = await harness.service.handleTopicMessage({
    batch: defaultBatch(), text: '41 码少一双', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });

  assert.equal(result.plan_ok, false);
  assert.equal(harness.cards.length, 0, '对不上就不发卡片');
  assert.equal(harness.gateway.writes.length, 0, '对不上就一个字都不写');
  assert.equal(harness.replied.length, 1);
  assert.match(harness.replied[0].content, /先不入库/);
});

test('三类差异⑤：**不为「实际为 0」写规则** —— 算出来不是正数就拒绝入库（不猜、不写负数）', async () => {
  // 她说"少 5 双"（申请只有 2 双）——真实口径是"实际到货不会为 0"，所以这不是业务场景，
  // 而是"她说的话算不出正数"的输入错误：一律不入库。
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 5 }] }],
  });
  const result = await harness.service.handleTopicMessage({
    batch: defaultBatch(), text: '38 码少 5 双', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });

  assert.equal(result.plan_ok, false);
  assert.equal(result.reason, 'actual_not_positive');
  assert.equal(harness.gateway.writes.length, 0);
  assert.equal(harness.cards.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// □ 「完毕」→ 发卡片（是 / 否）
// ═══════════════════════════════════════════════════════════════════════════

test('说「完毕」→ 在话题里发卡片，卡片上有「是」和「否」两个按钮', async () => {
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] }],
  });
  await harness.service.handleTopicMessage({
    batch: defaultBatch(), text: '38 码少一双，完毕', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });

  assert.equal(harness.cards.length, 1);
  // ⚠️ 卡片是**回复她那条消息**（回复 = 落在同一个话题里），不是另开一条私聊消息。
  assert.equal(harness.cards[0].messageId, 'om_1');
  const buttons = cardButtons(harness.cards[0].card);
  assert.deepEqual(buttons.map((item) => item.label), ['是', '否'], '卡片上必须有「是」和「否」两个按钮');
  assert.deepEqual(buttons.map((item) => item.action), [
    ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, ARRIVAL_CONVERSATION_ACTIONS.REJECT,
  ]);
  // 卡片上写着按她的话算出来的实际数（她点「是」之前还能核对一遍）。
  assert.match(JSON.stringify(harness.cards[0].card), /实际 1 双/);
  // 发卡片本身不是业务表写入。
  assert.equal(harness.gateway.writes.length, 0);
  assert.equal((await harness.store.get(taskIdForBatch(BATCH_NO))).status, 'awaiting_confirmation');
});

test('模型说「她还没说完」时 -> 不发卡片（判据来自模型，不是关键词匹配）', async () => {
  const harness = makeHarness({ responses: [{ complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] }] });
  // 这句话里**没有**"完毕"两个字，但语义上是说完了；反过来这里让模型答 false，
  // 断言的是"一切以模型的判断为准"，代码里没有任何关键词闸门。
  await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '38 码少一双', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1' });
  assert.equal(harness.cards.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// □ 点「是」之后 —— 这才是入库点
// ═══════════════════════════════════════════════════════════════════════════

const confirmCard = async (harness, text = '38 码少一双，完毕') => {
  await harness.service.handleTopicMessage({
    batch: defaultBatch(), text, messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });
  const taskId = taskIdForBatch(BATCH_NO);
  const cardEvent = { context: { open_message_id: 'om_card_1' } };
  const result = await harness.service.handleCardAction(
    { action: ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, draft_id: taskId }, cardEvent, 'ou_1',
  );
  return { taskId, result, cardEvent };
};

test('点「是」①：「采购到货」新增一行 —— 用户原话 + 验收人；**到货日由飞书自动填，代码不写**', async () => {
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] }],
  });
  await confirmCard(harness, '38 码少一双\n完毕');

  const created = writesTo(harness.gateway, 'purchaseArrival').filter((item) => item.op === 'create');
  assert.equal(created.length, 1, '「采购到货」只新增一行');
  const fields = created[0].values;
  assert.equal(fields['验收原话'], '38 码少一双\n完毕', '用户说的原话归集进「验收原话」');
  assert.deepEqual(fields['报货批次号'], [BATCH_RECORD_ID]);
  assert.deepEqual(fields['验收人'], [{ id: 'ou_1' }]);
  // 🔴 「到货日」是飞书里**自动填写**的日期字段（2026-10-06 读生产真表核对过：
  //    type=5 DateTime / property.auto_fill=true）。代码写它就是替飞书做决定。
  assert.equal('到货日' in fields, false, '代码一个字都不许写「到货日」');
  assert.equal(JSON.stringify(created[0].values).includes('到货日'), false);
});

test('点「是」①-补：「验收人」写不进去（UserFieldConvFail）时退一步 —— 不挡入库', async () => {
  // 「验收人」是我加的留痕，她没要求；飞书 User 字段对 open_id 很挑，
  // 写不进去时**不能让附加字段把入库挡住**（真实 E2E 抓到的 1254066）。
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] }],
  });
  const originalCreate = harness.gateway.create;
  harness.gateway.create = async (tableKey, values) => {
    if (tableKey === 'purchaseArrival' && values.inspector) {
      throw new Error('新增“采购到货”记录失败: UserFieldConvFail (Code: 1254066)');
    }
    return originalCreate(tableKey, values);
  };

  const { result } = await confirmCard(harness);

  assert.match(result.toast.content, /已按实际到货入库/);
  const created = writesTo(harness.gateway, 'purchaseArrival').filter((item) => item.op === 'create');
  assert.equal(created.length, 1);
  assert.equal('验收人' in created[0].values, false, '退一步之后只写必须写的字段');
  assert.equal(created[0].values['验收原话'], '38 码少一双，完毕');
  assert.equal(writesTo(harness.gateway, 'purchaseInbound').length, 2, '入库照常发生');
});

test('点「是」②：「采购入库」按**实际**数量写入（不是申请数）', async () => {
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [
      { item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 },
      { item_no: 'XHB8095', color: '黑', size: 39, type: 'more', quantity: 2 },
    ] }],
  });
  await confirmCard(harness);

  const inbounds = writesTo(harness.gateway, 'purchaseInbound').filter((item) => item.op === 'create');
  assert.equal(inbounds.length, 2, '一个（货品+尺码）一条入库行');
  const bySize = new Map(inbounds.map((item) => [JSON.stringify(item.values.尺码), item.values]));
  // 38 码：申请 2 − 1 = 1；39 码：申请 2 + 2 = 4。
  assert.equal(bySize.get(JSON.stringify(sizeLink(38)))['数量'], 1, '入库数量必须是**实际数**');
  assert.equal(bySize.get(JSON.stringify(sizeLink(39)))['数量'], 4, '多到的也要按实际数入库');
  for (const inbound of inbounds) {
    assert.deepEqual(inbound.values['采购行为'], ['bhv_in']);
    assert.ok(inbound.values['采购到货批次'], '入库行要挂回这次到货记录');
    // 🔴 「入库时间」代码一个字都不许写（与 #102 `fix/no-time-field-writes` 对齐）：
    //   业务负责人 2026-10-06 已把这一列从生产表删掉（生产真表「采购入库」11 列里没有它，
    //   见 docs/reports/time-field-writes-cleanup-2026-10-06.md §1），schema 里的
    //   `inboundAt` 映射也已同步删除。此时若有代码再传 `inboundAt`，
    //   `gateway.fields()` 会当场抛「"采购入库"未配置语义字段: inboundAt」——
    //   **整条入库写入失败**（不是少写一列而已）。
    //   时间语义交给飞书自动的「创建时间」(type=1001)：同一时刻，不丢信息。
    assert.equal('入库时间' in inbound.values, false, '代码一个字都不许写「入库时间」');
    assert.equal(JSON.stringify(inbound.values).includes('入库时间'), false);
  }
});

test('点「是」③：「库存流水」/「实时库存」跟着变 —— 全部经 inventory.applyPurchase（按实际数）', async () => {
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 39, type: 'more', quantity: 2 }] }],
  });
  await confirmCard(harness);

  // 「库存流水」和「实时库存」由 InventoryService.applyPurchase 负责（库存在只有一处实现），
  // 到货核对只负责把**实际数**交给它。这里断言的就是交给它的数。
  assert.equal(harness.inventory.calls.length, 2, '每个（货品+尺码）加一次库存');
  const bySize = new Map(harness.inventory.calls.map((call) => [call.size, call]));
  assert.equal(bySize.get(38).quantity, 2, '38 码没被说到的，按申请数 2');
  assert.equal(bySize.get(39).quantity, 4, '39 码按她说的实际数 4');
  for (const call of harness.inventory.calls) {
    assert.equal(call.productRecordId, PRODUCT_1);
    assert.ok(call.purchaseInboundRecordId, '库存的幂等来源是采购入库记录 id');
  }
  // 它没有写「库存流水」/「实时库存」两张表 —— 因为那是 InventoryService 的职责，
  // 那两张表在真环境里由它写（这里注入的是记录型假实现）。
  assert.equal(writesTo(harness.gateway, 'inventoryLedger').length, 0);
  assert.equal(writesTo(harness.gateway, 'liveInventory').length, 0);
});

test('点「是」④：🔴「单据信息」（采购申请表）**一个字都没变** —— 断言钉住', async () => {
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] }],
  });
  await confirmCard(harness);

  // ① 行为断言：整条入库链路对 purchaseRequest 表**零写入**（create / update / delete 都算）。
  assert.deepEqual(writesTo(harness.gateway, 'purchaseRequest'), [],
    '「单据信息」一个字都不许变（业务负责人：既然它就是采购申请，那个表就不要动）');
  // ② 特别钉住「到货状态」这一列：它的值必须还是入库前的样子。
  const requestRow = (harness.records.purchaseRequest || []).find((item) => item.record_id === 'req_38');
  assert.equal(requestRow.fields['到货状态'], undefined, '「到货状态」不许被回写');
  // ③ 申请行的数量也一个字没变（差异只体现在入库/库存上）。
  assert.equal(requestRow.fields['数量'], 2);
});

test('点「是」④-补：源码级断言 —— confirmArrivalLocked 里再也不会出现「回写采购申请」', () => {
  // 行为断言能拦住"现在不写"，源码断言能拦住"以后有人又加回去"。
  const source = fs.readFileSync(path.join(__dirname, '../src/services/purchaseWebhookService.js'), 'utf8');
  const start = source.indexOf('async confirmArrivalLocked(');
  assert.ok(start > 0, '找不到 confirmArrivalLocked');
  const body = source.slice(start, source.indexOf('\n  async nextBatchNo()', start));
  // 只看代码，不看注释：这段的注释里**故意**写着"这里原先回写过 arrivalStatus"，
  // 那是给人看的历史说明，不是代码。
  const codeOnly = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
  assert.equal(/arrivalStatus/.test(codeOnly), false, '入库实现里不许再出现 arrivalStatus');
  assert.equal(/gateway\.(update|create)\(\s*'purchaseRequest'/.test(codeOnly), false,
    '入库实现里不许再对 purchaseRequest 表做写入');
});

test('点「是」⑤：群里回一句结果 + 卡片改成终态', async () => {
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] }],
  });
  const { result } = await confirmCard(harness);

  assert.match(result.toast.content, /已按实际到货入库/);
  assert.match(result.toast.content, /共 3 双/); // 1 + 2
  assert.equal(harness.replied.length, 1, '群里（话题里）回一句结果');
  assert.match(harness.replied[0].content, /已按实际到货入库/);
  assert.equal(harness.updated.length, 1, '发出去的那张卡片要改成终态，不给她重复点的机会');
  assert.equal(cardButtons(harness.updated[0].card).length, 0);
});

test('点「是」⑥：重复点「是」/ 重复投递 → 幂等，不重复入库', async () => {
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] }],
  });
  const { taskId, cardEvent } = await confirmCard(harness);
  const again = await harness.service.handleCardAction(
    { action: ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, draft_id: taskId }, cardEvent, 'ou_1',
  );

  assert.equal(writesTo(harness.gateway, 'purchaseArrival').filter((item) => item.op === 'create').length, 1, '到货记录不重复建');
  assert.equal(writesTo(harness.gateway, 'purchaseInbound').filter((item) => item.op === 'create').length, 2, '入库行不重复写');
  assert.equal(harness.inventory.calls.length, 2, '库存不重复加');
  assert.match(again.toast.content, /已经入库/);
});

// ═══════════════════════════════════════════════════════════════════════════
// □ 点「否」
// ═══════════════════════════════════════════════════════════════════════════

test('点「否」→ 零写入 + 只回一句「好，那先不入库」', async () => {
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] }],
  });
  await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '38 码少一双，完毕', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1' });
  const taskId = taskIdForBatch(BATCH_NO);
  // 发卡片那一步不是业务表写入 —— 从这里开始记，断言"点了「否」之后一个字都没写"。
  harness.gateway.writes.length = 0;

  const result = await harness.service.handleCardAction(
    { action: ARRIVAL_CONVERSATION_ACTIONS.REJECT, draft_id: taskId },
    { context: { open_message_id: 'om_card_1' } }, 'ou_1',
  );

  assert.equal(result.toast.content, '好，那先不入库');
  assert.deepEqual(harness.replied.map((item) => item.content), ['好，那先不入库']);
  assert.deepEqual(harness.gateway.writes, [], '点「否」= 一个字都不写');
  assert.equal(harness.inventory.calls.length, 0);
  assert.equal((await harness.store.get(taskId)).status, 'rejected');
});

test('点「否」之后再点「是」→ 仍然按她的显式指令入库（她没说过「否」就不能改主意）', async () => {
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] }],
  });
  await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '38 码少一双，完毕', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1' });
  const taskId = taskIdForBatch(BATCH_NO);
  await harness.service.handleCardAction(
    { action: ARRIVAL_CONVERSATION_ACTIONS.REJECT, draft_id: taskId }, { context: { open_message_id: 'om_card_1' } }, 'ou_1',
  );
  const result = await harness.service.handleCardAction(
    { action: ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, draft_id: taskId }, { context: { open_message_id: 'om_card_1' } }, 'ou_1',
  );

  assert.match(result.toast.content, /已按实际到货入库/);
  assert.equal(writesTo(harness.gateway, 'purchaseArrival').filter((item) => item.op === 'create').length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// □ 边界：不是采购申请单的话题 / 开关 / 配置
// ═══════════════════════════════════════════════════════════════════════════

test('边界①：采购**退货**单的话题不走到货核对（否则会给退货批次建一条「采购到货」）', async () => {
  const harness = makeHarness({ responses: [{ complete: true, same: true, differences: [] }] });
  const result = await harness.service.handleTopicMessage({
    batch: defaultBatch({ batch_kind: ARRIVAL_BATCH_KINDS.PURCHASE_RETURN }),
    text: '都到了，完毕', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });

  assert.equal(result.handled, false);
  assert.equal(result.reason, 'batch_kind_not_purchase_request');
  assert.equal(harness.gateway.writes.length, 0);
  assert.equal(await harness.store.get(taskIdForBatch(BATCH_NO)), null, '退货话题连会话记录都不该建');
});

test('边界②：读不到采购申请明细 → 不猜、不写、不回话（日志是排查入口）', async () => {
  const harness = makeHarness({ responses: [{ complete: true, same: true, differences: [] }] });
  const result = await harness.service.handleTopicMessage({
    batch: defaultBatch({ request_ids: [] }), text: '都到了，完毕', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });

  assert.equal(result.reason, 'no_request_ids');
  assert.equal(harness.gateway.writes.length, 0);
  assert.deepEqual(harness.replied, []);
});

test('边界③：模型调用失败 → 不入库、不回错误刷屏（她再说一遍还会走同一条路）', async () => {
  const harness = makeHarness({ responses: [new Error('模型超时')] });
  const result = await harness.service.handleTopicMessage({
    batch: defaultBatch(), text: '38 码少一双，完毕', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });

  assert.equal(result.reason, 'parse_failed');
  assert.equal(harness.gateway.writes.length, 0);
  assert.equal(harness.cards.length, 0);
});

test('边界④：已经入过库之后她又说话 → 明确告诉她处理过了，且一个字都不写', async () => {
  const harness = makeHarness({
    responses: [
      { complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] },
      { complete: true, same: true, differences: [] },
    ],
  });
  await confirmCard(harness);
  harness.gateway.writes.length = 0;

  const after = await harness.service.handleTopicMessage({
    batch: defaultBatch(), text: '再补两双', messageId: 'om_9', threadId: 'omt_1', senderOpenId: 'ou_1',
  });

  assert.equal(after.reason, 'already_posted');
  assert.deepEqual(harness.gateway.writes, []);
  assert.match(harness.replied.at(-1).content, /已经入过库/);
});

// ── 配置（配置先行）────────────────────────────────────────────────────────

test('配置：开关是**显式布尔**（清空变量不等于打开，也不等于关掉默认值）', () => {
  assert.equal(parseExplicitBoolean('false', true), false);
  assert.equal(parseExplicitBoolean('FALSE', true), false);
  assert.equal(parseExplicitBoolean('0', true), false);
  assert.equal(parseExplicitBoolean('true', false), true);
  assert.equal(parseExplicitBoolean('', true), true, '空字符串 = 没配，回落默认值');
  assert.equal(parseExplicitBoolean(undefined, false), false);
  assert.throws(() => parseExplicitBoolean('maybe', true), /必须是 true\/false/);
});

test('配置：关掉开关 → 话题消息一个字都不处理（也不写会话记录）', async () => {
  const harness = makeHarness({ responses: [{ complete: true, same: true, differences: [] }], config: { enabled: false } });
  const result = await harness.service.handleTopicMessage({
    batch: defaultBatch(), text: '都到了，完毕', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });

  assert.equal(result.reason, 'disabled');
  assert.equal(harness.gateway.writes.length, 0);
  assert.equal(harness.recognizer.calls.length, 0, '关掉之后连模型都不调');
});

test('配置：卡片文案与回复文案都来自配置（改文案不碰逻辑）', async () => {
  const harness = makeHarness({
    responses: [{ complete: true, same: true, differences: [] }],
    config: { card: { title: '自定义标题', confirmLabel: 'YES', rejectLabel: 'NO' }, replies: { rejected: '自定义否' } },
  });
  await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '都到了', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1' });
  assert.equal(harness.cards[0].card.header.title.content, '自定义标题');
  assert.deepEqual(cardButtons(harness.cards[0].card).map((item) => item.label), ['YES', 'NO']);
});

// ═══════════════════════════════════════════════════════════════════════════
// □ 接线：群准入（话题免 @）与卡片动作分派
// ═══════════════════════════════════════════════════════════════════════════

const makeLarkService = async ({ arrivalConversation, mapping = {} } = {}) => {
  const locator = new PurchaseBatchLocator({
    store: new JsonTaskStore({ dir: tempDir('arrival-conv-locator-'), idField: 'task_id' }),
  });
  if (!mapping.skip) {
    await locator.rememberGroupMessage({
      batchNo: BATCH_NO,
      messageId: 'om_purchase_1',
      threadId: 'omt_thread_1',
      chatId: 'oc_test_group',
      requestIds: ['req_38', 'req_39'],
      kind: ARRIVAL_BATCH_KINDS.PURCHASE_REQUEST,
      ...mapping,
    });
  }
  const service = new LarkMvpService({
    client: {},
    gateway: {},
    references: {},
    recognizer: {},
    store: new JsonTaskStore({ dir: tempDir('arrival-conv-lark-'), idField: 'task_id' }),
    purchaseBatchLocator: locator,
    // 销售那侧的「话题 ↔ 销售记录」映射也指向临时目录：这里的话题是**采购**话题，
    // 销售定位必须一条都命中不到，才能原样落到采购链路上。
    salesGroupThreads: new SalesGroupThreadLocator({
      store: new JsonTaskStore({ dir: tempDir('arrival-conv-sales-thread-'), idField: 'task_id' }),
    }),
    botOpenId: 'ou_bot',
    arrivalConversation,
  });
  service.acknowledgeMessage = async () => undefined;
  return service;
};

const groupTopicEvent = (overrides = {}) => ({
  sender: { sender_id: { open_id: 'ou_1' } },
  message: {
    message_id: overrides.messageId || 'om_topic_1',
    chat_id: 'oc_test_group',
    chat_type: 'group',
    message_type: 'text',
    content: JSON.stringify({ text: overrides.text || '38 码少一双，完毕' }),
    // 话题里没 @ 机器人（真机实测就是这种形状）。
    mentions: overrides.mentions || [],
    thread_id: overrides.threadId === undefined ? 'omt_thread_1' : overrides.threadId,
    parent_id: overrides.parentId,
  },
});

test('接线①：话题里的消息（thread_id 有值）**不 @ 机器人**也走到货核对', async () => {
  const seen = [];
  const service = await makeLarkService({
    arrivalConversation: {
      handleTopicMessage: async (input) => { seen.push(input); return { handled: true }; },
    },
  });

  const result = await service.acceptMessage(groupTopicEvent());

  assert.equal(result.accepted, true, '话题里的消息不该因为没 @ 被丢掉（准入先判 thread_id）');
  assert.equal(seen.length, 1, '定位到批次之后要交给到货核对');
  assert.equal(seen[0].text, '38 码少一双，完毕');
  assert.equal(seen[0].batch.batch_no, BATCH_NO);
  assert.deepEqual(seen[0].batch.request_ids, ['req_38', 'req_39'], '到货核对要能拿到这批的采购申请明细');
  assert.equal(seen[0].threadId, 'omt_thread_1');
});

test('接线②：主群里没 @ 机器人的消息**一条都不处理**（到货核对也不该被触发）', async () => {
  const seen = [];
  const service = await makeLarkService({
    arrivalConversation: { handleTopicMessage: async (input) => { seen.push(input); return { handled: true }; } },
  });

  const result = await service.acceptMessage(groupTopicEvent({ threadId: '', text: '38 码少一双' }));

  assert.equal(result.accepted, false);
  assert.equal(seen.length, 0);
});

test('接线③：卡片上的「是 / 否」被分派到到货核对（不会被当成销售草稿）', async () => {
  const calls = [];
  const service = await makeLarkService({
    arrivalConversation: {
      handleCardAction: async (value, event, operatorOpenId) => {
        calls.push({ value, operatorOpenId });
        return { toast: { type: 'success', content: 'ok' } };
      },
    },
  });
  // ⚠️ 这里用的是**飞书卡片回调的真实形状**：动作取值在 `event.action.value`，
  //    操作人在 `event.operator.operator_id.open_id`，被点的卡片在 `event.context.open_message_id`。
  const cardEvent = (value) => ({
    operator: { operator_id: { open_id: 'ou_1' } },
    action: { tag: 'button', value },
    context: { open_message_id: 'om_card_1' },
  });

  const confirm = await service.handleCardAction(cardEvent({ action: ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, draft_id: 't1' }));
  const reject = await service.handleCardAction(cardEvent({ action: ARRIVAL_CONVERSATION_ACTIONS.REJECT, draft_id: 't1' }));
  // 「是」的卡片取值里**没有** draft_id 时也必须能路由到这里（不能掉进销售那套
  // "卡片缺少草稿 ID" 的逻辑）——这正是这两个动作名要单独分派的原因。
  const noDraft = await service.handleCardAction(cardEvent({ action: ARRIVAL_CONVERSATION_ACTIONS.CONFIRM }));

  assert.equal(confirm.toast.content, 'ok');
  assert.equal(reject.toast.content, 'ok');
  assert.equal(noDraft.toast.content, 'ok');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].operatorOpenId, 'ou_1');
  assert.equal(calls[0].value.draft_id, 't1');
});

test('接线④：别的卡片动作不会被到货核对抢走（照旧走采购/销售那套分派）', async () => {
  let arrivalCalled = 0;
  const service = await makeLarkService({
    arrivalConversation: { handleCardAction: async () => { arrivalCalled += 1; return null; } },
  });

  await assert.rejects(
    () => service.handleCardAction({
      operator: { operator_id: { open_id: 'ou_1' } },
      action: { tag: 'button', value: { action: 'confirm_purchase_request', draft_id: 'not_a_real_task' } },
      context: { open_message_id: 'om_card_1' },
    }),
    /草稿/,
  );
  assert.equal(arrivalCalled, 0);
});

