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
  assert.match(sent[0].message, /未写入销售录单/);
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
  const fields = {
    product: '编号',
    size: '尺码',
    quantity: '数量',
    paidAmount: '实付金额',
    paymentMethod: '支付方式',
    behavior: '销售行为',
    soldAt: '销售日',
  };
  const service = new LarkMvpService({
    client: {},
    gateway: {
      validateTables: async () => [],
      table: () => ({ fields }),
      listAll: async () => [
        {
          record_id: 'today',
          fields: {
            编号: [{ text: '8088-26棕' }],
            尺码: 38,
            数量: 1,
            实付金额: 230,
            支付方式: [{ text: '微信' }],
            销售行为: [{ text: '现货销售' }],
            销售日: Date.parse('2026-09-24T10:00:00+08:00'),
          },
        },
        {
          record_id: 'yesterday',
          fields: { 销售日: Date.parse('2026-09-23T10:00:00+08:00') },
        },
      ],
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
