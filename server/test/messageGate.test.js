// 入口闸门（退换货第一期之后放宽）的验收测试。
//
// 这一组要钉住的核心是三件事：
//   1) 含数字 → 进（原有行为不变）
//   2) 不含数字但含业务关键词 → **进**（"我要退货" / "查一下我买的鞋" / "库存还有多少"）
//   3) 不含数字也不含关键词 → **不进、也不回**（"你好" / "在吗" / "今天天气" / "哈哈哈"）
//
// 第 3 条同时是"引导语不能顺手把无意义聊天也回了"的防线：闸门在 AI 之前，
// 所以这里断言的是「AI 没被调用」+「没有发出任何消息」+「没有建任务」三件事。
//
// 🔴 2026-10-07「私聊链路移除」：**入口闸门现在只有【群聊】一条路** ——
// 私聊入口已整体删除（业务负责人拍板的 ⓐ：代码里一行私聊都不留，见
// docs/private-chat-removal-decision-2026-10-07.md）。
// ⇒ 这些用例的输入从「私聊」迁到「**主群 + 不 @ 机器人**」：那是群里**唯一**
//   还需要闸门判据的那条入口（话题里的消息一律处理，不问闸门），
//   而它用的正是 `config/messageGate` 这**同一把尺子**
//   （`LarkMvpService.resolveMainChatAdmission` 的第二条判据）。
// ⇒ 断言跟着改：群入口的回复是「**回到那条消息的话题**」（`reply_in_thread: true`）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { LarkMvpService, looksLikeSalesText, idFor } = require('../src/services/larkMvpService');
const { SalesGroupThreadLocator } = require('../src/services/salesGroupThreadLocator');
const {
  SALES_KEYWORDS,
  UNSUPPORTED_INTENT_REPLY,
  hasDigits,
  hasSalesKeyword,
  isSalesCandidate,
} = require('../src/config/messageGate');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

// 群聊链路要读 LARK_BOT_OPEN_ID 判 @（config/groupPurchase）。这些用例走的是
// 「主群**不 @**」那条路，判的是正文；给个测试值，免得服务构造时打一条
// lark.group.bot_open_id_missing 警告把真正的失败淹掉。
process.env.LARK_BOT_OPEN_ID = process.env.LARK_BOT_OPEN_ID || 'ou_test_bot_open_id';
// 业务负责人拍板的词表，逐字钉住：改动这份清单必须是一次有意识的决定。
const EXPECTED_KEYWORDS = ['查', '查询', '退', '退货', '换', '换货', '卖', '买', '记', '库存', '欠'];
// 只含关键词、不含任何数字的"她明明想办事"的消息。
const KEYWORD_ONLY_TEXTS = ['我要退货', '查一下我买的鞋', '库存还有多少', '昨天那双黑的能换吗'];
// 无意义聊天：一个字都不该往后走。
const MEANINGLESS_TEXTS = ['你好', '在吗', '今天天气', '哈哈哈'];

const CHAT_ID = 'oc_gate_group';

/** 主群里的一条消息，**不 @ 机器人** —— 进不进完全由闸门（含数字 / 含关键词）决定。 */
const textEvent = (id, text) => ({
  sender: { sender_id: { open_id: 'ou_gate' } },
  message: {
    message_id: id,
    chat_id: CHAT_ID,
    chat_type: 'group',
    message_type: 'text',
    create_time: '1000',
    content: JSON.stringify({ text }),
    mentions: [],
  },
});

/** 假 client：只记「发出去的是什么」——群入口的回复都是 `im.message.reply`。 */
const makeClient = () => {
  const replies = [];
  const reactions = [];
  const client = {
    im: {
      message: {
        reply: async ({ path: replyPath, data }) => {
          replies.push({ path: replyPath, data });
          return { code: 0, data: { message_id: `om_reply_${replies.length}`, thread_id: 'omt_gate' } };
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
  return { client, replies, reactions };
};

const makeService = ({ recognizerResult = {}, stubProcess = true } = {}) => {
  const { client, replies, reactions } = makeClient();
  const cards = [];
  const writes = [];
  const parsedTexts = [];
  const purchaseCalls = [];
  const gateway = {
    table: (tableKey) => V1_BITABLE_SCHEMA.tables[tableKey],
    listAll: async () => [],
    validateTables: async () => [],
    // 所有业务写一律记下并抛错：闸门这条链路一次业务写都不允许有。
    create: async (...args) => { writes.push(['create', ...args]); throw new Error('本链路不允许写业务表'); },
    update: async (...args) => { writes.push(['update', ...args]); throw new Error('本链路不允许写业务表'); },
    delete: async (...args) => { writes.push(['delete', ...args]); throw new Error('本链路不允许写业务表'); },
  };
  const store = new JsonTaskStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'message-gate-')),
    idField: 'task_id',
  });
  const service = new LarkMvpService({
    client,
    gateway,
    references: {},
    posting: {},
    store,
    salesGroupThreads: new SalesGroupThreadLocator({
      store: new JsonTaskStore({
        dir: fs.mkdtempSync(path.join(os.tmpdir(), 'message-gate-threads-')), idField: 'task_id',
      }),
    }),
    // 「话题 ↔ 销售」的本地映射/深链落点：本文件只关心"进没进闸门"，换成空实现。
    salesMessageLinks: { rememberFromSend: async () => null },
    // 采购那条路换成一个记录型桩：**闸门挡下的消息绝对不能走到它**。
    groupPurchaseFlow: {
      handleGroupPurchaseMessage: async (input) => { purchaseCalls.push(input); return { mode: 'purchase' }; },
    },
    recognizer: {
      parseSalesText: async (text) => { parsedTexts.push(text); return recognizerResult; },
    },
  });
  service.sendCard = async (_openId, card) => { cards.push(card); return 'om_card'; };
  service.replyCard = async (_messageId, card) => { cards.push(card); return 'om_card'; };
  service.acknowledgeMessage = async () => undefined;
  // 默认把识别链路打桩：这些用例只关心"有没有进闸门"，不关心识别本身。
  if (stubProcess) service.processSalesTask = async () => undefined;
  return { service, store, replies, reactions, cards, writes, parsedTexts, purchaseCalls };
};

// acceptMessage 用 setImmediate 把识别丢进后台队列，所以"没发生的事"要等一小会儿再断言。
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const waitFor = async (predicate, { tries = 60 } = {}) => {
  for (let index = 0; index < tries; index += 1) {
    if (predicate()) return true;
    // 轮询而不是固定 sleep：机器慢也不会假失败。
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
};

test('闸门配置：关键词表写在 config/messageGate，含数字或含关键词任一命中即放行', () => {
  // 词表在配置里（不在函数里）——改词只改配置，这是业务负责人反复强调的点。
  assert.deepEqual(SALES_KEYWORDS, EXPECTED_KEYWORDS);

  // 含数字：原有判据。
  assert.equal(hasDigits('6035黑38码230元微信'), true);
  assert.equal(hasDigits('好的'), false);
  assert.equal(isSalesCandidate('6035黑38码230元微信'), true, '含数字仍然进');

  // 不含数字、但含关键词：这次放宽要救回来的那一类。
  for (const text of KEYWORD_ONLY_TEXTS) {
    assert.equal(hasDigits(text), false, `${text} 本来就没有数字`);
    assert.equal(hasSalesKeyword(text), true, `${text} 应命中业务关键词`);
    assert.equal(isSalesCandidate(text), true, `${text} 应被放行`);
  }

  // 无意义聊天：两个判据都不命中 → 不放行。
  for (const text of MEANINGLESS_TEXTS) {
    assert.equal(isSalesCandidate(text), false, `${text} 不该进闸门`);
  }

  // 关键词是**参数**不是硬编码：换一份词表立刻生效，证明"配置先行"真的成立。
  assert.equal(isSalesCandidate('帮我调货一双', ['调货']), true);
  assert.equal(isSalesCandidate('帮我调货一双'), false, '未配置的词不该命中');

  // 既有导出名保持不变（其它调用点/测试按它找），语义已放宽。
  assert.equal(looksLikeSalesText('我要退货'), true);
  assert.equal(looksLikeSalesText('好的'), false);
});

test('引导语原文放在配置里，逐字钉住业务负责人的原话', () => {
  assert.equal(
    UNSUPPORTED_INTENT_REPLY,
    '这个我还没学会～你可以说"卖一双 6035黑 42码 199"，或者"帮我查 6035 黑"'
  );
});

test('含数字 → 仍然进（原有行为不变）', async () => {
  const { service, store } = makeService();
  const result = await service.acceptMessage(textEvent('om_gate_digit', '6035黑38码230元微信'));
  assert.equal(result.accepted, true);
  assert.equal(result.mode, 'new', '主群不 @ + 像销售 → 新开一笔');
  const task = await store.get(result.sales.taskId);
  assert.equal(task.original_text, '6035黑38码230元微信');
  assert.equal(task.chat_type, 'group', '群入口的任务带群上下文');
});

test('不含数字但含业务关键词 → 进（建任务并真的把文本送进识别）', async () => {
  const cases = [
    ['om_gate_kw_return', '我要退货'],
    ['om_gate_kw_lookup', '查一下我买的鞋'],
    ['om_gate_kw_stock', '库存还有多少'],
    ['om_gate_kw_exchange', '昨天那双黑的能换吗'],
  ];
  for (const [messageId, text] of cases) {
    const { service, store, parsedTexts } = makeService({
      recognizerResult: { intent: 'unsupported' },
      stubProcess: false,
    });
    const result = await service.acceptMessage(textEvent(messageId, text));
    assert.equal(result.accepted, true, `${text} 应该被放行`);
    assert.equal(result.mode, 'new');
    const task = await store.get(result.sales.taskId);
    assert.equal(task.original_text, text);
    // "进了 AI"的硬证据：识别函数真的被这条文本调到了。
    assert.equal(await waitFor(() => parsedTexts.includes(text)), true, `${text} 应被送进 AI`);
  }
});

test('不含数字也不含关键词 → 不进、也不回（无意义聊天保持静默）', async () => {
  for (const [index, text] of MEANINGLESS_TEXTS.entries()) {
    const messageId = `om_gate_mute_${index}`;
    const { service, store, replies, parsedTexts, cards, purchaseCalls } = makeService({ stubProcess: false });
    const result = await service.acceptMessage(textEvent(messageId, text));
    await settle();
    assert.deepEqual(result, { accepted: false, reason: 'group_not_sales_text' },
      `${text} 应被挡在闸门外`);
    assert.deepEqual(replies, [], `「${text}」不该收到任何回复（核心验收点）`);
    assert.deepEqual(cards, [], `「${text}」不该收到任何卡片`);
    assert.deepEqual(parsedTexts, [], `「${text}」不该进 AI`);
    assert.deepEqual(purchaseCalls, [], `「${text}」也不该掉进采购链路`);
    // 任务都没建，识别链路自然无从谈起。
    assert.equal(await store.get(idFor('sale', messageId)), null);
  }
});

test('过了闸门但 AI 认不出意图 → 回引导语（回到那条消息的话题），且零业务写', async () => {
  // 模型什么都没给（intent 缺失）→ 收敛成 unsupported，这正是"没学会"该触发的那一档。
  const { service, store, replies, writes } = makeService({
    recognizerResult: { item_no: '6035', color: '黑' },
    stubProcess: false,
  });
  const result = await service.acceptMessage(textEvent('om_gate_unsupported', '查一下我买的鞋'));
  assert.equal(result.accepted, true);
  assert.equal(await waitFor(() => replies.length > 0), true, '应该回一句引导语');

  assert.equal(replies.length, 1);
  // ⭐ 群入口的回复是「**回到那条消息的话题**」：回复她那条 + `reply_in_thread: true`。
  assert.equal(replies[0].path.message_id, 'om_gate_unsupported');
  assert.equal(replies[0].data.reply_in_thread, true);
  assert.equal(replies[0].data.msg_type, 'text');
  const sent = JSON.parse(replies[0].data.content).text;
  assert.equal(sent, UNSUPPORTED_INTENT_REPLY);
  assert.match(sent, /卖一双 6035黑 42码 199/);
  assert.match(sent, /帮我查 6035 黑/);
  assert.equal((await store.get(idFor('sale', 'om_gate_unsupported'))).status, 'ignored');
  assert.deepEqual(writes, [], '判不出意图时不允许写任何业务表');
});

test('无意义聊天不触发引导语（闸门在 AI 之前，端到端再验一次）', async () => {
  const { service, replies, parsedTexts, writes } = makeService({
    recognizerResult: { intent: 'unsupported' },
    stubProcess: false,
  });
  const result = await service.acceptMessage(textEvent('om_gate_hahaha', '哈哈哈'));
  await settle();
  assert.deepEqual(result, { accepted: false, reason: 'group_not_sales_text' });
  assert.deepEqual(replies, [], '「哈哈哈」不能因为加了引导语就被回复');
  assert.deepEqual(parsedTexts, [], '「哈哈哈」不能进 AI');
  assert.deepEqual(writes, []);
});
