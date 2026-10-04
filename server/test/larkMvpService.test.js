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

// 销售入口按「实时库存」匹配：一条实时库存记录 = 一双鞋。
// 「库存键」是飞书侧公式（货号|颜色|类别|尺码），「所属状态」是门盒/样品/仓库；
// 「编号」「尺码」是关联，写销售明细时直接用它们，不必再读货品资料。
const liveRow = ({ itemNo, color = '黑', size, state = '门盒', productRecordId, sizeRecordId, recordId }) => ({
  record_id: recordId || `live_${itemNo}_${color}_${size}_${state}`,
  fields: {
    库存键: `${itemNo}|${color}|女鞋|${size}`,
    所属状态: state,
    编号: [{ id: productRecordId }],
    尺码: [{ id: sizeRecordId || `size_${size}` }],
  },
});

const liveInventoryGateway = (rows, { vouchers = [] } = {}) => ({
  table: (key) => {
    if (key === 'liveInventory') {
      return { tableId: 'tbl_live', fields: { stockKey: '库存键', product: '编号', size: '尺码', state: '所属状态' } };
    }
    if (key === 'groupBuyVoucher') {
      return { tableId: 'tbl_voucher', fields: { name: '券名称', purchasePrice: '售价', faceValue: '面值',
        settlementAmount: '平台结算款', status: '销售状态' } };
    }
    return { fields: { number: '编号' } };
  },
  listAll: async (key) => {
    if (key === 'liveInventory') return rows;
    if (key === 'groupBuyVoucher') return vouchers;
    return [];
  },
});

// 券目录来自「团购券管理」表（只取在售），测试里给等价的两档。
const VOUCHER_CATALOG = [
  { purchasePrice: 89.9, faceValue: 100, settlementAmount: 85.4, name: '100元代金券（89.9元·9折）', status: '在售' },
  { purchasePrice: 49.9, faceValue: 100, settlementAmount: 47.4, name: '100元代金券（49.9元·5折）', status: '在售' },
];

// 「团购券管理」表里的一行：售价 89.9 抵 100，平台结算 85.4。
const voucherRow = ({ purchasePrice, faceValue, settlementAmount, status = '在售' }) => ({
  record_id: `voucher_${purchasePrice}`,
  fields: { 券名称: `${faceValue}元代金券`, 售价: purchasePrice, 面值: faceValue,
    平台结算款: settlementAmount, 销售状态: [status] },
});

test('sales intake writes only intake metadata and retains actual amount before confirmation', async () => {
  const store = makeStore();
  const calls = [];
  const cards = [];
  const service = new LarkMvpService({
    client: {},
    gateway: {
      ...liveInventoryGateway([liveRow({ itemNo: '8088-26', color: '棕', size: 38, productRecordId: 'rec_product' })]),
      validateTables: async () => [],
      create: async (tableKey, fields) => {
        calls.push({ operation: 'create', tableKey, fields });
        return { recordId: 'rec_sales_entry' };
      },
      update: async (tableKey, recordId, fields) => {
        calls.push({ operation: 'update', tableKey, recordId, fields });
      },
    },
    references: {},
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
  assert.equal('sentAt' in created.fields, false);
  const parsedUpdate = calls.find(
    (call) => call.operation === 'update' && call.fields.parseStatus === '解析成功'
  );
  assert.equal('behavior' in parsedUpdate.fields, false);
  assert.equal(cards.length, 1);
  assert.doesNotMatch(JSON.stringify(cards[0].card), /现货销售/);
  // 卡片上的展示编号来自实时库存（货号 + 颜色），库存分布也一并写出来。
  assert.match(JSON.stringify(cards[0].card), /8088-26棕/);
  // 卡片上不写库存数字：有货就不需要她看；库存只用来判断"有没有货、是不是样品"。
  assert.doesNotMatch(JSON.stringify(cards[0].card), /门盒|样品/);
  const task = await store.get('sale_test');
  assert.equal(task.draft.items[0].product_record_id, 'rec_product');
});

test('two products and two payments stay in one sales draft and confirmation card', async () => {
  const store = makeStore();
  const cards = [];
  const { normalizeSalesResult } = require('../src/services/doubaoService');
  const service = new LarkMvpService({
    client: {},
    gateway: {
      ...liveInventoryGateway([
        liveRow({ itemNo: '93827', color: '黑', size: 43, productRecordId: 'product_93827' }),
        liveRow({ itemNo: '2115', color: '米', size: 37, productRecordId: 'product_2115' }),
      ]),
      validateTables: async () => [],
      create: async () => ({ recordId: 'order_2' }),
      update: async () => undefined,
    },
    references: {},
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
  }, source, { vouchers: VOUCHER_CATALOG });
  const service = new LarkMvpService({ client: {}, store,
    gateway: {
      ...liveInventoryGateway(
        [liveRow({ itemNo: '2A831-18', color: '黑', size: 44, productRecordId: 'product_voucher' })],
        { vouchers: [voucherRow({ purchasePrice: 89.9, faceValue: 100, settlementAmount: 85.4 })] },
      ),
      validateTables: async () => [],
      create: async () => ({ recordId: 'entry_voucher' }), update: async () => undefined,
    },
    references: {},
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
    { amount: 169, method: '微信', status: '已收款' },
    { amount: 85.4, method: '抖音团购券', status: '待平台结算' },
  ]);
});

test('quoted actual sale amount may differ from Bitable list price', async () => {
  const store = makeStore();
  const messages = [];
  const { normalizeSalesResult } = require('../src/services/doubaoService');
  const service = new LarkMvpService({ client: {},
    gateway: {
      ...liveInventoryGateway([liveRow({ itemNo: '815195B-6', color: '黑', size: 39, productRecordId: 'product_1' })]),
      validateTables: async () => [],
      create: async () => ({ recordId: 'order_3' }), update: async () => undefined,
    },
    references: {},
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

test('partial delivery reports the failed shoe while preserving later successful deliveries', async () => {
  const store = makeStore();
  const cards = [];
  await store.create({ task_id: 'sale_partial_delivery', type: 'sale', status: 'ready_to_confirm',
    sender_open_id: 'ou_1', sales_entry_record_id: 'entry_1', card_message_id: 'om_card',
    draft: { items: [
      { item_no: 'A100', color: '黑', size: 39, quantity: 1, actual_amount: 186 },
      { item_no: 'B200', color: '黑', size: 38, quantity: 1, actual_amount: 176 },
      { item_no: 'C300', color: '黑', size: 43, quantity: 1, actual_amount: 99 },
      { item_no: 'D400', color: '黑', size: 44, quantity: 1, actual_amount: 89 },
    ], payments: [{ method: '微信', amount: 550 }], agreed_total: 550 } });
  const service = new LarkMvpService({ client: {}, gateway: {}, references: {}, recognizer: {}, store,
    posting: { postSale: async () => ({ sourceNo: 'XSD-004',
      detailRecordIds: ['detail_a', 'detail_b', 'detail_c', 'detail_d'], paymentRecordIds: ['pay_1'] }) },
    delivery: { deliver: async () => ({ deliveredQuantity: 3, totalQuantity: 4,
      failures: [{ detailRecordId: 'detail_b', lineNumber: 2, size: 38, quantity: 1,
        error: '门盒和样品库存不足' }], sampleReplacements: [] }) },
  });
  service.updateSalesActionCard = async (_task, _event, card) => { cards.push(card); return true; };
  const result = await service.handleCardAction({ operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale_delivered', draft_id: 'sale_partial_delivery' } } });
  assert.equal(result.toast.type, 'warning');
  assert.match(result.toast.content, /3\/4/);
  assert.match(JSON.stringify(cards.at(-1)), /第2双.*B200.*库存不足/);
  assert.equal((await store.get('sale_partial_delivery')).status, 'posted_delivery_pending');
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
  // 卡片只有一个「确认」：交付与否由草稿的交易类型决定，不由按钮决定。
  assert.deepEqual(retryActions.map((button) => button.value.action), ['confirm_sale']);
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

// ─── 颜色从必填变为可选 ───
//
// 用户现在不说颜色：货号能确定唯一颜色就直接用；确定不了就在确认卡片上给候选让用户点。

test('a multi-color SKU without a spoken color still reaches the confirmation card', async () => {
  const store = makeStore();
  const cards = [];
  const service = new LarkMvpService({
    client: {},
    gateway: {
      // 同一个货号同一个尺码，店里有两种颜色的实物：解析器不猜，把候选交给卡片。
      ...liveInventoryGateway([
        liveRow({ itemNo: '8035', color: '黑牛仔', size: 42, productRecordId: 'rec_black' }),
        liveRow({ itemNo: '8035', color: '灰牛仔', size: 42, productRecordId: 'rec_grey' }),
      ]),
      validateTables: async () => [],
      create: async () => ({ recordId: 'rec_sales_entry' }),
      update: async () => {},
    },
    references: {},
    posting: {},
    recognizer: {
      parseSalesText: async () => ({
        intent: 'sale', item_no: '8035', size: 42, quantity: 1, actual_amount: 200,
        agreed_total: 200, total_paid: 200, payment_method: '微信', missing_fields: [],
      }),
    },
    store,
  });
  service.replyCard = async (messageId, card) => cards.push({ messageId, card });
  await store.create({ task_id: 'sale_color', type: 'sale', status: 'received',
    message_id: 'om_color', sender_open_id: 'ou_1', sent_at: 1000, original_text: '8035 42码，200元微信' });

  await service.processSalesTask('sale_color');

  const task = await store.get('sale_color');
  assert.equal(task.status, 'ready_to_confirm', '颜色待选不该让整单停在「需要补充」');
  const item = task.draft.items[0];
  assert.equal(item.needs_color, true);
  assert.equal(item.product_record_id, '');
  assert.deepEqual(item.color_options.map((option) => option.color), ['黑牛仔', '灰牛仔']);
  assert.equal(cards.length, 1, '应当照常发确认卡片，而不是回一句「请补充颜色」');
  const cardText = JSON.stringify(cards[0].card);
  assert.match(cardText, /请选择颜色/);
  assert.match(cardText, /choose_sale_color/);
  // 颜色候选来自实时库存，但卡片上只写颜色名：她要选的是颜色，不是库存数字。
  assert.match(cardText, /黑牛仔/);
  assert.doesNotMatch(cardText, /门盒|样品|仓库/);
});

test('confirming is refused until every item has a chosen color, and choosing one settles it', async () => {
  const store = makeStore();
  await store.create({ task_id: 'sale_pick_color', type: 'sale', status: 'ready_to_confirm',
    sender_open_id: 'ou_1', sales_entry_record_id: 'entry_1',
    draft: { items: [{ item_no: '8035', size: 42, quantity: 1, actual_amount: 200,
      needs_color: true, color_options: [
        { recordId: 'rec_black', color: '黑牛仔', number: '8035|黑牛仔|A' },
        { recordId: 'rec_grey', color: '灰牛仔', number: '8035|灰牛仔|A' },
      ] }], payments: [] } });
  const service = new LarkMvpService({ client: {}, gateway: {}, references: {},
    recognizer: {}, store, posting: {} });
  service.publishSalesResultCard = async () => true;

  const refused = await service.handleCardAction({
    operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale_delivered', draft_id: 'sale_pick_color' } },
  });
  assert.equal(refused.toast.type, 'warning');
  assert.match(refused.toast.content, /选择颜色/);
  assert.equal((await store.get('sale_pick_color')).status, 'ready_to_confirm', '未选颜色不能进入入账');

  const chosen = await service.handleCardAction({
    operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'choose_sale_color', draft_id: 'sale_pick_color', item_index: 0,
      record_id: 'rec_black', product_number: '8035|黑牛仔|A', color_name: '黑牛仔' } },
  });
  assert.equal(chosen.toast.type, 'success');
  const task = await store.get('sale_pick_color');
  assert.equal(task.draft.items[0].needs_color, false);
  assert.equal(task.draft.items[0].product_record_id, 'rec_black');
  assert.equal(task.draft.items[0].product_number, '8035|黑牛仔|A');
});

// ─── 配品的解析：AI 说出的名字要精确对应「其他配品」里的一条 ───

const accessoryService = (accessoryNames, parsedItem) => {
  const store = makeStore();
  const cards = [];
  const service = new LarkMvpService({
    client: {},
    gateway: {
      validateTables: async () => [],
      table: (key) => (key === 'accessory'
        ? { tableId: 'tbl_acc', fields: { name: '名称' } }
        : { fields: { number: '编号' } }),
      listAll: async (key) => (key === 'accessory'
        ? accessoryNames.map((name, index) => ({ record_id: `acc_${index}`, fields: { 名称: name } }))
        : []),
      create: async () => ({ recordId: 'rec_sales_entry' }),
      update: async () => {},
    },
    references: {},
    posting: {},
    recognizer: {
      parseSalesText: async () => ({
        intent: 'sale', items: [parsedItem], payments: [{ method: '微信', amount: 39 }],
        agreed_total: 39, missing_fields: [],
      }),
    },
    store,
  });
  service.replyCard = async (messageId, card) => cards.push({ messageId, card });
  service.sendText = async () => {};
  return { store, cards, service };
};

test('an accessory name is matched to the accessory table by exact name', async () => {
  const { store, cards, service } = accessoryService(['39元腰带', '49元腰带'],
    { kind: 'accessory', accessory_name: '39元腰带', quantity: 1, actual_amount: 39 });
  await store.create({ task_id: 'sale_acc', type: 'sale', status: 'received',
    message_id: 'om_acc', sender_open_id: 'ou_1', sent_at: 1000, original_text: '39元腰带一条，微信39' });

  await service.processSalesTask('sale_acc');

  const task = await store.get('sale_acc');
  assert.equal(task.status, 'ready_to_confirm');
  assert.equal(task.draft.items[0].accessory_record_id, 'acc_0');
  assert.equal(task.draft.items[0].accessory_name, '39元腰带');
  assert.equal(cards.length, 1);
  // 卡片上显示的是配品名称，不是"未知货品"
  assert.match(JSON.stringify(cards[0].card), /39元腰带/);
});

test('an accessory name that is not in the table is asked for instead of guessed', async () => {
  const { store, service } = accessoryService(['39元腰带'],
    { kind: 'accessory', accessory_name: '59元腰带', quantity: 1, actual_amount: 39 });
  await store.create({ task_id: 'sale_acc_missing', type: 'sale', status: 'received',
    message_id: 'om_acc2', sender_open_id: 'ou_1', sent_at: 1000, original_text: '59元腰带一条，微信39' });

  await service.processSalesTask('sale_acc_missing');

  const task = await store.get('sale_acc_missing');
  assert.equal(task.status, 'needs_info');
  assert.equal(task.draft.items[0].accessory_record_id, '');
  // 「39元腰带」和「59元腰带」只差一个字，绝不能模糊匹配到另一件。
  assert.ok(task.draft.missing_fields.some((field) => field.includes('其他配品里没有「59元腰带」')),
    `实际：${JSON.stringify(task.draft.missing_fields)}`);
});

// ─── 入口按「实时库存」匹配：卖的是实物，不是配置 ───

test('库存里没有这个尺码时不发确认卡片，只回一句「库存里没有 X Y码，请核实～」', async () => {
  const { normalizeSalesResult } = require('../src/services/doubaoService');
  const store = makeStore();
  const cards = [];
  const messages = [];
  const service = new LarkMvpService({
    client: {},
    gateway: {
      ...liveInventoryGateway([
        liveRow({ itemNo: '26632', color: '黑', size: 36, productRecordId: 'p36' }),
        liveRow({ itemNo: '26632', color: '黑', size: 38, productRecordId: 'p38' }),
      ]),
      validateTables: async () => [],
      create: async () => ({ recordId: 'entry_no_stock' }),
      update: async () => undefined,
    },
    references: {},
    posting: {},
    recognizer: {
      parseSalesText: async () => normalizeSalesResult({ intent: 'sale', behavior_code: 'SALE_CASH',
        items: [{ item_no: '26632', color: '黑', size: 37, quantity: 1, actual_amount: 210 }],
        payments: [{ amount: 210, method: '微信' }], agreed_total: 210 }),
    },
    store,
  });
  service.replyCard = async (_messageId, card) => cards.push(card);
  service.sendText = async (_openId, message) => messages.push(message);
  await store.create({ task_id: 'sale_no_stock', type: 'sale', status: 'received', message_id: 'om_ns',
    sender_open_id: 'ou_1', sent_at: Date.now(), original_text: '26632黑37一双210微信' });

  await service.processSalesTask('sale_no_stock');

  const task = await store.get('sale_no_stock');
  assert.equal(task.status, 'needs_info');
  assert.equal(cards.length, 0, '库存里没有这一双，就不该出确认卡片让她点');
  // 缺货只回这一句：没有"销售信息还缺…请补充后重新发送"那层包装，
  // 也没有"第N件："的编号——她要知道的只是"哪一双没有"，然后自己核实。
  assert.equal(messages[0], '库存里没有 26632 37码，请核实～');
});

test('缺货之外还有别的问题时，才用完整的补充说明', async () => {
  const { normalizeSalesResult } = require('../src/services/doubaoService');
  const store = makeStore();
  const messages = [];
  const service = new LarkMvpService({
    client: {},
    gateway: {
      ...liveInventoryGateway([liveRow({ itemNo: '26632', color: '黑', size: 36, productRecordId: 'p36' })]),
      validateTables: async () => [],
      create: async () => ({ recordId: 'entry_mixed' }),
      update: async () => undefined,
    },
    references: {}, posting: {},
    recognizer: {
      parseSalesText: async () => normalizeSalesResult({ intent: 'sale', behavior_code: 'SALE_CASH',
        // 两件：37码缺货 + 两件都没写各自成交金额（整单给了金额，但不许分摊猜测）
        items: [
          { item_no: '26632', color: '黑', size: 37, quantity: 1 },
          { item_no: '26632', color: '黑', size: 36, quantity: 1 },
        ],
        payments: [], agreed_total: 210 }),
    },
    store,
  });
  service.replyCard = async () => undefined;
  service.sendText = async (_openId, message) => messages.push(message);
  await store.create({ task_id: 'sale_mixed', type: 'sale', status: 'received', message_id: 'om_mx',
    sender_open_id: 'ou_1', sent_at: Date.now(), original_text: '26632黑37一双210微信' });

  await service.processSalesTask('sale_mixed');

  assert.match(messages[0], /库存里没有 26632 37码/);
  assert.match(messages[0], /请逐件说明成交金额/);
  assert.match(messages[0], /销售信息还缺/, '夹杂别的问题时仍用完整说明');
});

test('一单多双只读一次实时库存，不按双数重复全表读', async () => {
  const { normalizeSalesResult } = require('../src/services/doubaoService');
  const store = makeStore();
  let liveReads = 0;
  const rows = [
    liveRow({ itemNo: '93827', color: '黑', size: 43, productRecordId: 'p1' }),
    liveRow({ itemNo: '2115', color: '米', size: 37, productRecordId: 'p2' }),
    liveRow({ itemNo: '6681-1', color: '黑灰', size: 42, productRecordId: 'p3' }),
  ];
  const service = new LarkMvpService({
    client: {},
    gateway: {
      ...liveInventoryGateway(rows),
      listAll: async (key) => {
        if (key === 'liveInventory') liveReads += 1;
        return key === 'liveInventory' ? rows : [];
      },
      validateTables: async () => [],
      create: async () => ({ recordId: 'entry_multi_read' }),
      update: async () => undefined,
    },
    references: {},
    posting: {},
    recognizer: {
      parseSalesText: async () => normalizeSalesResult({ intent: 'sale', behavior_code: 'SALE_CASH',
        items: [
          { item_no: '93827', color: '黑', size: 43, quantity: 1, actual_amount: 100 },
          { item_no: '2115', color: '米', size: 37, quantity: 1, actual_amount: 150 },
          { item_no: '6681-1', color: '黑灰', size: 42, quantity: 1, actual_amount: 119 },
        ],
        payments: [{ amount: 369, method: '微信' }], agreed_total: 369 }),
    },
    store,
  });
  service.replyCard = async () => 'card_multi_read';
  await store.create({ task_id: 'sale_multi_read', type: 'sale', status: 'received', message_id: 'om_mr',
    sender_open_id: 'ou_1', sent_at: Date.now(), original_text: '三双鞋，369元微信' });

  await service.processSalesTask('sale_multi_read');

  assert.equal(liveReads, 1, '整单只读一次实时库存；按双数重复读会让多双订单成倍变慢');
  const task = await store.get('sale_multi_read');
  assert.equal(task.draft.items.length, 3);
  assert.equal(task.status, 'ready_to_confirm');
});

// ─── 交易类型：AI 判断性质，脚本决定交付，用户只核对 ───

const tradeTypeService = ({ store, cards, updates, counters, parsed }) => {
  const service = new LarkMvpService({
    client: {},
    gateway: {
      ...liveInventoryGateway([liveRow({ itemNo: '26632', color: '黑', size: 37, productRecordId: 'p37' })]),
      validateTables: async () => [],
      create: async () => ({ recordId: 'entry_trade' }),
      update: async (tableKey, recordId, fields) => { updates.push({ tableKey, recordId, fields }); },
    },
    references: { resolveSalesTradeType: async (code) => ({ recordId: `behavior_${code}` }) },
    posting: { postSale: async () => ({ sourceNo: 'XSD-TRADE', detailRecordIds: ['d1'], paymentRecordIds: ['p1'] }) },
    delivery: { deliver: async () => { counters.delivered += 1; return { sampleReplacements: [] }; } },
    recognizer: { parseSalesText: async () => parsed() },
    store,
  });
  service.replyCard = async (_messageId, card) => { cards.push(card); return 'card_trade'; };
  service.updateSalesActionCard = async (_task, _event, card) => { cards.push(card); return true; };
  return service;
};

test('现货单：卡片显示「现货 · 已交付」，只留一个确认按钮，确认后扣库存', async () => {
  const { normalizeSalesResult } = require('../src/services/doubaoService');
  const store = makeStore();
  const cards = [];
  const updates = [];
  const counters = { delivered: 0 };
  const service = tradeTypeService({ store, cards, updates, counters, parsed: () => normalizeSalesResult({
    intent: 'sale', trade_type: '现货',
    items: [{ item_no: '26632', color: '黑', size: 37, quantity: 1, actual_amount: 210 }],
    payments: [{ amount: 210, method: '微信' }], agreed_total: 210 }) });
  await store.create({ task_id: 'sale_type_cash', type: 'sale', status: 'received', message_id: 'om_c',
    sender_open_id: 'ou_1', sent_at: Date.now(), original_text: '26632黑37一双210微信' });

  await service.processSalesTask('sale_type_cash');

  const draft = (await store.get('sale_type_cash')).draft;
  assert.equal(draft.trade_type, '现货');
  assert.equal(draft.delivery_status, '已交付', '现货当场交付，不该问用户');
  const card = JSON.stringify(cards[0]);
  assert.match(card, /现货 · 已交付/);
  // 卡片上不再有"你来选交付"的痕迹
  assert.doesNotMatch(card, /确认已交付|确认未交付|请按实际情况选择/);
  // 交易类型落成关联「行为管理」的记录，便于以后筛选对账
  const tradeUpdate = updates.find((item) => item.fields.tradeType);
  assert.deepEqual(tradeUpdate.fields.tradeType, ['behavior_SALE_CASH']);

  const result = await service.handleCardAction({ operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale', draft_id: 'sale_type_cash' } } });
  assert.equal(result.toast.type, 'success');
  assert.equal(counters.delivered, 1, '现货确认即交付并扣库存');
});

test('预付单：卡片显示「预付 · 未交付」，确认后不扣库存', async () => {
  const { normalizeSalesResult } = require('../src/services/doubaoService');
  const store = makeStore();
  const cards = [];
  const updates = [];
  const counters = { delivered: 0 };
  const service = tradeTypeService({ store, cards, updates, counters, parsed: () => normalizeSalesResult({
    intent: 'sale', trade_type: '预付',
    items: [{ item_no: '26632', color: '黑', size: 37, quantity: 1, actual_amount: 240 }],
    payments: [{ amount: 100, method: '微信' }], agreed_total: 240 }) });
  await store.create({ task_id: 'sale_type_prepaid', type: 'sale', status: 'received', message_id: 'om_p',
    sender_open_id: 'ou_1', sent_at: Date.now(), original_text: '26632黑37一双，定金100微信，尾款以后付' });

  await service.processSalesTask('sale_type_prepaid');

  const draft = (await store.get('sale_type_prepaid')).draft;
  assert.equal(draft.trade_type, '预付');
  assert.equal(draft.delivery_status, '未交付', '只有预付是未交付：货没拿走');
  assert.match(JSON.stringify(cards[0]), /预付 · 未交付/);

  const result = await service.handleCardAction({ operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale', draft_id: 'sale_type_prepaid' } } });
  assert.equal(result.toast.type, 'success');
  assert.equal(counters.delivered, 0, '预付单货没拿走，不能扣库存');
  assert.match(result.toast.content, /尚未交付/);
});

test('旧卡片上的交付按钮仍然可用：动作名映射到同一条路，不再让交付取决于按钮', async () => {
  const store = makeStore();
  const cards = [];
  const counters = { delivered: 0 };
  await store.create({ task_id: 'sale_legacy_card', type: 'sale', status: 'ready_to_confirm',
    sender_open_id: 'ou_1', sales_entry_record_id: 'entry_legacy', card_message_id: 'om_card',
    draft: { trade_type: '预付', delivery_status: '未交付',
      items: [{ item_no: '26632', color: '黑', size: 37, quantity: 1, actual_amount: 240,
        product_record_id: 'p37' }],
      payments: [{ amount: 100, method: '微信' }], agreed_total: 240 } });
  const service = new LarkMvpService({ client: {}, gateway: {}, references: {}, recognizer: {}, store,
    posting: { postSale: async () => ({ sourceNo: 'XSD-LEGACY', detailRecordIds: ['d1'], paymentRecordIds: ['p1'] }) },
    delivery: { deliver: async () => { counters.delivered += 1; return { sampleReplacements: [] }; } } });
  service.updateSalesActionCard = async (_task, _event, card) => { cards.push(card); return true; };

  // 用户点的是旧卡片上的「确认已交付（扣库存）」，但草稿说这是预付单。
  const result = await service.handleCardAction({ operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale_delivered', draft_id: 'sale_legacy_card' } } });
  assert.equal(result.toast.type, 'success');
  assert.equal(counters.delivered, 0, '存量旧卡片点"已交付"，也要按草稿的交易类型走');
});

test('团购券目录只认「在售」的券：下架的券不能拿来算结算金额', async () => {
  const store = makeStore();
  const service = new LarkMvpService({ client: {},
    gateway: liveInventoryGateway([], {
      vouchers: [
        voucherRow({ purchasePrice: 89.9, faceValue: 100, settlementAmount: 85.4, status: '已下架' }),
        voucherRow({ purchasePrice: 49.9, faceValue: 100, settlementAmount: 47.4, status: '在售' }),
      ],
    }),
    references: {}, posting: {}, recognizer: {}, store });
  const vouchers = await service.listGroupBuyVouchers();
  assert.deepEqual(vouchers.map((voucher) => voucher.purchasePrice), [49.9]);
});

test('券表读不到时返回空目录，让券的说法落到"未配置"追问，而不是算一个错的金额', async () => {
  const store = makeStore();
  const service = new LarkMvpService({ client: {},
    gateway: {
      table: (key) => (key === 'groupBuyVoucher' ? { tableId: 'tbl_voucher', fields: {} } : {}),
      listAll: async () => { throw new Error('飞书暂时不可用'); },
    },
    references: {}, posting: {}, recognizer: {}, store });
  assert.deepEqual(await service.listGroupBuyVouchers(), []);
});

// ─── 3B：卖样品要补哪个门盒，在确认卡片上一次问完 ───

const sampleSaleService = ({ store, cards, promoted, counter }) => {
  const { normalizeSalesResult } = require('../src/services/doubaoService');
  const service = new LarkMvpService({
    client: {},
    gateway: {
      ...liveInventoryGateway([
        // 卖的这一双只有样品（门盒 0）；同货号 36 / 38 码还有门盒能补。
        liveRow({ itemNo: '6V637-7', color: '黑', size: 41, state: '样品', productRecordId: 'prod_a', recordId: 'live_sample' }),
        liveRow({ itemNo: '6V637-7', color: '黑', size: 36, productRecordId: 'prod_a', recordId: 'live_36' }),
        liveRow({ itemNo: '6V637-7', color: '黑', size: 38, productRecordId: 'prod_a', recordId: 'live_38' }),
      ]),
      validateTables: async () => [], create: async () => ({ recordId: 'entry_sample' }), update: async () => undefined,
    },
    references: {},
    posting: { postSale: async () => ({ sourceNo: 'XSD-S', detailRecordIds: ['detail_1'], paymentRecordIds: ['pay_1'] }) },
    delivery: { deliver: async () => ({ sampleReplacements: [
      { salesDetailRecordId: 'detail_1', productRecordId: 'prod_a', consumedLiveRecordIds: ['live_sample'] }] }) },
    recognizer: { parseSalesText: async () => normalizeSalesResult({ intent: 'sale', trade_type: '现货',
      items: [{ item_no: '6V637-7', color: '黑', size: 41, quantity: 1, actual_amount: 150 }],
      payments: [{ amount: 150, method: '现金' }], agreed_total: 150 }) },
    store,
  });
  service.sampleReplacements = {
    applyPreChosen: async (replacements) => {
      promoted.push(...replacements);
      return new Set(replacements.map((item) => item.salesDetailRecordId));
    },
    notifySampleReplacements: async (_result, _openId, options) => { counter.notices += 1; counter.handled = options?.handledDetailIds; },
  };
  service.replyCard = async (_messageId, card) => { cards.push(card); return 'card_sample'; };
  service.updateSalesActionCard = async (_task, _event, card) => { cards.push(card); return true; };
  return service;
};

const openSampleSale = async (store, taskId) => store.create({ task_id: taskId, type: 'sale',
  status: 'received', message_id: `om_${taskId}`, sender_open_id: 'ou_1', sent_at: Date.now(),
  original_text: '6V637-7黑41一双150现金' });

const act = (service, value) => service.handleCardAction({
  operator: { operator_id: { open_id: 'ou_1' } }, action: { value } });

test('卖的是样品时：卡片上就让她选补哪个门盒，选完确认，不再另发一张补选卡', async () => {
  const store = makeStore();
  const cards = [];
  const promoted = [];
  const counter = { notices: 0, handled: null };
  const service = sampleSaleService({ store, cards, promoted, counter });
  await openSampleSale(store, 'sale_sample');

  await service.processSalesTask('sale_sample');

  const draft = (await store.get('sale_sample')).draft;
  assert.equal(draft.items[0].uses_sample, true, '门盒为 0、还有样品，卖掉就会动样品');
  assert.equal(draft.items[0].needs_sample_replacement, true);
  assert.deepEqual(draft.items[0].sample_replacement_options.map((row) => row.size), [36, 38]);
  const card = JSON.stringify(cards[0]);
  assert.match(card, /是样品，卖掉后要补一个门盒/);
  assert.match(card, /choose_sale_sample_replacement/);

  // 没选补样品就不许确认：跟"没选颜色不许确认"是同一条规矩
  const refused = await act(service, { action: 'confirm_sale', draft_id: 'sale_sample' });
  assert.equal(refused.toast.type, 'warning');
  assert.match(refused.toast.content, /补哪个门盒/);
  assert.equal((await store.get('sale_sample')).status, 'ready_to_confirm');

  const chosen = await act(service, { action: 'choose_sale_sample_replacement',
    draft_id: 'sale_sample', item_index: 0, size: 38 });
  assert.equal(chosen.toast.type, 'success');
  assert.equal((await store.get('sale_sample')).draft.items[0].sample_replacement_size, 38);

  const done = await act(service, { action: 'confirm_sale', draft_id: 'sale_sample' });
  assert.equal(done.toast.type, 'success');
  assert.deepEqual(promoted, [{ salesDetailRecordId: 'detail_1', productRecordId: 'prod_a', size: 38 }],
    '确认后由脚本直接补样品');
  // 补掉的明细要交给提醒去跳过，否则她还会收到第二张补选卡。
  assert.deepEqual([...(counter.handled || [])], ['detail_1'],
    '已经补完的明细必须进入跳过名单，否则还会再发一张补选卡');
});

test('门盒够的时候卡片不出现补偿区：不需要她为"补样品"多做一件事', async () => {
  const store = makeStore();
  const cards = [];
  const promoted = [];
  const counter = { notices: 0, handled: null };
  const { normalizeSalesResult } = require('../src/services/doubaoService');
  const service = new LarkMvpService({
    client: {},
    gateway: {
      ...liveInventoryGateway([
        liveRow({ itemNo: '26632', color: '黑', size: 37, productRecordId: 'prod_x', recordId: 'live_37' }),
      ]),
      validateTables: async () => [], create: async () => ({ recordId: 'entry_ok' }), update: async () => undefined,
    },
    references: {}, posting: {},
    recognizer: { parseSalesText: async () => normalizeSalesResult({ intent: 'sale', trade_type: '现货',
      items: [{ item_no: '26632', color: '黑', size: 37, quantity: 1, actual_amount: 210 }],
      payments: [{ amount: 210, method: '微信' }], agreed_total: 210 }) },
    store,
  });
  service.replyCard = async (_messageId, card) => { cards.push(card); return 'card_ok'; };
  await store.create({ task_id: 'sale_doorbox_ok', type: 'sale', status: 'received', message_id: 'om_ok',
    sender_open_id: 'ou_1', sent_at: Date.now(), original_text: '26632黑37一双210微信' });

  await service.processSalesTask('sale_doorbox_ok');

  const item = (await store.get('sale_doorbox_ok')).draft.items[0];
  assert.equal(item.uses_sample, false);
  assert.equal(item.needs_sample_replacement, false);
  assert.doesNotMatch(JSON.stringify(cards[0]), /要补一个门盒/);
});
