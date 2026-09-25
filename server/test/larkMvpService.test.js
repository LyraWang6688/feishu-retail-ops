const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService, aggregateRecognizedItems, looksLikeSalesText } = require('../src/services/larkMvpService');

const makeStore = () =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lark-mvp-test-')), idField: 'task_id' });

const makeService = () => {
  const sent = [];
  const service = new LarkMvpService({
    client: {},
    gateway: {},
    references: {},
    posting: {},
    recognizer: {},
    store: makeStore(),
  });
  service.sendText = async (openId, message) => sent.push({ openId, message });
  service.acknowledgeMessage = async () => undefined;
  service.processSalesTask = async () => undefined;
  return { service, sent };
};

test('private text is accepted as sales input and repeated message id is deduplicated', async () => {
  const { service } = makeService();
  const event = {
    sender: { sender_id: { open_id: 'ou_1' } },
    message: {
      message_id: 'om_1',
      chat_type: 'p2p',
      message_type: 'text',
      create_time: '1000',
      content: JSON.stringify({ text: 'A100 38码一双，100元微信' }),
    },
  };
  const first = await service.acceptMessage(event);
  const second = await service.acceptMessage(event);
  assert.equal(first.accepted, true);
  assert.equal(first.type, 'sale');
  assert.equal(second.reason, 'duplicate');
});

test('group messages are ignored even when message content is valid', async () => {
  const { service } = makeService();
  const result = await service.acceptMessage({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: {
      message_id: 'om_group',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: 'A100 38码一双' }),
    },
  });
  assert.deepEqual(result, { accepted: false, reason: 'not_p2p' });
});

test('ordinary private chat without numbers is not accepted as a sales task', async () => {
  const { service } = makeService();
  const result = await service.acceptMessage({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: {
      message_id: 'om_chat',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '好的' }),
    },
  });
  assert.deepEqual(result, { accepted: false, reason: 'not_sales_candidate' });
  assert.equal(looksLikeSalesText('好的'), false);
  assert.equal(looksLikeSalesText('8088-26棕38，230元微信'), true);
});

test('purchase images are isolated by private-chat sender and wait for explicit completion', async () => {
  const { service, sent } = makeService();
  const imageEvent = (messageId, openId) => ({
    sender: { sender_id: { open_id: openId } },
    message: {
      message_id: messageId,
      chat_type: 'p2p',
      message_type: 'image',
      create_time: '1000',
      content: JSON.stringify({ image_key: `img_${messageId}` }),
    },
  });
  await service.acceptMessage(imageEvent('om_1', 'ou_1'));
  await service.acceptMessage(imageEvent('om_2', 'ou_1'));
  await service.acceptMessage(imageEvent('om_3', 'ou_2'));
  assert.match(sent[1].message, /第 2 张/);
  const user1 = await service.store.get(require('../src/services/larkMvpService').idFor('purchase_open', 'ou_1'));
  const user2 = await service.store.get(require('../src/services/larkMvpService').idFor('purchase_open', 'ou_2'));
  assert.equal(user1.images.length, 2);
  assert.equal(user2.images.length, 1);
});

test('recognized purchase items with same SKU and size are aggregated', () => {
  assert.deepEqual(
    aggregateRecognizedItems([
      { item_no: 'A100', color: '黑', size: 38, quantity: 1 },
      { item_no: 'A100', color: '黑', size: 38, quantity: 2 },
    ]),
    [{ item_no: 'A100', color: '黑', size: 38, quantity: 3 }]
  );
});

test('sales intake keeps behavior in draft and writes only intake metadata before confirmation', async () => {
  const store = makeStore();
  const calls = [];
  const cards = [];
  const service = new LarkMvpService({
    client: {},
    gateway: {
      validateTables: async () => [],
      table: () => ({ fields: { number: '编号' } }),
      create: async (tableKey, fields) => {
        calls.push({ operation: 'create', tableKey, fields });
        return { recordId: 'rec_sales_entry' };
      },
      update: async (tableKey, recordId, fields) => {
        calls.push({ operation: 'update', tableKey, recordId, fields });
      },
    },
    references: {
      resolveProduct: async () => ({
        recordId: 'rec_product',
        record: { fields: { 编号: '8088-26|棕|女鞋' } },
      }),
    },
    posting: {},
    recognizer: {
      parseSalesText: async () => ({
        intent: 'sale',
        sales_behavior: '现货销售',
        behavior_code: 'SALE_CASH',
        item_no: '8088-26',
        color: '棕',
        size: 38,
        quantity: 1,
        gift: true,
        gift_description: '袜子一双',
        total_paid: 230,
        payment_method: '微信',
        missing_fields: [],
      }),
    },
    store,
  });
  service.replyCard = async (messageId, card) => cards.push({ messageId, card });
  await store.create({
    task_id: 'sale_test',
    type: 'sale',
    status: 'received',
    message_id: 'om_internal_only',
    sender_open_id: 'ou_1',
    sent_at: 1000,
    original_text: '8088-26棕38，230元微信，赠袜子一双',
  });

  await service.processSalesTask('sale_test');

  const created = calls.find((call) => call.operation === 'create');
  assert.equal(created.tableKey, 'salesEntry');
  assert.equal('messageId' in created.fields, false);
  const parsedUpdate = calls.find(
    (call) => call.operation === 'update' && call.fields.parseStatus === '解析成功'
  );
  assert.equal('behavior' in parsedUpdate.fields, false);
  assert.equal(cards.length, 1);
  assert.match(JSON.stringify(cards[0].card), /现货销售/);
  assert.match(JSON.stringify(cards[0].card), /8088-26\|棕\|女鞋/);
  const task = await store.get('sale_test');
  assert.equal(task.draft.items[0].product_record_id, 'rec_product');
});

test('two products and two payments stay in one sales draft and confirmation card', async () => {
  const store = makeStore();
  const cards = [];
  const { normalizeSalesResult } = require('../src/services/doubaoService');
  const prices = { '93827': 100, '2115': 150 };
  const service = new LarkMvpService({
    client: {},
    gateway: {
      validateTables: async () => [],
      table: () => ({ fields: { number: '编号', price: '单价' } }),
      create: async () => ({ recordId: 'order_2' }),
      update: async () => undefined,
    },
    references: {
      resolveProduct: async ({ itemNo }) => ({ recordId: `product_${itemNo}`,
        record: { fields: { 编号: itemNo, 单价: prices[itemNo] } } }),
    },
    posting: {},
    recognizer: { parseSalesText: async () => normalizeSalesResult({ intent: 'sale', behavior_code: 'SALE_CASH',
      sales_behavior: '现货销售', agreed_total: 250,
      items: [{ item_no: '93827', color: '黑', size: 43, quantity: 1 },
        { item_no: '2115', color: '米', size: 37, quantity: 1 }],
      payments: [{ amount: 150, method: '微信' }, { amount: 100, method: '现金' }],
    }) },
    store,
  });
  service.replyCard = async (_messageId, card) => cards.push(card);
  await store.create({ task_id: 'multi_sale', type: 'sale', status: 'received', message_id: 'om_multi',
    sender_open_id: 'ou_1', sent_at: Date.now(), original_text: '两双鞋，250元' });
  await service.processSalesTask('multi_sale');
  const task = await store.get('multi_sale');
  assert.equal(task.status, 'ready_to_confirm');
  assert.equal(task.draft.items.length, 2);
  assert.equal(task.draft.payments.length, 2);
  assert.match(JSON.stringify(cards[0]), /93827/);
  assert.match(JSON.stringify(cards[0]), /2115/);
  assert.match(JSON.stringify(cards[0]), /现金/);
});

test('quoted sale amount differing from Bitable formula price requires correction', async () => {
  const store = makeStore();
  const messages = [];
  const { normalizeSalesResult } = require('../src/services/doubaoService');
  const service = new LarkMvpService({ client: {},
    gateway: { validateTables: async () => [], table: () => ({ fields: { number: '编号', price: '单价' } }),
      create: async () => ({ recordId: 'order_3' }), update: async () => undefined },
    references: { resolveProduct: async () => ({ recordId: 'product_1', record: { fields: { 编号: '815195B-6黑', 单价: 300 } } }) },
    posting: {},
    recognizer: { parseSalesText: async () => normalizeSalesResult({ intent: 'sale', behavior_code: 'SALE_CASH',
      items: [{ item_no: '815195B-6', color: '黑', size: 39, quantity: 1 }], payments: [], agreed_total: 260 }) },
    store,
  });
  service.sendText = async (_openId, message) => messages.push(message);
  await store.create({ task_id: 'unpaid_sale', type: 'sale', status: 'received', message_id: 'om_unpaid',
    sender_open_id: 'ou_1', sent_at: Date.now(), original_text: '815195B-6黑39码260元未付' });
  await service.processSalesTask('unpaid_sale');
  assert.equal((await store.get('unpaid_sale')).status, 'needs_info');
  assert.match(messages[0], /当前表结构无法保存差价/);
});

test('unsupported text is parsed but does not create a sales entry record', async () => {
  const store = makeStore();
  let createCount = 0;
  const sent = [];
  const service = new LarkMvpService({
    client: {},
    gateway: {
      create: async () => {
        createCount += 1;
        return { recordId: 'unexpected' };
      },
    },
    references: {},
    posting: {},
    recognizer: {
      parseSalesText: async () => ({
        intent: 'unsupported',
        sales_behavior: '换货',
        behavior_code: '',
        missing_fields: ['当前只支持现货销售'],
      }),
    },
    store,
  });
  service.sendText = async (openId, message) => sent.push({ openId, message });
  await store.create({
    task_id: 'sale_unsupported',
    type: 'sale',
    status: 'received',
    sender_open_id: 'ou_2',
    original_text: '换8088-26棕38码',
  });

  await service.processSalesTask('sale_unsupported');

  assert.equal(createCount, 0);
  assert.equal((await store.get('sale_unsupported')).status, 'ignored');
  assert.match(sent[0].message, /未写入销售主表/);
});

test('failed card posting returns the draft to a retryable state', async () => {
  const store = makeStore();
  await store.create({
    task_id: 'sale_retry',
    type: 'sale',
    status: 'ready_to_confirm',
    sender_open_id: 'ou_1',
    sales_entry_record_id: 'rec_entry',
    draft: {
      behavior_code: 'SALE_CASH',
      payment_method: '微信',
      total_paid: 230,
      items: [{ product_record_id: 'rec_product', item_no: '8088-26', color: '棕', size: 38, quantity: 1 }],
    },
  });
  const service = new LarkMvpService({
    client: {},
    gateway: {},
    references: {},
    posting: { postSale: async () => { throw new Error('temporary failure'); } },
    recognizer: {},
    store,
  });

  await assert.rejects(
    service.handleCardAction({
      operator: { operator_id: { open_id: 'ou_1' } },
      action: { value: { action: 'confirm_sale', draft_id: 'sale_retry' } },
    }),
    /temporary failure/,
  );

  const task = await store.get('sale_retry');
  assert.equal(task.status, 'ready_to_confirm');
  assert.equal(task.posting_error, 'temporary failure');
});

test('today sales menu returns only confirmed detail rows from the Shanghai calendar day', async () => {
  const cards = [];
  const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
  const records = {
    salesDetail: [
      { record_id: 'today', fields: { 编号: ['product_1'], 尺码: 38, 数量: 1, 销售单号: ['order_1'], 销售日: Date.parse('2026-09-24T10:00:00+08:00') } },
      { record_id: 'yesterday', fields: { 编号: ['product_1'], 尺码: 38, 数量: 1, 销售单号: ['order_1'], 销售日: Date.parse('2026-09-23T10:00:00+08:00') } },
    ],
    product: [{ record_id: 'product_1', fields: { 编号: '8088-26棕' } }],
    salesEntry: [{ record_id: 'order_1', fields: { 销售单号: 'XSD-001', 确认状态: '已入账' } }],
    paymentMethod: [{ record_id: 'method_1', fields: { 收款方式: '微信' } }],
    paymentRecord: [{ record_id: 'payment_1', fields: { 关联销售单: ['order_1'], 支付方式: ['method_1'], 收款金额: 230 } }],
  };
  const service = new LarkMvpService({
    client: {},
    gateway: {
      validateTables: async () => [],
      table: (key) => V1_BITABLE_SCHEMA.tables[key],
      listAll: async (key) => records[key] || [],
    },
    references: {},
    posting: {},
    recognizer: {},
    store: makeStore(),
  });
  service.sendCard = async (openId, card) => cards.push({ openId, card });

  const result = await service.sendTodaySales('ou_1', new Date('2026-09-24T02:00:00Z'));

  assert.equal(result.rows.length, 1);
  assert.equal(result.totalQuantity, 1);
  assert.equal(result.totalAmount, 230);
  assert.match(JSON.stringify(cards[0].card), /8088-26棕/);
});
