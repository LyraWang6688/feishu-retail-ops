/**
 * 「采购到货：群话题对话式核对」的验收测试。
 *
 * 这个文件里的每一条用例都对应**业务负责人 2026-10-06 逐字定的验收标准**
 * （见 docs/arrival-conversation-acceptance-2026-10-06.md），标题里标出来：
 *   □ 核对期间：只记录，一张业务表都不写
 *   □ 话题里免 @
 *   □ 三类差异（完全一样 / 比申请多 / 比申请少）都能解析对
 *   □ 说「完毕」→ 发卡片，卡片上有「是」和「否」
 *   □ 点「是」→ 到货信息写到**「报货批次」那一行**（验收原话 / 确认状态；到货状态=已到货）
 *     ⭐ 2026-10-07 晚：落点从**已被业务负责人删除**的「到货验收」表搬到「报货批次」；
 *       「到货日」「验收人」在真表上是**飞书自动字段**（更新时间 / 创建人），代码一个字都不写。
 *   □ 点「是」→「采购入库」按实际数、「库存流水」/「实时库存」跟着变
 *   □ 「单据信息」（采购申请表）一个字都没变 —— **断言钉住，不是文档里说说**
 *   □ 重复点「是」→ 幂等
 *   □ 点「否」→ 零写入 + 一句话
 *   □ ⭐「某尺码实际到 0 双」是**正常情况**（2026-10-07 她纠正）：那行不入库、不阻断整单
 *   □ 「真对不上明细」与「算出来是负数」各自有自己的提示，**不与 0 双混为一谈**
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
  resolveArrivalConversationConfig,
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
  // ⭐ 2026-10-07 晚：到货信息的落点就是**这一行** —— 到货状态 / 验收原话 / 确认状态都写它。
  purchaseOrderBatch: [{ record_id: BATCH_RECORD_ID, fields: { 报货批次号: BATCH_NO, 到货状态: '未到货' } }],
  product: [
    { record_id: PRODUCT_1, fields: { 货号: 'XHB8095', 颜色: '黑' } },
    { record_id: PRODUCT_2, fields: { 货号: 'XHB8096', 颜色: '棕' } },
  ],
  purchaseRequest: [
    { record_id: 'req_38', fields: { 报货批次号: [BATCH_RECORD_ID], 编号: [PRODUCT_1], 尺码: sizeLink(38), 数量: 2 } },
    { record_id: 'req_39', fields: { 报货批次号: [BATCH_RECORD_ID], 编号: [PRODUCT_1], 尺码: sizeLink(39), 数量: 2 } },
  ],
  purchaseInbound: [],
  // ⚠️ 这里**故意没有** `purchaseArrival`：那张表已被业务负责人整个删除，代码里也没有这个表键。
  //    真写了会在记录型 gateway 上抛「未配置语义字段」（这正是守门测试想要的效果）。
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
    // ⭐ 2026-10-07 晚：到货状态的落点也是「报货批次」那一行（改成「已到货」），
    //    与生产接线一致（`larkMvpService` 就是这么注入的）。
    markBatchArrived: (batchNo, options) => webhook.orderBatches.markArrived(batchNo, options),
    // ⭐ ④ 两个端口都记下第三个参数 `options`：里面带着 threadId，
    //    由**飞书发送适配器**决定要不要 `reply_in_thread`（见 larkMvpService.replyPurchaseText）。
    replyText: async (messageId, content, options) => { replied.push({ messageId, content, options }); return 'om_reply'; },
    replyCard: async (messageId, card, options) => { cards.push({ messageId, card, options }); return `om_card_${cards.length}`; },
    updateCard: async (messageId, card) => { updated.push({ messageId, card }); return true; },
    config,
  });
  return { gateway, inventory, store, webhook, recognizer, replied, cards, updated, service, records };
};

const writesTo = (gateway, tableKey) => gateway.writes.filter((item) => item.tableKey === tableKey);

/** 「报货批次」那一行当前的样子（到货信息的落点）。 */
const batchFields = (records) =>
  (records.purchaseOrderBatch || []).find((item) => item.record_id === BATCH_RECORD_ID)?.fields || {};

/** 卡片上的按钮（column_set → column → button）：返回 [{label, action}]。 */
const cardButtons = (card) => (card.elements || [])
  .filter((element) => element.tag === 'column_set')
  .flatMap((element) => element.columns || [])
  .flatMap((column) => column.elements || [])
  .filter((element) => element.tag === 'button')
  .map((button) => ({ label: button.text.content, action: button.value.action }));

/**
 * 结构化日志的出口就是 console.log/warn/error（src/utils/logger.js）。
 * 捕获它们才能断言"哪些行没入库"这类**正向证据**（沿用 purchaseWebhookService.test.js 的范式）。
 * ⚠️ 用完必须 restore()（放在 finally 里）。
 */
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

// ═══════════════════════════════════════════════════════════════════════════
// □ ⭐ 收到到货反馈就直接处理（2026-10-07 起，不再要求她说「核对完毕」）
// ═══════════════════════════════════════════════════════════════════════════

test('直接处理①：一句话说清到货（**没说**「核对完毕」）→ 照样出卡片', async () => {
  // 模型判断她"还没说完"（complete=false）—— 这正是改动前的拦路虎：
  // 以前就是在这里 return，只记一条 collecting、卡片一张都不发。
  const harness = makeHarness({
    responses: [{ complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] }],
  });

  const result = await harness.service.handleTopicMessage({
    batch: defaultBatch(), text: '38 码少了一双', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });

  assert.equal(result.handled, true);
  assert.equal(result.card, true, '她说清了到货情况 → 直接出卡片，不等「核对完毕」');
  assert.equal(harness.cards.length, 1);
  // 卡片按她说的算：申请 2 双 − 少 1 双 = 实际 1 双。
  assert.match(JSON.stringify(harness.cards[0].card), /实际 1 双/);
  const task = await harness.store.get(taskIdForBatch(BATCH_NO));
  assert.equal(task.status, 'awaiting_confirmation');
  assert.deepEqual(task.plan.map((row) => [row.size, row.quantity, row.actual]), [[38, 2, 1], [39, 2, 2]]);
  // 出卡片本身不是业务表写入（入库仍要等她点「是」）。
  assert.equal(harness.gateway.writes.length, 0);
});

test('直接处理②：说「都到了」（same=true）也是一句到货反馈 → 直接出卡片', async () => {
  const harness = makeHarness({ responses: [{ complete: false, same: true, differences: [] }] });

  const result = await harness.service.handleTopicMessage({
    batch: defaultBatch(), text: '都到了', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });

  assert.equal(result.card, true);
  assert.equal(harness.cards.length, 1);
  const task = await harness.store.get(taskIdForBatch(BATCH_NO));
  assert.deepEqual(task.plan.map((row) => [row.size, row.actual]), [[38, 2], [39, 2]]);
  assert.equal(harness.gateway.writes.length, 0);
});

test('直接处理③ ⚠️：这句话里**没有**到货信息 → 一张卡片都不发（绝不能当成"全部到货"）', async () => {
  // 这是去掉闸门之后最危险的那个坑：没有内容时若当成"都到了"，
  // 她一点「是」就会按**申请数整单入库** —— 那正是"写错账"。
  for (const response of [
    { complete: false, same: false, differences: [] }, // 半句话 / 话题里的闲聊
    { complete: true, same: false, differences: [] },  // 她说完了，但什么差异都没给
  ]) {
    const harness = makeHarness({ responses: [response] });
    const result = await harness.service.handleTopicMessage({
      batch: defaultBatch(), text: '你好', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
    });

    assert.equal(result.reason, 'no_arrival_content', `complete=${response.complete} 时也不许发卡片`);
    assert.equal(harness.cards.length, 0, '没有到货内容就不许发卡片');
    assert.equal(harness.updated.length, 0, '也不许去更新一张不存在的卡片');
    assert.equal(harness.gateway.writes.length, 0, '也不许写任何业务表');
    const task = await harness.store.get(taskIdForBatch(BATCH_NO));
    assert.ok(!task.plan, '不许替她算出一份"全部到货"的计划');
    assert.equal(task.status, 'collecting');
  }
});

test('直接处理④：没有到货内容时 —— 她说完了就回一句教她怎么说，还在说就静默', async () => {
  const done = makeHarness({ responses: [{ complete: true, same: false, differences: [] }] });
  await done.service.handleTopicMessage({
    batch: defaultBatch(), text: '你好', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });
  assert.equal(done.replied.length, 1, '她说完了却什么都没给出 → 回一句（否则她以为机器人没反应）');
  assert.match(done.replied[0].content, /没听出到货的变化/);
  assert.equal(done.replied[0].options.threadId, 'omt_1');

  const mid = makeHarness({ responses: [{ complete: false, same: false, differences: [] }] });
  await mid.service.handleTopicMessage({
    batch: defaultBatch(), text: '你好', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });
  assert.deepEqual(mid.replied, [], '她还在说 / 就是闲聊 → 静默，避免刷屏');
});

test('直接处理⑤：分多次说 —— 每次只说一部分，模型看到的是**累积的原话**', async () => {
  const harness = makeHarness({
    responses: [
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 2 }] },
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 39, type: 'more', quantity: 1 }] },
    ],
  });
  await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '38 码少了两双', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1' });
  await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '39 码多一双', messageId: 'om_2', threadId: 'omt_1', senderOpenId: 'ou_1' });

  // 第二次调用时模型必须同时看到两句话（"可以一次说完，也可以分多次说完"）。
  assert.deepEqual(harness.recognizer.calls[1].messages, ['38 码少了两双', '39 码多一双']);
  // 模型也要看到这批采购申请的明细（货号/颜色/尺码/申请数），否则对不上具体行。
  assert.deepEqual(harness.recognizer.calls[0].rows, [
    { item_no: 'XHB8095', color: '黑', size: 38, quantity: 2 },
    { item_no: 'XHB8095', color: '黑', size: 39, quantity: 2 },
  ]);
  assert.equal(harness.gateway.writes.length, 0);
});

test('直接处理⑥：同一条消息被飞书重投 —— 只记一次，不重复喂模型，也不重复出卡片', async () => {
  const harness = makeHarness({
    responses: [
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] },
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] },
    ],
  });
  await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '38 码少了一双', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1' });
  const twice = await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '38 码少了一双', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1' });

  assert.equal(twice.reason, 'duplicate_message');
  assert.equal(harness.recognizer.calls.length, 1, '重复投递不该再调一次模型');
  assert.equal(harness.cards.length, 1);
  assert.equal(harness.updated.length, 0);
  assert.equal(harness.gateway.writes.length, 0);
  const task = await harness.store.get(taskIdForBatch(BATCH_NO));
  assert.equal(task.transcript.length, 1, '同一句话只记一次');
});

// ═══════════════════════════════════════════════════════════════════════════
// □ ⭐ 追加 / 修正反馈：**重算并更新那一张卡**，不发第二张、不重复建记录
// ═══════════════════════════════════════════════════════════════════════════

test('追加①：已经有待确认的卡片，她又补一句（没说「核对完毕」）→ 重算并更新**那一张**', async () => {
  const harness = makeHarness({
    responses: [
      // 第一句：38 码少一双 → 出一张卡（实际 1 双）。
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] },
      // 第二句：再补 39 码也多一双 → 重算（38 实际 1、39 实际 3），更新同一张卡。
      { complete: false, same: false, differences: [
        { item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 },
        { item_no: 'XHB8095', color: '黑', size: 39, type: 'more', quantity: 1 },
      ] },
    ],
  });
  const taskId = taskIdForBatch(BATCH_NO);

  await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '38 码少一双', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1' });
  const firstCardId = (await harness.store.get(taskId)).card_message_id;
  assert.equal(harness.cards.length, 1);

  const second = await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '还有 39 码多一双', messageId: 'om_2', threadId: 'omt_1', senderOpenId: 'ou_1' });

  // ① 发新卡 = 0 次；更新 = 1 次，而且更新的就是**第一张**那张。
  assert.equal(harness.cards.length, 1, '🔴 不许再发第二张卡片');
  assert.equal(harness.updated.length, 1, '要更新那张已经存在的卡片');
  assert.equal(harness.updated[0].messageId, firstCardId);
  assert.equal(second.card, true);
  assert.equal(second.card_updated, true);
  // ② 卡片上是**重算后的**数字（38 实际 1 双、39 实际 3 双）。
  assert.match(JSON.stringify(harness.updated[0].card), /实际 1 双/);
  assert.match(JSON.stringify(harness.updated[0].card), /实际 3 双/);
  // ③ 不重复建记录：还是同一条任务，卡片 id 不变，plan 覆盖成最新。
  const task = await harness.store.get(taskId);
  assert.equal(task.card_message_id, firstCardId, '卡片 id 不变（就是更新那一张）');
  assert.deepEqual(task.plan.map((row) => [row.size, row.actual]), [[38, 1], [39, 3]]);
  assert.deepEqual(task.transcript.map((item) => item.text), ['38 码少一双', '还有 39 码多一双']);
  assert.equal(task.acceptance_text, '38 码少一双\n还有 39 码多一双', '「验收原话」是累积的全部原话');
  // ④ 回一句让她知道卡片已经变了（文案可配）。
  assert.match(harness.replied.at(-1).content, /上面那张卡片已经更新/);
  // ⑤ 全程零业务表写入（入库仍要等她点「是」）。
  assert.equal(harness.gateway.writes.length, 0);
});

test('追加② ⚠️：她点**旧卡**也按最新计划入库（plan 存在任务里，两张卡指向同一个 taskId）', async () => {
  const harness = makeHarness({
    responses: [
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] },
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 2 }] },
    ],
  });
  const taskId = taskIdForBatch(BATCH_NO);
  await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '38 码少一双', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1' });
  await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '不对，是少两双', messageId: 'om_2', threadId: 'omt_1', senderOpenId: 'ou_1' });

  // 她点的是**第一张卡**那条消息（`om_card_1`），但入库必须按最新的计划（38 实际 0 双）。
  await harness.service.handleCardAction(
    { action: ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, draft_id: taskId },
    { context: { open_message_id: 'om_card_1' } }, 'ou_1',
  );

  const inbounds = writesTo(harness.gateway, 'purchaseInbound').filter((item) => item.op === 'create');
  // 最新计划：38 码申请 2 − 少 2 = 0 双（0 双不入库）；39 码没提差异 = 申请 2 双。
  assert.equal(inbounds.length, 1, '只有 39 码那一行入库（38 码最新算出来是 0 双）');
  assert.deepEqual(inbounds[0].values.尺码, sizeLink(39));
  assert.equal(inbounds[0].values['数量'], 2);
});

test('追加③：更新卡片失败 → 记 warn 并**补发一张新卡**（她不能卡在过期数字上）', async () => {
  const harness = makeHarness({
    responses: [
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] },
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 2 }] },
    ],
  });
  const logs = captureLogs();
  try {
    await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '38 码少一双', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1' });
    const firstCardId = (await harness.store.get(taskIdForBatch(BATCH_NO))).card_message_id;
    // 卡片改不动（权限 / 撤回 / 网络）。
    harness.service.updateCard = async () => false;

    const second = await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '不对，是少两双', messageId: 'om_2', threadId: 'omt_1', senderOpenId: 'ou_1' });

    assert.equal(second.card, true);
    assert.equal(second.card_updated, false);
    assert.equal(harness.cards.length, 2, '更新失败 → 补发一张新卡（这是唯一的出口）');
    assert.equal(logs.events('purchase.arrival.reconcile.card_update_failed').length, 1);
    assert.equal(logs.events('purchase.arrival.reconcile.card_update_fallback_sent').length, 1);
    const task = await harness.store.get(taskIdForBatch(BATCH_NO));
    assert.notEqual(task.card_message_id, firstCardId, '任务上记的是**最新那张**卡');
    assert.equal(task.card_message_id, 'om_card_2', 'replyCard 返回的新 id（第 2 张）');
    // 旧卡仍然指向同一个 taskId —— 点它也是按最新计划入库（不会写错账）。
    assert.match(logs.events('purchase.arrival.reconcile.card_update_fallback_sent')[0], /按最新计划入库/);
  } finally {
    logs.restore();
  }
});

test('追加④：点「否」之后又补一句 → 还是更新**那张卡**，不再发第二张', async () => {
  const harness = makeHarness({
    responses: [
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] },
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 2 }] },
    ],
  });
  const taskId = taskIdForBatch(BATCH_NO);
  await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '38 码少一双', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1' });
  await harness.service.handleCardAction(
    { action: ARRIVAL_CONVERSATION_ACTIONS.REJECT, draft_id: taskId },
    { context: { open_message_id: 'om_card_1' } }, 'ou_1',
  );
  assert.equal((await harness.store.get(taskId)).status, 'rejected');

  await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '算了，是少两双', messageId: 'om_2', threadId: 'omt_1', senderOpenId: 'ou_1' });

  assert.equal(harness.cards.length, 1, '「否」之后补一句也不许发第二张卡');
  assert.equal(harness.updated.length, 1);
  assert.equal((await harness.store.get(taskId)).status, 'awaiting_confirmation');
});

test('追加⑤：源码级断言 —— `complete` 那道提前 return 与 collecting 日志**都不许再回来**', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/purchaseArrivalConversationService.js'), 'utf8');
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
  // ⚠️ 只查代码、不查注释：上面那段注释里**故意**写着"原来那条 collecting 已经删掉"，
  //    那是给人看的历史说明，不是还在发的事件。
  assert.equal(/reconcile\.collecting/.test(codeOnly), false, 'collecting 那条日志已经删掉，不许加回来');
  assert.equal(/if \(!parsed\.complete\)/.test(codeOnly), false,
    '`complete === false` 不许再作为提前 return 的闸门');
  // 判据必须是**内容**（差异条数 / same），不是 `complete`。
  assert.match(codeOnly, /hasArrivalContent/, '判据要落在"这句话里有没有到货内容"上');
  assert.equal(/differences\.length > 0 \|\| parsed\.same === true/.test(codeOnly), true,
    '判据逐字：有差异 或 她说了"都一样"');
  // 关键词闸门也不许有。
  for (const word of ['完毕', '核对完了', '说完了吗']) {
    assert.equal(new RegExp(word).test(codeOnly), false, `代码里不许出现关键词闸门「${word}」`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// □ ⭐ 文案（配置先行）：不再有"等她说完了 / 在收集"的话术
// ═══════════════════════════════════════════════════════════════════════════

test('文案①：配置里不再有「先说我核对完了」这类话术，且新文案可覆盖', () => {
  const config = resolveArrivalConversationConfig({ env: {} });
  // 那句让"先说完"的口令已经废掉：`notConfirmedYet` 只说明"我还没算出来"。
  assert.doesNotMatch(config.replies.notConfirmedYet, /核对完了|完毕/);
  assert.match(config.replies.notConfirmedYet, /还没算出/);
  // 新增的两句都在配置里（改文案不碰逻辑）。
  assert.match(config.replies.noArrivalContent, /没听出到货的变化/);
  assert.match(config.replies.updatedCard, /上面那张卡片已经更新/);
  // 覆盖生效。
  const overridden = resolveArrivalConversationConfig({
    env: {},
    replies: { noArrivalContent: '自定义-没内容', updatedCard: '' },
  });
  assert.equal(overridden.replies.noArrivalContent, '自定义-没内容');
  assert.equal(overridden.replies.updatedCard, '', '置空 = 不回那句（卡片本身会原地刷新）');
});

test('文案②：卡片更新后那句回话也走配置（置空就不回，但卡片照样更新）', async () => {
  const harness = makeHarness({
    responses: [
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] },
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 2 }] },
    ],
    config: { replies: { updatedCard: '' } },
  });
  await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '38 码少一双', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1' });
  harness.replied.length = 0;
  await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '不对，是少两双', messageId: 'om_2', threadId: 'omt_1', senderOpenId: 'ou_1' });

  assert.equal(harness.replied.length, 0, '配置置空 = 不回这句');
  assert.equal(harness.updated.length, 1, '但卡片照样更新');
});

test('文案③：没有到货内容时那句回话也走配置', async () => {
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [] }],
    config: { replies: { noArrivalContent: '自定义-教她怎么说' } },
  });
  await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '你好', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1' });
  assert.equal(harness.replied.length, 1);
  assert.equal(harness.replied[0].content, '自定义-教她怎么说');
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
  // ⭐ ④ 文字回复同样把 threadId 交给适配器 → 回到她说话的那个话题。
  assert.equal(harness.replied[0].options.threadId, 'omt_1');
});

test('三类差异⑤：**算出来是负数** → 不入库、不发卡片，回一句让她重说（不放行、也不静默当 0）', async () => {
  // 她说"少 5 双"，而这一行只申请了 2 双 ⇒ 实际 = −3。这不是"她没对上行"，
  // 而是**数字对不上**（口误/听错）：既不放行、也不夹成 0（夹成 0 = 替她编一行"没到"），
  // 回一句**明确说算出来是负数**的话让她重说 —— 与「实际 0 双」（正常、放行）分开。
  // ⚠️ 2026-10-07 的口径只放宽了 `实际 = 0`；负数这条闸门**一个字没动**（reason 取值也没改）。
  const logs = captureLogs();
  try {
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
    // 回话是"负数"那句，**不是**"对不上明细"那句（货号/尺码其实对上了）。
    assert.equal(harness.replied.length, 1);
    assert.match(harness.replied[0].content, /负数/);
    assert.equal(harness.replied[0].content.includes('对不上这批采购申请的明细'), false);
    // 两个"不算数"的日志事件分开：负数走 plan_negative，真 unmatched 走 plan_unmatched。
    assert.equal(logs.events('purchase.arrival.reconcile.plan_negative').length, 1);
    assert.equal(logs.events('purchase.arrival.reconcile.plan_unmatched').length, 0);
    // 也不该留下"0 双放行"的痕迹（这一步根本没算到卡片）。
    assert.equal(logs.events('purchase.arrival.reconcile.plan_zero_actual').length, 0);
  } finally {
    logs.restore();
  }
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
  // ⭐ ④ 同时把 `threadId` 交给发送适配器 —— 由它带 `reply_in_thread` 真正回到**那个话题**
  //    （采购单/图是发群的，后续对话不带上它就会落回主群）。
  assert.equal(harness.cards[0].options.threadId, 'omt_1');
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

test('模型说「她还没说完」（complete=false）**也要出卡片** —— 判据是内容，不是那句口令', async () => {
  const harness = makeHarness({ responses: [{ complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] }] });
  // 这句原话里**没有**"完毕"两个字，模型也答了 complete=false。
  // ⭐ 2026-10-07 起：只要这句话里有可核对的到货内容（这里有一条差异），就**直接处理**。
  //    代码里既没有"完毕"这类关键词闸门，也没有 `complete` 闸门。
  const result = await harness.service.handleTopicMessage({
    batch: defaultBatch(), text: '38 码少一双', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });
  assert.equal(harness.cards.length, 1, 'complete=false 不再是"不发卡片"的理由');
  assert.equal(result.card, true);
  // 写进任务里的 `last_parse.complete` 如实记下模型的判断（诊断用），不被改写。
  const task = await harness.store.get(taskIdForBatch(BATCH_NO));
  assert.equal(task.last_parse.complete, false);
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

test('点「是」① ⭐：「验收原话」「确认状态」写到**「报货批次」那一行**（不再建「到货验收」行）', async () => {
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] }],
  });
  await confirmCard(harness, '38 码少一双\n完毕');

  // ⭐ 到货信息的落点 = 「报货批次」那一行（业务负责人 2026-10-07 晚：「写入的点变到了报货批次里面」）。
  const fields = batchFields(harness.records);
  assert.equal(fields['验收原话'], '38 码少一双\n完毕', '用户说的原话归集进「验收原话」');
  assert.equal(fields['确认状态'], '已确认', '入库成功之后「确认状态」= 已确认（取值来自 config）');
  assert.equal(fields['到货状态'], '已到货', '到货状态照旧（这一条本来就有，别重复写歪）');

  // 🔴 不再有任何「到货验收」的写入 —— 那张表已被她整个删除。
  //    真写了会在记录型 gateway 上抛「未配置语义字段: purchaseArrival.*」（本用例会当场红）。
  assert.equal(harness.gateway.writes.some((item) => item.tableKey === 'purchaseArrival'), false,
    '不许再写「到货验收」这张表（表都不存在了）');

  // 🔴 两个飞书**自动字段**代码一个字都不许写：
  //    「到货日」= 更新时间（type 1002）、「验收人」= 创建人（type 1003）。
  const batchWrites = writesTo(harness.gateway, 'purchaseOrderBatch');
  for (const write of batchWrites) {
    assert.equal('到货日' in write.values, false, '代码一个字都不许写「到货日」');
    assert.equal('验收人' in write.values, false, '代码一个字都不许写「验收人」');
    assert.equal(JSON.stringify(write.values).includes('图片'), false, '「图片」列已随表删除，任何载荷里都不许出现');
  }

  assert.equal(writesTo(harness.gateway, 'purchaseInbound').length, 2, '落点变更不影响入库：该写几行还是几行');
});

test('点「是」①-补：「验收人」现在是飞书自动字段（创建人）—— 代码**没有任何**写入点', async () => {
  // 改动前「验收人」是代码写的（还带一个 UserFieldConvFail 退一步重试的补丁）。
  // 2026-10-07 晚它在真表上是**创建人**（type 1003，自动）⇒ 代码不写、也不建映射：
  // 这一条用源码断言钉住"那个补丁不许回来"（行为断言在 ① 里）。
  const source = fs.readFileSync(path.join(__dirname, '../src/services/purchaseArrivalConversationService.js'), 'utf8');
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
  assert.equal(/inspector/.test(codeOnly), false, '代码里不许再出现 inspector（验收人=创建人，自动字段）');
  assert.equal(/UserFieldConvFail/.test(codeOnly), false, '那个"写不进验收人就退一步"的补丁随之删除，不许回来');
  assert.equal(/person\(/.test(codeOnly), false, '人员字段写入器不许再被这条链路用到');
  assert.equal(/purchaseArrival'/.test(codeOnly), false, '代码里不许再出现 purchaseArrival 这个表键');
});

test('点「是」②：「采购入库」按**实际**数量写入（不是申请数）· 且**不含**「采购到货批次」', async () => {
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
    // ⭐ 2026-10-07 晚：「采购入库.采购到货批次」已被业务负责人**整列删除** ⇒ 一个字都不许再写。
    assert.equal('采购到货批次' in inbound.values, false, '「采购到货批次」列已删 → 不许再写它');
    assert.equal(JSON.stringify(inbound.values).includes('采购到货批次'), false);
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

  // ⭐ 2026-10-07 晚：幂等的落点也换了 —— 批次行**不重复写**（重复点「是」时任务已经是
  //    posted，直接早退，连一次 update 都不会发出去）。
  const batchWritesAfter = writesTo(harness.gateway, 'purchaseOrderBatch').length;
  assert.equal(batchWritesAfter, 3,
    '第一批就三次 update：写「验收原话」→ 写「确认状态」→ 写「到货状态=已到货」；重复点一次都不再写');
  assert.equal(writesTo(harness.gateway, 'purchaseInbound').filter((item) => item.op === 'create').length, 2, '入库行不重复写');
  assert.equal(harness.inventory.calls.length, 2, '库存不重复加');
  assert.equal(batchFields(harness.records)['验收原话'], '38 码少一双，完毕', '批次行上的原话还是那一句');
  assert.equal(batchFields(harness.records)['确认状态'], '已确认');
  assert.match(again.toast.content, /已经入库/);
});

// ═══════════════════════════════════════════════════════════════════════════
// □ ⭐ 点卡片「必须看得见反馈」（业务负责人 2026-10-07 连着两次：
//    「卡片点击后也是没有任何反应」）
//
// 改前的事实（读代码得到）：
//   · 失败 → 一行 error 日志 + 一句**不带 threadId** 的回话 + 一个一闪而过的 toast，
//     **卡片原样不动** ⇒ 她在话题里就是"点了没反应"；
//   · 「采购到货」建行失败 / 任务找不到 / 还没算出计划 → **只 toast**（连回话都没有）；
//   · 重复点「是」 → 只 toast。
// 这组用例把"失败也要在她点的那张卡片上看得见"钉死。
// ═══════════════════════════════════════════════════════════════════════════

/** 卡片终态里那句 note（`purchaseArrivalReconcileStatusCard` 的 message）。 */
const cardNote = (card) => (card.elements || [])
  .filter((element) => element.tag === 'note')
  .flatMap((element) => element.elements || [])
  .map((element) => element.content)
  .join('\n');

const cardHeader = (card) => card.header?.title?.content || '';

test('可见失败① 🔴：点「是」入库抛错 → **那张卡片被 patch 成终态** + 话题里回一句（含错误原文）', async () => {
  // 制造她现场的那个错：行为表里**没有**编码 PURCHASE_IN 的行为 → confirmArrival 抛错。
  const harness = makeHarness({
    records: { ...defaultRecords(), behavior: [] },
    responses: [{ complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] }],
  });
  const logs = captureLogs();
  let result;
  try {
    ({ result } = await confirmCard(harness));
  } finally {
    logs.restore();
  }

  // ① 卡片被改成**红色终态**：就在她点的地方，跑不掉。
  assert.equal(harness.updated.length, 1, '失败也必须 patch 那张卡片（改前这里是 0 —— 所以她"看不到任何反应"）');
  assert.equal(harness.updated[0].messageId, 'om_card_1', 'patch 的是她点的那张卡');
  assert.equal(harness.updated[0].card.header.template, 'red');
  // ⚠️ 2026-10-07 晚**口径/文案变更**：她在生产表把「采购到货」改名「到货验收」，
  //    所以这张卡片的失败标题也跟着改（不是放宽——断言仍然**逐字**，只是字面量换名）。
  assert.equal(cardHeader(harness.updated[0].card), '到货验收核对没成功');
  assert.equal(cardButtons(harness.updated[0].card).length, 0, '终态卡不许再留可点的按钮');
  // ② 同一句回到**本话题**。
  assert.equal(harness.replied.length, 1, '失败要在话题里留一条看得见的文字');
  assert.equal(harness.replied[0].options.threadId, 'omt_1', '回话必须落回她那个话题');
  assert.equal(harness.replied[0].content, cardNote(harness.updated[0].card), '卡片与回话同源（同一句）');
  // ③ **错误原文一个字都不吞**：日志与她要看到的话里都带着它。
  assert.match(harness.replied[0].content, /入库没成功：/);
  assert.match(harness.replied[0].content, /PURCHASE_IN/);
  assert.equal(logs.events('purchase.arrival.reconcile.confirm_failed').length, 1,
    'error 原文仍要留在日志里（既有结构不许破坏）');
  assert.match(logs.events('purchase.arrival.reconcile.confirm_failed')[0], /PURCHASE_IN/);
  // ④ 失败的"可见性"本身也留痕：她到底看没看到，日志里能核。
  const notice = logs.events('purchase.arrival.reconcile.failure_notice');
  assert.equal(notice.length, 1);
  assert.match(notice[0], /"tier":"inbound_failed"/);
  assert.match(notice[0], /"card_patched":true/);
  assert.match(notice[0], /"replied":true/);
  // ⑤ 不许把失败写成成功：toast 仍是 error，任务停在可重试的 posting。
  assert.equal(result.toast.type, 'error');
  assert.equal((await harness.store.get(taskIdForBatch(BATCH_NO))).status, 'posting',
    '停在 posting —— 她再点一次「是」从断点继续');
  assert.equal(writesTo(harness.gateway, 'purchaseInbound').length, 0, '失败时一条入库行都不许写');
});

test('可见失败②：失败文案可配（`replies.inboundFailed`，改文案不碰逻辑）', async () => {
  const harness = makeHarness({
    records: { ...defaultRecords(), behavior: [] },
    responses: [{ complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] }],
    config: { replies: { inboundFailed: '自定义-入库没成功：{error}（再点一次）' } },
  });
  const { result } = await confirmCard(harness);

  assert.match(result.toast.content, /^自定义-入库没成功：/);
  assert.match(harness.replied[0].content, /^自定义-入库没成功：/);
  assert.equal(cardNote(harness.updated[0].card), harness.replied[0].content);
  // `{error}` 占位必须真的被填上（不静默留 `{error}` 给用户看）。
  assert.equal(harness.replied[0].content.includes('{error}'), false);
});

test('可见失败③：到货信息**写不进批次行** → 也 patch 卡片 + 回文字（且一个字都不入库）', async () => {
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] }],
  });
  // 让「报货批次」那次 update 失败（其余 gateway 行为不变）——落点写不进去 = 她这次确认没被记下来。
  const update = harness.gateway.update;
  harness.gateway.update = async (tableKey, recordId, values, options) => {
    if (tableKey === 'purchaseOrderBatch' && values.acceptanceText !== undefined) {
      throw new Error('飞书 500：写「验收原话」失败');
    }
    return update(tableKey, recordId, values, options);
  };

  const { result } = await confirmCard(harness);

  assert.equal(result.toast.type, 'error');
  // ⚠️ 文案走 `replies.inboundFailed`（改动前那个"「到货验收」这一行没建成"的专用文案随表一起删了）。
  assert.match(result.toast.content, /入库没成功：飞书 500：写「验收原话」失败/);
  assert.equal(harness.updated.length, 1, '卡片要改成终态');
  assert.equal(harness.updated[0].card.header.template, 'red');
  assert.match(cardNote(harness.updated[0].card), /飞书 500：写「验收原话」失败/);
  assert.equal(harness.replied.length, 1);
  assert.equal(harness.replied[0].options.threadId, 'omt_1');
  // 🔴 到货信息没有落点 ⇒ **一个字都不入库**（这是"先写到货、再写入库"的顺序保证）。
  assert.equal(writesTo(harness.gateway, 'purchaseInbound').length, 0, '落点失败就不入库');
  assert.equal(harness.inventory.calls.length, 0, '库存也不动');
});

test('可见失败④：卡片指向的任务已经找不到 → patch 卡片 + 回文字（不再静默/只 toast）', async () => {
  const harness = makeHarness({ responses: [] });
  const result = await harness.service.handleCardAction(
    { action: ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, draft_id: taskIdForBatch('BH-20261006-9999') },
    { context: { open_message_id: 'om_card_gone' } }, 'ou_1',
  );

  assert.equal(result.toast.type, 'error');
  assert.match(result.toast.content, /找不到了/);
  assert.equal(harness.updated.length, 1);
  assert.equal(harness.updated[0].messageId, 'om_card_gone');
  assert.equal(cardButtons(harness.updated[0].card).length, 0);
  assert.equal(harness.replied.length, 1);
  assert.match(harness.replied[0].content, /找不到了/);
  assert.deepEqual(harness.gateway.writes, [], '不写任何业务表');
});

test('可见失败⑤：她点了「是」但这边还没算出计划 → patch 卡片 + 回文字（橙色，不是错误）', async () => {
  // 一句"没有到货信息"的话：任务建了、但 plan 是空的（模型没听出到货变化）。
  const harness = makeHarness({ responses: [{ complete: true, same: false, differences: [] }] });
  await harness.service.handleTopicMessage({
    batch: defaultBatch(), text: '嗯嗯', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });
  const taskId = taskIdForBatch(BATCH_NO);
  assert.equal((await harness.store.get(taskId)).plan, undefined, '这个任务本来就还没有 plan');
  harness.replied.length = 0;

  const result = await harness.service.handleCardAction(
    { action: ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, draft_id: taskId },
    { context: { open_message_id: 'om_card_1' } }, 'ou_1',
  );

  assert.equal(result.toast.type, 'info', '这不是错误，只是"还没算出来"');
  assert.match(result.toast.content, /还没算出/);
  assert.equal(harness.updated.length, 1);
  assert.equal(harness.updated[0].card.header.template, 'orange', '中性状态别写成失败红');
  assert.equal(harness.replied.length, 1);
  assert.deepEqual(writesTo(harness.gateway, 'purchaseInbound'), []);
});

test('可见终态⑥：重复点「是」→ 卡片**再 patch 成绿色终态**（幂等，不重复入库、也不刷文字）', async () => {
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] }],
  });
  const { taskId, cardEvent } = await confirmCard(harness);
  // 模拟"上一次成功那一下卡片没改成功"：清掉记录，再看重复点有没有补上。
  harness.updated.length = 0;
  harness.replied.length = 0;

  const again = await harness.service.handleCardAction(
    { action: ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, draft_id: taskId }, cardEvent, 'ou_1',
  );

  assert.equal(again.toast.type, 'info');
  assert.match(again.toast.content, /已经入库/);
  assert.equal(harness.updated.length, 1, '重复点也要把那张卡刷成终态（万一上次没改成）');
  assert.equal(harness.updated[0].card.header.template, 'green');
  assert.equal(cardNote(harness.updated[0].card), again.toast.content);
  assert.deepEqual(harness.replied, [], '只是重复点了一次，不再刷一条文字');
  assert.equal(harness.inventory.calls.length, 2, '库存不重复加');
});

test('可见终态⑦：成功 → 终态卡与回话**都落回本话题**（threadId）', async () => {
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] }],
  });
  await confirmCard(harness);

  assert.equal(harness.updated[0].card.header.template, 'green');
  assert.equal(harness.replied[0].options.threadId, 'omt_1',
    '卡片点击事件里没有 thread_id —— 要用任务上记的那个话题，否则她又"看不到"');
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
  assert.equal(harness.replied[0].options.threadId, 'omt_1', '那句回话要落回她那个话题');
  assert.deepEqual(harness.gateway.writes, [], '点「否」= 一个字都不写');
  assert.equal(harness.inventory.calls.length, 0);
  assert.equal((await harness.store.get(taskId)).status, 'rejected');
  // ⚠️ 点「否」**刻意不动卡片**：那两个按钮要留着 —— 她还能再点「是」
  //    （见下一条用例）。这是既定口径，不许"顺手统一"成终态。
  assert.deepEqual(harness.updated, [], '点「否」不许把卡片改成终态（她要还能改主意）');
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
  assert.equal(batchFields(harness.records)['验收原话'], '38 码少一双，完毕');
  assert.equal(batchFields(harness.records)['确认状态'], '已确认');
});

test('可见终态⑧：已经入库之后又点「否」→ 卡片 patch 成绿色终态（不再只 toast）', async () => {
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] }],
  });
  const { taskId, cardEvent } = await confirmCard(harness);
  harness.updated.length = 0;
  harness.gateway.writes.length = 0;

  const result = await harness.service.handleCardAction(
    { action: ARRIVAL_CONVERSATION_ACTIONS.REJECT, draft_id: taskId }, cardEvent, 'ou_1',
  );

  assert.equal(result.toast.type, 'info');
  assert.match(result.toast.content, /已经入库/);
  assert.equal(harness.updated.length, 1, '已入库就是终态，卡片要看得见');
  assert.equal(harness.updated[0].card.header.template, 'green');
  assert.deepEqual(harness.gateway.writes, [], '不因为她又点了个「否」就改账');
  assert.equal((await harness.store.get(taskId)).status, 'posted');
});

// ═══════════════════════════════════════════════════════════════════════════
// □ ⭐ 2026-10-07：「某尺码实际到 0 双」是正常情况 —— 那行不入库，但不阻断整单
//    （业务负责人原话：「**如果这个尺码算下来为 0，那么就不用入库啊！**」）
//    口径：docs/arrival-zero-arrived-rule-2026-10-07.md
//    验收标准与逐条对照：docs/reports/arrival-zero-actual-2026-10-07.md
// ═══════════════════════════════════════════════════════════════════════════

const PRODUCT_3 = 'prod_3';

// 12 行 = 3 个货品 × 4 个尺码（37–40），**每行申请 1 双** —— 与 2026-10-07 真机现场同形：
// 她说「8230黑色少一双38码 / 93827黑色少39 40码各一双」，那三行申请数都是 1 双 ⇒ 实际 0 双。
const TWELVE_ROWS = [PRODUCT_1, PRODUCT_2, PRODUCT_3].flatMap((productId, productIndex) =>
  [37, 38, 39, 40].map((size) => ({ record_id: `req_${productIndex}_${size}`, productId, size })));

const twelveRowRecords = () => ({
  purchaseOrderBatch: [{ record_id: BATCH_RECORD_ID, fields: { 报货批次号: BATCH_NO, 到货状态: '未到货' } }],
  product: [
    { record_id: PRODUCT_1, fields: { 货号: 'XHB8095', 颜色: '黑' } },
    { record_id: PRODUCT_2, fields: { 货号: 'XHB8096', 颜色: '棕' } },
    { record_id: PRODUCT_3, fields: { 货号: 'XHB8097', 颜色: '白' } },
  ],
  purchaseRequest: TWELVE_ROWS.map((row) => ({
    record_id: row.record_id,
    fields: {
      报货批次号: [BATCH_RECORD_ID], 编号: [row.productId], 尺码: sizeLink(row.size), 数量: 1,
    },
  })),
  purchaseInbound: [],
});

const twelveRowBatch = () => defaultBatch({ request_ids: TWELVE_ROWS.map((row) => row.record_id) });

// 她这次说的三行差异（各少 1 双 ⇒ 实际 0 双）。三个 (货品,尺码) 都唯一，能一一对上。
const zeroActualDifferences = () => [
  { item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 },
  { item_no: 'XHB8096', color: '棕', size: 39, type: 'less', quantity: 1 },
  { item_no: 'XHB8096', color: '棕', size: 40, type: 'less', quantity: 1 },
];

test('0 双①：12 行里 3 行实际 0 双 → 那 3 行一条都不入库、其余 9 行照常，流程走到卡片', async () => {
  const logs = captureLogs();
  try {
    const harness = makeHarness({
      records: twelveRowRecords(),
      responses: [{ complete: true, same: false, differences: zeroActualDifferences() }],
    });

    const result = await harness.service.handleTopicMessage({
      batch: twelveRowBatch(),
      text: '8230黑色少一双38码\n93827黑色少39 40码各一双\n完毕',
      messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
    });

    // ① 0 双不是错误提示：正常出卡片；不回任何文字（更不是"对不上明细"那句）。
    assert.equal(result.card, true, '0 双不许阻断整单：卡照样发');
    assert.equal(harness.cards.length, 1);
    assert.deepEqual(harness.replied, [], '0 双不是错误提示，群里不该出现任何提示语');
    const cardJson = JSON.stringify(harness.cards[0].card);
    assert.equal(cardJson.includes('对不上'), false, '0 双的情况**不再**出现「对不上明细」那句');
    // ② 卡片如实：申请 1 双 → 实际 0 双，且看得出来是"这双没到"。
    assert.equal((cardJson.match(/申请 1 双 → 实际 0 双/g) || []).length, 3, '正好 3 行 0 双');
    assert.match(cardJson, /这双没到/, '0 的行要看得出来是"这双没到"');
    assert.match(cardJson, /不入库/, '卡片要说清这些行不入库');
    // 发卡片本身仍然不是业务表写入。
    assert.equal(harness.gateway.writes.length, 0);

    const taskId = taskIdForBatch(BATCH_NO);
    const task = await harness.store.get(taskId);
    assert.equal(task.plan.length, 12, '12 行都在计划里（含那 3 行 0 双）');
    assert.deepEqual(
      task.plan.filter((row) => row.actual === 0).map((row) => [row.product_record_id, row.size]),
      [[PRODUCT_1, 38], [PRODUCT_2, 39], [PRODUCT_2, 40]],
    );
    // ③ 日志：计划阶段就记下"哪几行是 0 双"（可排查）。
    const zeroPlanLog = logs.events('purchase.arrival.reconcile.plan_zero_actual');
    assert.equal(zeroPlanLog.length, 1);
    assert.match(zeroPlanLog[0], /"zero_actual_count":3/);
    assert.match(logs.events('purchase.arrival.reconcile.card_sent')[0], /"zero_actual_count":3/);

    // ④ 点「是」→ **只有 9 行入库**：3 行 0 双不写「采购入库」、不调库存。
    logs.lines.length = 0;
    const confirmed = await harness.service.handleCardAction(
      { action: ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, draft_id: taskId },
      { context: { open_message_id: 'om_card_1' } }, 'ou_1',
    );

    const inbounds = writesTo(harness.gateway, 'purchaseInbound').filter((item) => item.op === 'create');
    assert.equal(inbounds.length, 9, '12 行里只有 9 行写「采购入库」（0 双的 3 行一条都不写）');
    const zeroKeys = new Set([`${PRODUCT_1}|38`, `${PRODUCT_2}|39`, `${PRODUCT_2}|40`]);
    const expectedKeys = TWELVE_ROWS
      .map((row) => `${row.productId}|${row.size}`)
      .filter((key) => !zeroKeys.has(key))
      .sort();
    assert.deepEqual(
      harness.inventory.calls.map((call) => `${call.productRecordId}|${call.size}`).sort(),
      expectedKeys,
      '库存只加在 9 行上：0 双的行一次都不加（= 不写库存流水）',
    );
    assert.equal(harness.inventory.calls.length, 9);
    for (const inbound of inbounds) {
      assert.equal(inbound.values['数量'], 1, '入库数量 = **实际数量**（不是差异数、不是申请数）');
    }
    // 0 双的行不许出现在入库行里。
    for (const inbound of inbounds) {
      assert.equal(zeroKeys.has(`${inbound.values['编号'][0]}|${SIZE_RECORDS
        .find((record) => record.record_id === inbound.values['尺码'][0]).fields['尺码']}`), false);
    }

    // ⑤ 该写的照旧：批次行上的到货信息（验收原话 / 确认状态）+ 收尾；
    //    「单据信息」一个字没写；流程不卡。
    assert.equal(batchFields(harness.records)['验收原话'], '8230黑色少一双38码\n93827黑色少39 40码各一双\n完毕',
      '12 行那种全链路的「验收原话」照旧落到批次行');
    assert.equal(batchFields(harness.records)['确认状态'], '已确认');
    assert.deepEqual(writesTo(harness.gateway, 'purchaseRequest'), [],
      '「单据信息」一个字都不许变（既有口径，0 双这件事也不例外）');
    assert.equal((await harness.store.get(taskId)).status, 'posted', '流程不卡：正常收尾');
    assert.equal(harness.replied.length, 1, '收尾在群里回一句结果');
    assert.match(harness.replied[0].content, /共 9 双/);
    assert.match(harness.replied[0].content, /3 条实际 0 双（没到）/);

    // ⑥ 日志（正向证据）：那 3 行**没有**入库、**没有**动库存 —— 有地方可核。
    const skippedLog = logs.events('purchase.arrival.reconcile.zero_actual_skipped');
    assert.equal(skippedLog.length, 1);
    assert.match(skippedLog[0], /"zero_actual_count":3/);
    assert.match(skippedLog[0], /"inbound_rows_written":0/);
    assert.match(skippedLog[0], /"inventory_apply_calls":0/);
    const postedLog = logs.events('purchase.arrival.reconcile.posted');
    assert.match(postedLog[0], /"posted_row_count":9/);
    assert.match(postedLog[0], /"skipped_zero_count":3/);
    // 这条链路的红线：入库全程对「单据信息」零写入。
    assert.match(postedLog[0], /"purchase_request_writes":0/);
    assert.equal(confirmed.toast.type, 'success');
  } finally {
    logs.restore();
  }
});

test('0 双②：整批都是 0 双（一件都没到）→ 一条入库 / 库存流水都不写，但流程不卡', async () => {
  // 边界：把"每行 0 双不入库"这条规则用到全部行上。她没明说这个场景，
  // 但"不写入库"恰恰是正确结果；唯一要小心的是**不能**回成"已入库 0 条"含糊过去。
  const harness = makeHarness({
    responses: [{
      complete: true,
      same: false,
      differences: [
        { item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 2 },
        { item_no: 'XHB8095', color: '黑', size: 39, type: 'less', quantity: 2 },
      ],
    }],
  });
  const taskId = taskIdForBatch(BATCH_NO);
  await harness.service.handleTopicMessage({
    batch: defaultBatch(), text: '这单货这么久了，一双都没到，完毕', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });

  assert.equal(harness.cards.length, 1);
  assert.equal((JSON.stringify(harness.cards[0].card).match(/实际 0 双/g) || []).length, 2);

  const result = await harness.service.handleCardAction(
    { action: ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, draft_id: taskId },
    { context: { open_message_id: 'om_card_1' } }, 'ou_1',
  );

  assert.equal(writesTo(harness.gateway, 'purchaseInbound').length, 0, '一件都没到 → 一条入库行都没有');
  assert.equal(harness.inventory.calls.length, 0, '一件都没到 → 一次库存都不加');
  // 到货信息的落点照旧（一件都没到也是"核对过"）：验收原话 + 确认状态照样写批次行。
  assert.equal(batchFields(harness.records)['验收原话'], '这单货这么久了，一双都没到，完毕');
  assert.equal(batchFields(harness.records)['确认状态'], '已确认');
  assert.deepEqual(writesTo(harness.gateway, 'purchaseRequest'), []);
  assert.equal((await harness.store.get(taskId)).status, 'posted', '不卡单：照常收尾');
  assert.match(result.toast.content, /一件都没到/);
  assert.equal(result.toast.content.includes('已按实际到货入库'), false, '不许含糊成"已入库 0 条"');
});

test('0 双③：0 双的两句卡片文案 + 收尾回话都来自配置（改文案不碰逻辑）', async () => {
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 2 }] }],
    config: {
      card: { zeroActualNote: '零双·自定义', zeroRowsNote: '零行说明·自定义' },
      summary: { postedWithZero: '自定义回话：{zeroCount} 条没到、没有入库' },
    },
  });
  const taskId = taskIdForBatch(BATCH_NO);
  await harness.service.handleTopicMessage({
    batch: defaultBatch(), text: '38 码一双都没到，完毕', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });

  const cardJson = JSON.stringify(harness.cards[0].card);
  assert.match(cardJson, /零双·自定义/);
  assert.match(cardJson, /零行说明·自定义/);

  const result = await harness.service.handleCardAction(
    { action: ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, draft_id: taskId },
    { context: { open_message_id: 'om_card_1' } }, 'ou_1',
  );
  assert.equal(result.toast.content, '自定义回话：1 条没到、没有入库');
});

// ═══════════════════════════════════════════════════════════════════════════
// □ 边界：不是采购申请单的话题 / 开关 / 配置
// ═══════════════════════════════════════════════════════════════════════════

test('边界①：采购**退货**单的话题不走到货核对（否则会给退货批次写一条到货信息）', async () => {
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

const makeLarkService = async ({ arrivalConversation, mapping = {}, mainChatRequireMention } = {}) => {
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
    // `undefined` → 走 config/groupAdmission 的默认（放宽：主群不 @ 也能识别销售）。
    mainChatRequireMention,
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

test('接线②：主群里没 @ 机器人 + 不像销售的消息 → 一条都不处理（到货核对也不该被触发）', async () => {
  const seen = [];
  const service = await makeLarkService({
    arrivalConversation: { handleTopicMessage: async (input) => { seen.push(input); return { handled: true }; } },
  });

  // 日常闲聊：不 @、没有数字、没有业务关键词、没有批次号 → 静默。
  const result = await service.acceptMessage(groupTopicEvent({ threadId: '', text: '今天天气不错' }));

  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'group_not_sales_text');
  assert.equal(seen.length, 0);
});

test('接线②-b：开关要求 @（mainChatRequireMention=true）→ 主群没 @ 一条都不处理', async () => {
  const seen = [];
  const service = await makeLarkService({
    mainChatRequireMention: true,
    arrivalConversation: { handleTopicMessage: async (input) => { seen.push(input); return { handled: true }; } },
  });

  // "38 码少一双"带数字、会被销售闸门放行；但开关要求 @，所以必须被挡掉
  // （= 2026-10-06 之前的口径，钉住它随时能切回去）。
  const result = await service.acceptMessage(groupTopicEvent({ threadId: '', text: '38 码少一双' }));

  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'group_not_mentioned');
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

