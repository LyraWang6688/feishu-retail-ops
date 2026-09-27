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

test('robot no longer starts the legacy purchase-image flow', async () => {
  const { service, sent } = makeService();
  const imageEvent = {
    sender: { sender_id: { open_id: 'ou_1' } },
    message: {
      message_id: 'om_image',
      chat_type: 'p2p',
      message_type: 'image',
      create_time: '1000',
      content: JSON.stringify({ image_key: 'img_1' }),
    },
  };
  const result = await service.acceptMessage(imageEvent);
  assert.equal(result.reason, 'unsupported_message_type');
  assert.match(sent[0].message, /采购表单/);
  assert.equal(await service.store.get(require('../src/services/larkMvpService').idFor('purchase_open', 'ou_1')), null);
});

test('ordered-list post message is accepted as one sale with all four item lines', async () => {
  const { service } = makeService();
  const content = { post: { zh_cn: { title: '550元微信卖了4双鞋：', content: [
    [{ tag: 'text', text: '1. 第一双：3287黑39的，186元' }],
    [{ tag: 'text', text: '2. 第二双：11633黑色38的，176元' }],
    [{ tag: 'text', text: '3. 第三双：86822黑色43的，99元' }],
    [{ tag: 'text', text: '4. 第四双：XHB8095全黑44的，89元' }],
  ] } } };
  const result = await service.acceptMessage({ sender: { sender_id: { open_id: 'ou_1' } },
    message: { message_id: 'om_post_four', chat_type: 'p2p', message_type: 'post',
      create_time: '1000', content: JSON.stringify(content) } });
  assert.equal(result.accepted, true);
  const task = await service.store.get(result.taskId);
  assert.equal(task.original_text.split('\n').length, 5);
  assert.match(task.original_text, /XHB8095全黑44/);
  assert.match(task.original_text, /550元微信/);
});

test('one seller can submit separate sale messages while their recognition runs in order', async () => {
  const { service } = makeService();
  const stages = [];
  let finishFirst;
  const firstPending = new Promise((resolve) => { finishFirst = resolve; });
  let finishBoth;
  const bothDone = new Promise((resolve) => { finishBoth = resolve; });
  service.processSalesTask = async (taskId) => {
    stages.push(`start:${taskId}`);
    if (stages.length === 1) await firstPending;
    stages.push(`end:${taskId}`);
    if (stages.length === 4) finishBoth();
  };
  const event = (id, text) => ({ sender: { sender_id: { open_id: 'ou_1' } },
    message: { message_id: id, chat_type: 'p2p', message_type: 'text',
      create_time: '1000', content: JSON.stringify({ text }) } });
  const first = await service.acceptMessage(event('om_sale_one', 'A100黑38 99元微信'));
  const second = await service.acceptMessage(event('om_sale_two', 'B200棕39 109元现金'));
  assert.notEqual(first.taskId, second.taskId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stages, [`start:${first.taskId}`]);
  finishFirst();
  await bothDone;
  assert.deepEqual(stages, [
    `start:${first.taskId}`, `end:${first.taskId}`,
    `start:${second.taskId}`, `end:${second.taskId}`,
  ]);
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

test('selling a sample sends a per-order size choice card and only its recipient can promote a door-box pair', async () => {
  const store = makeStore();
  const cards = [];
  const promoted = [];
  const delivery = { inventory: {
    sampleReplacementCandidates: async () => [
      { size: 40, doorBoxCount: 1, sampleCount: 0, warehouseCount: 0 },
      { size: 41, doorBoxCount: 0, sampleCount: 0, warehouseCount: 1 },
    ],
    promoteToSample: async (input) => { promoted.push(input); return { liveRecordId: 'door_40' }; },
  } };
  const service = new LarkMvpService({ client: {}, store,
    gateway: { table: () => ({ fields: { number: '编号' } }),
      get: async () => ({ fields: { 编号: 'A100黑' } }) },
    references: {}, posting: {}, recognizer: {}, purchaseWebhooks: {}, delivery });
  service.sendCard = async (_openId, card) => { cards.push(card); return 'om_sample_card'; };
  service.updateSalesActionCard = async (_task, _event, card) => { cards.push(card); return true; };
  const delivered = { sampleReplacements: [{ salesDetailRecordId: 'detail_1',
    productRecordId: 'product_1', sampleConsumedQuantity: 1 }] };
  await service.notifySampleReplacements(delivered, 'ou_seller');
  await service.notifySampleReplacements(delivered, 'ou_seller');
  assert.equal(cards.length, 1);
  assert.match(JSON.stringify(cards[0]), /A100黑/);
  assert.match(JSON.stringify(cards[0]), /40码：门盒 1/);
  assert.ok(!JSON.stringify(cards[0]).includes('选 41 码'));
  const choose = (openId) => ({ action: { value: { action: 'choose_sample_replacement',
    draft_id: cards[0].elements[1].actions[0].value.draft_id, size: 40 } },
    operator: { operator_id: { open_id: openId } } });
  await assert.rejects(service.handleCardAction(choose('ou_other')), /只能由收到提醒的用户/);
  const result = await service.handleCardAction(choose('ou_seller'));
  assert.equal(result.toast.type, 'success');
  assert.equal(promoted.length, 1);
  assert.equal((await service.handleCardAction(choose('ou_seller'))).toast.type, 'info');
  assert.equal(promoted.length, 1);
});

test('concurrent sample choices promote only one size and end with a feedback card', async () => {
  const store = makeStore();
  const cards = [];
  const promoted = [];
  await store.create({ task_id: 'sample_race', type: 'sample_replacement', status: 'pending',
    sender_open_id: 'ou_1', product_record_id: 'product_1', product_number: 'A100黑',
    sales_detail_record_id: 'detail_1', card_message_id: 'om_card' });
  const service = new LarkMvpService({ client: {}, gateway: {}, references: {}, recognizer: {}, store,
    purchaseWebhooks: {}, delivery: { inventory: {
      sampleReplacementCandidates: async () => [{ size: 40, doorBoxCount: 1, sampleCount: 0, warehouseCount: 0 }],
      promoteToSample: async ({ size }) => {
        promoted.push(size);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { size, liveRecordId: 'door_40' };
      },
    } } });
  service.updateSalesActionCard = async (_task, _event, card) => { cards.push(card); return true; };
  const choose = (size) => ({ operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'choose_sample_replacement', draft_id: 'sample_race', size } } });
  const results = await Promise.all([service.handleCardAction(choose(40)), service.handleCardAction(choose(41))]);
  assert.deepEqual(promoted, [40]);
  assert.equal(results[0].toast.type, 'success');
  assert.match(results[1].toast.content, /已补选/);
  assert.match(cards.at(-1).header.title.content, /已补选/);
});

test('sample refresh failure replaces processing view with a retryable card', async () => {
  const store = makeStore();
  const cards = [];
  await store.create({ task_id: 'sample_refresh_error', type: 'sample_replacement', status: 'pending',
    sender_open_id: 'ou_1', product_record_id: 'product_1', product_number: 'A100黑',
    sales_detail_record_id: 'detail_1', card_message_id: 'om_card' });
  const service = new LarkMvpService({ client: {}, gateway: {}, references: {}, recognizer: {}, store,
    purchaseWebhooks: {}, delivery: { inventory: {
      sampleReplacementCandidates: async () => { throw new Error('查询库存失败'); },
    } } });
  service.updateSalesActionCard = async (_task, _event, card) => { cards.push(card); return true; };
  const result = await service.handleCardAction({ operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'refresh_sample_replacement', draft_id: 'sample_refresh_error' } } });
  assert.equal(result.toast.type, 'warning');
  assert.match(cards[0].header.title.content, /处理中/);
  assert.match(JSON.stringify(cards[1]), /刷新尺码失败/);
  assert.ok(cards[1].elements.some((element) => element.tag === 'action'));
});

test('sales intake writes only intake metadata and retains actual amount before confirmation', async () => {
  const store = makeStore();
  const calls = [];
  const cards = [];
  const productLookups = [];
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
      resolveProduct: async (input) => {
        productLookups.push(input);
        return {
          recordId: 'rec_product',
          record: { fields: { 编号: '8088-26|棕|女鞋' } },
        };
      },
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
        actual_amount: 230,
        agreed_total: 230,
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
  assert.doesNotMatch(JSON.stringify(cards[0].card), /现货销售/);
  assert.match(JSON.stringify(cards[0].card), /8088-26\|棕\|女鞋/);
  const task = await store.get('sale_test');
  assert.equal(task.draft.items[0].product_record_id, 'rec_product');
  assert.deepEqual(productLookups, [{ itemNo: '8088-26', color: '棕', matchMode: 'sales' }]);
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
      items: [{ item_no: '93827', color: '黑', size: 43, quantity: 1, actual_amount: 100 },
        { item_no: '2115', color: '米', size: 37, quantity: 1, actual_amount: 150 }],
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

test('voucher sale card and posting retain separate settled and platform-pending receipts', async () => {
  const { normalizeSalesResult } = require('../src/services/doubaoService');
  const store = makeStore();
  const cards = [];
  let posted;
  const source = '2A831-18黑色44的，是169元微信，然后一张89块9抵100的代金券，然后赠了一双袜子';
  const parsed = normalizeSalesResult({ intent: 'sale', items: [
    { item_no: '2A831-18', color: '黑', size: 44, quantity: 1, actual_amount: 269,
      gift: true, gift_description: '一双袜子' }],
    payments: [{ method: '微信', amount: 169 }, { method: '团购券', amount: 100 }],
    agreed_total: 269,
  }, source);
  const service = new LarkMvpService({ client: {}, store,
    gateway: { validateTables: async () => [], table: () => ({ fields: { number: '编号' } }),
      create: async () => ({ recordId: 'entry_voucher' }), update: async () => undefined },
    references: { resolveProduct: async () => ({ recordId: 'product_voucher',
      record: { fields: { 编号: '2A831-18黑' } } }) },
    recognizer: { parseSalesText: async () => parsed },
    posting: { postSale: async (input) => { posted = input;
      return { sourceNo: 'XSD-VOUCHER', detailRecordIds: ['detail_voucher'],
        paymentRecordIds: ['cash_receipt', 'voucher_receipt'] }; } },
  });
  service.replyCard = async (_messageId, card) => { cards.push(card); return 'card_voucher'; };
  await store.create({ task_id: 'sale_voucher', type: 'sale', status: 'received',
    message_id: 'om_voucher', sender_open_id: 'ou_1', sent_at: Date.now(), original_text: source });
  await service.processSalesTask('sale_voucher');
  assert.equal((await store.get('sale_voucher')).status, 'ready_to_confirm');
  const card = JSON.stringify(cards[0]);
  assert.match(card, /本次已收/);
  assert.match(card, /待平台结算/);
  assert.match(card, /85.4/);
  await service.handleCardAction({ operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale_pending', draft_id: 'sale_voucher' } } });
  assert.equal(posted.items[0].actualAmount, 254.4);
  assert.equal(posted.items[0].giftDescription, '一双袜子');
  assert.deepEqual(posted.payments.map(({ amount, method, status }) => ({ amount, method, status })), [
    { amount: 169, method: '微信', status: '已收清' },
    { amount: 85.4, method: '抖音团购券', status: '待平台结算' },
  ]);
});

test('quoted actual sale amount may differ from Bitable list price', async () => {
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
  service.replyCard = async () => 'card_1';
  await store.create({ task_id: 'unpaid_sale', type: 'sale', status: 'received', message_id: 'om_unpaid',
    sender_open_id: 'ou_1', sent_at: Date.now(), original_text: '815195B-6黑39码260元未付' });
  await service.processSalesTask('unpaid_sale');
  assert.equal((await store.get('unpaid_sale')).status, 'ready_to_confirm');
  assert.equal((await store.get('unpaid_sale')).draft.items[0].actual_amount, 260);
  assert.equal(messages.length, 0);
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

  const result = await service.handleCardAction({
    operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale', draft_id: 'sale_retry' } },
  });
  assert.match(result.toast.content, /请核对原卡片后重试/);

  const task = await store.get('sale_retry');
  assert.equal(task.status, 'ready_to_confirm');
  assert.equal(task.posting_error, 'temporary failure');
  await service.handleCardAction({ operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale_pending', draft_id: 'sale_retry' } } });
  assert.equal((await store.get('sale_retry')).posting_requested_action, 'confirm_sale_pending');
});

test('sale card shows processing immediately and becomes action-free after posting', async () => {
  const store = makeStore();
  const cards = [];
  await store.create({
    task_id: 'sale_card_progress', type: 'sale', status: 'ready_to_confirm',
    sender_open_id: 'ou_1', sales_entry_record_id: 'rec_entry', card_message_id: 'om_card',
    draft: { items: [{ item_no: 'A100', size: 38, quantity: 1 }], payments: [], agreed_total: 100 },
  });
  const service = new LarkMvpService({
    client: { im: { v1: { message: { patch: async ({ path, data }) => {
      cards.push({ messageId: path.message_id, card: JSON.parse(data.content) });
      return { code: 0 };
    } } } } },
    gateway: {}, references: {}, recognizer: {}, store,
    posting: { postSale: async () => {
      assert.match(cards[0].card.header.title.content, /处理中/);
      return { sourceNo: 'XSD-001', detailRecordIds: ['detail_1'] };
    } },
  });
  const result = await service.handleCardAction({
    operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale', draft_id: 'sale_card_progress' } },
  });
  assert.equal(result.toast.type, 'success');
  assert.deepEqual(cards.map((item) => item.messageId), ['om_card', 'om_card']);
  assert.match(cards[1].card.header.title.content, /已入账/);
  assert.ok(cards.every((item) => !item.card.elements.some((element) => element.tag === 'action')));
  assert.equal((await store.get('sale_card_progress')).status, 'posted');
});

test('two clicks on the same sale draft post once and repair the already processed card', async () => {
  const store = makeStore();
  const cards = [];
  let postCalls = 0;
  await store.create({ task_id: 'sale_double_click', type: 'sale', status: 'ready_to_confirm',
    sender_open_id: 'ou_1', sales_entry_record_id: 'entry_1', card_message_id: 'om_card',
    draft: { items: [{ item_no: 'A100', size: 38, quantity: 1, actual_amount: 99 }], payments: [] } });
  const service = new LarkMvpService({ client: { im: { v1: { message: { patch: async ({ data }) => {
    cards.push(JSON.parse(data.content));
    return { code: 0 };
  } } } } }, gateway: {}, references: {}, recognizer: {}, store,
  posting: { postSale: async () => {
    postCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { sourceNo: 'XSD-002', detailRecordIds: ['detail_1'] };
  } } });
  const event = { operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale_pending', draft_id: 'sale_double_click' } } };
  const results = await Promise.all([service.handleCardAction(event), service.handleCardAction(event)]);
  assert.equal(postCalls, 1);
  assert.equal(results[0].toast.type, 'success');
  assert.match(results[1].toast.content, /已处理/);
  assert.equal(cards.length, 3);
  assert.ok(!cards[2].elements.some((element) => element.tag === 'action'));
});

test('sale final-card patch failure sends a new result card without reversing a posted sale', async () => {
  const store = makeStore();
  const fallbackCards = [];
  let patches = 0;
  await store.create({ task_id: 'sale_card_fallback', type: 'sale', status: 'ready_to_confirm',
    sender_open_id: 'ou_1', sales_entry_record_id: 'entry_1', card_message_id: 'om_old',
    draft: { items: [{ item_no: 'A100', size: 38, quantity: 1, actual_amount: 99 }], payments: [] } });
  const service = new LarkMvpService({ client: { im: { v1: { message: { patch: async () => {
    patches += 1;
    return { code: patches === 1 ? 0 : 1254607, msg: 'Data not ready' };
  } } } } }, gateway: {}, references: {}, recognizer: {}, store,
  posting: { postSale: async () => ({ sourceNo: 'XSD-003', detailRecordIds: ['detail_1'] }) } });
  service.sendCard = async (_openId, card) => { fallbackCards.push(card); return 'om_new'; };
  const result = await service.handleCardAction({ operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale_pending', draft_id: 'sale_card_fallback' } } });
  assert.equal(result.toast.type, 'success');
  assert.equal(fallbackCards.length, 1);
  assert.match(fallbackCards[0].header.title.content, /已入账/);
  assert.equal((await store.get('sale_card_fallback')).card_message_id, 'om_new');
});

test('delivered confirmation writes sale first then delegates stock to delivery owner', async () => {
  const store = makeStore();
  const calls = [];
  await store.create({ task_id: 'sale_delivered', type: 'sale', status: 'ready_to_confirm',
    sender_open_id: 'ou_1', sales_entry_record_id: 'entry_1',
    draft: { items: [{ item_no: 'A100', size: 38, quantity: 1, actual_amount: 220,
      product_record_id: 'product_1' }], payments: [{ method: '微信', amount: 220 }], agreed_total: 220 },
  });
  const service = new LarkMvpService({ client: {}, gateway: {}, references: {}, recognizer: {}, store,
    posting: { postSale: async (input) => {
      calls.push(['post', input.items[0].actualAmount]);
      return { sourceNo: 'XSD-001', detailRecordIds: ['detail_1'] };
    } },
    delivery: { deliver: async (input) => { calls.push(['deliver', input.detailRecordIds, input.paymentRecordIds]);
      return { sampleReplacements: [] }; } },
  });
  const result = await service.handleCardAction({ operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale_delivered', draft_id: 'sale_delivered' } } });
  assert.equal(result.toast.type, 'success');
  assert.deepEqual(calls, [['post', 220], ['deliver', ['detail_1'], undefined]]);
  assert.equal((await store.get('sale_delivered')).status, 'posted');
});

test('stock failure after sale posting is not presented as sale posting failure', async () => {
  const store = makeStore();
  await store.create({ task_id: 'sale_stock_error', type: 'sale', status: 'ready_to_confirm',
    sender_open_id: 'ou_1', sales_entry_record_id: 'entry_1',
    draft: { items: [{ item_no: 'A100', size: 38, quantity: 1, actual_amount: 220 }], payments: [], agreed_total: 220 },
  });
  const service = new LarkMvpService({ client: {}, gateway: {}, references: {}, recognizer: {}, store,
    posting: { postSale: async () => ({ sourceNo: 'XSD-002', detailRecordIds: ['detail_2'] }) },
    delivery: { deliver: async () => { throw new Error('门盒库存不足'); } },
  });
  const result = await service.handleCardAction({ operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale_delivered', draft_id: 'sale_stock_error' } } });
  assert.match(result.toast.content, /库存交付待处理/);
  assert.equal((await store.get('sale_stock_error')).status, 'posted_delivery_pending');
});

test('failed sale posting restores action buttons for retry', async () => {
  const store = makeStore();
  const cards = [];
  await store.create({ task_id: 'sale_card_retry', type: 'sale', status: 'ready_to_confirm',
    sender_open_id: 'ou_1', sales_entry_record_id: 'rec_entry', card_message_id: 'om_card',
    draft: { items: [{ item_no: 'A100', size: 38, quantity: 1 }] } });
  const service = new LarkMvpService({
    client: { im: { v1: { message: { patch: async ({ data }) => {
      cards.push(JSON.parse(data.content));
      return { code: 0 };
    } } } } },
    gateway: {}, references: {}, recognizer: {}, store,
    posting: { postSale: async () => { throw new Error('temporary failure'); } },
  });
  const result = await service.handleCardAction({
    operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale', draft_id: 'sale_card_retry' } },
  });
  assert.match(result.toast.content, /请核对原卡片后重试/);
  assert.equal(cards.length, 2);
  assert.match(JSON.stringify(cards[1]), /入账失败/);
  assert.ok(cards[1].elements.some((element) => element.tag === 'action'));
  assert.equal((await store.get('sale_card_retry')).status, 'ready_to_confirm');
});

test('sale card persists written record IDs and distinguishes pending sync from failed creation', async () => {
  const store = makeStore();
  const cards = [];
  let postingCalls = 0;
  let deliveryCalls = 0;
  await store.create({ task_id: 'sale_sync_retry', type: 'sale', status: 'ready_to_confirm',
    sender_open_id: 'ou_1', sales_entry_record_id: 'order_1', card_message_id: 'om_card',
    draft: { items: [{ product_record_id: 'product_1', item_no: 'A100', size: 39,
      quantity: 1, actual_amount: 260 }], payments: [{ method: '微信', amount: 260 }], agreed_total: 260 } });
  const service = new LarkMvpService({ client: {}, gateway: {}, references: {}, recognizer: {}, store,
    posting: { postSale: async (input) => {
      postingCalls += 1;
      if (postingCalls === 1) {
        await input.onRecordPersisted('details', 0, 'detail_1');
        await input.onRecordPersisted('payments', 0, 'payment_1');
        const error = new Error('Request failed with status code 400');
        error.response = { data: { code: 1254607 } };
        error.saleRecordsWritten = true;
        throw error;
      }
      assert.deepEqual(input.knownRecordIds, { details: ['detail_1'], payments: ['payment_1'] });
      assert.equal(input.knownFinancialComplete, true);
      return { sourceNo: 'XSD-001', detailRecordIds: ['detail_1'], paymentRecordIds: ['payment_1'] };
    } },
    delivery: { deliver: async () => { deliveryCalls += 1; return { sampleReplacements: [] }; } },
  });
  service.updateSalesActionCard = async (_task, _event, card) => { cards.push(card); return true; };
  const event = { operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale_delivered', draft_id: 'sale_sync_retry' } } };
  const pending = await service.handleCardAction(event);
  assert.match(pending.toast.content, /记录已写入，进度待同步/);
  assert.match(JSON.stringify(cards.at(-1)), /库存未扣/);
  assert.doesNotMatch(JSON.stringify(cards.at(-1)), /入账失败/);
  const retryActions = cards.at(-1).elements.find((element) => element.tag === 'action').actions;
  assert.deepEqual(retryActions.map((button) => button.value.action), ['confirm_sale_delivered']);
  assert.equal((await store.get('sale_sync_retry')).status, 'ready_to_confirm');
  assert.deepEqual((await store.get('sale_sync_retry')).posting_record_ids,
    { details: ['detail_1'], payments: ['payment_1'] });
  assert.equal((await store.get('sale_sync_retry')).posting_records_written, true);
  assert.equal(deliveryCalls, 0);
  const cancelled = await service.handleCardAction({ ...event,
    action: { value: { action: 'cancel', draft_id: 'sale_sync_retry' } } });
  assert.match(cancelled.toast.content, /不能直接取消或修改/);
  const changed = await service.handleCardAction({ ...event,
    action: { value: { action: 'confirm_sale_pending', draft_id: 'sale_sync_retry' } } });
  assert.match(changed.toast.content, /原来的交付选择/);
  assert.equal(postingCalls, 1);

  const recovered = await service.handleCardAction(event);
  assert.match(recovered.toast.content, /库存已更新/);
  assert.equal(deliveryCalls, 1);
  assert.equal((await store.get('sale_sync_retry')).status, 'posted');
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
