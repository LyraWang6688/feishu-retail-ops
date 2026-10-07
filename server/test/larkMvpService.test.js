// ⭐ 本文件有一大批历史用例是**拿私聊录单当输入**测销售链路的（回归覆盖，不该删）。
//    这里显式把私聊开关打开 → 它们转为回归「**开关打开时行为与改动前逐字不变**」。
//    另一半方向（"默认关 = 私聊不处理"）由 test/privateChatRemoval.test.js 钉住 ——
//    那个文件**不** require 这个 helper。
//    （配置是**每次调用时读 env**，所以不依赖 require 顺序，见 config/privateChat。）
require('./helpers/enablePrivateChatForTests');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService, aggregateRecognizedItems, looksLikeSalesText } = require('../src/services/larkMvpService');
const { PurchaseBatchLocator } = require('../src/services/purchaseBatchLocator');
const { SalesGroupThreadLocator } = require('../src/services/salesGroupThreadLocator');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');

// 拼接「货品信息」的记录链接要读 Base token。测试里给一个占位值；
// 已配置时不覆盖（CI 或本地 .env 里可能已经有真值）。
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

// 群聊链路要的两个配置：机器人 open_id（判 @ 用）与采购群 id（发单用）。
// ⚠️ 真值是生产数据，**不写进测试**：这里用明显的测试值，证明代码是"从配置读"
// 而不是"写死了生产那个 open_id"。用赋值而不是 `|| 默认值`：显式赋值才能保证
// "配置为空时会怎样"这类用例被测到——`||` 会把空串当没配而回落成默认值。
const TEST_BOT_OPEN_ID = 'ou_test_bot_open_id';
const TEST_PURCHASE_CHAT_ID = 'oc_test_purchase_chat_id';
process.env.LARK_BOT_OPEN_ID = TEST_BOT_OPEN_ID;
// 主群「是否仍然要求 @」的开关：显式赋值成**空串 = 走默认**（默认放宽，= 新行为）。
// 要测老行为的用例**注入 `mainChatRequireMention: true`**，不靠改这个全局变量。
process.env.GROUP_MAIN_CHAT_REQUIRE_MENTION = '';

const makeStore = () =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lark-mvp-test-')), idField: 'task_id' });

const makeService = (options = {}) => {
  const sent = [];
  const service = new LarkMvpService({
    client: options.client || {},
    gateway: options.gateway || {},
    references: options.references || {},
    posting: options.posting || {},
    recognizer: options.recognizer || {},
    store: options.store || makeStore(),
    // 群聊定位器指向临时目录：**不受**构造时默认的 data/purchase_group_messages 影响。
    purchaseBatchLocator: options.purchaseBatchLocator,
    purchaseBatchLocatorStore: options.purchaseBatchLocatorStore,
    // 销售那侧的「话题 ↔ 销售记录」映射同样指向临时目录：用例之间不共享映射，
    // 也不会往仓库的 server/data/sales_group_threads/ 里写东西。
    salesGroupThreads: options.salesGroupThreads || new SalesGroupThreadLocator({
      store: new JsonTaskStore({
        dir: fs.mkdtempSync(path.join(os.tmpdir(), 'group-sales-thread-')), idField: 'task_id',
      }),
    }),
    botOpenId: options.botOpenId === undefined ? TEST_BOT_OPEN_ID : options.botOpenId,
    // `undefined` → 走 config/groupAdmission 的默认（放宽）；显式 true/false → 钉死口径。
    mainChatRequireMention: options.mainChatRequireMention,
    groupPurchaseFlow: options.groupPurchaseFlow,
  });
  service.sendText = async (openId, message) => sent.push({ openId, message });
  // 表情/「已收到」这条反馈默认打桩：绝大多数用例只关心"进没进流程"。
  // 专门验证表情的用例会在拿到 service 之后把它解掉（见 `reactionSpyService`）。
  service.acknowledgeMessage = async () => undefined;
  service.processSalesTask = async () => undefined;
  return { service, sent };
};

// 用真实的 acknowledgeMessage + 假的飞书 client：断言的是**真实发生的远端调用**
// （emoji_type 到底传了什么），而不是"我们有没有调用 acknowledgeMessage"。
const makeReactionService = () => {
  const reactions = [];
  const client = {
    im: {
      messageReaction: {
        create: async ({ path, data }) => {
          reactions.push({ messageId: path.message_id, emoji: data.reaction_type.emoji_type });
          return { code: 0 };
        },
      },
    },
  };
  const { service } = makeService({ client });
  service.acknowledgeMessage = LarkMvpService.prototype.acknowledgeMessage;
  return { service, reactions };
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

// 主群准入（2026-10-06 业务负责人拍板：**不再要求 @**）。三条判据任一条就理：
// @ / 正文像销售 / 正文带采购批次号；都不满足 → 静默 + 零远端调用。
// 下面这组用例把「日常聊天绝不触发」这条红线钉死（含"像销售但其实是闲聊"的边界）。
const makeAdmissionSpyService = (options = {}) => {
  // 远端调用一律记账：主群闲聊必须**一个都不发生**。
  const calls = [];
  const client = {
    im: {
      message: { create: async () => { calls.push('message.create'); return { code: 0 }; } },
      messageReaction: { create: async () => { calls.push('reaction.create'); return { code: 0 }; } },
    },
  };
  const gateway = {
    table: () => { calls.push('gateway.table'); return {}; },
    listAll: async () => { calls.push('gateway.listAll'); return []; },
    get: async () => { calls.push('gateway.get'); return null; },
    create: async () => { calls.push('gateway.create'); throw new Error('群聊不该写业务表'); },
    update: async () => { calls.push('gateway.update'); throw new Error('群聊不该写业务表'); },
  };
  let recognized = 0;
  const { service } = makeService({
    ...options, client, gateway,
    recognizer: { parseSalesText: async () => { recognized += 1; return {}; } },
  });
  return { service, calls, recognized: () => recognized };
};

test('主群不 @ + 日常聊天：完全无反应（不发消息、不加表情、不读表、不进识别）', async () => {
  const { service, calls, recognized } = makeAdmissionSpyService();
  const result = await service.acceptMessage({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: {
      message_id: 'om_group',
      chat_id: 'oc_group',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '今天天气不错' }),
      mentions: [],
    },
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'group_not_sales_text');
  assert.deepEqual(calls, [], '主群日常聊天不能有任何远端调用');
  assert.equal(recognized(), 0, '主群日常聊天不能进 AI 识别');
});

test('主群不 @ + 正文像销售 → 处理（放宽后的新行为）', async () => {
  const { service } = makeAdmissionSpyService();
  const result = await service.acceptMessage({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: {
      message_id: 'om_group_autosale',
      chat_id: 'oc_group',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: 'A100 38码一双，100元微信' }),
      mentions: [],
    },
  });
  assert.equal(result.accepted, true, '不 @ 也要能识别销售');
  assert.equal(result.mode, 'new', '主群新开一笔销售');
});

test('主群不 @ + 正文带采购批次号 → 处理（归采购那条路）', async () => {
  // 采购那条路换成一个记录型的桩：用它证明"这条归采购"，不去碰真实定位/发送。
  const purchaseCalls = [];
  const { service } = makeAdmissionSpyService({
    groupPurchaseFlow: {
      handleGroupPurchaseMessage: async (input) => {
        purchaseCalls.push(input);
        return { resolved: true, reason: 'stub', replied: false };
      },
    },
  });
  const result = await service.acceptMessage({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: {
      message_id: 'om_group_batch',
      chat_id: 'oc_group',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: 'BH-20261005-0009 这批到哪了' }),
      mentions: [],
    },
  });
  assert.equal(result.accepted, true);
  assert.equal(purchaseCalls.length, 1, '带批次号的主群消息要交给采购定位');
  assert.equal(purchaseCalls[0].text, 'BH-20261005-0009 这批到哪了');
  assert.equal(result.handled, undefined, '这条不归销售');
});

test('开关打开（mainChatRequireMention=true）→ 回到改动前：主群只认 @', async () => {
  const { service, calls, recognized } = makeAdmissionSpyService({ mainChatRequireMention: true });
  const result = await service.acceptMessage({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: {
      message_id: 'om_group_strict',
      chat_id: 'oc_group',
      chat_type: 'group',
      message_type: 'text',
      // 带数字、带业务关键词 —— 真实销售；但开关要求 @，所以必须被挡掉。
      content: JSON.stringify({ text: 'A100 38码一双，库存还有多少' }),
      mentions: [],
    },
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'group_not_mentioned');
  assert.deepEqual(calls, [], '严格模式下不 @ 不能有任何远端调用');
  assert.equal(recognized(), 0);
});

test('群聊没配 LARK_BOT_OPEN_ID 且要求 @：不猜 @，一律忽略', async () => {
  const calls = [];
  const { service } = makeService({
    botOpenId: '',
    mainChatRequireMention: true,
    client: { im: { messageReaction: { create: async () => { calls.push('reaction.create'); return { code: 0 }; } } } },
  });
  const result = await service.acceptMessage({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: {
      message_id: 'om_group_nobot',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 这批到了' }),
      mentions: [{ key: '@_user_1', id: TEST_BOT_OPEN_ID, name: '测试机器人' }],
    },
  });
  // 判不出"@的是不是机器人"时**不处理**：宁可不响应，也不能把群里日常聊天当指令。
  assert.deepEqual(result, { accepted: false, reason: 'group_bot_open_id_unconfigured' });
  assert.deepEqual(calls, []);
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
    // 候选尺码按钮已从 action 换成 column_set（移动端实测，见 larkCards.buttonColumns），
    // 所以按钮要从 column 里取。
    draft_id: cards[0].elements[1].columns[0].elements[0].value.draft_id, size: 40 } },
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
  // 「刷新可选尺码」是单个按钮，不会有换行问题，保持 action 元素（只有多按钮才改成 column_set）。
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

const liveInventoryGateway = (rows, { vouchers = [], products = [] } = {}) => ({
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
    if (key === 'product') return products;
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
  // 认不出意图时回的是业务负责人定的引导语（原文在 config/messageGate），
  // 不再是原来那句"未写入销售主表"——那句话对"我不知道你在说什么"没有任何帮助。
  assert.equal(sent[0].message, require('../src/config/messageGate').UNSUPPORTED_INTENT_REPLY);
  assert.match(sent[0].message, /这个我还没学会/);
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
  // 终态卡片不能再给按钮：多按钮现在是 column_set，单按钮仍是 action，两种都算「有按钮」。
  assert.ok(cards.every((item) => !item.card.elements
    .some((element) => ['action', 'column_set'].includes(element.tag))));
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
  // 同上：终态卡片不允许再出现按钮（column_set 或 action 都算）。
  assert.ok(!cards[2].elements.some((element) => ['action', 'column_set'].includes(element.tag)));
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
  // 重试卡片仍要能继续操作：确认/修改/取消现在是 column_set（移动端实测，见 larkCards.buttonColumns）。
  assert.ok(cards[1].elements.some((element) => element.tag === 'column_set'));
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
  // 按钮改成 column_set 之后（移动端实测，见 larkCards.buttonColumns），按钮要从 column 里取。
  const retryButtons = cards.at(-1).elements
    .filter((element) => element.tag === 'column_set')
    .flatMap((element) => element.columns.flatMap((column) => column.elements))
    .filter((child) => child.tag === 'button');
  // 卡片只有一个「确认」：交付与否由草稿的交易类型决定，不由按钮决定。
  assert.deepEqual(retryButtons.map((button) => button.value.action), ['confirm_sale']);
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

// 🔴 2026-10-07「私聊链路移除」：原来这里有一条
//    `today sales menu returns only confirmed detail rows from the Shanghai calendar day`
//    —— 它测的是 `sendTodaySales`（机器人菜单「今日销售」，**只有私聊点得到**）。
//    那个方法连同菜单事件 handler 已随私聊入口一起删除，所以这条用例**一并删除**：
//    留着它就只能靠"删掉入口再断言旧行为"来维持，那是自己骗自己。
//    要看今日销售 → 飞书网页工作台「销售查询」（`GET /api/workbench/sales/today`）。

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

// ─── 配品的解析：用户说的「分类」优先，其次才是「名称」精确匹配 ───

// 每一行可以是名称字符串（只测名称匹配的老写法），也可以是 { name, category }。
// 「种类」按真实表返回单选数组，与线上读回来的形状一致。
const accessoryService = (accessoryRows, parsedItem) => {
  const store = makeStore();
  const cards = [];
  const service = new LarkMvpService({
    client: {},
    gateway: {
      validateTables: async () => [],
      table: (key) => (key === 'accessory'
        ? { tableId: 'tbl_acc', fields: { name: '名称', category: '种类' } }
        : { fields: { number: '编号' } }),
      listAll: async (key) => (key === 'accessory'
        ? accessoryRows.map((entry, index) => {
            const row = typeof entry === 'string' ? { name: entry } : entry;
            return {
              record_id: `acc_${index}`,
              fields: {
                ...(row.name ? { 名称: row.name } : {}),
                ...(row.category ? { 种类: [row.category] } : {}),
              },
            };
          })
        : []),
      create: async () => ({ recordId: 'rec_sales_entry' }),
      update: async () => {},
    },
    references: {},
    posting: {},
    recognizer: {
      // 整单金额跟着这一件的成交金额走，测试里不必手写两份、也不会互相打架。
      parseSalesText: async () => ({
        intent: 'sale', items: [parsedItem],
        payments: [{ method: '微信', amount: Number(parsedItem.actual_amount) || 0 }],
        agreed_total: Number(parsedItem.actual_amount) || 0, missing_fields: [],
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

// 腰带在真实表里有 9 档价位，名称只差一个数字——正好用来验证"多档按金额对"。
const BELT_TIERS = [39, 49, 79, 99, 119, 128, 139, 159, 189];
const beltRows = () => BELT_TIERS.map((price) => ({ name: `${price}元腰带`, category: '腰带' }));

test('分类下唯一时直接用它，成交金额以用户说的为准（不是名称里的价）', async () => {
  const { store, cards, service } = accessoryService(
    [{ name: '15元鞋油', category: '鞋油' }, { name: '9.9元袜子', category: '袜子' }],
    { kind: 'accessory', accessory_name: '鞋油', quantity: 1, actual_amount: 10 });
  await store.create({ task_id: 'sale_acc_cat_only', type: 'sale', status: 'received',
    message_id: 'om_acc_cat_only', sender_open_id: 'ou_1', sent_at: 1000,
    original_text: '一盒鞋油 10 元，微信' });

  await service.processSalesTask('sale_acc_cat_only');

  const task = await store.get('sale_acc_cat_only');
  assert.equal(task.status, 'ready_to_confirm');
  assert.equal(task.draft.items[0].accessory_record_id, 'acc_0');
  // 关键：名称里是 15 元，用户说 10 元就记 10 元，名称里的价只用来区分档位。
  assert.equal(task.draft.items[0].actual_amount, 10);
  assert.equal(cards.length, 1);
});

test('分类下有多档时，用用户说的金额对到正确那一档', async () => {
  const { store, service } = accessoryService(beltRows(),
    { kind: 'accessory', accessory_name: '腰带', quantity: 1, actual_amount: 99 });
  await store.create({ task_id: 'sale_acc_belt_tier', type: 'sale', status: 'received',
    message_id: 'om_acc_belt_tier', sender_open_id: 'ou_1', sent_at: 1000,
    original_text: '腰带一条 99 元，微信' });

  await service.processSalesTask('sale_acc_belt_tier');

  const task = await store.get('sale_acc_belt_tier');
  assert.equal(task.status, 'ready_to_confirm');
  // 99 元那一档在 BELT_TIERS 里排第 4（索引 3）。
  assert.equal(task.draft.items[0].accessory_record_id, 'acc_3');
  assert.equal(task.draft.items[0].actual_amount, 99);
});

test('腰带：她说的 119 只用来对档位，成交金额记实收 100（她的真实一单）', async () => {
  // 解析层已经把「119 的腰带，是收到了 100 元微信」定成
  // actual_amount=100（她说收到的钱）+ tier_price=119（对档位用的价位）。
  const { store, cards, service } = accessoryService(beltRows(),
    { kind: 'accessory', accessory_name: '腰带', quantity: 1, actual_amount: 100, tier_price: 119 });
  await store.create({ task_id: 'sale_acc_belt_119_paid_100', type: 'sale', status: 'received',
    message_id: 'om_acc_belt_119_paid_100', sender_open_id: 'ou_1', sent_at: 1000,
    original_text: '119 的腰带，是收到了 100 元微信' });

  await service.processSalesTask('sale_acc_belt_119_paid_100');

  const task = await store.get('sale_acc_belt_119_paid_100');
  assert.equal(task.status, 'ready_to_confirm');
  // 119 那一档在 BELT_TIERS 里排第 5（索引 4）：档位靠 tier_price 对上（100 不是任何一档）。
  assert.equal(task.draft.items[0].accessory_record_id, 'acc_4');
  // 成交金额是实收 100，不是 119。
  assert.equal(task.draft.items[0].actual_amount, 100);
  assert.deepEqual(task.draft.missing_fields, []);
  assert.equal(cards.length, 1);
  assert.match(JSON.stringify(cards[0].card), /腰带/);
});

test('分类下有多档但金额对不上时不猜，提示有哪几档', async () => {
  const { store, service } = accessoryService(beltRows(),
    { kind: 'accessory', accessory_name: '腰带', quantity: 1, actual_amount: 88 });
  await store.create({ task_id: 'sale_acc_belt_miss', type: 'sale', status: 'received',
    message_id: 'om_acc_belt_miss', sender_open_id: 'ou_1', sent_at: 1000,
    original_text: '腰带一条 88 元，微信' });

  await service.processSalesTask('sale_acc_belt_miss');

  const task = await store.get('sale_acc_belt_miss');
  assert.equal(task.status, 'needs_info');
  assert.equal(task.draft.items[0].accessory_record_id, '');
  const issue = task.draft.missing_fields.find((field) => field.includes('腰带'));
  assert.ok(issue, `实际：${JSON.stringify(task.draft.missing_fields)}`);
  // 说人话：列出真实档位，并且不能再说"没有这一件"（它明明有）。
  assert.match(issue, /腰带有 .*39 元.*49 元.* 这几档/);
  assert.match(issue, /你卖的是哪一档/);
  assert.doesNotMatch(issue, /没有/);
});

test('分类里没有这个词时，退回按名称精确匹配（向后兼容）', async () => {
  // 「赠品鞋垫」不是分类值（分类是「鞋垫」），而且表里同名两条：
  // 走名称精确匹配取第一条，与改动前完全一致。
  const { store, service } = accessoryService(
    [{ name: '赠品鞋垫', category: '鞋垫' }, { name: '赠品鞋垫', category: '鞋垫' },
      { name: '9.9元鞋垫', category: '鞋垫' }],
    { kind: 'accessory', accessory_name: '赠品鞋垫', quantity: 1, actual_amount: 0 });
  await store.create({ task_id: 'sale_acc_name_fallback', type: 'sale', status: 'received',
    message_id: 'om_acc_name_fallback', sender_open_id: 'ou_1', sent_at: 1000,
    original_text: '赠鞋垫一双' });

  await service.processSalesTask('sale_acc_name_fallback');

  const task = await store.get('sale_acc_name_fallback');
  assert.equal(task.draft.items[0].accessory_record_id, 'acc_0');
});

test('分类和名称都匹配不到时，仍然报「没有这一件」', async () => {
  const { store, service } = accessoryService([{ name: '15元鞋油', category: '鞋油' }],
    { kind: 'accessory', accessory_name: '袜子', quantity: 1, actual_amount: 9.9 });
  await store.create({ task_id: 'sale_acc_none', type: 'sale', status: 'received',
    message_id: 'om_acc_none', sender_open_id: 'ou_1', sent_at: 1000,
    original_text: '袜子一双 9.9 元，微信' });

  await service.processSalesTask('sale_acc_none');

  const task = await store.get('sale_acc_none');
  assert.equal(task.status, 'needs_info');
  assert.equal(task.draft.items[0].accessory_record_id, '');
  assert.ok(task.draft.missing_fields.some((field) => field.includes('其他配品里没有「袜子」')),
    `实际：${JSON.stringify(task.draft.missing_fields)}`);
});

test('分类唯一时即使用户没给金额也能定位到配品（金额另按原有规则追问）', async () => {
  const { store, service } = accessoryService([{ name: '15元鞋油', category: '鞋油' }],
    { kind: 'accessory', accessory_name: '鞋油', quantity: 1, actual_amount: '' });
  await store.create({ task_id: 'sale_acc_no_amount', type: 'sale', status: 'received',
    message_id: 'om_acc_no_amount', sender_open_id: 'ou_1', sent_at: 1000,
    original_text: '一盒鞋油，微信' });

  await service.processSalesTask('sale_acc_no_amount');

  const task = await store.get('sale_acc_no_amount');
  // 配品本身定位到了；缺金额是整单原本就有的追问，与配品匹配无关。
  assert.equal(task.draft.items[0].accessory_record_id, 'acc_0');
  assert.ok(task.draft.missing_fields.some((field) => field.includes('请逐件说明成交金额')),
    `实际：${JSON.stringify(task.draft.missing_fields)}`);
});

test('配品改按分类匹配后，鞋仍然按「货号+尺码」走实时库存（回归）', async () => {
  const store = makeStore();
  const cards = [];
  // 这张表里既配了配品（含分类），也有实时库存：确认鞋这条分支一行都没被影响。
  const base = liveInventoryGateway([
    liveRow({ itemNo: '26632', color: '黑', size: 36, productRecordId: 'p36' }),
  ]);
  const service = new LarkMvpService({
    client: {},
    gateway: {
      ...base,
      table: (key) => (key === 'accessory'
        ? { tableId: 'tbl_acc', fields: { name: '名称', category: '种类' } }
        : base.table(key)),
      listAll: async (key) => (key === 'accessory'
        ? [{ record_id: 'acc_oil', fields: { 名称: '15元鞋油', 种类: ['鞋油'] } }]
        : base.listAll(key)),
      validateTables: async () => [],
      create: async () => ({ recordId: 'rec_sales_entry' }),
      update: async () => {},
    },
    references: {},
    posting: {},
    recognizer: {
      parseSalesText: async () => ({
        intent: 'sale', items: [{ item_no: '26632', size: 36, quantity: 1, actual_amount: 100 }],
        payments: [{ method: '微信', amount: 100 }], agreed_total: 100, missing_fields: [],
      }),
    },
    store,
  });
  service.replyCard = async (messageId, card) => cards.push({ messageId, card });
  await store.create({ task_id: 'sale_shoe_regression', type: 'sale', status: 'received',
    message_id: 'om_shoe_regression', sender_open_id: 'ou_1', sent_at: 1000,
    original_text: '26632 36码 100元微信' });

  await service.processSalesTask('sale_shoe_regression');

  const task = await store.get('sale_shoe_regression');
  const item = task.draft.items[0];
  assert.equal(task.status, 'ready_to_confirm');
  assert.equal(item.product_record_id, 'p36');
  assert.equal(item.color, '黑');
  // 鞋不会被配品词表或分类匹配"抢走"：鞋这条分支根本不写配品字段。
  assert.equal(item.accessory_record_id, undefined);
  assert.equal(cards.length, 1);
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
  // 缺货只回这一句：哪一双没有 + 这个货号现在有哪些码 + 请核实。
  // 没有"销售信息还缺…请补充后重新发送"那层包装，也没有"第N件："的编号。
  assert.equal(messages[0], '库存里没有 26632 37码（这个货号现在有 36、38码），请核实～');
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

// ─── 销售确认卡片第三区：货品资料缺口 ───

const PRODUCT_FIELDS = { number: '编号', itemNo: '货号', color: '颜色',
  completeness: '信息是否齐备', sampleImage: '样例图' };

// 货品信息现在是**整表读一次**（listAll），不再是逐条 get。
const gapService = ({ store, cards, productRecord, productListFails = false }) => {
  const { normalizeSalesResult } = require('../src/services/doubaoService');
  const base = liveInventoryGateway(
    [liveRow({ itemNo: '66356', color: '黑', size: 42, productRecordId: 'prod_gap' })],
    { products: productRecord ? [productRecord] : [] },
  );
  const service = new LarkMvpService({
    client: {},
    gateway: {
      ...base,
      table: (key) => (key === 'product' ? { tableId: 'tbl_product', fields: PRODUCT_FIELDS } : base.table(key)),
      listAll: async (key) => {
        if (key === 'product' && productListFails) throw new Error('飞书暂时不可用');
        return base.listAll(key);
      },
      validateTables: async () => [], create: async () => ({ recordId: 'entry_gap' }), update: async () => undefined,
    },
    references: {}, posting: {},
    recognizer: { parseSalesText: async () => normalizeSalesResult({ intent: 'sale', trade_type: '现货',
      items: [{ item_no: '66356', color: '黑', size: 42, quantity: 1, actual_amount: 99 }],
      payments: [{ amount: 99, method: '微信' }], agreed_total: 99 }) },
    store,
  });
  service.replyCard = async (_messageId, card) => { cards.push(card); return 'card_gap'; };
  return service;
};

const openSale = (store, taskId) => store.create({ task_id: taskId, type: 'sale', status: 'received',
  message_id: `om_${taskId}`, sender_open_id: 'ou_1', sent_at: Date.now(), original_text: '66356黑42一双99微信' });

test('货品资料不齐时，确认卡片上直接给出「还差什么」和记录链接', async () => {
  const store = makeStore();
  const cards = [];
  const service = gapService({ store, cards,
    productRecord: { record_id: 'prod_gap', fields: { 货号: '66356', 信息是否齐备: '成本、品类', 样例图: [] } } });
  await openSale(store, 'sale_gap');

  await service.processSalesTask('sale_gap');

  const gaps = (await store.get('sale_gap')).draft.product_info_gaps;
  assert.equal(gaps.length, 1);
  assert.deepEqual(gaps[0].missing, ['成本', '品类']);
  assert.equal(gaps[0].missing_sample_image, true, '没有样例图也要算缺口');
  assert.match(gaps[0].url, /\/base\/.+\?table=tbl_product&record=prod_gap$/);

  const card = JSON.stringify(cards[0]);
  assert.match(card, /补货品信息/);
  assert.match(card, /还差：成本、品类、样例图/);
  assert.match(card, /去补全这条记录/);
});

test('货品齐备而且有样例图时，卡片上不出现这一区', async () => {
  const store = makeStore();
  const cards = [];
  const service = gapService({ store, cards,
    productRecord: { record_id: 'prod_gap', fields: { 货号: '66356', 信息是否齐备: '齐备', 样例图: [{ file_token: 'tok_1' }] } } });
  await openSale(store, 'sale_complete');

  await service.processSalesTask('sale_complete');

  assert.deepEqual((await store.get('sale_complete')).draft.product_info_gaps, []);
  assert.doesNotMatch(JSON.stringify(cards[0]), /补货品信息/);
});

test('齐备但缺样例图 → 依然提醒（两个条件任意不满足都提醒）', async () => {
  const store = makeStore();
  const cards = [];
  const service = gapService({ store, cards,
    productRecord: { record_id: 'prod_gap', fields: { 货号: '66356', 信息是否齐备: '齐备', 样例图: [] } } });
  await openSale(store, 'sale_no_photo');

  await service.processSalesTask('sale_no_photo');

  const gaps = (await store.get('sale_no_photo')).draft.product_info_gaps;
  assert.deepEqual(gaps[0].missing, []);
  assert.equal(gaps[0].missing_sample_image, true);
  assert.match(JSON.stringify(cards[0]), /还差：样例图/);
});

test('读货品信息表失败时当作没有缺口，照常出确认卡片', async () => {
  const store = makeStore();
  const cards = [];
  const service = gapService({ store, cards, productRecord: null, productListFails: true });
  await openSale(store, 'sale_read_fail');

  await service.processSalesTask('sale_read_fail');

  assert.deepEqual((await store.get('sale_read_fail')).draft.product_info_gaps, []);
  assert.equal(cards.length, 1, '照常出确认卡片');
});

test('一单两件商品时，货品信息只读一次全表（不按件数重复读）', async () => {
  const { normalizeSalesResult } = require('../src/services/doubaoService');
  const store = makeStore();
  const cards = [];
  let productListReads = 0;
  const base = liveInventoryGateway([
    liveRow({ itemNo: '66356', color: '黑', size: 42, productRecordId: 'prod_a' }),
    liveRow({ itemNo: '8035', color: '灰牛仔', size: 40, productRecordId: 'prod_b' }),
  ], { products: [
    { record_id: 'prod_a', fields: { 货号: '66356', 颜色: [{ text: '黑' }], 信息是否齐备: '成本', 样例图: [] } },
    { record_id: 'prod_b', fields: { 货号: '8035', 颜色: [{ text: '灰牛仔' }], 信息是否齐备: '单价', 样例图: [] } },
  ] });
  const service = new LarkMvpService({
    client: {},
    gateway: {
      ...base,
      table: (key) => (key === 'product' ? { tableId: 'tbl_product', fields: PRODUCT_FIELDS } : base.table(key)),
      listAll: async (key) => { if (key === 'product') productListReads += 1; return base.listAll(key); },
      validateTables: async () => [], create: async () => ({ recordId: 'entry_two' }), update: async () => undefined,
    },
    references: {}, posting: {},
    recognizer: { parseSalesText: async () => normalizeSalesResult({ intent: 'sale', trade_type: '现货',
      items: [
        { item_no: '66356', color: '黑', size: 42, quantity: 1, actual_amount: 99 },
        { item_no: '8035', color: '灰牛仔', size: 40, quantity: 1, actual_amount: 301 },
      ], payments: [{ amount: 400, method: '微信' }], agreed_total: 400 }) },
    store,
  });
  service.replyCard = async (_m, card) => { cards.push(card); return 'card_two'; };
  await store.create({ task_id: 'sale_two_products', type: 'sale', status: 'received', message_id: 'om_two',
    sender_open_id: 'ou_1', sent_at: Date.now(), original_text: '66356黑42、8035灰牛仔40，共400微信' });

  await service.processSalesTask('sale_two_products');

  assert.equal(productListReads, 1, '货品信息整表只读一次，不随件数增长');
  const gaps = (await store.get('sale_two_products')).draft.product_info_gaps;
  assert.deepEqual(gaps.map((gap) => gap.label), ['66356黑', '8035灰牛仔']);
});

test('同一个货号有多个颜色时，把该货号下所有资料不全的颜色都列出来', async () => {
  const { normalizeSalesResult } = require('../src/services/doubaoService');
  const store = makeStore();
  const cards = [];
  // 66356 有三个颜色：黑色资料全（有图）、米色缺成本、白色缺单价和样例图
  const products = [
    { record_id: 'p_black', fields: { 货号: '66356', 颜色: [{ text: '黑' }], 信息是否齐备: '齐备', 样例图: [{ file_token: 't' }] } },
    { record_id: 'p_beige', fields: { 货号: '66356', 颜色: [{ text: '米' }], 信息是否齐备: '成本', 样例图: [{ file_token: 't' }] } },
    { record_id: 'p_white', fields: { 货号: '66356', 颜色: [{ text: '白' }], 信息是否齐备: '单价、品类', 样例图: [] } },
  ];
  const base = liveInventoryGateway(
    [liveRow({ itemNo: '66356', color: '黑', size: 42, productRecordId: 'p_black' })],
    { products },
  );
  const service = new LarkMvpService({
    client: {},
    gateway: {
      ...base,
      table: (key) => (key === 'product' ? { tableId: 'tbl_product', fields: PRODUCT_FIELDS } : base.table(key)),
      validateTables: async () => [], create: async () => ({ recordId: 'entry_multi' }), update: async () => undefined,
    },
    references: {}, posting: {},
    recognizer: { parseSalesText: async () => normalizeSalesResult({ intent: 'sale', trade_type: '现货',
      items: [{ item_no: '66356', color: '黑', size: 42, quantity: 1, actual_amount: 99 }],
      payments: [{ amount: 99, method: '微信' }], agreed_total: 99 }) },
    store,
  });
  service.replyCard = async (_m, card) => { cards.push(card); return 'card_multi'; };
  await store.create({ task_id: 'sale_multi_color', type: 'sale', status: 'received', message_id: 'om_mc',
    sender_open_id: 'ou_1', sent_at: Date.now(), original_text: '66356黑42一双99微信' });

  await service.processSalesTask('sale_multi_color');

  const gaps = (await store.get('sale_multi_color')).draft.product_info_gaps;
  // 卖掉的是黑色（资料全），但同货号的米色、白色也要提示补齐
  assert.deepEqual(gaps.map((gap) => gap.label), ['66356米', '66356白']);
  assert.deepEqual(gaps.map((gap) => gap.missing), [['成本'], ['单价', '品类']]);
  assert.equal(gaps[1].missing_sample_image, true, '白色还缺样例图');
  const card = JSON.stringify(cards[0]);
  assert.match(card, /66356米/);
  assert.match(card, /66356白/);
  assert.doesNotMatch(card, /66356黑\*\*/, '资料全的颜色不该出现在缺口里');
});

// ─────────────────────────────────────────────────────────────────────────────
// 群聊链路（B / C）：话题免 @ / 主群 @ + 引用定位 + 剥 @ 占位符 + 收到表情
// ─────────────────────────────────────────────────────────────────────────────

// 群聊定位器指向临时目录，并可选地预置「消息 ↔ 批次」「话题 ↔ 批次」映射
// （生产上由 PurchaseWebhookService 发完采购单后写入，见 purchaseWebhookService.test.js）。
const makeGroupContext = async (options = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-purchase-locator-'));
  const store = new JsonTaskStore({ dir, idField: 'task_id' });
  const locator = new PurchaseBatchLocator({ store });
  if (options.mappingMessageId || options.mappingThreadId) {
    await locator.rememberGroupMessage({
      batchNo: options.batchNo || 'BH-20261005-0001',
      messageId: options.mappingMessageId || options.mappingThreadId,
      threadId: options.mappingThreadId || '',
      chatId: TEST_PURCHASE_CHAT_ID,
      suppliers: ['金猴'],
      requestIds: ['req_1'],
      detailCount: 2,
    });
  }
  return { store, locator };
};

const groupEvent = (overrides = {}) => ({
  sender: { sender_id: { open_id: 'ou_sender' } },
  message: {
    message_id: overrides.messageId || 'om_group_1',
    chat_id: TEST_PURCHASE_CHAT_ID,
    chat_type: 'group',
    message_type: 'text',
    create_time: '1000',
    content: JSON.stringify({ text: overrides.text || '' }),
    // 默认 @ 了机器人（主群那条路）；传 mention=false 模拟"话题里没 @"。
    mentions: overrides.mentions || [{ key: '@_user_1', id: TEST_BOT_OPEN_ID, name: '测试机器人' }],
    parent_id: overrides.parentId,
    // thread_id 有值 = 话题里的消息（免 @）；不传 = 主群消息（必须 @）。
    thread_id: overrides.threadId,
  },
});

test('群聊①：话题里的消息（thread_id 有值）**不 @ 机器人**也进流程', async () => {
  // 真机实测：她在话题里发「你好 小来财」，mentions=[]，事件照样推给我们。
  const { locator } = await makeGroupContext({ mappingThreadId: 'omt_thread_1', batchNo: 'BH-20261005-0011' });
  const { service } = makeService({ purchaseBatchLocator: locator });
  const replied = [];
  service.replyText = async (_messageId, content) => { replied.push(content); return 'om_reply'; };

  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_topic_no_mention',
    threadId: 'omt_thread_1',
    text: '你好 小来财',
    mentions: [],
  }));

  assert.equal(result.accepted, true, '话题里的消息不该因为没 @ 被丢掉');
  assert.equal(result.resolved, true);
  assert.equal(result.reason, 'thread_id');
  assert.equal(result.batchNo, 'BH-20261005-0011');
  assert.deepEqual(replied, [], '定位成功不该再发问句');
});

test('群聊②：主群消息（thread_id 为空）@ 机器人 → 进流程', async () => {
  const { locator } = await makeGroupContext({ mappingMessageId: 'om_purchase_main', batchNo: 'BH-20261005-0012' });
  const { service } = makeService({ purchaseBatchLocator: locator });
  service.replyText = async () => { throw new Error('定位成功不该回消息'); };

  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_main_mention',
    text: '@_user_1 这批到了',
    parentId: 'om_purchase_main',
  }));

  assert.equal(result.accepted, true);
  assert.equal(result.resolved, true);
  assert.equal(result.batchNo, 'BH-20261005-0012');
});

test('C：thread_id 命中 → 定位到正确批次（优先级高于 parent_id）', async () => {
  // 话题映射指向 0011，parent_id 映射指向 0099：必须是 thread_id 赢
  //（话题里后续消息不一定还引用着机器人那条，thread_id 才是稳的那个）。
  const { locator } = await makeGroupContext({ mappingThreadId: 'omt_thread_prio', batchNo: 'BH-20261005-0011' });
  await locator.rememberGroupMessage({ batchNo: 'BH-20261005-0099', messageId: 'om_other_batch' });
  const { service } = makeService({ purchaseBatchLocator: locator });
  service.replyText = async () => { throw new Error('定位成功不该回消息'); };

  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_topic_prio',
    threadId: 'omt_thread_prio',
    parentId: 'om_other_batch',
    text: '这批货到了',
  }));

  assert.equal(result.resolved, true);
  assert.equal(result.reason, 'thread_id');
  assert.equal(result.batchNo, 'BH-20261005-0011');
});

test('C：thread_id 查不到映射 → 明确回「认不出」，零写入，不拿正文号去猜', async () => {
  const writes = [];
  const { locator } = await makeGroupContext({ mappingThreadId: 'omt_known', batchNo: 'BH-20261005-0001' });
  const { service } = makeService({
    purchaseBatchLocator: locator,
    gateway: {
      table: () => ({}),
      listAll: async () => [],
      get: async () => null,
      create: async (...args) => { writes.push(['create', ...args]); throw new Error('定位链路不允许写业务表'); },
      update: async (...args) => { writes.push(['update', ...args]); throw new Error('定位链路不允许写业务表'); },
    },
  });
  const replied = [];
  service.replyText = async (_messageId, content) => { replied.push(content); return 'om_reply'; };
  // ⭐ ④ 这条消息在**话题**里 → 「认不出」那句话走的是**回复到话题**那条出口
  // （带 `reply_in_thread`），所以这里也要把那条出口抓下来。
  service.replyTextInThread = async (_messageId, content) => {
    replied.push(content);
    return { messageId: 'om_reply', threadId: 'omt_unknown_thread' };
  };

  // 这条话题我们没记过；正文里**故意**带上一个真实批次号——也不能因此去猜。
  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_topic_unknown',
    threadId: 'omt_unknown_thread',
    text: 'BH-20261005-0001 这批你看下',
  }));

  assert.equal(result.resolved, false);
  assert.equal(result.reason, 'not_found');
  assert.equal(replied.length, 1);
  assert.match(replied[0], /没认出来|认不出|批次号/);
  assert.deepEqual(writes, [], '认不出时一次业务写都不允许有');
});

test('C：普通群里第一条回复（话题没记过、但引用得到）→ 用 parent_id 命中并把 thread_id 补记', async () => {
  const { locator, store } = await makeGroupContext({ mappingMessageId: 'om_purchase_first', batchNo: 'BH-20261005-0021' });
  const { service } = makeService({ purchaseBatchLocator: locator });
  service.replyText = async () => { throw new Error('定位成功不该回消息'); };

  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_first_reply',
    threadId: 'omt_new_thread',
    parentId: 'om_purchase_first',
    text: '这批到了',
  }));

  assert.equal(result.resolved, true);
  assert.equal(result.reason, 'parent_id');
  assert.equal(result.batchNo, 'BH-20261005-0021');
  // 补记之后，这条话题下的**后续**消息（不再引用机器人那条）也能只靠 thread_id 命中。
  const after = await new PurchaseBatchLocator({ store }).resolve({ threadId: 'omt_new_thread' });
  assert.equal(after.status, 'matched');
  assert.equal(after.source, 'thread_id');
  assert.equal(after.batchNo, 'BH-20261005-0021');
});

test('C①：@ + 引用机器人发的采购单 → 用 parent_id 命中映射，定位到正确批次', async () => {
  const { locator } = await makeGroupContext({ mappingMessageId: 'om_purchase_1', batchNo: 'BH-20261005-0007' });
  const replied = [];
  const { service } = makeService({ purchaseBatchLocator: locator });
  // 定位成功时**只回一句问清楚**的那条路不该被走到：把引用回复全记下来断言它没被调用。
  service.replyText = async (messageId, content) => { replied.push({ messageId, content }); return 'om_reply'; };

  const result = await service.acceptMessage(groupEvent({
    text: '@_user_1 这批鞋到了，帮我核对一下',
    parentId: 'om_purchase_1',
  }));

  assert.equal(result.resolved, true);
  assert.equal(result.reason, 'parent_id');
  assert.equal(result.batchNo, 'BH-20261005-0007');
  assert.equal(result.batch.message_id, 'om_purchase_1');
  assert.deepEqual(replied, [], '定位成功不该再发问句');
});

test('C②：@ 但没引用 → 按正文里的批次号定位', async () => {
  const { locator } = await makeGroupContext({ mappingMessageId: 'om_purchase_9', batchNo: 'BH-20261005-0009' });
  const { service } = makeService({ purchaseBatchLocator: locator });
  service.replyText = async () => { throw new Error('不该回消息'); };

  const result = await service.acceptMessage(groupEvent({
    text: '@_user_1 BH-20261005-0009 这批的到货单你看下',
  }));

  assert.equal(result.resolved, true);
  assert.equal(result.reason, 'batch_no');
  assert.equal(result.batchNo, 'BH-20261005-0009');
});

test('C③：@ 但既没引用也没说批次号 → 回一句问清楚，零写入', async () => {
  const writes = [];
  const { locator } = await makeGroupContext();
  const { service } = makeService({
    purchaseBatchLocator: locator,
    gateway: {
      table: () => ({}),
      listAll: async () => [],
      get: async () => null,
      create: async (...args) => { writes.push(['create', ...args]); throw new Error('定位链路不允许写业务表'); },
      update: async (...args) => { writes.push(['update', ...args]); throw new Error('定位链路不允许写业务表'); },
    },
  });
  const replied = [];
  service.replyText = async (messageId, content) => { replied.push({ messageId, content }); return 'om_reply'; };

  const result = await service.acceptMessage(groupEvent({ text: '@_user_1 这批鞋到了' }));

  assert.equal(result.resolved, false);
  assert.equal(result.reason, 'ambiguous');
  assert.equal(replied.length, 1);
  assert.equal(replied[0].messageId, 'om_group_1');
  assert.match(replied[0].content, /分不清|批次号/);
  assert.deepEqual(writes, [], '定位不到时一次业务写都不允许有');
});

test('C④：parent_id 查不到映射 → 明确回「认不出哪一批」，不回退去猜，零写入', async () => {
  const writes = [];
  const { locator } = await makeGroupContext({ mappingMessageId: 'om_purchase_known' });
  const { service } = makeService({
    purchaseBatchLocator: locator,
    gateway: {
      table: () => ({}),
      listAll: async () => [],
      get: async () => null,
      create: async (...args) => { writes.push(['create', ...args]); throw new Error('定位链路不允许写业务表'); },
      update: async (...args) => { writes.push(['update', ...args]); throw new Error('定位链路不允许写业务表'); },
    },
  });
  const replied = [];
  service.replyText = async (_messageId, content) => { replied.push(content); return 'om_reply'; };

  // 引用的是**别人的**消息（不是机器人发的采购单）。
  const result = await service.acceptMessage(groupEvent({
    text: '@_user_1 这条你看下',
    parentId: 'om_someone_else',
  }));

  assert.equal(result.resolved, false);
  assert.equal(result.reason, 'not_found');
  assert.equal(replied.length, 1);
  assert.match(replied[0], /没认出来|认不出|批次号/);
  assert.deepEqual(writes, []);
});

test('C：说了两个批次号 → 判为说不清，反问，绝不挑一个', async () => {
  const { locator } = await makeGroupContext();
  await locator.rememberGroupMessage({ batchNo: 'BH-20261005-0001', messageId: 'om_a' });
  await locator.rememberGroupMessage({ batchNo: 'BH-20261005-0002', messageId: 'om_b' });
  const { service } = makeService({ purchaseBatchLocator: locator });
  const replied = [];
  service.replyText = async (_messageId, content) => { replied.push(content); return 'om_reply'; };

  const result = await service.acceptMessage(groupEvent({
    text: '@_user_1 BH-20261005-0001 和 BH-20261005-0002 这两批都要',
  }));

  assert.equal(result.resolved, false);
  assert.equal(result.reason, 'ambiguous');
  assert.equal(replied.length, 1);
});

test('B：@ 占位符被剥掉——送到定位链路的是「她真正说的那句话」', async () => {
  const seen = [];
  const { service } = makeService({
    groupPurchaseFlow: {
      handleGroupPurchaseMessage: async ({ text, messageId, parentId }) => {
        seen.push({ text, messageId, parentId });
        return { resolved: true, reason: 'test' };
      },
    },
  });
  // 群里 @ 了两个人：两个占位符都要剥掉，并且不能把正文吃掉。
  // ⚠️ 正文刻意用**不像销售**的一句（不含数字、不含业务关键词）：主群里 @ 机器人
  //    说一笔销售现在归销售链路（见 salesGroupThread.test.js），这条用例验证的是
  //    "剥占位符"这一件事，所以走采购那条路来断言。
  await service.acceptMessage(groupEvent({
    text: '@_user_1 @_user_2 这批到了 你看下',
    mentions: [
      { key: '@_user_1', id: TEST_BOT_OPEN_ID, name: '测试机器人' },
      { key: '@_user_2', id: 'ou_someone', name: '别人' },
    ],
  }));

  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, '这批到了 你看下');
  assert.ok(!seen[0].text.includes('@_user_1'));
  assert.ok(!seen[0].text.includes('@_user_2'));
  assert.equal(seen[0].messageId, 'om_group_1');
});

test('B：私聊与群聊各自加 OneSecond 表情；只有私聊回「已收到」文字', async () => {
  const { locator } = await makeGroupContext({ mappingMessageId: 'om_purchase_2' });
  // 用真实的 acknowledgeMessage + 假 client：断言"实际发出去的表情是什么"。
  const { service, reactions } = makeReactionService();
  service.purchaseBatchLocator = locator;
  service.groupPurchaseFlow.locator = locator;
  const replies = [];
  service.replyText = async (_messageId, content) => { replies.push(content); return 'om_reply'; };
  service.processSalesTask = async () => undefined;

  // 私聊：表情 + 「已收到」文字（现状不变）
  await service.acceptMessage({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: {
      message_id: 'om_private_ack',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '8088 黑 38 一双 230 微信' }),
    },
  });
  assert.deepEqual(reactions, [{ messageId: 'om_private_ack', emoji: 'OneSecond' }]);
  assert.deepEqual(replies, ['👀 已收到，正在识别销售信息，请稍候…']);

  // 群聊：只有表情，**不回文字**（群里回文字会刷屏）
  await service.acceptMessage(groupEvent({
    messageId: 'om_group_ack',
    text: '@_user_1 这批到了',
    parentId: 'om_purchase_2',
  }));
  assert.deepEqual(reactions[1], { messageId: 'om_group_ack', emoji: 'OneSecond' });
  assert.equal(replies.length, 1, '群聊不该再回「已收到」文字');
});

test('B：表情加不上（缺权限）只记日志，不影响主流程', async () => {
  const { locator } = await makeGroupContext({ mappingMessageId: 'om_purchase_3' });
  const { service } = makeService({
    client: {
      im: {
        messageReaction: {
          create: async () => { throw new Error('99991672 缺少 im:message.reactions:write 权限'); },
        },
      },
    },
    purchaseBatchLocator: locator,
  });
  // 解掉 acknowledgeMessage 的打桩：这里要验证的正是"表情失败会不会影响主流程"。
  service.acknowledgeMessage = LarkMvpService.prototype.acknowledgeMessage;
  service.replyText = async () => { throw new Error('不该回消息'); };

  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_group_reaction_fail',
    text: '@_user_1 这批到了',
    parentId: 'om_purchase_3',
  }));

  assert.equal(result.resolved, true);
  assert.equal(result.batchNo, 'BH-20261005-0001');
});
