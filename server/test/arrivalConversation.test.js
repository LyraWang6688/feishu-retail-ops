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
  // ⚠️ 这里**故意没有** `purchaseArrival` / 入库明细那张表：两张表都已被业务负责人整个删除，
  //    代码里也没有它们的表键。真写了会在记录型 gateway 上抛「未配置语义字段」
  //    （这正是守门测试想要的效果）。
});

const defaultBatch = (overrides = {}) => ({
  batch_no: BATCH_NO,
  batch_kind: ARRIVAL_BATCH_KINDS.PURCHASE_REQUEST,
  request_ids: ['req_38', 'req_39'],
  chat_id: 'oc_test_group',
  ...overrides,
});

const makeHarness = ({ records = defaultRecords(), responses = [], config, messageMeta, inventory: injectedInventory } = {}) => {
  const gateway = makeGateway(records);
  const inventory = injectedInventory || makeInventory();
  const store = new JsonTaskStore({ dir: tempDir('arrival-conv-test-'), idField: 'task_id' });
  const webhook = makeWebhookService({ gateway, inventory, store });
  const recognizer = makeRecognizer(responses);
  const replied = [];
  const cards = [];
  const updated = [];
  // ⭐ 2026-10-07 晚：「更新一张已存在的消息之前，先读一眼它到底是什么」这个能力
  //   （`im.v1.message.get` → `msg_type` / `deleted` / `thread_id` / `updated`）的桩。
  //   `messageMeta` 可以是 `(messageId) => 覆盖项` 的函数，也可以是 `{ messageId: 覆盖项 }` 的映射；
  //   没给到的按「一张正常的、没被撤回的卡片」算（绝大多数用例走这条路）。
  //   `updated` 随本桩里的 `updateCard` 变 true ⇒「改完再读一眼校验」这件事能被真的断言。
  const metaQueries = [];
  const patchedIds = new Set();
  const metaOverride = (messageId) => (typeof messageMeta === 'function'
    ? (messageMeta(messageId) || {})
    : ((messageMeta && messageMeta[messageId]) || {}));
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
    updateCard: async (messageId, card) => { updated.push({ messageId, card }); patchedIds.add(messageId); return true; },
    getMessageMeta: async (messageId) => {
      metaQueries.push(messageId);
      return {
        ok: true, msgType: 'interactive', deleted: false, threadId: '',
        updated: patchedIds.has(messageId), ...metaOverride(messageId),
      };
    },
    config,
  });
  return {
    gateway, inventory, store, webhook, recognizer, replied, cards, updated,
    metaQueries, service, records,
  };
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
// □ ⭐ 追加 / 修正反馈：**在当前话题重发一张新卡**（她一定看得见）+ 旧卡尽力作废；
//   不重复建记录、不重复写库
//   ⚠️ 2026-10-07 晚改：出口从"更新已有那张"换成"重发新卡"（见上面「卡片她一定看得见」一节）。
// ═══════════════════════════════════════════════════════════════════════════

test('追加①：已经有待确认的卡片，她又补一句（没说「核对完毕」）→ **重发一张新卡**，旧卡作废', async () => {
  const harness = makeHarness({
    responses: [
      // 第一句：38 码少一双 → 出一张卡（实际 1 双）。
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] },
      // 第二句：再补 39 码也多一双 → 重算（38 实际 1、39 实际 3），重发一张新卡。
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

  // ① 重发一张新卡（落在她说这句话的话题里）**并且**把旧卡作废 ⇒ 她眼前始终只有**一张能点的卡**。
  assert.equal(harness.cards.length, 2, '要重发一张新卡（可见性优先）');
  assert.equal(harness.cards[1].messageId, 'om_2');
  assert.equal(harness.cards[1].options.threadId, 'omt_1');
  assert.equal(harness.updated.length, 1, '旧卡作废 = patch 那**一张**');
  assert.equal(harness.updated[0].messageId, firstCardId);
  assert.deepEqual(cardButtons(harness.updated[0].card), [], '作废的旧卡上不许再留按钮');
  assert.equal(second.card, true);
  assert.equal(second.card_message_id, 'om_card_2');
  // ② 新卡上是**重算后的**数字（38 实际 1 双、39 实际 3 双）。
  assert.match(JSON.stringify(harness.cards[1].card), /实际 1 双/);
  assert.match(JSON.stringify(harness.cards[1].card), /实际 3 双/);
  // ③ 不重复建记录：还是同一条任务；任务上记的是**最新**那张卡；plan 覆盖成最新。
  const task = await harness.store.get(taskId);
  assert.equal(task.card_message_id, 'om_card_2', '任务上记最新那张卡');
  assert.deepEqual(task.plan.map((row) => [row.size, row.actual]), [[38, 1], [39, 3]]);
  assert.deepEqual(task.transcript.map((item) => item.text), ['38 码少一双', '还有 39 码多一双']);
  assert.equal(task.acceptance_text, '38 码少一双\n还有 39 码多一双', '「验收原话」是累积的全部原话');
  // ④ 回一句说明哪张才是准的（文案可配）。
  //    🔴 不许再说"上面那张卡片已经更新"：真机 23:37 那句回话就是这么说的，可她那边一张卡都没有。
  assert.match(harness.replied.at(-1).content, /最新那张核对卡片/);
  assert.doesNotMatch(harness.replied.at(-1).content, /上面那张卡片已经更新/);
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

  // ⚠️ 2026-10-07 深夜：「采购入库」表被整表删除 ⇒ 判据从"写了几行入库行"换成"给几行加了库存"。
  const applied = harness.inventory.calls;
  // 最新计划：38 码申请 2 − 少 2 = 0 双（0 双不入库）；39 码没提差异 = 申请 2 双。
  assert.equal(applied.length, 1, '只有 39 码那一行加库存（38 码最新算出来是 0 双）');
  assert.equal(applied[0].size, 39);
  assert.equal(applied[0].quantity, 2);
  assert.equal(harness.gateway.writes.filter((item) => item.op === 'create').length, 0,
    '到货确认不新建任何业务表记录（入库明细表整个不要了）');
});

test('追加③：旧卡作废失败 → 记 warn，但**新卡照样发出去了**（她不会卡在过期数字上）', async () => {
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
    assert.equal(second.card_message_id, 'om_card_2');
    // ⭐ 交付物（新卡）**不依赖**旧卡作废成不成功 —— 她一定拿得到一张能点的卡。
    assert.equal(harness.cards.length, 2, '新卡照样发出去（旧卡作废只是收尾）');
    assert.equal(logs.events('purchase.arrival.reconcile.card_update_failed').length, 1);
    assert.equal(logs.events('purchase.arrival.reconcile.card_supersede_failed').length, 1);
    assert.match(logs.events('purchase.arrival.reconcile.card_sent').at(-1), /"supersede_result":"failed"/);
    const task = await harness.store.get(taskIdForBatch(BATCH_NO));
    assert.notEqual(task.card_message_id, firstCardId, '任务上记的是**最新那张**卡');
    assert.equal(task.card_message_id, 'om_card_2', 'replyCard 返回的新 id（第 2 张）');
    // 旧卡仍然指向同一个 taskId —— 点它也是按最新计划入库（不会写错账）。
    assert.equal(cardButtons(harness.cards[1].card).length, 2, '新卡上两个按钮齐全');
  } finally {
    logs.restore();
  }
});

test('追加④：点「否」之后又补一句 → 还是**重发一张新卡** + 旧卡作废（话题里只留一张能点的）', async () => {
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

  assert.equal(harness.cards.length, 2, '「否」之后补一句：照样重发一张新卡');
  assert.equal(harness.updated.length, 1, '旧卡作废（收掉按钮）');
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
// □ ⭐⭐ 卡片**她一定看得见**
//   （真机 2026-10-07 23:37：日志说 `card_updated`，她那边**一张卡都没有**，
//    只有一句「上面那张卡片已经更新」—— 交付物是"带「是」的核对卡片"，她只拿到一句话）
//
//   根因：改前的出口是"任务上有历史卡片 id 就去**更新**那一张"，而
//     ① 那个 id 是**批次级**的（同一批跨话题共用一条会话任务，见 taskIdForBatch），
//        她看的是**话题级**的 ⇒ 更新可能落在**另一个话题**那张卡上；
//     ② `im.v1.message.patch` 的成功判据**只有 `code === 0`**（官方文档：该接口
//        「仅支持更新卡片（消息类型为 interactive）」，可错误码表里**没有**"目标不是卡片"），
//        ⇒ 对一条文字消息它完全可能回 0 却什么都没改。
//   ⇒ 改法：出口**一律在她说这句话的那个话题里发新卡**；旧卡只**尽力作废**，
//     而且作废前**先读一眼确认它真是卡片**、作废后**再读一眼校验**，全程有日志。
// ═══════════════════════════════════════════════════════════════════════════

test('可见性①（真机复现）🔴：卡片在**另一个话题**里 —— 她在本话题说「货都到了」也必须拿到一张卡', async () => {
  const harness = makeHarness({
    responses: [
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] },
      { complete: true, same: true, differences: [] },
    ],
  });
  // 第一句在话题 A：出一张卡，在 A 里等她确认。
  await harness.service.handleTopicMessage({
    batch: defaultBatch(), text: '38 码少一双', messageId: 'om_1', threadId: 'omt_A', senderOpenId: 'ou_1',
  });
  assert.equal(harness.cards.length, 1);
  assert.equal(harness.cards[0].options.threadId, 'omt_A');

  // 她换到话题 B（**同一批** —— 会话任务只跟批次有关，见 taskIdForBatch）说「货都到了」。
  // 真机 23:37 就是这一步：旧代码把卡"更新"回 A 的那张 ⇒ 她在 B 里只看到一句回话。
  const second = await harness.service.handleTopicMessage({
    batch: defaultBatch(), text: '货都到了', messageId: 'om_2', threadId: 'omt_B', senderOpenId: 'ou_1',
  });

  assert.equal(second.card, true);
  assert.equal(harness.cards.length, 2,
    '🔴 必须**在她说这句话的那个话题**里发一张新卡（不是去更新别处那张）');
  assert.equal(harness.cards[1].messageId, 'om_2', '新卡回复的是她刚说的那条消息');
  assert.equal(harness.cards[1].options.threadId, 'omt_B', '新卡落在她正在看的话题里');
  assert.deepEqual(
    cardButtons(harness.cards[1].card).map((button) => button.action),
    [ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, ARRIVAL_CONVERSATION_ACTIONS.REJECT],
    '新卡上就有「是」「否」两个按钮（她点得到）',
  );
  // 「货都到了」= 全部到齐。
  const task = await harness.store.get(taskIdForBatch(BATCH_NO));
  assert.deepEqual(task.plan.map((row) => [row.size, row.actual]), [[38, 2], [39, 2]]);
  assert.equal(task.card_message_id, 'om_card_2', '任务上记的是**最新**那张卡');
  assert.equal(task.card_thread_id, 'omt_B', '并记下它长在哪个话题里（排查时一眼可见）');
  // 旧卡（话题 A 里那张）**尽力作废**：按钮收掉，免得话题里同时有两张都能点的卡。
  assert.equal(harness.updated.length, 1);
  assert.equal(harness.updated[0].messageId, 'om_card_1');
  assert.deepEqual(cardButtons(harness.updated[0].card), [], '作废的卡上不许再留「是 / 否」按钮');
  assert.equal(harness.gateway.writes.length, 0, '发卡 / 作废旧卡都不写任何业务表');
});

test('可见性②🔴：历史卡片 id 指向的那条消息**不是卡片** → 一个字都不许 patch 它，照样发新卡', async () => {
  const harness = makeHarness({
    responses: [
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] },
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 2 }] },
    ],
    // `om_card_1` 实际上是一条**文字**消息 —— 真机那个 `om_x100b…` 的 `msg_type`
    // 就是要在服务器上只读核一次的事（见 docs/arrival-card-visibility-2026-10-07.md 第 9 节）。
    // `patch` 对非卡片消息可能回 `code 0` 却什么都不改，旧代码据此记成 `card_updated`。
    messageMeta: (messageId) => (messageId === 'om_card_1' ? { msgType: 'text' } : {}),
  });
  const logs = captureLogs();
  try {
    await harness.service.handleTopicMessage({
      batch: defaultBatch(), text: '38 码少一双', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
    });
    const second = await harness.service.handleTopicMessage({
      batch: defaultBatch(), text: '不对，是少两双', messageId: 'om_2', threadId: 'omt_1', senderOpenId: 'ou_1',
    });

    assert.equal(second.card, true, '照样发新卡（不许静默什么都不做）');
    assert.equal(harness.cards.length, 2);
    assert.equal(harness.updated.length, 0, '🔴 目标不是卡片 → 一个字都不许 patch 它');
    const skipped = logs.events('purchase.arrival.reconcile.card_supersede_skipped');
    assert.equal(skipped.length, 1, '要留一条明确的日志，说清"为什么没动它"');
    assert.match(skipped[0], /"reason":"target_not_interactive"/);
    assert.match(skipped[0], /"target_msg_type":"text"/, '把那条消息**真实的**类型写进日志');
  } finally {
    logs.restore();
  }
});

test('可见性③：读过之后拿不准（读不到 / 已撤回）→ **不 patch**，照样发新卡', async () => {
  for (const [label, meta, reason] of [
    ['读不到（缺权限 / 网络）', { ok: false, reason: 'call_failed' }, 'call_failed'],
    ['已撤回', { deleted: true }, 'target_deleted'],
  ]) {
    const harness = makeHarness({
      responses: [
        { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] },
        { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 2 }] },
      ],
      messageMeta: (messageId) => (messageId === 'om_card_1' ? meta : {}),
    });
    const logs = captureLogs();
    try {
      await harness.service.handleTopicMessage({
        batch: defaultBatch(), text: '38 码少一双', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
      });
      await harness.service.handleTopicMessage({
        batch: defaultBatch(), text: '不对，是少两双', messageId: 'om_2', threadId: 'omt_1', senderOpenId: 'ou_1',
      });

      assert.equal(harness.cards.length, 2, `${label}：新卡照样发`);
      assert.equal(harness.updated.length, 0, `${label}：宁可不做，也不做一件看不见的事`);
      assert.equal(logs.events('purchase.arrival.reconcile.card_supersede_skipped').length, 1, label);
      assert.match(logs.events('purchase.arrival.reconcile.card_supersede_skipped')[0],
        new RegExp(`"reason":"${reason}"`), label);
    } finally {
      logs.restore();
    }
  }
});

test('可见性④：`card_sent` 日志能回答"发出去没有 / message_id / 是不是 interactive / 在哪个话题"', async () => {
  const harness = makeHarness({
    responses: [{ complete: true, same: true, differences: [] }],
    // 发出去的那条卡片消息落在她说话的话题里（`im.v1.message.get` 读回来的事实）。
    messageMeta: (messageId) => (messageId === 'om_card_1' ? { threadId: 'omt_1' } : {}),
  });
  const logs = captureLogs();
  try {
    await harness.service.handleTopicMessage({
      batch: defaultBatch(), text: '货都到了', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
    });

    const sent = logs.events('purchase.arrival.reconcile.card_sent');
    assert.equal(sent.length, 1, '出口只有一个：`card_sent`（旧的 `card_updated` 已经删掉）');
    assert.equal(logs.events('purchase.arrival.reconcile.card_updated').length, 0);
    assert.match(sent[0], /"card_message_id":"om_card_1"/);
    assert.match(sent[0], /"thread_id":"omt_1"/);
    assert.match(sent[0], /"card_msg_type":"interactive"/, '读回来的**事实**：它就是一张卡片');
    assert.match(sent[0], /"card_msg_type_source":"message_get"/);
    assert.match(sent[0], /"card_thread_match":true/, '卡片落的话题 = 她说话的话题');
    assert.match(sent[0], /"card_action":"sent"/);
  } finally {
    logs.restore();
  }
});

test('可见性⑤：旧卡作废**先确认是卡片、改完再读一眼校验**，结果进日志', async () => {
  const harness = makeHarness({
    responses: [
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] },
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 2 }] },
    ],
  });
  const logs = captureLogs();
  try {
    await harness.service.handleTopicMessage({
      batch: defaultBatch(), text: '38 码少一双', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
    });
    await harness.service.handleTopicMessage({
      batch: defaultBatch(), text: '不对，是少两双', messageId: 'om_2', threadId: 'omt_1', senderOpenId: 'ou_1',
    });

    const superseded = logs.events('purchase.arrival.reconcile.card_superseded');
    assert.equal(superseded.length, 1);
    assert.match(superseded[0], /"card_message_id":"om_card_1"/);
    assert.match(superseded[0], /"new_card_message_id":"om_card_2"/);
    assert.match(superseded[0], /"update_verified":true/, '改完再读一眼：`updated` 确实是 true');
    // 作废的那张卡上写着"请用最新那张"，不再留按钮。
    const retired = JSON.stringify(harness.updated[0].card);
    assert.match(retired, /最新那张/);
    assert.deepEqual(cardButtons(harness.updated[0].card), []);
    // 回她一句：**不许再说"上面那张已经更新"**（新出口下那是假话，真机上那句回话正是误导来源）。
    assert.equal(harness.replied.at(-1).content, resolveArrivalConversationConfig({ env: {} }).replies.recalculatedCard);
    assert.doesNotMatch(harness.replied.at(-1).content, /上面那张卡片已经更新/);
    assert.equal(harness.replied.at(-1).options.threadId, 'omt_1');
  } finally {
    logs.restore();
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
  // ⭐ 2026-10-07 晚改名：`updatedCard` → `recalculatedCard`（出口从"更新那张"改成"重发一张"）。
  assert.match(config.replies.recalculatedCard, /最新那张核对卡片/);
  assert.doesNotMatch(config.replies.recalculatedCard, /上面那张卡片已经更新/,
    '🔴 不许再说"上面那张已经更新"——真机 23:37 那句回话正把她带偏');
  assert.equal(config.replies.updatedCard, undefined, '旧的那句（会误导人）已经删掉');
  // 覆盖生效。
  const overridden = resolveArrivalConversationConfig({
    env: {},
    replies: { noArrivalContent: '自定义-没内容', recalculatedCard: '' },
  });
  assert.equal(overridden.replies.noArrivalContent, '自定义-没内容');
  assert.equal(overridden.replies.recalculatedCard, '', '置空 = 不回那句（卡片本身照样发）');
});

test('文案②：重发新卡后那句回话也走配置（置空就不回，但卡片照样发）', async () => {
  const harness = makeHarness({
    responses: [
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] },
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 2 }] },
    ],
    config: { replies: { recalculatedCard: '' } },
  });
  await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '38 码少一双', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1' });
  harness.replied.length = 0;
  await harness.service.handleTopicMessage({ batch: defaultBatch(), text: '不对，是少两双', messageId: 'om_2', threadId: 'omt_1', senderOpenId: 'ou_1' });

  assert.equal(harness.replied.length, 0, '配置置空 = 不回这句');
  assert.equal(harness.cards.length, 2, '但卡片照样发（可见性不依赖那句回话）');
  assert.equal(harness.updated.length, 1, '旧卡照样尽力作废');
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

  // ⭐ 2026-10-07 深夜：「采购入库」表被整表删除 ⇒ 这两行是**加库存**的两次调用（不再是入库行）。
  assert.equal(harness.inventory.calls.length, 2, '落点/表结构的变更不影响加库存：该加几次还是几次');
  assert.equal(harness.gateway.writes.filter((item) => item.op === 'create').length, 0,
    '到货确认不新建任何业务表记录（入库明细表整个不要了）');
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

test('点「是」②：**按实际数量加库存**（不是申请数）—— 那次"入库明细行"整体退场', async () => {
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [
      { item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 },
      { item_no: 'XHB8095', color: '黑', size: 39, type: 'more', quantity: 2 },
    ] }],
  });
  await confirmCard(harness);

  // ⭐ 2026-10-07 深夜：「采购入库」表被她**整表删除** ⇒ 这条用例的判据从"入库行写了什么"
  //    整体挪到"**交给库存的实际数**是什么"（那条写入点现在也是唯一的数量出口）。
  const calls = harness.inventory.calls;
  assert.equal(calls.length, 2, '一个（货品+尺码）加一次库存');
  const bySize = new Map(calls.map((call) => [call.size, call]));
  // 38 码：申请 2 − 1 = 1；39 码：申请 2 + 2 = 4。
  assert.equal(bySize.get(38).quantity, 1, '加库存的数量必须是**实际数**');
  assert.equal(bySize.get(39).quantity, 4, '多到的也要按实际数加');
  for (const call of calls) {
    // 一个业务表都不新建（没有入库行这回事了）。
    assert.equal(call.purchaseInboundRecordId, undefined, '那个键随「采购入库」表一起退场');
  }
  assert.equal(harness.gateway.writes.filter((item) => item.op === 'create').length, 0,
    '到货确认不新建任何业务表记录（入库明细表整个不要了）');
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
    // ⭐ 幂等来源 = **真实三元组**（批次记录 id ｜ 货品 ｜ 尺码）；那个随表退场的键不再是来源。
    assert.equal(call.purchaseBatchRecordId, BATCH_RECORD_ID);
    assert.equal(call.purchaseBatchNo, BATCH_NO);
    assert.equal(call.purchaseInboundRecordId, undefined);
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
  assert.equal(harness.gateway.writes.filter((item) => item.op === 'create').length, 0,
    '重复点「是」不新建任何业务表记录（入库明细行早就不存在了）');
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

test('可见失败① 🔴：点「是」加库存抛错 → **那张卡片被 patch 成终态** + 话题里回一句（含错误原文）', async () => {
  // ⚠️ 2026-10-07 深夜：原先这里靠"行为表里没有 PURCHASE_IN"制造失败 —— 那个查找
  //    随入库明细行一起退场了。现在最能代表"她点「是」之后炸了"的是**库存那一层抛错**。
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] }],
    inventory: { calls: [], async applyPurchase() { throw new Error('库存引擎：STOCK_PURCHASE_INCREASE 行为方向不对'); } },
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
  assert.match(harness.replied[0].content, /行为方向不对/);
  assert.equal(logs.events('purchase.arrival.reconcile.confirm_failed').length, 1,
    'error 原文仍要留在日志里（既有结构不许破坏）');
  assert.match(logs.events('purchase.arrival.reconcile.confirm_failed')[0], /行为方向不对/);
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
  // ⚠️ 2026-10-07 深夜：入库明细行整体退场 ⇒ 这条断言改成"**一个业务表都不新建**"
  //    （原先数的是入库行；现在连那张表都没有了）。
  assert.equal(harness.gateway.writes.filter((item) => item.op === 'create').length, 0,
    '加库存失败时也不新建任何业务表记录');
});

test('可见失败②：失败文案可配（`replies.inboundFailed`，改文案不碰逻辑）', async () => {
  const harness = makeHarness({
    responses: [{ complete: true, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] }],
    config: { replies: { inboundFailed: '自定义-入库没成功：{error}（再点一次）' } },
    // 失败触发同 ①：库存那一层抛错（行为查找那个触发点已随入库明细行退场）。
    inventory: { calls: [], async applyPurchase() { throw new Error('库存引擎没配好'); } },
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
  // 🔴 到货信息没有落点 ⇒ **一个字都不入库、也不新建任何记录**
  //   （这是"先写到货、再加库存"的顺序保证）。
  assert.deepEqual(harness.gateway.writes, [], '落点失败就一个业务表都不写');
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
  // ⚠️ 2026-10-07 深夜：入库明细行整体退场 ⇒ 这里改成"一个业务表都不写"（更强）。
  assert.deepEqual(harness.gateway.writes, []);
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

    // ④ 点「是」→ **只有 9 行加库存**：3 行 0 双不写任何入库明细、也不调库存。
    logs.lines.length = 0;
    const confirmed = await harness.service.handleCardAction(
      { action: ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, draft_id: taskId },
      { context: { open_message_id: 'om_card_1' } }, 'ou_1',
    );

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
    for (const call of harness.inventory.calls) {
      assert.equal(call.quantity, 1, '加库存的数量 = **实际数量**（不是差异数、不是申请数）');
    }
    // ⭐ 2026-10-07 深夜：「采购入库」表被整表删除 ⇒ 一个业务表都不新建
    //   （原先这里数的是"9 条入库行"，现在连那张表都没有了）。
    assert.equal(harness.gateway.writes.filter((item) => item.op === 'create').length, 0,
      '到货确认不新建任何业务表记录（入库明细表整个不要了）');
    // 0 双的行不许出现在加库存的清单里（上面那条 deepEqual 已经逐字钉住，这里再明写一次口径）。
    const appliedKeys = new Set(harness.inventory.calls.map((call) => `${call.productRecordId}|${call.size}`));
    for (const key of zeroKeys) assert.equal(appliedKeys.has(key), false, `0 双的行不该加库存：${key}`);

    // ⑤ 该写的照旧：批次行上的到货信息（验收原话 / 确认状态）+ 收尾；
    //    「报货信息」一个字没写；流程不卡。
    assert.equal(batchFields(harness.records)['验收原话'], '8230黑色少一双38码\n93827黑色少39 40码各一双\n完毕',
      '12 行那种全链路的「验收原话」照旧落到批次行');
    assert.equal(batchFields(harness.records)['确认状态'], '已确认');
    assert.deepEqual(writesTo(harness.gateway, 'purchaseRequest'), [],
      '「报货信息」一个字都不许变（既有口径，0 双这件事也不例外）');
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

  assert.equal(harness.gateway.writes.filter((item) => item.op === 'create').length, 0,
    '一件都没到 → 一条业务表记录都不新建（入库明细行早就不存在了）');
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

// ═══════════════════════════════════════════════════════════════════════════
// □ ⭐⭐ 到货核对卡片改成「表单填写 + 提交」（业务负责人 2026-10-07 深夜定）
//
// 她的原话（逐字）：
//   「我们的消息卡片是否支持**输入一段文字**？……等到货之后，**请在卡片里填写实际到货情况**。
//    也就是给到用户卡片，**用户填写内容之后，再点击提交**。以这个来作为**触发后续的到货验收**」
//
// 官方依据（curl 实查，原文见 `docs/arrival-card-form-input-2026-10-08.md` 第 0 节）：
//   · 输入框**必须**与按钮一起内嵌进「表单容器」；表单容器**只能**放卡片根节点；
//   · 提交按钮要绑 `action_type: "form_submit"`；回调里带 `form_value`（表单项 name → 值）；
//   · 表单内交互组件的 `name` 必填且**卡片全局唯一**（否则飞书报 200530）；
//   · 输入框需飞书 **V6.8+**（低版本走 `fallback` 降级文案）⇒ **老路（在话题里说）必须留着**。
//
// ⚠️ 本节的验收标准逐条写在 `docs/arrival-card-form-input-2026-10-08.md` 第 1 节（先写后做）。
// ═══════════════════════════════════════════════════════════════════════════

const FORM_FIELD = 'actual_arrival';

/** 卡片里的表单容器（官方硬约束：只能放在**卡片根节点**下）。 */
const cardForm = (card) => (card.elements || []).find((element) => element.tag === 'form') || null;

/** 深挖整张卡片上全部交互组件的 `name` —— 用来断言"全局唯一"。 */
const cardInteractiveNames = (card) => {
  const names = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.name) names.push(node.name);
    Object.values(node).forEach(walk);
  };
  walk(card.elements || []);
  return names;
};

/** 飞书 `form_submit` 回调的**真实形状**（官方 form-container 文档「回调结构」）。 */
const formSubmitEvent = ({ cardMessageId = 'om_card_1', taskId, formValue = {}, openId = 'ou_1' } = {}) => ({
  operator: { operator_id: { open_id: openId } },
  action: {
    tag: 'button',
    name: 'submit_arrival_reconcile',
    value: { action: ARRIVAL_CONVERSATION_ACTIONS.SUBMIT, draft_id: taskId },
    form_value: formValue,
  },
  context: { open_message_id: cardMessageId },
});

/** 提交一次（形参顺序与 `larkMvpService` 的接线一致：value / formValue / event / operator）。 */
const submitForm = (harness, options = {}) => {
  const event = formSubmitEvent({ taskId: taskIdForBatch(BATCH_NO), ...options });
  return harness.service.handleCardFormSubmit(
    event.action.value, event.action.form_value, event, event.operator.operator_id.open_id,
  );
};

/** 先造一张"已经算出结果"的到货核对卡片（表单就长在它上面）。 */
const withReconcileCard = async (harness, text = '38 码少一双') => {
  await harness.service.handleTopicMessage({
    batch: defaultBatch(), text, messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });
  const taskId = taskIdForBatch(BATCH_NO);
  const task = await harness.store.get(taskId);
  return { taskId, cardMessageId: task.card_message_id, task };
};

test('表单①⭐：输入框与提交按钮都在**卡片根节点的表单容器**里，name 全局唯一，既有「是/否」一个都没少', async () => {
  const harness = makeHarness({ responses: [{ complete: false, same: true, differences: [] }] });
  await harness.service.handleTopicMessage({
    batch: defaultBatch(), text: '都到了', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });
  const card = harness.cards[0].card;

  // ① 表单容器在**卡片根节点**（官方：表单容器不可被内嵌在其它组件内，只可放在根节点下）。
  const form = cardForm(card);
  assert.ok(form, '卡片根节点上必须有一个表单容器（输入框必须与按钮一起内嵌在表单容器里）');
  assert.equal(form.tag, 'form');
  assert.equal(form.name, 'arrival_reconcile_form');

  // ② 容器内恰好两项：输入框 + 提交按钮。
  const input = (form.elements || []).find((element) => element.tag === 'input');
  const submit = (form.elements || []).find((element) => element.tag === 'button');
  assert.ok(input, '表单容器里必须有输入框');
  assert.ok(submit, '表单容器里必须有提交按钮（官方：输入框与按钮**一起**内嵌）');
  assert.equal(input.name, FORM_FIELD, '输入框 name = form_value 里的键');
  assert.equal(input.input_type, 'multiline_text', '业务负责人要的是**多行**文本框');
  assert.equal(input.required, true, '必填（前端会拦空提交；服务端仍然自己兜一层）');
  assert.equal(input.label.content, '实际到货情况');
  assert.ok(String(input.placeholder.content || '').length > 0, 'placeholder 可配且非空');
  assert.equal(input.fallback.tag, 'fallback_text', '低版本客户端的降级文案（老路还留着）');
  assert.match(input.fallback.text.content, /话题/);

  // ③ 提交按钮绑 `form_submit`，value 里带得回任务 id。
  assert.equal(submit.action_type, 'form_submit', '官方：提交按钮必须绑 form_submit');
  assert.equal(submit.text.content, '提交');
  assert.equal(submit.value.action, ARRIVAL_CONVERSATION_ACTIONS.SUBMIT);
  assert.equal(submit.value.draft_id, taskIdForBatch(BATCH_NO));

  // ④ `name` 全局唯一（否则飞书报 200530）。
  const names = cardInteractiveNames(card);
  assert.ok(names.includes(FORM_FIELD) && names.includes('arrival_reconcile_form'));
  assert.equal(new Set(names).size, names.length, `交互组件 name 必须全局唯一，实际：${names.join(' / ')}`);

  // ⑤ 入库闸门那两个按钮**一个都没少**（提交不是入库，入库仍然要点「是」）。
  assert.deepEqual(cardButtons(card).map((item) => item.label), ['是', '否']);
  assert.deepEqual(cardButtons(card).map((item) => item.action), [
    ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, ARRIVAL_CONVERSATION_ACTIONS.REJECT,
  ]);
});

test('表单②⭐⭐：提交带文字 = 在话题里说同一句 —— 模型入参 / 计划 / 新卡片**逐字一致**', async () => {
  const first = { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] };
  const second = { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 39, type: 'more', quantity: 1 }] };
  const SENTENCE = 'XHB8095 39 码多一双';

  // A 组：她在**话题里**说这一句。
  const topic = makeHarness({ responses: [first, second] });
  await withReconcileCard(topic);
  const byTopic = await topic.service.handleTopicMessage({
    batch: defaultBatch(), text: SENTENCE, messageId: 'om_2', threadId: 'omt_1', senderOpenId: 'ou_1',
  });

  // B 组：她在**卡片输入框**里填这一句并提交（同一批、同一段前情）。
  const form = makeHarness({ responses: [first, second] });
  const context = await withReconcileCard(form);
  const byForm = await submitForm(form, {
    cardMessageId: context.cardMessageId, formValue: { [FORM_FIELD]: SENTENCE },
  });

  // ① 喂给模型的入参（taskId / rows / messages）**深度相等**。
  assert.deepEqual(form.recognizer.calls[1], topic.recognizer.calls[1], '提交与说话必须喂同一条解析、同样的入参');
  assert.equal(form.recognizer.calls.length, 2, '提交只多调一次模型（没有第二套解析）');
  // ② 算出来的计划 / 差异 / 验收原话**深度相等**。
  const topicTask = await topic.store.get(taskIdForBatch(BATCH_NO));
  const formTask = await form.store.get(taskIdForBatch(BATCH_NO));
  assert.deepEqual(formTask.plan, topicTask.plan);
  assert.deepEqual(formTask.differences, topicTask.differences);
  assert.equal(formTask.acceptance_text, topicTask.acceptance_text);
  assert.deepEqual(formTask.transcript.map((item) => item.text), topicTask.transcript.map((item) => item.text));
  assert.equal(formTask.status, topicTask.status);
  // ③ **新发出去的那张卡片**逐字一致。
  assert.deepEqual(form.cards[1].card, topic.cards[1].card, '提交与说话发出去的卡片必须是同一份 JSON');
  assert.equal(byForm.card, true);
  assert.equal(byTopic.card, true);
  // ④ 出卡本身照样**零业务表写入**（入库仍然只认「是」）。
  assert.deepEqual(form.gateway.writes, []);
  assert.deepEqual(topic.gateway.writes, []);
});

test('表单③⭐：提交之后点「是」→ 就是按**表单里说的数**入库（走的是既有的确认链路）', async () => {
  const harness = makeHarness({
    responses: [
      { complete: false, same: true, differences: [] },
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] },
    ],
  });
  const context = await withReconcileCard(harness, '都到了');
  await submitForm(harness, { cardMessageId: context.cardMessageId, formValue: { [FORM_FIELD]: '38 码少了一双' } });

  const result = await harness.service.handleCardAction(
    { action: ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, draft_id: context.taskId },
    { context: { open_message_id: 'om_card_2' } },
    'ou_1',
  );

  assert.equal(result.toast.type, 'success');
  const bySize = new Map(harness.inventory.calls.map((call) => [call.size, call]));
  assert.equal(bySize.get(38).quantity, 1, '38 码按表单里说的"少一双"入库');
  assert.equal(bySize.get(39).quantity, 2, '没说到的行按申请数');
  assert.equal((await harness.store.get(context.taskId)).status, 'posted');
  // 「验收原话」= 表单项里那句话（和她当面说一模一样）。
  assert.equal((await harness.store.get(context.taskId)).acceptance_text, '都到了\n38 码少了一双');
});

test('表单④⚠️：空提交 / 未填 → 明确提示 + **零写库** + 不喂模型 + 不发卡片', async () => {
  for (const formValue of [{}, { [FORM_FIELD]: '' }, { [FORM_FIELD]: '   ' }, { other: 'x' }]) {
    const harness = makeHarness({ responses: [{ complete: false, same: true, differences: [] }] });
    const context = await withReconcileCard(harness, '都到了');
    const before = await harness.store.get(context.taskId);
    const callsBefore = harness.recognizer.calls.length;

    const result = await submitForm(harness, { cardMessageId: context.cardMessageId, formValue });

    // ⚠️ 她**真正看得见**的那句提示在**卡片上**（见下面那条断言）：卡片动作路由的同步响应
    //    固定是「已收到，正在处理」，service 返回的 toast 只进 `lark.card.handled` 日志。
    //    这里仍然断言 toast 形状 —— 它是日志口径，也是"不许静默"的服务端契约。
    assert.equal(result.toast.type, 'error', '空提交必须**明确提示**（不许静默）');
    assert.match(result.toast.content, /实际到货情况/);
    assert.equal(harness.recognizer.calls.length, callsBefore, '空提交连模型都不许调');
    assert.equal(harness.cards.length, 1, '空提交不许再发卡片');
    assert.equal(harness.replied.length, 0, '也不许往话题里刷一句');
    assert.deepEqual(harness.gateway.writes, [], '空提交不许写任何业务表');
    const after = await harness.store.get(context.taskId);
    assert.deepEqual(after.transcript, before.transcript, '本地原话一个字都不许加');
    assert.equal(after.status, before.status);
    // 卡片**仍然可用**：提醒与表单一起留在她提交的那张卡上（改一句再提交即可）。
    const patch = harness.updated.at(-1);
    assert.equal(patch.messageId, context.cardMessageId);
    assert.ok(cardForm(patch.card), '空提交之后表单还要在，别把她堵死');
    assert.match(JSON.stringify(patch.card), /没收到内容/);
  }
});

test('表单⑤：同一次提交被飞书重投 → 不重复喂模型 / 不重复发卡 / 不重复入库', async () => {
  const harness = makeHarness({
    responses: [
      { complete: false, same: true, differences: [] },
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] },
    ],
  });
  const context = await withReconcileCard(harness, '都到了');
  const payload = { cardMessageId: context.cardMessageId, formValue: { [FORM_FIELD]: '38 码少一双' } };
  const first = await submitForm(harness, payload);
  assert.equal(first.card, true);

  const callsAfterFirst = harness.recognizer.calls.length;
  const cardsAfterFirst = harness.cards.length;
  const second = await submitForm(harness, payload);
  assert.equal(harness.recognizer.calls.length, callsAfterFirst, '重投不许再喂一次模型');
  assert.equal(harness.cards.length, cardsAfterFirst, '重投不许再发一张卡');
  assert.deepEqual(harness.gateway.writes, [], '重投不许写业务表');
  assert.match(second.toast.content, /已经处理过|没有重复/);

  // 再连点两次「是」：库存只加一次（38 码 1 双 / 39 码 2 双）。
  const click = () => harness.service.handleCardAction(
    { action: ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, draft_id: context.taskId },
    { context: { open_message_id: 'om_card_2' } }, 'ou_1',
  );
  await click();
  await click();
  assert.equal(harness.inventory.calls.length, 2, '两条明细各加一次，重复点击不重复入库');

  // 已经入库之后又提交一次：不重复入库、如实回执（任务上原话也不再追加）。
  const transcriptBefore = (await harness.store.get(context.taskId)).transcript.length;
  const third = await submitForm(harness, { cardMessageId: 'om_card_3', formValue: { [FORM_FIELD]: '再补一双' } });
  assert.equal(third.toast.type, 'info');
  assert.match(third.toast.content, /已经入过库|没有再动/);
  assert.equal(harness.inventory.calls.length, 2, '已入库之后提交不许再动库存');
  assert.equal((await harness.store.get(context.taskId)).transcript.length, transcriptBefore);
});

test('表单⑥⭐：老客户端降级 —— 输入框带降级文案；**"在话题里说话"这条入口逐字保留**', async () => {
  const harness = makeHarness({
    responses: [
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] },
      { complete: false, same: true, differences: [] },
    ],
  });
  await withReconcileCard(harness);
  // ① 降级文案在（飞书 < V6.8 看不见输入框，得告诉她去哪儿说）。
  const input = cardForm(harness.cards[0].card).elements.find((element) => element.tag === 'input');
  assert.match(input.fallback.text.content, /V6\.8/);
  assert.match(input.fallback.text.content, /话题/);

  // ② 老路照旧：她**直接在话题里说**，一句就到货核对（本改动没给这条路加任何闸门）。
  const result = await harness.service.handleTopicMessage({
    batch: defaultBatch(), text: '都到了', messageId: 'om_2', threadId: 'omt_1', senderOpenId: 'ou_1',
  });
  assert.equal(result.card, true);
  assert.equal(harness.cards.length, 2);
  assert.equal(harness.cards[1].messageId, 'om_2', '卡片仍然回在她说话的那条消息下面（同一话题）');
  assert.equal(harness.cards[1].options.threadId, 'omt_1');
  // ③ 提交与说话**都能用**：同一个任务上两种入口写的是同一份 transcript。
  assert.deepEqual(
    (await harness.store.get(taskIdForBatch(BATCH_NO))).transcript.map((item) => item.text),
    ['38 码少一双', '都到了'],
  );
});

test('表单⑦⚠️：提交里**没有**到货内容 → 与"在话题里说同一句"一样：不发卡、不写表（不许放宽）', async () => {
  for (const response of [
    { complete: false, same: false, differences: [] }, // 半句 / 闲聊
    { complete: true, same: false, differences: [] },  // 说完了但什么差异都没给
  ]) {
    const harness = makeHarness({
      responses: [{ complete: false, same: true, differences: [] }, response],
    });
    const context = await withReconcileCard(harness, '都到了');
    const before = await harness.store.get(context.taskId);

    const result = await submitForm(harness, { cardMessageId: context.cardMessageId, formValue: { [FORM_FIELD]: '你好' } });

    assert.equal(harness.cards.length, 1, '没有到货内容就不许发卡片 —— 提交这条路也不例外');
    assert.deepEqual(harness.gateway.writes, [], '也不许写任何业务表');
    assert.deepEqual(harness.updated, [], '卡片保持可编辑：不许把它 patch 成"已提交"（那会把没算成说成算成了）');
    // 回执也不许说"卡片发在你下面"（根本没有那张卡）。
    assert.match(result.toast.content, /没能按它算出核对结果/);
    assert.doesNotMatch(result.toast.content, /最新那张核对卡片就发在你/);
    const after = await harness.store.get(context.taskId);
    assert.deepEqual(after.plan, before.plan, '不许替她算出一份"全部到货"的计划');
    assert.equal(after.status, before.status);
  }
});

test('表单⑭：她提交的是**另一张**（不是最新那张）→ 最新那张照旧作废，她提交的那张收成「已提交」', async () => {
  // 场景：话题里已经有两张卡，但第二张发出来时第一张的作废**读不到事实**而没改成，
  // 所以第一张上还留着表单 —— 她恰好在第一张上填并提交。
  const harness = makeHarness({
    responses: [
      { complete: false, same: true, differences: [] },
      { complete: false, same: true, differences: [] },
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] },
    ],
    messageMeta: { om_card_1: { ok: false, reason: 'unavailable' } },
  });
  const topic = (messageId) => harness.service.handleTopicMessage({
    batch: defaultBatch(), text: '都到了', messageId, threadId: 'omt_1', senderOpenId: 'ou_1',
  });
  await topic('om_1');
  await topic('om_2');
  assert.equal((await harness.store.get(taskIdForBatch(BATCH_NO))).card_message_id, 'om_card_2', '最新那张是第二张');
  assert.deepEqual(harness.updated, [], '第二张发出来时旧卡没读成事实 ⇒ 一张都没 patch');

  await submitForm(harness, { cardMessageId: 'om_card_1', formValue: { [FORM_FIELD]: '38 码少一双' } });

  // ① 最新那张（om_card_2）作废（它上面的数字相对这次提交已经过期）；
  // ② 她提交的那张（om_card_1）收成「已提交」终态。
  assert.deepEqual(harness.updated.map((item) => item.messageId), ['om_card_2', 'om_card_1']);
  assert.equal(harness.updated[0].card.header.title.content, '这张核对卡片已经作废');
  assert.equal(harness.updated[1].card.header.title.content, '已提交');
  assert.equal(cardForm(harness.updated[1].card), null);
});

test('表单⑬：到货核对整个链路关着时提交 → 不处理、不写表、不喂模型（开关真的能关掉这条路）', async () => {
  const harness = makeHarness({
    responses: [{ complete: false, same: true, differences: [] }],
    config: { enabled: false },
  });
  // 开关是在**入口**判的 ⇒ 连任务都不该建（与"在话题里说"同一条判据）。
  const result = await submitForm(harness, {
    cardMessageId: 'om_card_1', formValue: { [FORM_FIELD]: '都到了' },
  });

  assert.match(result.toast.content, /没有开着/);
  assert.equal(harness.recognizer.calls.length, 0, '关掉之后连模型都不许调');
  assert.equal(harness.cards.length, 0);
  assert.deepEqual(harness.gateway.writes, []);
  assert.equal(await harness.store.get(taskIdForBatch(BATCH_NO)), null, '不该建任何会话任务');
});

test('表单⑧：提交成功 → 她提交的那张卡被 patch 成「已提交」终态（表单收掉，避免重复提交）', async () => {
  const harness = makeHarness({
    responses: [
      { complete: false, same: true, differences: [] },
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] },
    ],
  });
  const context = await withReconcileCard(harness, '都到了');
  await submitForm(harness, { cardMessageId: context.cardMessageId, formValue: { [FORM_FIELD]: '38 码少一双' } });

  assert.equal(harness.updated.length, 1, '只 patch 一张（提交入口自己收；管道不再拿它当"旧卡"作废一遍）');
  assert.equal(harness.updated[0].messageId, context.cardMessageId);
  assert.equal(harness.updated[0].card.header.title.content, '已提交');
  assert.equal(cardForm(harness.updated[0].card), null, '终态卡上不许再留表单');
  assert.deepEqual(cardButtons(harness.updated[0].card), [], '也不许再留「是 / 否」');
  assert.match(JSON.stringify(harness.updated[0].card), /最新那张/);
  // 最新的那张（带表单的）才是她要用的。
  assert.ok(cardForm(harness.cards[1].card));
});

test('表单⑨：表单全部文案走配置（改文案不碰逻辑；只覆盖一项时其余项仍有默认值）', async () => {
  const harness = makeHarness({
    responses: [
      { complete: false, same: true, differences: [] },
      { complete: false, same: false, differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }] },
    ],
    config: {
      card: {
        form: {
          containerName: 'my_form', fieldName: 'my_field', label: '填这里',
          placeholder: '自定义占位', submitLabel: '交上去', submitButtonName: 'my_submit',
          fallbackText: '升级飞书或直接在话题里说',
        },
        submittedTitle: '我自己定的已提交',
        submittedMessage: '自定义已提交说明',
      },
      replies: { submitMissing: '自定义空提交提示', submitReceived: '自定义收到提示', submitDuplicate: '自定义重复提示' },
    },
  });
  await harness.service.handleTopicMessage({
    batch: defaultBatch(), text: '都到了', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });
  const form = cardForm(harness.cards[0].card);
  const input = form.elements.find((element) => element.tag === 'input');
  const submit = form.elements.find((element) => element.tag === 'button');
  assert.equal(form.name, 'my_form');
  assert.equal(input.name, 'my_field');
  assert.equal(input.label.content, '填这里');
  assert.equal(input.placeholder.content, '自定义占位');
  assert.equal(input.fallback.text.content, '升级飞书或直接在话题里说');
  assert.equal(submit.text.content, '交上去');
  assert.equal(submit.name, 'my_submit');
  // 没覆盖的那些仍然有默认值（嵌套合并 = 只改一项不会把其余项变成 undefined）。
  assert.equal(input.input_type, 'multiline_text');
  assert.equal(input.required, true);
  assert.ok(Number(input.rows) > 1, '多行行数是默认值，没被这次覆盖弄丢');

  // 空提交用的是自定义提示。
  const empty = await submitForm(harness, { cardMessageId: 'om_card_1', formValue: {} });
  assert.equal(empty.toast.content, '自定义空提交提示');

  // 提交成功用的是自定义的「已提交」文案与自定义收到提示。
  const ok = await submitForm(harness, { cardMessageId: 'om_card_1', formValue: { my_field: '38 码少一双' } });
  assert.equal(ok.toast.content, '自定义收到提示');
  assert.equal(harness.updated.at(-1).card.header.title.content, '我自己定的已提交');
  assert.match(JSON.stringify(harness.updated.at(-1).card), /自定义已提交说明/);
});

test('表单⑩：她提交的那张卡指向的任务已经找不到 → 可见失败（不静默、不写表、不喂模型）', async () => {
  const harness = makeHarness({ responses: [] });
  const result = await submitForm(harness, {
    cardMessageId: 'om_card_x', taskId: 'arrival_reconcile_missing',
    formValue: { [FORM_FIELD]: '都到了' },
  });

  assert.equal(result.toast.type, 'error');
  assert.match(result.toast.content, /重新核一遍/);
  assert.equal(harness.recognizer.calls.length, 0);
  assert.deepEqual(harness.gateway.writes, []);
  assert.equal(harness.cards.length, 0);
  // 失败也要在她点的地方看得见（patch 那张卡 + 话题里回一句）。
  assert.equal(harness.updated.at(-1).messageId, 'om_card_x');
  assert.equal(harness.replied.length, 1);
});

test('表单⑪：接线 —— `card.action.trigger` 的 `form_value` 被取出来交给到货核对（不掉进销售那套）', async () => {
  const calls = [];
  const service = await makeLarkService({
    arrivalConversation: {
      handleCardAction: async () => null,
      handleCardFormSubmit: async (value, formValue, event, operatorOpenId) => {
        calls.push({ value, formValue, operatorOpenId, cardMessageId: event?.context?.open_message_id });
        return { toast: { type: 'info', content: 'ok' } };
      },
    },
  });
  const event = formSubmitEvent({
    cardMessageId: 'om_card_1', taskId: 'arrival_reconcile_1',
    formValue: { actual_arrival: '38 码少一双' },
  });

  const result = await service.handleCardAction(event);

  assert.equal(result.toast.content, 'ok');
  assert.equal(calls.length, 1, '提交必须被分派到到货核对（不能被当成销售草稿）');
  assert.deepEqual(calls[0].formValue, { actual_arrival: '38 码少一双' }, 'form_value 原样带下去');
  assert.equal(calls[0].operatorOpenId, 'ou_1');
  assert.equal(calls[0].cardMessageId, 'om_card_1');
  assert.equal(calls[0].value.draft_id, 'arrival_reconcile_1');
});

test('表单⑫：源码级断言 —— 提交这条路**没有第二套解析**，它复用话题那条锁定管道', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/services/purchaseArrivalConversationService.js'), 'utf8',
  );
  const parseCalls = source.match(/parseArrivalReconciliation/g) || [];
  assert.equal(parseCalls.length, 1, '整条链路只有一处调模型解析（提交与"在话题里说"共用它）');
  assert.match(source, /handleTopicMessageLocked/, '提交入口必须复用话题那条锁定管道');
  const planCalls = source.match(/this\.buildPlan\(/g) || [];
  assert.equal(planCalls.length, 1, '算计划也只有一处（提交不另造一套差异比对）');
});

