/**
 * 「主群不 @ 机器人也能识别销售」的验收测试。
 *
 * 业务负责人 2026-10-06 逐字确认的判据：
 *   □ 主群**不 @** + 正文是销售   → **处理** + 回卡片
 *   □ 主群**不 @** + 正文是日常聊天（「今天天气不错」）→ **静默 + 零远端调用**
 *   □ 主群 **@机器人**            → **照旧处理**（不破坏现有行为）
 *   □ 主群**不 @** + 正文有 `BH-…` → **走采购**（不走销售）
 *   □ **话题里不 @**              → **照旧处理**
 *   □ 🔴 **私聊行为【一个字都不变】**
 *
 * 判据的三条与顺序见 `LarkMvpService.resolveMainChatAdmission`；开关见
 * `config/groupAdmission`（`GROUP_MAIN_CHAT_REQUIRE_MENTION`，**默认放宽**）。
 *
 * 「静默」的判据是**真实发生的远端调用计数**（飞书 client + 业务网关 + AI 识别器
 * 三个都记账），不是"我们没调用某个方法"。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService } = require('../src/services/larkMvpService');
const { SalesGroupThreadLocator } = require('../src/services/salesGroupThreadLocator');
const { normalizeSalesResult } = require('../src/services/doubaoService');

const TEST_BOT_OPEN_ID = 'ou_test_bot_open_id';
const CHAT_ID = 'oc_test_group';

const tempStore = (prefix = 'group-autodetect-') =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

const liveRow = ({ itemNo, color = '黑', size, productRecordId }) => ({
  record_id: `live_${itemNo}_${color}_${size}`,
  fields: {
    库存键: `${itemNo}|${color}|女鞋|${size}`,
    所属状态: '门盒',
    编号: [{ id: productRecordId }],
    尺码: [{ id: `size_${size}` }],
  },
});

const saleParse = () => normalizeSalesResult({
  intent: 'sale',
  trade_type: '现货',
  items: [{ item_no: '66356', color: '黑', size: 42, quantity: 1, actual_amount: 230 }],
  payments: [{ amount: 230, method: '微信' }],
  agreed_total: 230,
});

/**
 * 全套记账的替身：飞书 client（回复/表情）、业务网关（读写表）、AI 识别器。
 * 任何一个被碰到都会留在 `calls` 里——「零远端调用」这条红线靠它来证。
 */
const makeRecorder = () => {
  const calls = [];
  const replies = [];
  const client = {
    im: {
      message: {
        reply: async ({ path: replyPath, data }) => {
          calls.push('im.message.reply');
          replies.push({ path: replyPath, data });
          return { code: 0, data: { message_id: `om_reply_${replies.length}`, thread_id: 'omt_new_thread' } };
        },
        create: async ({ data }) => {
          calls.push('im.message.create');
          replies.push({ path: { message_id: '' }, data, direct: true });
          return { code: 0, data: { message_id: `om_direct_${replies.length}` } };
        },
      },
      messageReaction: {
        create: async () => { calls.push('im.messageReaction.create'); return { code: 0 }; },
      },
    },
  };
  const created = [];
  const gateway = {
    table: (key) => {
      calls.push('gateway.table');
      if (key === 'liveInventory') {
        return { tableId: 'tbl_live', fields: { stockKey: '库存键', product: '编号', size: '尺码', state: '所属状态' } };
      }
      if (key === 'salesEntry') return { tableId: 'tbl_sales', fields: { orderNo: '销售单号' } };
      return {};
    },
    listAll: async (key) => {
      calls.push('gateway.listAll');
      return key === 'liveInventory'
        ? [liveRow({ itemNo: '66356', color: '黑', size: 42, productRecordId: 'p_black' })]
        : [];
    },
    validateTables: async () => { calls.push('gateway.validateTables'); return []; },
    create: async (key, fields) => {
      calls.push('gateway.create');
      created.push({ key, fields });
      return { recordId: 'entry_created' };
    },
    update: async () => { calls.push('gateway.update'); },
    get: async () => { calls.push('gateway.get'); return null; },
  };
  let parseCalls = 0;
  const recognizer = {
    parseSalesText: async () => { parseCalls += 1; calls.push('recognizer.parseSalesText'); return saleParse(); },
  };
  return { calls, replies, client, gateway, created, recognizer, parseCalls: () => parseCalls };
};

const makeHarness = (options = {}) => {
  const recorder = makeRecorder();
  const purchaseCalls = [];
  const service = new LarkMvpService({
    client: recorder.client,
    gateway: recorder.gateway,
    references: {},
    posting: {},
    recognizer: recorder.recognizer,
    store: tempStore('group-autodetect-lark-'),
    botOpenId: options.botOpenId === undefined ? TEST_BOT_OPEN_ID : options.botOpenId,
    // `undefined` → 走配置默认（放宽）；显式传 true/false 才钉死口径。
    mainChatRequireMention: options.mainChatRequireMention,
    salesGroupThreads: options.salesGroupThreads || new SalesGroupThreadLocator({ store: tempStore() }),
    // 采购那条路换成记录型的桩：用它证明"这条消息有没有走采购"。
    groupPurchaseFlow: {
      handleGroupPurchaseMessage: async (input) => {
        purchaseCalls.push(input);
        return { resolved: true, reason: 'stub', replied: false };
      },
    },
  });
  // ⚠️ 刻意**不打桩** acknowledgeMessage：表情是真实的远端调用之一，
  //    它必须出现在 `calls` 里，才能同时证明"处理了"与"没处理就一个调用都没有"。
  return { service, purchaseCalls, ...recorder };
};

const groupEvent = (overrides = {}) => ({
  sender: { sender_id: { open_id: overrides.senderOpenId || 'ou_sender' } },
  message: {
    message_id: overrides.messageId || 'om_group_1',
    chat_id: CHAT_ID,
    chat_type: 'group',
    message_type: overrides.messageType || 'text',
    create_time: '1000',
    content: JSON.stringify({ text: overrides.text || '' }),
    // 默认 @ 了机器人；传 `mentions: []` 模拟主群里**不 @**。
    mentions: overrides.mentions === undefined
      ? [{ key: '@_user_1', id: TEST_BOT_OPEN_ID, name: '测试机器人' }]
      : overrides.mentions,
    parent_id: overrides.parentId,
    thread_id: overrides.threadId,
  },
});

// 录单本身是 `setImmediate` 之后异步跑的（与线上一致：先回事件、再慢慢处理）。
const flushSalesTasks = async (service, openId = 'ou_sender') => {
  await new Promise((resolve) => setImmediate(resolve));
  await service.enqueueForSender(openId, async () => undefined);
};

// ═══════════════════════════════════════════════════════════════════════════
// 【判据单测】resolveMainChatAdmission —— 主群（thread_id 为空）的三条判据
// ═══════════════════════════════════════════════════════════════════════════

test('判据：@ 机器人 → 理（via=mention，老判据照旧）', () => {
  const { service } = makeHarness();
  const decision = service.resolveMainChatAdmission(
    { mentions: [{ key: '@_user_1', id: TEST_BOT_OPEN_ID }] }, '在吗',
  );
  assert.deepEqual(decision, { accepted: true, via: 'mention' });
});

test('判据：正文像销售（不 @）→ 理（via=sales_gate）', () => {
  const { service } = makeHarness();
  assert.deepEqual(service.resolveMainChatAdmission({ mentions: [] }, 'A100 38码一双 100元微信'),
    { accepted: true, via: 'sales_gate' });
  // 不带数字、只有业务关键词（"退"/"查"/"库存"）也算像销售 —— 与私聊同一把尺子。
  assert.deepEqual(service.resolveMainChatAdmission({ mentions: [] }, '库存还有多少'),
    { accepted: true, via: 'sales_gate' });
});

test('判据：正文有采购批次号 → 理（via=purchase_batch_no，优先于销售闸门）', () => {
  const { service } = makeHarness();
  // 这句同时含数字（会被销售闸门放行），但批次号优先 —— 它就是采购的。
  assert.deepEqual(service.resolveMainChatAdmission({ mentions: [] }, 'BH-20261005-0009 这批到哪了'),
    { accepted: true, via: 'purchase_batch_no' });
});

test('判据：日常聊天（不 @、不像销售、没批次号）→ 不理，且**不产生任何判断副作用**', () => {
  const { service } = makeHarness();
  for (const text of ['今天天气不错', '哈哈哈', '好的', '这批鞋到了', '']) {
    assert.deepEqual(service.resolveMainChatAdmission({ mentions: [] }, text),
      { accepted: false, reason: 'group_not_sales_text' }, `「${text}」不该被理`);
  }
});

test('判据（开关=严格）：不 @ 一律不理 —— 回到改动前的口径', () => {
  const { service } = makeHarness({ mainChatRequireMention: true });
  assert.deepEqual(service.resolveMainChatAdmission({ mentions: [] }, 'A100 38码一双 100元微信'),
    { accepted: false, reason: 'group_not_mentioned' });
  assert.deepEqual(service.resolveMainChatAdmission({ mentions: [] }, 'BH-20261005-0009 这批到哪了'),
    { accepted: false, reason: 'group_not_mentioned' });
  // @ 了照旧理
  assert.deepEqual(service.resolveMainChatAdmission(
    { mentions: [{ id: TEST_BOT_OPEN_ID }] }, '在吗',
  ), { accepted: true, via: 'mention' });
});

test('判据（开关=严格）且没配 LARK_BOT_OPEN_ID：判不出 @，一条主群消息都不理', () => {
  const { service } = makeHarness({ botOpenId: '', mainChatRequireMention: true });
  assert.deepEqual(service.resolveMainChatAdmission({ mentions: [] }, 'A100 38码一双'),
    { accepted: false, reason: 'group_bot_open_id_unconfigured' });
});

test('判据（默认放宽）且没配 LARK_BOT_OPEN_ID：判不出 @ 不影响正文判据', () => {
  // 刻意钉住：放宽口径**不依赖** LARK_BOT_OPEN_ID —— 否则少配一个变量，
  // 「不 @ 也能识别销售」会静默失效（这正是这次要修的病）。
  const { service } = makeHarness({ botOpenId: '' });
  assert.deepEqual(service.resolveMainChatAdmission({ mentions: [] }, 'A100 38码一双 100元微信'),
    { accepted: true, via: 'sales_gate' });
  assert.deepEqual(service.resolveMainChatAdmission({ mentions: [] }, '今天天气不错'),
    { accepted: false, reason: 'group_not_sales_text' });
});

// ═══════════════════════════════════════════════════════════════════════════
// 【①】主群不 @ + 正文是销售 → 处理 + 回卡片
// ═══════════════════════════════════════════════════════════════════════════

test('主群不 @ + 正文是销售 → 处理，并在她那条消息下开话题回卡片', async () => {
  const { service, replies, calls, created, purchaseCalls, parseCalls } = makeHarness();

  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_auto_sale', text: '66356 黑 42 一双 230 微信', mentions: [],
  }));

  assert.equal(result.accepted, true, '主群不 @ 也要处理');
  assert.equal(result.mode, 'new', '主群新开一笔销售');
  assert.deepEqual(purchaseCalls, [], '这条不该走采购');

  // ① 建了销售任务，且带上了群聊渠道
  const task = await service.store.get(result.sales.taskId);
  assert.equal(task.chat_type, 'group');
  assert.equal(task.chat_id, CHAT_ID);
  assert.equal(task.original_text, '66356 黑 42 一双 230 微信');

  // ② 「收到」表情是真实发生的（群里不回文字）
  assert.ok(calls.includes('im.messageReaction.create'), '要加「收到」表情');

  // ③ 跑完录单链路：建销售记录 + 出确认卡片（卡片回复到话题）
  await flushSalesTasks(service);
  assert.ok(parseCalls() >= 1, '像销售的消息要进 AI 识别');
  assert.equal(created.filter((item) => item.key === 'salesEntry').length, 1);
  const cardReply = replies.find((item) => item.data.msg_type === 'interactive');
  assert.ok(cardReply, '要发出确认卡片');
  assert.equal(cardReply.path.message_id, 'om_auto_sale', '卡片回在她那条消息下');
  assert.equal(cardReply.data.reply_in_thread, true, '群聊的卡片要回复到话题（reply_in_thread）');

  // ④ 本地映射写下「话题 ↔ 这笔销售」
  const mapped = await service.salesGroupThreads.findByThreadId('omt_new_thread');
  assert.ok(mapped, '要能用话题 id 反查回这笔销售');
  assert.equal(mapped.message_id, 'om_auto_sale');
});

// ═══════════════════════════════════════════════════════════════════════════
// 【②】主群不 @ + 日常聊天 → 静默 + 零远端调用（🔴 红线）
// ═══════════════════════════════════════════════════════════════════════════

test('主群不 @ + 日常聊天 → 静默：飞书、业务表、AI 三处**一个调用都没有**', async () => {
  const { service, calls, replies, purchaseCalls, parseCalls } = makeHarness();

  for (const [index, text] of ['今天天气不错', '哈哈哈', '好的', '这批鞋到了'].entries()) {
    const result = await service.acceptMessage(groupEvent({
      messageId: `om_chat_${index}`, text, mentions: [],
    }));
    assert.equal(result.accepted, false, `「${text}」不该被处理`);
    assert.equal(result.reason, 'group_not_sales_text');
  }

  assert.deepEqual(calls, [], '日常聊天不能有任何远端调用（发消息/表情/读表/AI 都不行）');
  assert.deepEqual(replies, [], '日常聊天不能发出任何飞书消息');
  assert.deepEqual(purchaseCalls, [], '日常聊天不能进采购链路');
  assert.equal(parseCalls(), 0, '日常聊天不能进 AI 识别');
});

test('主群不 @ + 日常聊天（图片）：同样静默，零远端调用', async () => {
  const { service, calls, replies } = makeHarness();
  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_chat_image', text: '', messageType: 'image', mentions: [],
  }));
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'group_not_sales_text');
  assert.deepEqual(calls, []);
  assert.deepEqual(replies, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// 【③】主群 @机器人 → 照旧处理（不破坏现有行为）
// ═══════════════════════════════════════════════════════════════════════════

test('主群 @机器人 → 照旧处理（任务里的正文要剥掉 @ 占位符）', async () => {
  const { service, replies, purchaseCalls } = makeHarness();

  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_mention_sale', text: '@_user_1 66356 黑 42 一双 230 微信',
  }));

  assert.equal(result.accepted, true);
  assert.equal(result.mode, 'new');
  assert.deepEqual(purchaseCalls, []);
  const task = await service.store.get(result.sales.taskId);
  assert.equal(task.original_text, '66356 黑 42 一双 230 微信', '@ 占位符要剥掉再当正文');
  await flushSalesTasks(service);
  const cardReply = replies.find((item) => item.data.msg_type === 'interactive');
  assert.equal(cardReply.data.reply_in_thread, true);
});

test('主群 @机器人 + 日常聊天 → 照旧进链路（@ 是最高优先判据，不因正文不像销售而丢）', async () => {
  const { service, purchaseCalls } = makeHarness();
  // "这批到了"不像销售：@ 了就该理，并原样交给采购那条路（改动前就是这条行为）。
  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_mention_chat', text: '@_user_1 这批到了',
  }));
  assert.equal(result.accepted, true);
  assert.equal(purchaseCalls.length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 【④】主群不 @ + 正文有 BH-… → 走采购
// ═══════════════════════════════════════════════════════════════════════════

test('主群不 @ + 正文有批次号 → 走采购，不建销售任务、不发销售卡片', async () => {
  const { service, purchaseCalls, replies, parseCalls } = makeHarness();

  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_batch', text: 'BH-20261005-0009 这批到哪了', mentions: [],
  }));

  assert.equal(result.accepted, true);
  assert.equal(result.handled, undefined, '这条不归销售');
  assert.equal(purchaseCalls.length, 1, '要交给采购定位链路');
  assert.equal(purchaseCalls[0].text, 'BH-20261005-0009 这批到哪了');
  assert.equal(purchaseCalls[0].threadId, '');
  assert.deepEqual(replies.filter((item) => item.data.msg_type === 'interactive'), [],
    '不该发销售确认卡片');
  assert.equal(parseCalls(), 0, '不该进销售 AI 识别');
});

// ═══════════════════════════════════════════════════════════════════════════
// 【⑤】话题里不 @ → 照旧处理（顺序不能反）
// ═══════════════════════════════════════════════════════════════════════════

test('话题里不 @ → 照旧处理（thread_id 优先，且按话题定位到那笔销售）', async () => {
  const threads = new SalesGroupThreadLocator({ store: tempStore('group-autodetect-threads-') });
  await threads.rememberSaleThread({
    salesEntryRecordId: 'entry_existing', taskId: 'sale_orig',
    messageId: 'om_orig_sale', threadId: 'omt_sale_9', chatId: CHAT_ID, senderOpenId: 'ou_sender',
  });
  const { service, purchaseCalls, replies } = makeHarness({ salesGroupThreads: threads });

  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_topic_follow', threadId: 'omt_sale_9', mentions: [],
    text: '再记一双 66356 黑 42 230 微信',
  }));

  assert.equal(result.accepted, true, '话题里免 @，必须被处理');
  assert.equal(result.mode, 'thread');
  assert.equal(result.source, 'thread_id');
  assert.deepEqual(purchaseCalls, []);
  const task = await service.store.get(result.sales.taskId);
  assert.equal(task.sales_entry_record_id, 'entry_existing', '绑定到已定位的那一笔');
  assert.equal(task.group_thread_id, 'omt_sale_9');
  await flushSalesTasks(service);
  const cardReply = replies.find((item) => item.data.msg_type === 'interactive');
  assert.equal(cardReply.path.message_id, 'om_topic_follow');
  assert.equal(cardReply.data.reply_in_thread, true);
});

test('话题里不 @ + 完全不像销售的一句（如「你好 小来财」）→ 照旧处理，不因闸门被丢', async () => {
  const { service, purchaseCalls } = makeHarness();
  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_topic_hi', threadId: 'omt_unknown_thread', mentions: [], text: '你好 小来财',
  }));
  assert.equal(result.accepted, true, '话题本身就是"冲着机器人来的"判据');
  // 这条话题没记过销售映射 → 原样交给采购那条路（它自己会回"认不出"）。
  assert.equal(purchaseCalls.length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 原【⑥】「私聊行为一个字都不变」那 2 条 —— 私聊入口已整体删除，
//    按业务负责人 2026-10-07 拍板的 ⓐ（代码里一行私聊都不留）**迁到群入口**。
//    见 docs/private-chat-removal-decision-2026-10-07.md。
// ═══════════════════════════════════════════════════════════════════════════

test('话题里不 @ + 录单 → 销售主表只建 1 条、加了「收到」表情、卡片回到**那个话题**', async () => {
  const threads = new SalesGroupThreadLocator({ store: tempStore('group-autodetect-threads-') });
  await threads.rememberSaleThread({
    salesEntryRecordId: 'entry_existing', taskId: 'sale_orig',
    messageId: 'om_orig_sale', threadId: 'omt_sale_sale', chatId: CHAT_ID, senderOpenId: 'ou_sender',
  });
  const { service, replies, calls, created, purchaseCalls } = makeHarness({ salesGroupThreads: threads });

  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_topic_sale', threadId: 'omt_sale_sale', mentions: [], text: '再记一双 66356 黑 42 230 微信',
  }));

  assert.equal(result.accepted, true);
  assert.equal(result.mode, 'thread');
  const task = await service.store.get(result.sales.taskId);
  assert.equal(task.chat_type, 'group', '群入口的任务必须带群上下文');
  assert.equal(task.chat_id, CHAT_ID);
  assert.equal(task.group_thread_id, 'omt_sale_sale');
  assert.equal(task.sales_entry_record_id, 'entry_existing', '绑定到话题定位到的那一笔');

  await flushSalesTasks(service);
  // 话题已经绑定了那一笔销售 → **不新建**销售主表记录（一条销售 = 一个话题）。
  assert.equal(created.filter((item) => item.key === 'salesEntry').length, 0);
  const cardReply = replies.find((item) => item.data.msg_type === 'interactive');
  assert.ok(cardReply);
  assert.equal(cardReply.data.reply_in_thread, true, '群入口的卡片一律回复进那条话题');
  assert.equal(cardReply.path.message_id, 'om_topic_sale');
  // 群聊收到消息要加表情（**不回**「已收到」文字，群里回文字会刷屏）
  assert.ok(calls.includes('im.messageReaction.create'));
  assert.deepEqual(replies.filter((item) => item.data.msg_type === 'text'), []);
  assert.deepEqual(purchaseCalls, [], '走了销售那条路就不该再进采购');

  // 主群的日常聊天照旧静默（闸门一个字没动）
  const chat = await service.acceptMessage(groupEvent({
    messageId: 'om_main_chat', mentions: [], text: '今天天气不错',
  }));
  assert.deepEqual(chat, { accepted: false, reason: 'group_not_sales_text' });
});

test('主群准入的 strict 开关**只管主群**：话题里的消息不受它影响', async () => {
  const threads = new SalesGroupThreadLocator({ store: tempStore('group-autodetect-strict-') });
  await threads.rememberSaleThread({
    salesEntryRecordId: 'entry_existing', taskId: 'sale_orig',
    messageId: 'om_orig_sale', threadId: 'omt_strict', chatId: CHAT_ID, senderOpenId: 'ou_sender',
  });
  const { service } = makeHarness({ mainChatRequireMention: true, salesGroupThreads: threads });

  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_topic_strict', threadId: 'omt_strict', mentions: [], text: '再记一双 66356 黑 42 230 微信',
  }));
  assert.equal(result.accepted, true, 'strict 只管主群；话题里免 @ 这条判据不受它影响');
  assert.equal(result.mode, 'thread');
});
