// 「采购到货：群话题对话式核对」的验收测试。
//
// 规格：`docs/arrival-conversation-flow.md`（业务负责人 2026-10-06 定稿）。
// **一条用例对应验收标准里的一条**，尤其是两条最容易被"写在文档里就算过了"的：
//   · 核对期间**一张表都不写**（§5.1）——断言 gateway 的 create/update 调用数为 0；
//   · 「单据信息」（采购申请表）**一个字都没变**（§5.2 ⑤）——前后**全表快照 deepEqual**，
//     并单独盯住「到货状态」列不可被改写。
//
// ⚠️ 这里用的是**项目自己的代码**：ArrivalConversationService / PurchaseWebhookService /
//    InventoryService 都是真的（库存那一层跑的是真 applyPurchase），只有"模型"和"飞书"
//    这两个外部依赖是假的。所以断言的是"项目链路真的这么干"，不是"CLI 把表改了"。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ArrivalConversationService } = require('../src/services/arrivalConversationService');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const { InventoryService } = require('../src/services/inventoryService');
const { V1ReferenceResolver } = require('../src/services/v1ReferenceResolver');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { LarkMvpService } = require('../src/services/larkMvpService');
const {
  ARRIVAL_CONFIRM_ACTION,
  ZERO_ARRIVAL_REPLY,
} = require('../src/config/arrivalConversation');
// 入口开关复用当初为「对话到货」刻意保留的那一个（不新加第二个开关）。
const {
  isPurchaseArrivalIntakeEnabled,
} = require('../src/config/purchaseArrivalIntake');

// 拼接货品记录链接要读 Base token；本地/CI 没有真配置时给个测试值。
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const table = (key) => V1_BITABLE_SCHEMA.tables[key];
const tempDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `arrival-${name}-`));

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

// 会记账的假网关：`writes` 就是"有没有写业务表"的唯一判据。
const makeGateway = (records = {}) => {
  const writes = [];
  return {
    writes,
    table,
    get: async (tableKey, recordId) => (records[tableKey] || []).find((r) => r.record_id === recordId) || null,
    listAll: async (tableKey) => records[tableKey] || [],
    create: async (tableKey, semanticValues) => {
      const fields = mapFields(tableKey, semanticValues);
      const recordId = `new_${tableKey}_${(records[tableKey] || []).length}_${Math.random().toString(36).slice(2, 6)}`;
      const record = { record_id: recordId, fields };
      (records[tableKey] ||= []).push(record);
      writes.push({ op: 'create', tableKey, recordId, fields });
      return { recordId, record };
    },
    update: async (tableKey, recordId, semanticValues) => {
      const fields = mapFields(tableKey, semanticValues);
      writes.push({ op: 'update', tableKey, recordId, fields });
      const record = (records[tableKey] || []).find((r) => r.record_id === recordId);
      if (record) record.fields = { ...record.fields, ...fields };
      return record || { record_id: recordId };
    },
    delete: async (tableKey, recordId) => {
      writes.push({ op: 'delete', tableKey, recordId });
      records[tableKey] = (records[tableKey] || []).filter((r) => r.record_id !== recordId);
    },
  };
};

const SIZE_LINKS = [36, 37, 38].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));
const sizeLink = (size) => [`size_${size}`];
const BATCH_NO = 'BH-20261006-0001';
const BATCH_ID = 'batch_1';
const PRODUCT_ID = 'prod_8088_brown';

// 基准场景：同一货号两个尺码（36 申请 2 双 / 38 申请 1 双）。
const baseRecords = () => ({
  purchaseOrderBatch: [{ record_id: BATCH_ID, fields: { 报货批次号: BATCH_NO } }],
  product: [{
    record_id: PRODUCT_ID,
    fields: { 货号: '8088', 颜色: [{ text: '棕' }], 编号: '8088棕' },
  }],
  purchaseRequest: [
    { record_id: 'req_36', fields: { 报货批次号: [BATCH_ID], 编号: [PRODUCT_ID], 尺码: sizeLink(36), 数量: 2 } },
    { record_id: 'req_38', fields: { 报货批次号: [BATCH_ID], 编号: [PRODUCT_ID], 尺码: sizeLink(38), 数量: 1 } },
  ],
  behavior: [{
    record_id: 'behavior_purchase_in',
    fields: { 行为名称: '采购入库', 行为编码: 'STOCK_PURCHASE_INCREASE', 库存方向: '增加', 是否启用: true },
  }],
  sizeManagement: SIZE_LINKS,
  purchaseArrival: [],
  purchaseInbound: [],
  inventoryLedger: [],
  liveInventory: [],
});

const REQUEST_IDS = ['req_36', 'req_38'];

const makeHarness = (options = {}) => {
  const records = options.records || baseRecords();
  const gateway = makeGateway(records);
  const inventory = new InventoryService({
    gateway,
    store: new JsonTaskStore({ dir: tempDir('inv'), idField: 'operation_id' }),
  });
  const purchaseWebhooks = new PurchaseWebhookService({
    gateway,
    references: new V1ReferenceResolver(gateway),
    recognizer: {},
    inventory,
    client: {},
    store: new JsonTaskStore({ dir: tempDir('webhook'), idField: 'task_id' }),
    images: { render: async () => Buffer.from('fake-png') },
    gatewayTimeoutMs: 0,
    batchReadMaxRetries: 1,
    batchReadRetryDelay: 0,
    batchLocatorStore: new JsonTaskStore({ dir: tempDir('locator'), idField: 'task_id' }),
  });
  const cards = [];
  const replies = [];
  const patches = [];
  const understandCalls = [];
  const queue = [...(options.understanding || [])];
  let clock = options.now ?? Date.parse('2026-10-06T05:41:00.000Z'); // 上海 2026-10-06 13:41
  const service = new ArrivalConversationService({
    gateway,
    store: new JsonTaskStore({ dir: tempDir('conv'), idField: 'conversation_id' }),
    purchaseWebhooks,
    understand: async (input) => {
      understandCalls.push(input);
      const next = queue.length ? queue.shift() : { finalized: false, items: [] };
      return typeof next === 'function' ? next(input) : next;
    },
    replyCard: async (messageId, card) => { cards.push({ messageId, card }); return `card_${cards.length}`; },
    replyText: async (messageId, content) => { replies.push({ messageId, content }); return `reply_${replies.length}`; },
    updateCard: async (event, card, metadata) => { patches.push({ event, card, metadata }); return true; },
    // 不传 isEnabled = 用服务自己的默认（= 读 PURCHASE_ARRIVAL_INTAKE_ENABLED）。
    ...(options.isEnabled === undefined ? {} : { isEnabled: options.isEnabled }),
    now: () => clock,
  });
  return {
    records, gateway, inventory, purchaseWebhooks, service, cards, replies, patches, understandCalls,
    setNow: (value) => { clock = value; },
  };
};

const note = (harness, text, extra = {}) => harness.service.noteTopicMessage({
  batchNo: BATCH_NO,
  threadId: 'thr_1',
  chatId: 'oc_purchase',
  requestIds: REQUEST_IDS,
  messageId: extra.messageId || `om_${Math.random().toString(36).slice(2, 8)}`,
  text,
  senderOpenId: 'ou_her',
  ...extra,
});

const clickYes = (harness, conversationId) => harness.service.handleCardAction(
  { action: ARRIVAL_CONFIRM_ACTION, draft_id: conversationId, conversation_id: conversationId },
  'ou_her',
  { context: { open_message_id: 'om_card' } },
);

const buttonsOf = (card) => (card.elements || [])
  .filter((element) => element.tag === 'column_set')
  .flatMap((element) => (element.columns || []).flatMap((column) => column.elements || []))
  .filter((element) => element.tag === 'button');

const conversationIdOf = () => {
  const seed = BATCH_NO;
  // 与 service 里的 conversationKey 同一算法（导出的函数保证不会各写一份）。
  const { conversationKey } = require('../src/services/arrivalConversationService');
  return conversationKey(seed, 'thr_1');
};

// ─── ① 入口开关（配置先行）─────────────────────────────────────────────────

test('对话到货开关：复用 PURCHASE_ARRIVAL_INTAKE_ENABLED，只有显式 false 才关', () => {
  // 判定本身的细节由 test/larkEvents.test.js 钉住；这里确认**接的就是那一个**，
  // 不是又新加了一个同名不同义的开关（两个开关并存 = "她关了 A 链路还在跑"）。
  assert.equal(isPurchaseArrivalIntakeEnabled({}), true);
  assert.equal(isPurchaseArrivalIntakeEnabled({ PURCHASE_ARRIVAL_INTAKE_ENABLED: '' }), true);
  assert.equal(isPurchaseArrivalIntakeEnabled({ PURCHASE_ARRIVAL_INTAKE_ENABLED: 'true' }), true);
  assert.equal(isPurchaseArrivalIntakeEnabled({ PURCHASE_ARRIVAL_INTAKE_ENABLED: 'false' }), false);
  assert.equal(isPurchaseArrivalIntakeEnabled({ PURCHASE_ARRIVAL_INTAKE_ENABLED: ' FALSE ' }), false);
});

test('对话到货开关：服务默认读的确实就是那一个环境变量', async () => {
  const key = 'PURCHASE_ARRIVAL_INTAKE_ENABLED';
  const previous = process.env[key];
  const harness = makeHarness({ isEnabled: undefined }); // 不注入 → 用默认实现
  try {
    process.env[key] = 'false';
    const blocked = await note(harness, '都到了，核对完了');
    assert.equal(blocked.reason, 'disabled');
    assert.equal(harness.gateway.writes.length, 0);

    process.env[key] = 'true';
    const allowed = await note(harness, '都到了，核对完了');
    assert.equal(allowed.recorded, true);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test('对话到货开关显式关闭时：一句话都不记、一张表都不写', async () => {
  const harness = makeHarness({ isEnabled: () => false });
  const result = await note(harness, '都到了，核对完了');
  assert.deepEqual(result, { recorded: false, evaluated: false, state: '', reason: 'disabled' });
  assert.equal(harness.gateway.writes.length, 0);
  assert.equal(harness.cards.length, 0);
});

// ─── §5.1 核对期间（还没点「是」）───────────────────────────────────────────

test('§5.1 核对期间：只记录，四张表 + 采购申请表一个字都没写', async () => {
  const harness = makeHarness({
    // 两句都还没表达"核对完了"。
    understanding: [{ finalized: false, items: [] }, { finalized: false, items: [] }],
  });
  const before = JSON.parse(JSON.stringify(harness.records));

  const first = await note(harness, '到了 36 码两双');
  const second = await note(harness, '38 码还差一双没到');

  assert.equal(first.recorded, true);
  assert.equal(second.recorded, true);
  assert.equal(first.evaluated, false);
  assert.equal(second.evaluated, false);
  // 🔴 一张业务表都没写（四张业务表 + 采购申请表都在这个数里）。
  assert.deepEqual(harness.gateway.writes, [], '核对期间不允许有任何 create/update/delete');
  assert.deepEqual(harness.records, before, '核对期间所有表的内容必须一模一样');
  // 没有说"核对完了" → 不发卡片、也不回话（机器人不主动追问）。
  assert.equal(harness.cards.length, 0);
  assert.equal(harness.replies.length, 0);

  const conversation = await harness.service.store.get(conversationIdOf());
  assert.equal(conversation.messages.length, 2);
  assert.deepEqual(conversation.messages.map((m) => m.text), ['到了 36 码两双', '38 码还差一双没到']);
  assert.equal(conversation.state, 'collecting');
});

test('§5.1 核对期间：同一条消息被飞书重投 → 不重复记录、不重复判意图', async () => {
  const harness = makeHarness({ understanding: [{ finalized: false, items: [] }] });
  await note(harness, '到了', { messageId: 'om_same' });
  const again = await note(harness, '到了', { messageId: 'om_same' });

  assert.equal(again.recorded, false);
  assert.equal(again.reason, 'duplicate_message');
  const conversation = await harness.service.store.get(conversationIdOf());
  assert.equal(conversation.messages.length, 1);
  assert.equal(harness.understandCalls.length, 1, '重投不能让模型再判一次');
  assert.equal(harness.gateway.writes.length, 0);
});

// ─── ③④ 判「核对完了」+ 发确认卡片 ─────────────────────────────────────────

test('③④ 说了「核对完了」：往话题里发一张只有「是」的确认卡片，仍然零表写入', async () => {
  const harness = makeHarness({
    understanding: [{ finalized: true, items: [{ index: 0, quantity: 2 }, { index: 1, quantity: 1 }] }],
  });
  const before = JSON.parse(JSON.stringify(harness.records));
  const result = await note(harness, '都到了，核对完了', { messageId: 'om_final' });

  assert.equal(result.evaluated, true);
  assert.equal(result.state, 'awaiting_confirmation');
  assert.equal(harness.cards.length, 1);
  // 卡片发在她说话的那条消息下（一定落在同一个话题里）。
  assert.equal(harness.cards[0].messageId, 'om_final');
  const card = harness.cards[0].card;
  assert.equal(card.header.title.content, '本次到货核对完毕，确认入库吗？');
  const buttons = buttonsOf(card);
  assert.equal(buttons.length, 1, '规格只写了「是」一个按钮，不加「否 / 再想想」');
  assert.equal(buttons[0].text.content, '是');
  assert.equal(buttons[0].value.action, ARRIVAL_CONFIRM_ACTION);
  assert.equal(buttons[0].value.draft_id, conversationIdOf());
  // 发卡片本身不是写业务表：核对期间仍然一个字都没写。
  assert.deepEqual(harness.gateway.writes, []);
  assert.deepEqual(harness.records, before);
  assert.equal(harness.replies.length, 0, '还没入库，不回结果');
});

test('③④ 卡片已经发出去之后再说话：不重复发卡片、不重复回话', async () => {
  const harness = makeHarness({
    understanding: [
      { finalized: true, items: [{ index: 0, quantity: 2 }, { index: 1, quantity: 1 }] },
      { finalized: true, items: [{ index: 0, quantity: 2 }, { index: 1, quantity: 1 }] },
    ],
  });
  await note(harness, '核对完了');
  const second = await note(harness, '就这样吧');

  assert.equal(second.recorded, true);
  assert.equal(second.evaluated, false);
  assert.equal(second.reason, 'state_awaiting_confirmation');
  assert.equal(harness.cards.length, 1, '不能重复发卡片');
  assert.equal(harness.replies.length, 0);
  assert.equal(harness.understandCalls.length, 1, '已经定了就不必再问模型');
});

// ─── §5.2 点「是」之后 —— 入库点 ───────────────────────────────────────────

const finalizedHarness = (items = [{ index: 0, quantity: 2 }, { index: 1, quantity: 1 }]) =>
  makeHarness({ understanding: [{ finalized: true, items }] });

test('§5.2 ① 采购到货：新增 1 行，带「到货日」+「验收原话」+ 确认状态=已确认', async () => {
  const harness = finalizedHarness();
  await note(harness, '都到了，核对完了');
  const harnessNow = Date.parse('2026-10-06T05:41:00.000Z'); // 上海 13:41
  harness.setNow(harnessNow);

  await clickYes(harness, conversationIdOf());

  const arrivals = harness.records.purchaseArrival;
  assert.equal(arrivals.length, 1, '「采购到货」只新增一行');
  const fields = arrivals[0].fields;
  // ④ 到货日 = 她点「是」那一刻的时间戳。
  assert.equal(fields[table('purchaseArrival').fields.arrivalAt], harnessNow);
  // ⑦ 验收原话 = 最后那句"核对完了"的原话。
  assert.equal(fields[table('purchaseArrival').fields.acceptanceText], '都到了，核对完了');
  assert.equal(fields[table('purchaseArrival').fields.confirmStatus], '已确认');
  assert.deepEqual(fields[table('purchaseArrival').fields.batch], [BATCH_ID]);
});

test('§5.2 ②③④ 采购入库 / 库存流水 / 实时库存都按**实际**数量写，且粒度与既有入库一致', async () => {
  const harness = finalizedHarness([{ index: 0, quantity: 3 }, { index: 1, quantity: 1 }]);
  await note(harness, '到了 36 三双、38 一双，核对完了');
  await clickYes(harness, conversationIdOf());

  // ② 采购入库：每条（货品+尺码）一行，数量 = 实际数（36 是 3 而不是申请的 2）。
  const inbounds = harness.records.purchaseInbound;
  assert.equal(inbounds.length, 2);
  const bySize = new Map(inbounds.map((row) => [row.fields[table('purchaseInbound').fields.size][0], row]));
  assert.equal(bySize.get('size_36').fields[table('purchaseInbound').fields.quantity], 3);
  assert.equal(bySize.get('size_38').fields[table('purchaseInbound').fields.quantity], 1);
  assert.equal(bySize.get('size_36').fields[table('purchaseInbound').fields.behavior][0], 'behavior_purchase_in');
  // 「采购到货批次」关联到 ① 那一行。
  assert.deepEqual(
    bySize.get('size_36').fields[table('purchaseInbound').fields.batch],
    [harness.records.purchaseArrival[0].record_id],
  );

  // ③ 库存流水：一个尺码一行，变动数量 = 该尺码实际双数，「关联采购」指向 ② 的入库行。
  const ledgers = harness.records.inventoryLedger;
  assert.equal(ledgers.length, 2, '一个尺码一行');
  const ledgerBySize = new Map(ledgers.map((row) => [row.fields[table('inventoryLedger').fields.size][0], row]));
  assert.equal(ledgerBySize.get('size_36').fields[table('inventoryLedger').fields.quantityChange], 3);
  assert.equal(ledgerBySize.get('size_38').fields[table('inventoryLedger').fields.quantityChange], 1);
  assert.deepEqual(
    ledgerBySize.get('size_36').fields[table('inventoryLedger').fields.purchaseInbound],
    [bySize.get('size_36').record_id],
  );
  assert.equal(ledgerBySize.get('size_36').fields[table('inventoryLedger').fields.behavior][0], 'behavior_purchase_in');

  // ④ 实时库存：按实际数增加（一双一条是既有粒度）。
  const live = harness.records.liveInventory;
  assert.equal(live.length, 4, '3 + 1 双 = 4 条实时库存');
  const liveBySize = live.reduce((acc, row) => {
    const key = row.fields[table('liveInventory').fields.size][0];
    acc.set(key, (acc.get(key) || 0) + 1);
    return acc;
  }, new Map());
  assert.equal(liveBySize.get('size_36'), 3);
  assert.equal(liveBySize.get('size_38'), 1);
});

test('🔴 §5.2 ⑤ 「单据信息」（采购申请表）一个字都没变：全表快照 + 到货状态列不可改写', async () => {
  const harness = finalizedHarness([{ index: 0, quantity: 3 }, { index: 1, quantity: 0 }]);
  await note(harness, '36 码到了三双，38 一双没到，核对完了');
  const requestsBefore = JSON.parse(JSON.stringify(harness.records.purchaseRequest));

  await clickYes(harness, conversationIdOf());

  // ① 全表快照：内容与顺序都要一模一样。
  assert.deepEqual(harness.records.purchaseRequest, requestsBefore);
  // ② 专项：**没有任何**对采购申请表的写操作（create / update / delete）。
  const requestWrites = harness.gateway.writes.filter((write) => write.tableKey === 'purchaseRequest');
  assert.deepEqual(requestWrites, [], '「单据信息」一个字都不许写');
  // ③ 专项：到货状态列不可被改写（哪怕写成同一个值也算改）。
  const arrivalStatusField = table('purchaseRequest').fields.arrivalStatus;
  for (const row of harness.records.purchaseRequest) {
    assert.equal(row.fields[arrivalStatusField], undefined, '到货状态列不允许被写');
  }
  for (const write of harness.gateway.writes) {
    assert.equal(Object.prototype.hasOwnProperty.call(write.fields || {}, arrivalStatusField), false,
      `不允许出现写到货状态的写入：${JSON.stringify(write)}`);
  }
});

test('§5.2 ⑥ 群里回一句结果 + 那张卡片变成「已入库」', async () => {
  const harness = finalizedHarness();
  await note(harness, '都到了，核对完了');
  await clickYes(harness, conversationIdOf());

  assert.equal(harness.replies.length, 1, '群里回一句结果');
  assert.match(harness.replies[0].content, /已入库/);
  assert.match(harness.replies[0].content, /采购申请表一个字都没有改/);
  assert.equal(harness.patches.length, 1);
  assert.equal(harness.patches[0].card.header.title.content, '已入库');
  assert.equal(buttonsOf(harness.patches[0].card).length, 0, '入库之后卡片不该再留按钮');
});

test('§5.2 重复点「是」/ 重复投递 → 幂等，不重复入库', async () => {
  const harness = finalizedHarness([{ index: 0, quantity: 2 }, { index: 1, quantity: 1 }]);
  await note(harness, '都到了，核对完了');

  const conversationId = conversationIdOf();
  const first = await clickYes(harness, conversationId);
  const writesAfterFirst = harness.gateway.writes.length;
  const second = await clickYes(harness, conversationId);
  const third = await clickYes(harness, conversationId);

  assert.match(first.toast.content, /已入库/);
  assert.match(second.toast.content, /已经入过库/);
  assert.match(third.toast.content, /已经入过库/);
  assert.equal(harness.gateway.writes.length, writesAfterFirst, '重复点击不再产生任何写入');
  assert.equal(harness.records.purchaseArrival.length, 1);
  assert.equal(harness.records.purchaseInbound.length, 2);
  assert.equal(harness.records.inventoryLedger.length, 2);
  assert.equal(harness.records.liveInventory.length, 3);
  assert.equal(harness.patches.length, 1, '只 patch 一次卡片');
});

test('幂等（任务层）：同一个到货任务 confirmArrivalForConversation 连调两次 → 只入一次库', async () => {
  const harness = finalizedHarness([{ index: 0, quantity: 2 }, { index: 1, quantity: 1 }]);
  await note(harness, '都到了，核对完了');
  await clickYes(harness, conversationIdOf());

  const taskId = `arrival_conversation_${require('node:crypto').createHash('sha256').update(BATCH_NO).digest('hex').slice(0, 24)}`;
  const before = JSON.parse(JSON.stringify(harness.records.purchaseInbound));
  // 直接把任务那一层的入口再调一次（模拟"卡片回调重投到同一个任务"）。
  const again = await harness.purchaseWebhooks.confirmArrivalForConversation(taskId, 'ou_her');
  assert.equal(again.alreadyPosted, true);
  assert.deepEqual(harness.records.purchaseInbound, before);
});

// ─── §5.3 异常（按【保守默认】落地）────────────────────────────────────────

test('异常① 实际 > 申请：照实际入库 + 群里回一句说明，且不回写申请表', async () => {
  const harness = finalizedHarness([{ index: 0, quantity: 5 }, { index: 1, quantity: 1 }]);
  await note(harness, '36 码到了五双，核对完了');
  const requestsBefore = JSON.parse(JSON.stringify(harness.records.purchaseRequest));
  // 卡片上就先让她看见（点确认之前有机会发现数说错了）。
  assert.match(JSON.stringify(harness.cards[0].card), /多了 3 双/);

  await clickYes(harness, conversationIdOf());

  const inbounds = harness.records.purchaseInbound;
  const bySize = new Map(inbounds.map((row) => [row.fields[table('purchaseInbound').fields.size][0], row]));
  assert.equal(bySize.get('size_36').fields[table('purchaseInbound').fields.quantity], 5, '照实际数量入库');
  assert.equal(harness.records.inventoryLedger
    .find((row) => row.fields[table('inventoryLedger').fields.size][0] === 'size_36')
    .fields[table('inventoryLedger').fields.quantityChange], 5);
  const reply = harness.replies.map((item) => item.content).join('\n');
  assert.match(reply, /多了 3 双/, '超额必须在群里告诉她');
  assert.match(reply, /采购申请表没有改动/);
  assert.deepEqual(harness.records.purchaseRequest, requestsBefore, '超额也不许改采购申请表');
});

test('异常② 实际 = 0：拒绝入库 + 回一句 + 零写入（这是规则，不是错误）', async () => {
  const harness = finalizedHarness([{ index: 0, quantity: 0 }, { index: 1, quantity: 0 }]);
  const before = JSON.parse(JSON.stringify(harness.records));

  const result = await note(harness, '这次一双都没到，核对完了');

  assert.equal(result.evaluated, true);
  assert.equal(result.reason, 'zero_arrival');
  assert.equal(harness.cards.length, 0, '全没到就不该发"确认入库吗"的卡片');
  assert.equal(harness.replies.length, 1);
  assert.equal(harness.replies[0].content, ZERO_ARRIVAL_REPLY);
  assert.deepEqual(harness.gateway.writes, [], '零写入');
  assert.deepEqual(harness.records, before, '一张表都不许改');
  // 会话留在 collecting：她改表再发一次还能重新核对。
  const conversation = await harness.service.store.get(conversationIdOf());
  assert.equal(conversation.state, 'collecting');

  // 她又强调了一遍同一个意思：**同一句话只回一次**（"不重复回话"）。
  harness.service.understand = async () => ({ finalized: true, items: [{ index: 0, quantity: 0 }, { index: 1, quantity: 0 }] });
  await note(harness, '真的没到');
  assert.equal(harness.replies.length, 1, '同一句规则说明不重复刷屏');
  assert.deepEqual(harness.gateway.writes, [], '零写入');
});

test('异常② 兜底：真要是在"全没到"的会话上点了「是」，也零写入', async () => {
  const harness = finalizedHarness([{ index: 0, quantity: 0 }, { index: 1, quantity: 0 }]);
  await note(harness, '一双都没到，核对完了');
  // 手工把会话摆成"待确认"（模拟卡片在别的情况下被点到），验证兜底那一道。
  await harness.service.store.update(conversationIdOf(), { state: 'awaiting_confirmation' });
  const writesBefore = harness.gateway.writes.length;

  const result = await clickYes(harness, conversationIdOf());

  assert.match(result.toast.content, /一双都没到/);
  assert.equal(harness.gateway.writes.length, writesBefore, '零写入');
  assert.equal(harness.records.purchaseArrival.length, 0);
  assert.equal(harness.records.purchaseInbound.length, 0);
});

test('异常③ 只到部分尺码：未到的尺码不留任何记录', async () => {
  const harness = finalizedHarness([{ index: 0, quantity: 2 }, { index: 1, quantity: 0 }]);
  await note(harness, '36 码到了，38 没到，核对完了');

  // 卡片上也只有到的那一条。
  const cardText = JSON.stringify(harness.cards[0].card);
  assert.match(cardText, /36/);
  assert.doesNotMatch(cardText, /38/);

  await clickYes(harness, conversationIdOf());

  assert.equal(harness.records.purchaseInbound.length, 1);
  assert.equal(harness.records.purchaseInbound[0].fields[table('purchaseInbound').fields.size][0], 'size_36');
  assert.equal(harness.records.inventoryLedger.length, 1);
  assert.equal(harness.records.liveInventory.length, 2);
  assert.equal(harness.records.liveInventory
    .every((row) => row.fields[table('liveInventory').fields.size][0] === 'size_36'), true);
});

test('异常③ 模型给的行号越界 / 数量非法：忽略并记日志，绝不自己编一条明细', async () => {
  const harness = makeHarness({
    understanding: [{
      finalized: true,
      items: [{ index: 0, quantity: 2 }, { index: 9, quantity: 3 }, { index: 1, quantity: -1 }],
    }],
  });
  await note(harness, '核对完了');
  await clickYes(harness, conversationIdOf());

  assert.equal(harness.records.purchaseInbound.length, 1, '只有基准里那一行有效');
  assert.equal(harness.records.purchaseInbound[0].fields[table('purchaseInbound').fields.size][0], 'size_36');
  assert.equal(harness.records.purchaseInbound[0].fields[table('purchaseInbound').fields.quantity], 2);
});

test('④「到货日」取她点「是」那一刻的**上海**日期（不是 UTC 日期）', async () => {
  const harness = finalizedHarness([{ index: 0, quantity: 1 }, { index: 1, quantity: 0 }]);
  await note(harness, '核对完了');
  // 2026-10-05T16:30:00Z = 上海 2026-10-06 00:30 → 到货日必须是 10-06（上海），不是 10-05（UTC）。
  const clickAt = Date.parse('2026-10-05T16:30:00.000Z');
  harness.setNow(clickAt);

  await clickYes(harness, conversationIdOf());

  const arrival = harness.records.purchaseArrival[0];
  assert.equal(arrival.fields[table('purchaseArrival').fields.arrivalAt], clickAt);
  const { arrivalDateOf } = require('../src/config/arrivalConversation');
  assert.equal(arrivalDateOf(arrival.fields[table('purchaseArrival').fields.arrivalAt]), '2026-10-06');
});

test('§4.2 待改 2：模型判完了但基准一条都对不上 → 不入库、不猜、明确回一句', async () => {
  const harness = makeHarness({
    records: { ...baseRecords(), purchaseRequest: [] },
    understanding: [{ finalized: true, items: [{ index: 0, quantity: 1 }] }],
  });
  const before = JSON.parse(JSON.stringify(harness.records));
  const result = await note(harness, '核对完了');

  assert.equal(result.reason, 'baseline_missing');
  assert.deepEqual(harness.gateway.writes, []);
  assert.deepEqual(harness.records, before);
  assert.equal(harness.cards.length, 0);
});

test('模型给的行号全都对不上基准 → 不入库、明确回一句（与"全没到"分开）', async () => {
  const harness = makeHarness({
    understanding: [{ finalized: true, items: [{ index: 7, quantity: 1 }, { index: 8, quantity: 2 }] }],
  });
  const before = JSON.parse(JSON.stringify(harness.records));
  const result = await note(harness, '核对完了');

  assert.equal(result.reason, 'actual_unmatched');
  assert.deepEqual(harness.gateway.writes, []);
  assert.deepEqual(harness.records, before);
  assert.equal(harness.cards.length, 0, '行号都没对上，不能发"确认入库吗"的卡片');
  assert.equal(harness.replies.length, 1);
});

test('模型调用失败：只记日志、不猜、不写表、不追问', async () => {
  const harness = makeHarness({ understanding: [() => { throw new Error('模型挂了'); }] });
  const result = await note(harness, '核对完了');

  assert.equal(result.evaluated, false);
  assert.equal(result.reason, 'intent_judgement_failed');
  assert.equal(harness.gateway.writes.length, 0);
  assert.equal(harness.cards.length, 0);
  assert.equal(harness.replies.length, 0);
});

// ─── 接线：话题消息（免 @）→ 核对 → 卡片 → 入库 ────────────────────────────

test('接线：话题里没 @ 机器人也进到货核对，且此时零表写入（卡片进了同一话题）', async () => {
  const harness = makeHarness({ understanding: [{ finalized: true, items: [{ index: 0, quantity: 2 }, { index: 1, quantity: 1 }] }] });
  const service = new LarkMvpService({
    client: {},
    gateway: harness.gateway,
    references: {},
    recognizer: {},
    store: new JsonTaskStore({ dir: tempDir('lark'), idField: 'task_id' }),
    purchaseWebhooks: harness.purchaseWebhooks,
    arrivalConversations: harness.service,
    purchaseBatchLocatorStore: new JsonTaskStore({ dir: tempDir('locator2'), idField: 'task_id' }),
    botOpenId: 'ou_bot',
  });
  service.acknowledgeMessage = async () => undefined;
  // 机器人发采购单时记下的映射：这条话题 ↔ 这一批。
  await service.purchaseBatchLocator.rememberGroupMessage({
    batchNo: BATCH_NO, messageId: 'om_batch_root', threadId: 'thr_lark', chatId: 'oc_g',
    requestIds: REQUEST_IDS, suppliers: [], detailCount: 2,
  });

  const result = await service.acceptMessage({
    sender: { sender_id: { open_id: 'ou_her' } },
    message: {
      message_id: 'om_topic_msg',
      chat_id: 'oc_g',
      chat_type: 'group',
      message_type: 'text',
      thread_id: 'thr_lark',
      mentions: [], // 话题里**没有 @**：判据是先看 thread_id
      content: JSON.stringify({ text: '都到了，核对完了' }),
    },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.arrival.evaluated, true);
  assert.equal(harness.cards.length, 1, '卡片要发进话题里');
  // 卡片回复的是**她说话的那条消息**，所以一定落在同一个话题下。
  assert.equal(harness.cards[0].messageId, 'om_topic_msg');
  assert.equal(harness.cards[0].card.header.title.content, '本次到货核对完毕，确认入库吗？');
  assert.deepEqual(harness.gateway.writes, [], '核对期间仍然零表写入');
});

// ─── 接线：卡片回调 → 入库 ─────────────────────────────────────────────────

test('接线：卡片回调（LarkMvpService.handleCardAction）能走到入库，且采购申请表不变', async () => {
  const harness = finalizedHarness([{ index: 0, quantity: 2 }, { index: 1, quantity: 1 }]);
  await note(harness, '都到了，核对完了');
  const service = new LarkMvpService({
    client: {},
    gateway: harness.gateway,
    references: {},
    recognizer: {},
    store: new JsonTaskStore({ dir: tempDir('lark3'), idField: 'task_id' }),
    purchaseWebhooks: harness.purchaseWebhooks,
    arrivalConversations: harness.service,
    purchaseBatchLocatorStore: new JsonTaskStore({ dir: tempDir('locator4'), idField: 'task_id' }),
    botOpenId: 'ou_bot',
  });
  const requestsBefore = JSON.parse(JSON.stringify(harness.records.purchaseRequest));

  // 飞书卡片回调事件的最小形状（value 里就是卡片按钮带的那些字段）。
  const result = await service.handleCardAction({
    action: { value: { action: ARRIVAL_CONFIRM_ACTION, draft_id: conversationIdOf() } },
    operator: { operator_id: { open_id: 'ou_her' } },
    context: { open_message_id: 'om_card' },
  });

  assert.match(result.toast.content, /已入库/);
  assert.equal(harness.records.purchaseArrival.length, 1);
  assert.equal(harness.records.purchaseInbound.length, 2);
  assert.deepEqual(harness.records.purchaseRequest, requestsBefore);
  assert.equal(harness.gateway.writes.filter((write) => write.tableKey === 'purchaseRequest').length, 0);
});

test('§4.2 待改 2：ensureConversationArrival 重复调用只建/找回一条「采购到货」', async () => {
  const harness = finalizedHarness([{ index: 0, quantity: 2 }, { index: 1, quantity: 1 }]);
  await note(harness, '都到了，核对完了');
  const input = {
    batchNo: BATCH_NO,
    requestIds: REQUEST_IDS,
    actual: [{ product_record_id: PRODUCT_ID, item_no: '8088', color: '棕', size: 36, quantity: 2 }],
    acceptanceText: '都到了，核对完了',
    occurredAt: Date.parse('2026-10-06T05:41:00.000Z'),
    operatorOpenId: 'ou_her',
  };
  const first = await harness.purchaseWebhooks.ensureConversationArrival(input);
  const second = await harness.purchaseWebhooks.ensureConversationArrival(input);

  assert.equal(first.taskId, second.taskId, '任务 id 由批次号确定性推导');
  assert.equal(first.arrivalRecordId, second.arrivalRecordId);
  assert.equal(harness.records.purchaseArrival.length, 1, '「采购到货」只有一行');
  assert.equal(first.created, true);
  assert.equal(second.created, false);
});

test('基准靠批次号找回（映射没带 request_ids）时，点「是」照样能入库', async () => {
  const harness = makeHarness({ understanding: [{ finalized: true, items: [{ index: 0, quantity: 2 }, { index: 1, quantity: 1 }] }] });
  // 历史映射可能没记 request_ids：这一条走"按批次号找申请行"那条兜底。
  await harness.service.noteTopicMessage({
    batchNo: BATCH_NO, threadId: 'thr_1', chatId: 'oc_purchase', requestIds: [],
    messageId: 'om_legacy', text: '都到了，核对完了', senderOpenId: 'ou_her',
  });
  assert.equal(harness.cards.length, 1);

  const result = await clickYes(harness, conversationIdOf());

  assert.match(result.toast.content, /已入库/);
  assert.equal(harness.records.purchaseArrival.length, 1);
  assert.equal(harness.records.purchaseInbound.length, 2, '入库行要挂回对应的采购申请行');
});

test('接线：认不出是哪一批时，不进到货核对（还是反问那一句）', async () => {
  const harness = makeHarness();
  const service = new LarkMvpService({
    client: { im: { message: { reply: async () => ({ code: 0 }), create: async () => ({ code: 0 }) } } },
    gateway: harness.gateway,
    references: {},
    recognizer: {},
    store: new JsonTaskStore({ dir: tempDir('lark2'), idField: 'task_id' }),
    purchaseWebhooks: harness.purchaseWebhooks,
    arrivalConversations: harness.service,
    purchaseBatchLocatorStore: new JsonTaskStore({ dir: tempDir('locator3'), idField: 'task_id' }),
    botOpenId: 'ou_bot',
  });
  service.acknowledgeMessage = async () => undefined;

  const result = await service.acceptMessage({
    sender: { sender_id: { open_id: 'ou_her' } },
    message: {
      message_id: 'om_unknown',
      chat_id: 'oc_g',
      chat_type: 'group',
      message_type: 'text',
      thread_id: 'thr_unknown',
      mentions: [],
      content: JSON.stringify({ text: '都到了，核对完了' }),
    },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.resolved, false);
  assert.equal(result.arrival, undefined);
  assert.equal(harness.cards.length, 0);
  assert.equal(harness.understandCalls.length, 0, '认不出批次就不该去调模型');
  assert.equal(harness.gateway.writes.length, 0);
});
