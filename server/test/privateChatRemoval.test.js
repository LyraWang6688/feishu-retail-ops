/**
 * 🔴「私聊链路移除 · ⓐ 彻底版」的验收测试
 *    （业务负责人 2026-10-07：「**干净、彻底** …… **以后代码里【一行私聊都没有】**」）。
 *
 * 验收标准逐条对照见 `docs/private-chat-removal-hard-2026-10-07.md`：
 *   A 私聊入口 —— 只记一条日志，**不建任务、不进 AI、不写表、不加表情**（+ 可选的一句文案）
 *   A4/A5/B3 两个"可显式恢复"的开关与私聊发送分支**已从代码里删除**
 *   B 发送出口 —— 非群任务**不发**；群任务照旧回到那条话题（payload 逐字不变）
 *   C 补样品提醒 —— 群销售回话题；没有群上下文就不发
 *   D 群聊回归 —— **先判 `thread_id`** / 话题免 @ / 主群三判据 / 卡片出口逐字不变
 *
 * ⚠️ 这个文件**刻意不做任何"打开私聊"的准备** —— 因为已经没有任何开关可以打开它。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService } = require('../src/services/larkMvpService');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const { SalesGroupThreadLocator } = require('../src/services/salesGroupThreadLocator');
const { createLarkEventHandlers } = require('../src/routes/larkEvents');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const larkCards = require('../src/utils/larkCards');
const privateChatConfig = require('../src/config/privateChat');
const {
  PRIVATE_CHAT_NOTICE_ENV_KEY,
  PRIVATE_CHAT_NOTICE_TEXT_ENV_KEY,
  DEFAULT_NOTICE_TEXT,
  resolvePrivateChatNotice,
} = require('../src/config/privateChat');

const TEST_BOT_OPEN_ID = 'ou_test_bot_open_id';
const TEST_SELLER = 'ou_seller';
const PRODUCT_FIELD = V1_BITABLE_SCHEMA.tables.product.fields.number;

// ═══════════════════════════════════════════════════════════════════════════
// 0. 工具
// ═══════════════════════════════════════════════════════════════════════════

const tempStore = (prefix = 'private-chat-') =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

/** 临时改环境变量跑一段，跑完**原样还原**（包括"本来就没设"这一种）。 */
const withEnv = async (vars, fn) => {
  const saved = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.entries(vars).forEach(([key, value]) => { process.env[key] = value; });
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

/**
 * 抓 `lark.*` 结构化日志（logger 走 console.log → process.stdout.write）。
 * ⚠️ 只**旁听**、照样原样转发给真正的 stdout，免得把测试 runner 自己的输出吞掉。
 */
const captureLogs = async (fn) => {
  const lines = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    const text = String(chunk);
    if (text.includes('"event"')) lines.push(text);
    return original.call(process.stdout, chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return lines.join('');
};

const makeClient = () => {
  const sent = []; // 主动发（im.message.create）
  const replies = []; // 回复（im.message.reply）
  const reactions = [];
  const client = {
    im: {
      message: {
        create: async ({ params, data }) => {
          sent.push({ params, data });
          return { code: 0, data: { message_id: `om_sent_${sent.length}` } };
        },
        reply: async ({ path: replyPath, data }) => {
          replies.push({ path: replyPath, data });
          return { code: 0, data: { message_id: `om_reply_${replies.length}`, thread_id: 'omt_new' } };
        },
      },
      messageReaction: {
        create: async ({ path: reactionPath, data }) => {
          reactions.push({ messageId: reactionPath?.message_id, emoji: data?.reaction_type?.emoji_type });
          return { code: 0 };
        },
      },
    },
  };
  return { client, sent, replies, reactions };
};

const makeGateway = () => {
  const created = [];
  const updated = [];
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key] || {},
    listAll: async () => [],
    validateTables: async () => [],
    create: async (key, fields) => { created.push({ key, fields }); return { recordId: 'rec_1' }; },
    update: async (key, recordId, fields) => { updated.push({ key, recordId, fields }); },
    get: async () => ({ fields: { [PRODUCT_FIELD]: '8088-26棕' } }),
  };
  return { gateway, created, updated };
};

/**
 * 全套替身：飞书 client（主动发 / 回复 / 表情）、业务网关、AI 识别器、库存。
 * 「不建任务 / 不进 AI / 不写表 / 不发消息」这四条红线全靠它来证。
 */
const makeHarness = () => {
  const { client, sent, replies, reactions } = makeClient();
  const { gateway, created, updated } = makeGateway();
  const purchaseCalls = [];
  const sampleCandidateCalls = [];
  let parseCalls = 0;
  const service = new LarkMvpService({
    client,
    gateway,
    references: {},
    posting: {},
    // 「第二次交付」在构造时会再包一层 delivery，这里不需要它。
    secondDelivery: {},
    recognizer: { parseSalesText: async () => { parseCalls += 1; return { intent: 'unsupported', items: [] }; } },
    store: tempStore('private-chat-lark-'),
    botOpenId: TEST_BOT_OPEN_ID,
    salesGroupThreads: new SalesGroupThreadLocator({ store: tempStore('private-chat-threads-') }),
    // 「话题 ↔ 销售」的本地映射 / 深链落点：本文件只关心"发到哪里"，换成记录型空实现。
    salesMessageLinks: { rememberFromSend: async () => null },
    // 采购那条路换成一个记录型桩：用它证明"这条消息没走采购"。
    groupPurchaseFlow: {
      handleGroupPurchaseMessage: async (input) => { purchaseCalls.push(input); return { mode: 'purchase' }; },
    },
    // 补样品提醒要用的库存端口（只走这一个方法）。
    delivery: {
      inventory: {
        sampleReplacementCandidates: async (productRecordId) => {
          sampleCandidateCalls.push(productRecordId);
          return [];
        },
      },
      deliver: async () => ({}),
    },
  });
  return {
    service, client, sent, replies, reactions, created, updated,
    purchaseCalls, sampleCandidateCalls, parseCalls: () => parseCalls,
  };
};

const privateEvent = (messageId, text, messageType = 'text', content = null) => ({
  sender: { sender_id: { open_id: TEST_SELLER } },
  message: {
    message_id: messageId,
    chat_id: 'oc_private',
    chat_type: 'p2p',
    message_type: messageType,
    create_time: '1000',
    content: content || (messageType === 'text' ? JSON.stringify({ text }) : ''),
  },
});

const groupThreadEvent = (messageId, text, overrides = {}) => ({
  sender: { sender_id: { open_id: TEST_SELLER } },
  message: {
    message_id: messageId,
    chat_id: 'oc_test_group',
    chat_type: 'group',
    message_type: 'text',
    create_time: '1000',
    content: JSON.stringify({ text }),
    mentions: [], // 话题里**不 @** 也要处理（2026-10-06 真机测出来的判据）
    thread_id: 'omt_sale_1',
    ...overrides,
  },
});

const sampleDelivery = (detailId = 'detail_1') => ({
  sampleReplacements: [{ salesDetailRecordId: detailId, productRecordId: 'p_1', consumedLiveRecordIds: [] }],
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. 配置：只剩"一句话"（入口与发送两件事上**再没有任何开关**）
// ═══════════════════════════════════════════════════════════════════════════

test('D 配置：私聊入口/发送的开关**已从模块里删除**（只剩文案那两个旋钮）', () => {
  assert.equal(privateChatConfig.isPrivateChatIntakeEnabled, undefined,
    'PRIVATE_CHAT_INTAKE_ENABLED 的读取点必须整体删除');
  assert.equal(privateChatConfig.isPrivateChatSendEnabled, undefined,
    'PRIVATE_CHAT_SEND_ENABLED 的读取点必须整体删除');
  assert.deepEqual(Object.keys(privateChatConfig).sort(), [
    'DEFAULT_NOTICE_TEXT',
    'PRIVATE_CHAT_NOTICE_ENV_KEY',
    'PRIVATE_CHAT_NOTICE_TEXT_ENV_KEY',
    'resolvePrivateChatNotice',
  ], '模块只导出"那句话"的开关与文案，不导出任何入口/发送开关');
});

test('D 配置：变量没设 → 默认（回一句文案）', () => {
  assert.deepEqual(resolvePrivateChatNotice({}), { enabled: true, text: DEFAULT_NOTICE_TEXT });
});

test('D 配置：**空串 = 关掉**（真的是关，不回退默认）—— 这正是"关不掉"那个坑的反面', () => {
  assert.equal(resolvePrivateChatNotice({ [PRIVATE_CHAT_NOTICE_ENV_KEY]: '' }).enabled, false,
    'notice 默认 true；显式设成空串 = 关掉它（不是回退默认 true）');
});

test('D 配置：认得出的写法都认；**认不出的值当场抛错**（不猜）', () => {
  for (const value of ['false', 'FALSE', '0', 'no', 'off']) {
    assert.equal(resolvePrivateChatNotice({ [PRIVATE_CHAT_NOTICE_ENV_KEY]: value }).enabled, false, value);
  }
  for (const value of ['true', 'TRUE', '1', 'yes', 'on', ' on ']) {
    assert.equal(resolvePrivateChatNotice({ [PRIVATE_CHAT_NOTICE_ENV_KEY]: value }).enabled, true, value);
  }
  assert.throws(() => resolvePrivateChatNotice({ [PRIVATE_CHAT_NOTICE_ENV_KEY]: '哦' }),
    /PRIVATE_CHAT_DISABLED_NOTICE_ENABLED 必须是显式布尔/);
});

test('D 配置：notice 文案可配；设成空串 → 空串（调用方据此不发一条空消息）', () => {
  assert.equal(resolvePrivateChatNotice({ [PRIVATE_CHAT_NOTICE_TEXT_ENV_KEY]: '请到群里说' }).text, '请到群里说');
  assert.equal(resolvePrivateChatNotice({ [PRIVATE_CHAT_NOTICE_TEXT_ENV_KEY]: '' }).text, '');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. A —— 私聊入口：不建任务、不进 AI、不写表、不加表情；只回那一句
// ═══════════════════════════════════════════════════════════════════════════

test('A1+A2 私聊文字 → 不建任务 / 不进 AI / 不写表 / 不加表情；只回那一句 notice', async () => {
  const { service, sent, replies, reactions, created, updated, parseCalls } = makeHarness();

  const result = await service.acceptMessage(privateEvent('om_p2p_text', 'A100 38码一双，100元微信'));

  assert.deepEqual(result, { accepted: false, reason: 'private_chat_removed' });
  assert.equal(parseCalls(), 0, '私聊不再进 AI');
  assert.deepEqual(created, [], '一个业务写都没有');
  assert.deepEqual(updated, [], '一个业务写都没有');
  assert.deepEqual(await service.store.list(), [], '连本地任务都不建');
  assert.deepEqual(reactions, [], '不再加「收到」表情（那条链路整个不跑了）');
  assert.deepEqual(replies, [], '不做任何回复');

  // 唯一的那一次远端调用 = 那句固定文案。
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].params, { receive_id_type: 'open_id' });
  assert.equal(sent[0].data.receive_id, TEST_SELLER);
  assert.equal(sent[0].data.msg_type, 'text');
  assert.deepEqual(JSON.parse(sent[0].data.content), { text: DEFAULT_NOTICE_TEXT });
});

test('A3 私聊**非文字 / 空文字** → 与文字同一档；旧的两条私聊专属提示不再出现', async () => {
  const { service, sent } = makeHarness();

  const image = await service.acceptMessage(
    privateEvent('om_p2p_image', '', 'image', JSON.stringify({ image_key: 'img_1' })),
  );
  const empty = await service.acceptMessage(privateEvent('om_p2p_empty', '   '));

  assert.deepEqual(image, { accepted: false, reason: 'private_chat_removed' });
  assert.deepEqual(empty, { accepted: false, reason: 'private_chat_removed' });
  assert.equal(sent.length, 2, '两条都只回 notice');
  const payloads = JSON.stringify(sent);
  assert.ok(!payloads.includes('机器人当前只接收销售文字'), '旧的非文字提示已随私聊入口删除');
  assert.ok(!payloads.includes('没有读到销售文字'), '旧的空文字提示已随私聊入口删除');
  assert.ok(payloads.includes(DEFAULT_NOTICE_TEXT));
});

test('A2 notice 关掉 → **一条消息都不发**；文案留空 → 同样不发（不发一条空消息）', async () => {
  await withEnv({ [PRIVATE_CHAT_NOTICE_ENV_KEY]: 'false' }, async () => {
    const { service, sent, replies } = makeHarness();
    const result = await service.acceptMessage(privateEvent('om_p2p_no_notice', 'A100 38码一双 100元'));
    assert.deepEqual(result, { accepted: false, reason: 'private_chat_removed' });
    assert.deepEqual(sent, []);
    assert.deepEqual(replies, []);
  });

  await withEnv({ [PRIVATE_CHAT_NOTICE_TEXT_ENV_KEY]: '' }, async () => {
    const { service, sent } = makeHarness();
    await service.acceptMessage(privateEvent('om_p2p_empty_notice', 'A100 38码一双 100元'));
    assert.deepEqual(sent, [], '文案留空 = 没什么可说的，就不发');
  });
});

test('A 私聊被挡下 → 记一条 lark.private_chat.removed 日志（可排查、不是静默失效）', async () => {
  const { service } = makeHarness();
  const logs = await captureLogs(async () => {
    await service.acceptMessage(privateEvent('om_p2p_log', 'A100 38码一双 100元'));
  });
  assert.match(logs, /lark\.private_chat\.removed/);
  assert.match(logs, /"stage":"intake"/);
  assert.match(logs, /"notice_sent":true/);
});

test('A4 ⭐ `PRIVATE_CHAT_INTAKE_ENABLED=true` **没有任何作用**（开关真的不存在了）', async () => {
  await withEnv({ PRIVATE_CHAT_INTAKE_ENABLED: 'true' }, async () => {
    const { service, sent, created, parseCalls } = makeHarness();
    const result = await service.acceptMessage(privateEvent('om_p2p_switch_gone', 'A100 38码一双，100元微信'));
    assert.deepEqual(result, { accepted: false, reason: 'private_chat_removed' },
      '这个变量已经不是配置了，设成 true 也不该有任何效果');
    assert.equal(parseCalls(), 0);
    assert.deepEqual(created, []);
    assert.deepEqual(await service.store.list(), []);
    assert.equal(sent.length, 1, '仍然只有那一句 notice');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. B —— 发送出口：非群任务**不发**（代码里没有"发到私聊"这一段了）
// ═══════════════════════════════════════════════════════════════════════════

test('B1 非群任务：sendTaskCard / sendTaskText **不发、返 null、记 removed**', async () => {
  const { service, sent, replies } = makeHarness();
  const orphanTask = { task_id: 't_no_group', type: 'sale', sender_open_id: TEST_SELLER };

  const logs = await captureLogs(async () => {
    assert.equal(await service.sendTaskCard(orphanTask, { header: {} }), null);
    assert.equal(await service.sendTaskText(orphanTask, '回你一句'), null);
  });

  assert.deepEqual(sent, [], '一条主动私聊都不许发');
  assert.deepEqual(replies, [], '也不许"回复"一条');
  assert.match(logs, /lark\.private_chat\.removed/);
  assert.match(logs, /"stage":"send"/);
  assert.match(logs, /"kind":"card"/);
  assert.match(logs, /"kind":"text"/);
});

test('B3 ⭐ `PRIVATE_CHAT_SEND_ENABLED=true` **没有任何作用**（开关真的不存在了）', async () => {
  await withEnv({ PRIVATE_CHAT_SEND_ENABLED: 'true' }, async () => {
    const { service, sent } = makeHarness();
    const orphanTask = { task_id: 't_no_group', sender_open_id: TEST_SELLER };
    assert.equal(await service.sendTaskCard(orphanTask, { header: { template: 'blue' } }), null);
    assert.equal(await service.sendTaskText(orphanTask, '回你一句'), null);
    assert.deepEqual(sent, [], '这个变量已经不是配置了，设成 true 也不该把私聊发出去');
  });
});

test('B2 群任务的三条出口 payload **逐字不变**：卡片/文字都回到那条消息的话题', async () => {
  const { service, sent, replies } = makeHarness();
  const groupTask = {
    task_id: 'sale_group_2', type: 'sale', chat_type: 'group', chat_id: 'oc_test_group',
    group_thread_id: 'omt_sale_1', message_id: 'om_her_sale', sender_open_id: TEST_SELLER,
    sales_entry_record_id: 'entry_1',
  };

  await service.sendTaskCard(groupTask, { header: {} });
  await service.sendTaskText(groupTask, '群里回一句');

  assert.equal(replies.length, 2);
  for (const item of replies) {
    assert.equal(item.path.message_id, 'om_her_sale');
    assert.equal(item.data.reply_in_thread, true);
  }
  assert.equal(replies[0].data.msg_type, 'interactive');
  assert.equal(replies[1].data.msg_type, 'text');
  assert.deepEqual(sent, [], '群这条路一条主动私聊都没有');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. C —— 补样品提醒：群销售回话题；没有群上下文就不发
// ═══════════════════════════════════════════════════════════════════════════

test('C3 群销售的补样品提醒 → 卡片回到**那条销售话题**（reply_in_thread），不发私聊', async () => {
  const { service, sent, replies, sampleCandidateCalls } = makeHarness();
  const channelTask = {
    task_id: 'sale_group_1', type: 'sale', chat_type: 'group', chat_id: 'oc_test_group',
    group_thread_id: 'omt_sale_1', message_id: 'om_her_sale', sender_open_id: TEST_SELLER,
    sales_entry_record_id: 'entry_1',
  };

  await service.notifySampleReplacements(sampleDelivery(), TEST_SELLER, { channelTask });

  assert.deepEqual(sampleCandidateCalls, ['p_1']);
  const card = replies.find((item) => item.data.msg_type === 'interactive');
  assert.ok(card, '群销售那条必须把补选卡片发出去');
  assert.equal(card.path.message_id, 'om_her_sale', '回到她那笔销售那条消息的话题');
  assert.equal(card.data.reply_in_thread, true);
  assert.deepEqual(sent, [], '群这条路一个主动私聊都不许有');
});

test('C3 没有群上下文的补样品提醒 → **不发**，只记一条 removed；也不记 notice_sent', async () => {
  const { service, sent, replies } = makeHarness();

  const logs = await captureLogs(async () => {
    await service.notifySampleReplacements(sampleDelivery('detail_no_group'), TEST_SELLER);
  });

  assert.deepEqual(sent, [], '没有群上下文就不再发任何消息（私聊出口已删除）');
  assert.deepEqual(replies, []);
  assert.match(logs, /lark\.private_chat\.removed/);

  // 没发出去就不算发过 —— 将来有了渠道还能再发一次。
  const tasks = await service.store.list();
  assert.equal(tasks.length, 1, '补样品任务本身**照建**（它是业务状态，不依赖发不发得出去）');
  assert.equal(tasks[0].notice_sent, undefined, '没发出去就不许记 notice_sent');
  assert.equal(tasks[0].card_message_id, undefined);
});

test('C3 ⭐ 工作台那条路（`routes/workbench.js` 自己 new 的 service）同样**一条都不发**', async () => {
  // 工作台**不经过** `larkMvpService` 的适配器，走的是 SampleReplacementService 的**缺省出口** ——
  // 那条缺省分支必须自己也不发，否则"私聊链路移除"会在这一条路上留个口子。
  const { SampleReplacementService } = require('../src/services/sampleReplacementService');
  const creates = [];
  const workbenchNotifier = new SampleReplacementService({
    gateway: {
      table: () => ({ fields: { number: '编号' } }),
      get: async () => ({ fields: { 编号: '8088-26棕' } }),
    },
    inventory: { sampleReplacementCandidates: async () => [] },
    store: tempStore('private-chat-workbench-'),
    client: {
      im: {
        message: {
          create: async (args) => { creates.push(args); return { code: 0, data: { message_id: 'om_never' } }; },
        },
      },
    },
  });

  const logs = await captureLogs(async () => {
    await workbenchNotifier.notifySampleReplacements(sampleDelivery('detail_wb'), TEST_SELLER);
  });

  assert.deepEqual(creates, [], '工作台触发的补样品提醒一条消息都不发');
  assert.match(logs, /lark\.private_chat\.removed/);
  assert.match(logs, /"reason":"no_group_context"/);
  const tasks = await workbenchNotifier.store.list();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].notice_sent, undefined);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. 私聊专属的东西**已经不在了**（死代码 / 孤儿卡片 / 路由分支）
// ═══════════════════════════════════════════════════════════════════════════

test('C4 `PurchaseWebhookService.sendCard`（全仓无调用方）已删除', () => {
  assert.equal(PurchaseWebhookService.prototype.sendCard, undefined);
  // 同类里另外三个「发消息」的方法还在（名字各不相同，见类内注释）。
  assert.equal(typeof PurchaseWebhookService.prototype.sendText, 'function');
  assert.equal(typeof PurchaseWebhookService.prototype.sendImage, 'function');
  assert.equal(typeof PurchaseWebhookService.prototype.sendPurchaseGroupNotice, 'function');
});

test('私聊专属的入口与卡片都已删除：sendTodaySales / handleBotMenu / todaySalesCard', () => {
  assert.equal(LarkMvpService.prototype.sendTodaySales, undefined);
  assert.equal(LarkMvpService.prototype.handleBotMenu, undefined);
  assert.equal(larkCards.todaySalesCard, undefined);
});

test('路由不再注册机器人菜单事件（application.bot.menu_v6），但消息入口还在', () => {
  const handlers = createLarkEventHandlers({
    handleCardAction: async () => ({}),
    sendText: async () => undefined,
  });
  assert.equal(handlers['application.bot.menu_v6'], undefined);
  assert.equal(typeof handlers['im.message.receive_v1'], 'function');
  assert.equal(typeof handlers['card.action.trigger'], 'function');
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. D —— 群聊入口回归：**先判 thread_id** / 免 @ / 主群三判据 / 卡片出口
// ═══════════════════════════════════════════════════════════════════════════

test('D1 话题里不 @ 也处理；任务带群上下文；采购那条路没被碰', async () => {
  const { service, reactions, purchaseCalls } = makeHarness();
  service.processSalesTask = async () => undefined;
  // 先把这个话题**记成本地映射里的那一笔销售**（真实链路是先建单、再记映射）。
  await service.salesGroupThreads.rememberSaleThread({
    salesEntryRecordId: 'entry_existing', taskId: 'sale_orig', messageId: 'om_orig_sale',
    threadId: 'omt_sale_1', chatId: 'oc_test_group', senderOpenId: TEST_SELLER,
  });

  const result = await service.acceptMessage(groupThreadEvent('om_group_thread', '再记一双 8088 黑 38 230 微信'));

  assert.equal(result.accepted, true, '话题里的消息免 @，必须被处理');
  assert.equal(result.mode, 'thread');
  assert.equal(result.source, 'thread_id');
  assert.deepEqual(purchaseCalls, [], '认得出是哪一笔销售 → 绝不进采购链路');

  const task = await service.store.get(result.sales.taskId);
  assert.equal(task.chat_type, 'group');
  assert.equal(task.chat_id, 'oc_test_group');
  assert.equal(task.group_thread_id, 'omt_sale_1');
  assert.equal(task.sales_entry_record_id, 'entry_existing', '绑定到已定位的那一笔');
  assert.deepEqual(reactions.map((item) => item.emoji), ['OneSecond'], '群聊「收到」仍然只有表情');
});

test('D1 ⭐ **先判 `thread_id`**：同一句"不像销售"的话，话题里理、主群不 @ 不理', async () => {
  const { service } = makeHarness();

  // ① 话题里（thread_id 有值）→ 一律处理，**不要求 @**（真机测出来的判据，顺序不能反）
  const inThread = await service.acceptMessage(groupThreadEvent('om_order_thread', '你好 小来财'));
  assert.equal(inThread.accepted, true, '话题本身就是"冲着机器人来的"判据');

  // ② 主群里同样那句话、同样没 @ → 完全静默（零远端调用）
  const inMain = await service.acceptMessage(groupThreadEvent('om_order_main', '你好 小来财', {
    thread_id: undefined,
  }));
  assert.deepEqual(inMain, { accepted: false, reason: 'group_not_sales_text' });
});

test('D1 主群准入的三条判据都在（@ / 像销售 / 带批次号）', () => {
  const { service } = makeHarness();
  // ① 主群 @ 了机器人 → 理
  assert.equal(service.resolveMainChatAdmission(
    { mentions: [{ id: TEST_BOT_OPEN_ID }] }, '你好',
  ).accepted, true);
  // ② 没 @ 但正文像销售 → 理（业务负责人 2026-10-06 拍板）
  assert.equal(service.resolveMainChatAdmission({ mentions: [] }, '8088 黑 38 一双 230 微信').accepted, true);
  // ③ 没 @ 但有采购批次号 → 理（归采购那条路）
  assert.equal(service.resolveMainChatAdmission({ mentions: [] }, 'BH-20261005-0009 这批到哪了').accepted, true);
  // 都不满足 → 静默不理（群里日常聊天零远端调用）
  assert.deepEqual(service.resolveMainChatAdmission({ mentions: [] }, '今天天气不错'),
    { accepted: false, reason: 'group_not_sales_text' });
});
