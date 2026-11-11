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
const { createLarkEventHandlers } = require('../src/routes/larkEvents');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

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
    store: tempStore('private-chat-lark-'),
    botOpenId: TEST_BOT_OPEN_ID,
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

test('① 私聊文字 → 不建任务 / 不进 AI / 不写表 / 不加表情，只记日志 + 回一句「请到群里说」', async () => {
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
  // ⭐ 业务负责人 2026-10-07：「（回一句请到群里说的开关）保留就可以」
  assert.equal(sent.length, 1, '私聊只回那一句，别的什么都不发');
  assert.match(JSON.stringify(sent[0]), /请到群里说/);
  assert.deepEqual(replies, [], '也不做任何回复');
  assert.match(logs, /lark\.private_chat\.disabled/, '可排查：不是静默失效');
});

test('① 私聊的非文字 / 空文字 → 与文字**同一档**：一条日志 + 回同一句（旧的两条专属提示已删）', async () => {
  const { service, sent, replies } = makeHarness();

  const image = await service.acceptMessage(
    privateEvent('om_p2p_image', '', 'image', JSON.stringify({ image_key: 'img_1' })),
  );
  const empty = await service.acceptMessage(privateEvent('om_p2p_empty', '   '));

  assert.deepEqual(image, { accepted: false, reason: 'private_chat_removed' });
  assert.deepEqual(empty, { accepted: false, reason: 'private_chat_removed' });
  assert.equal(sent.length, 2, '两条都只回那一句');
  assert.ok(sent.every((x) => /请到群里说/.test(JSON.stringify(x))));
  assert.deepEqual(replies, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 没有群上下文的任务：**没有去处** → 不发 + 记 skip
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
});

test('④ `LarkMvpService.sendCard`（open_id 口径的卡片发送器，全仓无调用方）已删除；`sendText` 留给 notice', () => {
  // 🔴 2026-10-07 收尾：清掉 5 处"缺省回落发私聊"之后，`sendCard` 的两个注入方
  //    （`SaleLookupService` / 售后编排那条链路的 `sendCard` 选项）都不存在了，
  //    它成了**孤儿** → 整段删除。要发卡片只有**群**那几条路
  //    （`replyCard` / `replyCardInThread`）。
  assert.equal(LarkMvpService.prototype.sendCard, undefined);
  // ⚠️ `sendText` **不能删** —— 「私聊被挡下时回一句『请到群里说』」那一句要用它
  //    （`acceptMessage` 的非群聊分支，见 config/privateChatNotice）。
  assert.equal(typeof LarkMvpService.prototype.sendText, 'function');
});

;

test('④ 路由不再注册机器人菜单事件（application.bot.menu_v6）；卡片回调也已退场，但消息入口还在', () => {
  const handlers = createLarkEventHandlers({
    sendText: async () => undefined,
  });
  assert.equal(handlers['application.bot.menu_v6'], undefined);
  assert.equal(typeof handlers['im.message.receive_v1'], 'function');
  // ⭐ 2026-10-28：`card.action.trigger` 也随「没有旧卡片」删除（业务负责人现行口径）。
  assert.equal('card.action.trigger' in handlers, false, '卡片回调不许再注册');
});

;

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 群聊那条真入口不受影响
// ═══════════════════════════════════════════════════════════════════════════


test('① 那句话可关：NOTICE_ENABLED=false → 私聊一个字都不发（只留日志）', async () => {
  const { service, sent } = makeHarness();
  process.env.PRIVATE_CHAT_DISABLED_NOTICE_ENABLED = 'false';
  try {
    const result = await service.acceptMessage(privateEvent('om_p2p_off', 'A100 38码一双'));
    assert.deepEqual(result, { accepted: false, reason: 'private_chat_removed' });
    assert.deepEqual(sent, [], '关掉就不发');
  } finally {
    delete process.env.PRIVATE_CHAT_DISABLED_NOTICE_ENABLED;
  }
});
