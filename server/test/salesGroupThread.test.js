/**
 * 「销售链路：私聊 → 群聊话题」的验收测试（业务负责人 2026-10-06 逐字确认的口径，
 * 见 docs/sales-purchase-group-thread-2026-10-06.md）。
 *
 * 这份文件只覆盖**新链路**（A / B / C）与**私聊回归**；采购那侧的既有用例仍在
 * larkMvpService.test.js / arrivalConversation.test.js 里原样跑着。
 *
 *   □ 主群里 @ 机器人说一笔销售 → 建销售记录 ＋ 在那条消息下开话题 ＋ 回卡片
 *   □ 话题里的消息 → 按话题定位到那笔销售 → 走销售（不是采购）
 *   □ 私聊行为完全不变（卡片回复不带 reply_in_thread、任务上没有群字段）
 *   □ 认不出是哪一笔销售时 → 仍然走采购那条路（不抢答、不猜"最近一笔"）
 *   □ 本地映射不写业务表
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

const tempStore = (prefix = 'sales-group-thread-') =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

// ── 飞书 client 的假实现：记录**真的发出去了什么**（回复到哪条、带不带 reply_in_thread）
const makeClient = () => {
  const replies = [];
  const client = {
    im: {
      message: {
        reply: async ({ path, data }) => {
          replies.push({ path, data });
          return { code: 0, data: { message_id: `om_reply_${replies.length}`, thread_id: 'omt_new_thread' } };
        },
        create: async ({ data }) => {
          replies.push({ path: { message_id: '' }, data, direct: true });
          return { code: 0, data: { message_id: `om_direct_${replies.length}` } };
        },
      },
      messageReaction: { create: async () => ({ code: 0 }) },
    },
  };
  return { client, replies };
};

// ── 实时库存 + 销售主表的假实现（够跑通「解析 → 建单 → 出确认卡片」这一段）
const liveRow = ({ itemNo, color = '黑', size, productRecordId }) => ({
  record_id: `live_${itemNo}_${color}_${size}`,
  fields: {
    库存键: `${itemNo}|${color}|女鞋|${size}`,
    所属状态: '门盒',
    编号: [{ id: productRecordId }],
    尺码: [{ id: `size_${size}` }],
  },
});

const makeGateway = () => {
  const created = [];
  const updated = [];
  const gateway = {
    table: (key) => {
      if (key === 'liveInventory') {
        return { tableId: 'tbl_live', fields: { stockKey: '库存键', product: '编号', size: '尺码', state: '所属状态' } };
      }
      if (key === 'salesEntry') return { tableId: 'tbl_sales', fields: { orderNo: '销售单号' } };
      return {};
    },
    listAll: async (key) => (key === 'liveInventory'
      ? [liveRow({ itemNo: '66356', color: '黑', size: 42, productRecordId: 'p_black' })]
      : []),
    validateTables: async () => [],
    create: async (key, fields) => {
      created.push({ key, fields });
      return { recordId: 'entry_created' };
    },
    update: async (key, recordId, fields) => { updated.push({ key, recordId, fields }); },
  };
  return { gateway, created, updated };
};

const saleParse = () => normalizeSalesResult({
  intent: 'sale',
  trade_type: '现货',
  items: [{ item_no: '66356', color: '黑', size: 42, quantity: 1, actual_amount: 230 }],
  payments: [{ amount: 230, method: '微信' }],
  agreed_total: 230,
});

const makeHarness = ({ salesGroupThreads, gateway = makeGateway().gateway, recognizer } = {}) => {
  const { client, replies } = makeClient();
  const purchaseCalls = [];
  const service = new LarkMvpService({
    client,
    gateway,
    references: {},
    posting: {},
    recognizer: recognizer || { parseSalesText: async () => saleParse() },
    store: tempStore('sales-group-lark-'),
    botOpenId: TEST_BOT_OPEN_ID,
    salesGroupThreads: salesGroupThreads
      || new SalesGroupThreadLocator({ store: tempStore() }),
    // 采购那条路换成一个记录型的桩：用它证明"这条消息没走采购"。
    groupPurchaseFlow: {
      handleGroupPurchaseMessage: async (input) => {
        purchaseCalls.push(input);
        return { resolved: false, reason: 'stub', replied: false };
      },
    },
  });
  service.acknowledgeMessage = async () => undefined;
  return { service, replies, purchaseCalls };
};

const groupEvent = (overrides = {}) => ({
  sender: { sender_id: { open_id: overrides.senderOpenId || 'ou_sender' } },
  message: {
    message_id: overrides.messageId || 'om_group_1',
    chat_id: CHAT_ID,
    chat_type: 'group',
    message_type: 'text',
    create_time: '1000',
    content: JSON.stringify({ text: overrides.text || '' }),
    mentions: overrides.mentions || [{ key: '@_user_1', id: TEST_BOT_OPEN_ID, name: '测试机器人' }],
    parent_id: overrides.parentId,
    thread_id: overrides.threadId,
  },
});

const privateEvent = (overrides = {}) => ({
  sender: { sender_id: { open_id: overrides.senderOpenId || 'ou_sender' } },
  message: {
    message_id: overrides.messageId || 'om_private_1',
    chat_id: 'oc_private',
    chat_type: 'p2p',
    message_type: 'text',
    create_time: '1000',
    content: JSON.stringify({ text: overrides.text || '' }),
  },
});

// 录单本身是 `setImmediate` 之后**异步**跑的（与线上一致：先回事件、再慢慢处理）。
// 测试里要把这一段等干净：先让出一次事件循环，再往同一个发送者的串行队列尾部排一件事，
// 排到它时就说明前面那次 processSalesTask 已经跑完了。
const flushSalesTasks = async (service, openId = 'ou_sender') => {
  await new Promise((resolve) => setImmediate(resolve));
  await service.enqueueForSender(openId, async () => undefined);
};

// ═══════════════════════════════════════════════════════════════════════════
// 【A】主群里 @ 机器人说一笔销售 → 建销售记录 ＋ 开话题 ＋ 回卡片
// ═══════════════════════════════════════════════════════════════════════════

test('A：主群里 @ 机器人说一笔销售 → 建销售任务 ＋ 卡片回复进话题（reply_in_thread）', async () => {
  const { service, replies, purchaseCalls } = makeHarness();
  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_sale_main', text: '@_user_1 66356 黑 42 一双 230 微信',
  }));

  assert.equal(result.accepted, true);
  assert.equal(result.handled, true, '主群里 @ 机器人说销售 → 由销售链路接管');
  assert.equal(result.mode, 'new');
  assert.deepEqual(purchaseCalls, [], '这条消息不该再走采购定位');

  // ① 建了销售任务，且带上了群聊渠道（私聊任务没有这些字段）
  const task = await service.store.get(result.sales.taskId);
  assert.equal(task.chat_type, 'group');
  assert.equal(task.chat_id, CHAT_ID);
  assert.equal(task.original_text, '66356 黑 42 一双 230 微信', '@ 占位符要剥掉再当正文');
  assert.equal(task.sales_entry_record_id, '', '主群里新说一笔：还没有"已定位到的那笔销售"');

  // ② 等真实的录单链路跑完：建销售主表记录 + 出确认卡片
  await flushSalesTasks(service);

  // ③ 卡片是「回复到话题」发的：回复那条消息 + reply_in_thread: true → 开话题
  const cardReply = replies.find((item) => item.data.msg_type === 'interactive');
  assert.ok(cardReply, '要发出确认卡片');
  assert.equal(cardReply.path.message_id, 'om_sale_main', '卡片回在她那条消息下');
  assert.equal(cardReply.data.reply_in_thread, true, '群聊的卡片必须回复到话题（reply_in_thread）');

  // ④ 本地映射写下了「话题 ↔ 这笔销售」，业务表没有多出"话题"列
  const mapped = await service.salesGroupThreads.findByThreadId('omt_new_thread');
  assert.ok(mapped, '要能用话题 id 反查回这笔销售');
  assert.equal(mapped.message_id, 'om_sale_main');
  assert.equal(mapped.sales_entry_record_id, 'entry_created');
});

test('A：群里发的一条销售消息 → 销售主表只建一条记录（不是两条）', async () => {
  const { gateway, created } = makeGateway();
  const { service } = makeHarness({ gateway });
  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_sale_once', text: '@_user_1 66356 黑 42 一双 230 微信',
  }));
  await flushSalesTasks(service);

  assert.equal(created.filter((item) => item.key === 'salesEntry').length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 【C】话题里收到消息 → 按话题定位到那笔销售 → 走销售（不是采购）
// ═══════════════════════════════════════════════════════════════════════════

// ⚠️ 这里刻意用**不像进展**的一句（有货号/尺码/"一双"，没有收款/交付线索）：
//    "收到微信 300" 这种二次处理的话归 ②（见 salesThreadProgress.test.js）。
test('C：话题里的消息（thread_id 命中本地映射）→ 走销售，不走采购', async () => {
  const threads = new SalesGroupThreadLocator({ store: tempStore() });
  await threads.rememberSaleThread({
    salesEntryRecordId: 'entry_existing', taskId: 'sale_orig',
    messageId: 'om_orig_sale', threadId: 'omt_sale_9', chatId: CHAT_ID, senderOpenId: 'ou_sender',
  });
  const { service, purchaseCalls, replies } = makeHarness({ salesGroupThreads: threads });

  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_follow_up', threadId: 'omt_sale_9', mentions: [],
    text: '再记一双 66356 黑 42 230 微信',
  }));

  assert.equal(result.accepted, true, '话题里的消息免 @，必须被处理');
  assert.equal(result.handled, true);
  assert.equal(result.mode, 'thread');
  assert.equal(result.source, 'thread_id');
  assert.deepEqual(purchaseCalls, [], '认得出是哪一笔销售 → 绝不进采购链路');

  // 绑定到**已定位的那一笔**：不新建销售主表记录（一条销售记录 = 一个话题）
  const task = await service.store.get(result.sales.taskId);
  assert.equal(task.sales_entry_record_id, 'entry_existing');
  assert.equal(task.group_thread_id, 'omt_sale_9');
  assert.equal(task.chat_type, 'group');

  await flushSalesTasks(service);
  // 回复仍然回到**同一个**话题（回复到话题），而不是私聊、也不是主群的光秃秃一条
  const cardReply = replies.find((item) => item.data.msg_type === 'interactive');
  assert.equal(cardReply.path.message_id, 'om_follow_up');
  assert.equal(cardReply.data.reply_in_thread, true);
});

test('C：话题里的消息定位到的那笔销售已存在 → 不再新建销售主表记录', async () => {
  const threads = new SalesGroupThreadLocator({ store: tempStore() });
  await threads.rememberSaleThread({
    salesEntryRecordId: 'entry_existing', taskId: 'sale_orig',
    messageId: 'om_orig_sale', threadId: 'omt_sale_reuse', chatId: CHAT_ID,
  });
  const { gateway, created } = makeGateway();
  const { service } = makeHarness({ salesGroupThreads: threads, gateway });

  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_reuse_1', threadId: 'omt_sale_reuse', mentions: [], text: '收到微信 300',
  }));
  await flushSalesTasks(service);

  assert.deepEqual(created.filter((item) => item.key === 'salesEntry'), [],
    '话题里后续消息要更新**那一笔**销售，不能新建一条');
});

test('C：引用机器人那条消息（parent_id 命中）也能定位，并把 thread_id 补记下来', async () => {
  const threads = new SalesGroupThreadLocator({ store: tempStore() });
  await threads.rememberSaleThread({
    salesEntryRecordId: 'entry_parent', taskId: 'sale_parent',
    messageId: 'om_orig_parent', chatId: CHAT_ID,
  });
  const { service, purchaseCalls } = makeHarness({ salesGroupThreads: threads });

  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_quote_1', threadId: 'omt_bound_later', parentId: 'om_orig_parent',
    mentions: [], text: '又收到微信 200',
  }));

  assert.equal(result.handled, true);
  assert.equal(result.source, 'parent_id');
  assert.deepEqual(purchaseCalls, []);
  // 补记之后，这条话题下的后续消息只靠 thread_id 也能命中
  const later = await threads.resolve({ threadId: 'omt_bound_later' });
  assert.equal(later.status, 'matched');
  assert.equal(later.sale.sales_entry_record_id, 'entry_parent');
});

test('C：话题里查不到销售映射 → 原样交给采购链路（不抢答、不猜最近一笔）', async () => {
  const { service, purchaseCalls } = makeHarness();
  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_unknown_topic', threadId: 'omt_unknown', mentions: [], text: '这条你看下',
  }));

  assert.equal(result.accepted, true);
  assert.notEqual(result.handled, true);
  assert.equal(purchaseCalls.length, 1, '认不出是哪一笔销售时，交给采购那条路按它的规矩处理');
});

test('C：主群里 @ 机器人 + 采购批次号 → 仍然归采购（不能被当成销售）', async () => {
  const { service, purchaseCalls } = makeHarness();
  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_batch_no', text: '@_user_1 BH-20261005-0009 这批的到货单你看下',
  }));

  assert.notEqual(result.handled, true);
  assert.equal(purchaseCalls.length, 1);
});

test('C：主群里 @ 机器人但不像销售 → 仍然归采购（走它原有的"认不出"）', async () => {
  const { service, purchaseCalls } = makeHarness();
  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_not_sales', text: '@_user_1 这批鞋到了',
  }));

  assert.notEqual(result.handled, true);
  assert.equal(purchaseCalls.length, 1);
});

test('定位器：thread_id 优先于 parent_id；都查不到就认不出，绝不取"最近一笔"', async () => {
  const threads = new SalesGroupThreadLocator({ store: tempStore() });
  await threads.rememberSaleThread({ salesEntryRecordId: 'entry_thread', messageId: 'om_t', threadId: 'omt_prio' });
  await threads.rememberSaleThread({ salesEntryRecordId: 'entry_parent', messageId: 'om_p' });

  const byThread = await threads.resolve({ threadId: 'omt_prio', parentId: 'om_p' });
  assert.equal(byThread.source, 'thread_id');
  assert.equal(byThread.sale.sales_entry_record_id, 'entry_thread');

  const unknown = await threads.resolve({ threadId: 'omt_nope', parentId: 'om_nope' });
  assert.equal(unknown.status, 'not_found');
  assert.equal(unknown.sale, undefined, '查不到就是查不到，不能退化成"最近一笔"');
});

// ═══════════════════════════════════════════════════════════════════════════
// 【私聊回归】行为完全不变（最重要的一条）
// ═══════════════════════════════════════════════════════════════════════════

test('回归：私聊销售 → 卡片回复**不带** reply_in_thread，任务上没有群聊字段', async () => {
  const { service, replies, purchaseCalls } = makeHarness();
  const result = await service.acceptMessage(privateEvent({
    messageId: 'om_private_sale', text: '66356 黑 42 一双 230 微信',
  }));

  assert.equal(result.accepted, true);
  assert.equal(result.type, 'sale');
  assert.deepEqual(purchaseCalls, [], '私聊永远不走群聊那两条路');

  const task = await service.store.get(result.taskId);
  assert.equal(task.chat_type, undefined, '私聊任务不该被打上群聊标记');
  assert.equal(task.chat_id, undefined);
  assert.equal(task.sales_entry_record_id, undefined, '私聊仍然是"新建一笔"，不绑定已定位的销售');

  await flushSalesTasks(service);
  const cardReply = replies.find((item) => item.data.msg_type === 'interactive');
  assert.ok(cardReply);
  assert.equal(cardReply.path.message_id, 'om_private_sale');
  assert.equal(cardReply.data.reply_in_thread, undefined,
    '私聊的 payload 与改动前逐字相同：一个字段都不许多');
  assert.equal(cardReply.data.msg_type, 'interactive');
});

test('回归：私聊闸门不变——不像销售的话静默忽略，一个远端调用都没有', async () => {
  const { service, replies } = makeHarness();
  const result = await service.acceptMessage(privateEvent({
    messageId: 'om_private_chat', text: '你好 小来财',
  }));

  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'not_sales_candidate');
  assert.deepEqual(replies, []);
});

test('回归：私聊的「已收到」仍然是表情 ＋ 一句文字（群聊只有表情）', async () => {
  const reactions = [];
  const { client, replies } = makeClient();
  client.im.messageReaction.create = async ({ path, data }) => {
    reactions.push({ messageId: path.message_id, emoji: data.reaction_type.emoji_type });
    return { code: 0 };
  };
  const service = new LarkMvpService({
    client, gateway: makeGateway().gateway, references: {}, posting: {},
    recognizer: { parseSalesText: async () => saleParse() },
    store: tempStore('sales-group-ack-'),
    botOpenId: TEST_BOT_OPEN_ID,
    salesGroupThreads: new SalesGroupThreadLocator({ store: tempStore() }),
  });
  service.processSalesTask = async () => undefined;

  await service.acceptMessage(privateEvent({ messageId: 'om_ack_p2p', text: '66356 黑 42 一双 230 微信' }));
  assert.deepEqual(reactions.map((item) => item.emoji), ['OneSecond']);
  // 私聊那条文字回复走 `reply`，内容与改动前逐字相同，且**不带** reply_in_thread
  const textReply = replies.find((item) => item.data.msg_type === 'text');
  assert.equal(textReply.path.message_id, 'om_ack_p2p');
  assert.deepEqual(JSON.parse(textReply.data.content), { text: '👀 已收到，正在识别销售信息，请稍候…' });
  assert.equal(textReply.data.reply_in_thread, undefined);
});
