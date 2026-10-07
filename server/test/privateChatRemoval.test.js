/**
 * 🔴「私聊链路移除」的验收测试（业务负责人 2026-10-07：「以后私聊这条链路我们就没有了」）。
 *
 * 她拍板的方式是 **ⓐ：代码里一行私聊都不留**（见
 * `docs/private-chat-removal-decision-2026-10-07.md`）——
 * **没有** `PRIVATE_CHAT_*` 之类的开关，也**没有**"测试专用 helper"：
 * 约 20+ 条历史用例已经**迁到群入口**（散在各自的文件里），这一份只管：
 *
 *   ① 私聊消息 → **只记一条日志**：不建任务、不进 AI、不写表、**也不回消息**；
 *   ② 没有群上下文的任务 → **没有去处**：不发 + 记 `lark.private_chat.send_skipped`；
 *   ③ 群销售 → 补样品提醒回到**那条销售话题**；工作台那条路（没有群上下文）→ 不发；
 *   ④ 私聊专属的东西**已经不在了**（死代码 / 孤儿卡片 / 路由分支 / open_id 发送器）；
 *   ⑤ 群聊那条真入口**不受影响**（准入 / 话题免 @ / 卡片出口 / 表情）。
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

const TEST_BOT_OPEN_ID = 'ou_test_bot_open_id';
const TEST_SELLER = 'ou_seller';
const GROUP_CHAT_ID = 'oc_test_group';
const PRODUCT_FIELD = V1_BITABLE_SCHEMA.tables.product.fields.number;

// ═══════════════════════════════════════════════════════════════════════════
// 0. 工具
// ═══════════════════════════════════════════════════════════════════════════

const tempStore = (prefix = 'private-chat-') =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

/**
 * 抓 `lark.*` 结构化日志（logger：info → console.log → stdout；warn/error → stderr）。
 * ⚠️ 只**旁听**、照样原样转发给真正的流，免得把测试 runner 自己的输出吞掉。
 */
const captureLogs = async (fn) => {
  const lines = [];
  const patch = (stream) => {
    const original = stream.write;
    stream.write = function write(chunk, ...rest) {
      const text = String(chunk);
      if (text.includes('"event"')) lines.push(text);
      return original.apply(stream, [chunk, ...rest]);
    };
    return () => { stream.write = original; };
  };
  const restoreOut = patch(process.stdout);
  const restoreErr = patch(process.stderr);
  try {
    await fn();
  } finally {
    restoreOut();
    restoreErr();
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

const groupThreadEvent = (messageId, text) => ({
  sender: { sender_id: { open_id: TEST_SELLER } },
  message: {
    message_id: messageId,
    chat_id: GROUP_CHAT_ID,
    chat_type: 'group',
    message_type: 'text',
    create_time: '1000',
    content: JSON.stringify({ text }),
    mentions: [], // 话题里**不 @** 也要处理（2026-10-06 真机测出来的判据）
    thread_id: 'omt_sale_1',
  },
});

const sampleDelivery = (detailId = 'detail_1') => ({
  sampleReplacements: [{ salesDetailRecordId: detailId, productRecordId: 'p_1', consumedLiveRecordIds: [] }],
});

// ═══════════════════════════════════════════════════════════════════════════
// ① 私聊入口：只记一条日志 —— 不建任务 / 不进 AI / 不写表 / **不回消息**
// ═══════════════════════════════════════════════════════════════════════════

test('① 私聊文字 → 不建任务 / 不进 AI / 不写表 / 不加表情 / **也不回消息**，只记一条日志', async () => {
  const { service, sent, replies, reactions, created, updated, parseCalls } = makeHarness();

  let result;
  const logs = await captureLogs(async () => {
    result = await service.acceptMessage(privateEvent('om_p2p_text', 'A100 38码一双，100元微信'));
  });

  assert.deepEqual(result, { accepted: false, reason: 'private_chat_removed' });
  assert.equal(parseCalls(), 0, '私聊不再进 AI');
  assert.deepEqual(created, [], '一个业务写都没有');
  assert.deepEqual(updated, [], '一个业务写都没有');
  assert.deepEqual(await service.store.list(), [], '连本地任务都不建');
  assert.deepEqual(reactions, [], '不再加「收到」表情（那条链路整个不跑了）');
  assert.deepEqual(sent, [], '**一条主动消息都不发**（那句"请到群里说"的开关已经删掉）');
  assert.deepEqual(replies, [], '也不做任何回复');
  assert.match(logs, /lark\.private_chat\.disabled/, '可排查：不是静默失效');
});

test('① 私聊的非文字 / 空文字 → 与文字**同一档**：静默 + 一条日志（旧的两条提示已删）', async () => {
  const { service, sent, replies } = makeHarness();

  const image = await service.acceptMessage(
    privateEvent('om_p2p_image', '', 'image', JSON.stringify({ image_key: 'img_1' })),
  );
  const empty = await service.acceptMessage(privateEvent('om_p2p_empty', '   '));

  assert.deepEqual(image, { accepted: false, reason: 'private_chat_removed' });
  assert.deepEqual(empty, { accepted: false, reason: 'private_chat_removed' });
  assert.deepEqual(sent, []);
  assert.deepEqual(replies, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 没有群上下文的任务：**没有去处** → 不发 + 记 skip
// ═══════════════════════════════════════════════════════════════════════════

test('② 没有群上下文的任务：sendTaskCard / sendTaskText **不发、返 null、记 skip**', async () => {
  const { service, sent, replies } = makeHarness();
  const noChannelTask = { task_id: 't_no_channel', type: 'sale', sender_open_id: TEST_SELLER };

  const logs = await captureLogs(async () => {
    assert.equal(await service.sendTaskCard(noChannelTask, { header: {} }), null);
    assert.equal(await service.sendTaskText(noChannelTask, '回你一句'), null);
  });

  assert.deepEqual(replies, [], '没有去处 → 一个远端调用都不做');
  assert.deepEqual(sent, [], '更没有主动私聊');
  assert.match(logs, /lark\.private_chat\.send_skipped/);
  assert.match(logs, /"kind":"card"/);
  assert.match(logs, /"kind":"text"/);
  assert.match(logs, /"reason":"no_group_context"/);
});

test('② 私聊触发的补样品提醒（没有群上下文）→ 不发，只记 skip；也不记 notice_sent', async () => {
  const { service, sent, replies } = makeHarness();

  const logs = await captureLogs(async () => {
    await service.notifySampleReplacements(sampleDelivery('detail_p2p'), TEST_SELLER);
  });

  assert.deepEqual(sent, [], '不再静默发私聊（这是**有意的行为变化**）');
  assert.deepEqual(replies, []);
  assert.match(logs, /lark\.private_chat\.send_skipped/);

  // 没发出去就不算发过 —— 将来有了渠道还能再发一次。
  const tasks = await service.store.list();
  assert.equal(tasks.length, 1, '补样品任务本身**照建**（它是业务状态，不依赖发不发得出去）');
  assert.equal(tasks[0].notice_sent, undefined, '没发出去就不许记 notice_sent');
  assert.equal(tasks[0].card_message_id, undefined);
});

test('② ⭐ 工作台触发那条路（`routes/workbench.js` 自己 new 的 service）同样不发，且注明 no_group_context', async () => {
  // 工作台**不经过** `larkMvpService` 的适配器，走的是 SampleReplacementService 的**缺省出口** ——
  // 这条缺省分支必须自己判一次，否则"私聊链路移除"会在这一条路上留个口子。
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
  assert.match(logs, /lark\.private_chat\.send_skipped/);
  assert.match(logs, /"reason":"no_group_context"/);
  const tasks = await workbenchNotifier.store.list();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].notice_sent, undefined);
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 群销售 → 补样品提醒回到**那条销售话题**
// ═══════════════════════════════════════════════════════════════════════════

test('③ 群销售的补样品提醒 → 卡片回到**那条销售话题**（reply_in_thread），零主动私聊', async () => {
  const { service, sent, replies, sampleCandidateCalls } = makeHarness();
  const channelTask = {
    task_id: 'sale_group_1', type: 'sale', chat_type: 'group', chat_id: GROUP_CHAT_ID,
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

// ═══════════════════════════════════════════════════════════════════════════
// ④ 私聊专属的东西**已经不在了**
// ═══════════════════════════════════════════════════════════════════════════

test('④ `PurchaseWebhookService.sendCard`（全仓无调用方）已删除', () => {
  assert.equal(PurchaseWebhookService.prototype.sendCard, undefined);
  // 同类里另外三个「发消息」的方法还在（名字各不相同，见类内注释）。
  assert.equal(typeof PurchaseWebhookService.prototype.sendText, 'function');
  assert.equal(typeof PurchaseWebhookService.prototype.sendImage, 'function');
  assert.equal(typeof PurchaseWebhookService.prototype.sendPurchaseGroupNotice, 'function');
});

test('④ 私聊专属的入口与卡片都已删除：sendTodaySales / handleBotMenu / todaySalesCard', () => {
  assert.equal(LarkMvpService.prototype.sendTodaySales, undefined);
  assert.equal(LarkMvpService.prototype.handleBotMenu, undefined);
  assert.equal(larkCards.todaySalesCard, undefined);
});

test('④ 路由不再注册机器人菜单事件（application.bot.menu_v6），但消息入口还在', () => {
  const handlers = createLarkEventHandlers({
    handleCardAction: async () => ({}),
    sendText: async () => undefined,
  });
  assert.equal(handlers['application.bot.menu_v6'], undefined);
  assert.equal(typeof handlers['im.message.receive_v1'], 'function');
  assert.equal(typeof handlers['card.action.trigger'], 'function');
});

test('④ SampleReplacementService 里**没有** open_id 发送器（sendCard / sendText 已整体删除）', () => {
  const { SampleReplacementService } = require('../src/services/sampleReplacementService');
  const notifier = new SampleReplacementService({
    gateway: { table: () => ({ fields: {} }), get: async () => null },
    inventory: { sampleReplacementCandidates: async () => [] },
    store: tempStore('private-chat-no-sender-'),
    client: {},
  });
  assert.equal(notifier.sendCard, undefined);
  assert.equal(notifier.sendText, undefined);
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 群聊那条真入口不受影响
// ═══════════════════════════════════════════════════════════════════════════

test('⑤ 话题里不 @ 也处理；任务带群上下文；采购那条路没被碰', async () => {
  const { service, reactions, purchaseCalls } = makeHarness();
  service.processSalesTask = async () => undefined;
  // 先把这个话题**记成本地映射里的那一笔销售**（真实链路是先建单、再记映射）。
  await service.salesGroupThreads.rememberSaleThread({
    salesEntryRecordId: 'entry_existing', taskId: 'sale_orig', messageId: 'om_orig_sale',
    threadId: 'omt_sale_1', chatId: GROUP_CHAT_ID, senderOpenId: TEST_SELLER,
  });

  const result = await service.acceptMessage(groupThreadEvent('om_group_thread', '再记一双 8088 黑 38 230 微信'));

  assert.equal(result.accepted, true, '话题里的消息免 @，必须被处理');
  assert.equal(result.mode, 'thread');
  assert.equal(result.source, 'thread_id');
  assert.deepEqual(purchaseCalls, [], '认得出是哪一笔销售 → 绝不进采购链路');

  const task = await service.store.get(result.sales.taskId);
  assert.equal(task.chat_type, 'group');
  assert.equal(task.chat_id, GROUP_CHAT_ID);
  assert.equal(task.group_thread_id, 'omt_sale_1');
  assert.equal(task.sales_entry_record_id, 'entry_existing', '绑定到已定位的那一笔');
  assert.deepEqual(reactions.map((item) => item.emoji), ['OneSecond'], '群聊「收到」仍然只有表情');
});

test('⑤ 群任务的两条出口 payload 不变：卡片/文字都回到那条消息的话题', async () => {
  const { service, sent, replies } = makeHarness();
  const groupTask = {
    task_id: 'sale_group_2', type: 'sale', chat_type: 'group', chat_id: GROUP_CHAT_ID,
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

test('⑤ 主群准入判据不受影响（三条判据都在）', () => {
  const { service } = makeHarness();
  assert.equal(service.resolveMainChatAdmission(
    { mentions: [{ id: TEST_BOT_OPEN_ID }] }, '你好',
  ).accepted, true);
  assert.equal(service.resolveMainChatAdmission({ mentions: [] }, '8088 黑 38 一双 230 微信').accepted, true);
  assert.equal(service.resolveMainChatAdmission({ mentions: [] }, 'BH-20261005-0009 这批到哪了').accepted, true);
  assert.deepEqual(service.resolveMainChatAdmission({ mentions: [] }, '今天天气不错'),
    { accepted: false, reason: 'group_not_sales_text' });
});
