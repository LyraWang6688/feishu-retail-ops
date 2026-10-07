/**
 * ③「售后（退货 / 换货）回到销售话题」的验收测试（业务负责人 2026-10-06 的口径）。
 *
 * 要实现的三件事：
 *   □ **入口**：销售话题里说「退那双 1366-33」→ 走售后链路（不是新开一笔销售）
 *   □ **回复**：售后卡片 / 文字都回到**同一个话题**（`reply_in_thread: true`）
 *   □ **上下文**：售后**绑定到那个话题对应的销售**（同一笔的售后）——
 *      候选查询带上 `salesEntryRecordId`，绝不跨单去捞
 *   □ 主群新说一笔（**没有**已定位的销售）→ 候选**不**限定在某笔（同一套售后编排的另一档）
 *
 * 售后**执行完写「销售状态 = 已退货 / 部分退货」**那一步在 afterSalesService.test.js 里
 * （它是执行器的职责，这里只覆盖"接线 + 回复回话题"）。
 */

// ⭐ 2026-10-07 ⓐ「私聊链路移除」：原来这一文件里有两条**拿私聊当入口**的回归用例，
//    已按业务负责人的口径**迁到群聊真入口**（主群 @ 机器人）—— 见文件末尾那两条。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService } = require('../src/services/larkMvpService');
const { SalesGroupThreadLocator } = require('../src/services/salesGroupThreadLocator');
const { normalizeSalesResult } = require('../src/services/doubaoService');
const { AFTER_SALES_CARD_ACTIONS } = require('../src/config/afterSalesFlow');

const TEST_BOT_OPEN_ID = 'ou_test_bot_open_id';
const CHAT_ID = 'oc_test_group';
const SALE_ID = 'entry_thread';
const OTHER_SALE_ID = 'entry_other';

const tempStore = (prefix = 'after-sales-thread-') =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

const makeClient = () => {
  const replies = [];
  const client = {
    im: {
      // ⚠️ 刻意**没有** im.message.patch：售后结果卡片更新不了 → 走"另发一张"的兜底，
      //    那条兜底也必须回到同一个话题（这正是本文件要钉住的）。
      message: {
        reply: async ({ path: replyPath, data }) => {
          replies.push({ path: replyPath, data });
          return { code: 0, data: { message_id: `om_reply_${replies.length}`, thread_id: 'omt_thread' } };
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

const candidate = ({ saleId, recordId, orderNo }) => ({
  record_id: recordId,
  sales_entry_record_id: saleId,
  sales_order_no: orderNo,
  item_no: '1366-33',
  color: '黑',
  size: 36,
  actual_amount: 230,
});

/** 只读定位能力的桩：记录"带着哪个筛选条件查的"，并按条件给候选。 */
const makeLookup = () => {
  const calls = [];
  return {
    days: 5,
    ttlMs: 10 * 60 * 1000,
    calls,
    async findCandidates(input = {}) {
      calls.push({ ...input });
      return input.salesEntryRecordId
        ? [candidate({ saleId: SALE_ID, recordId: 'detail_thread', orderNo: 'XSD-20261006-0001' })]
        : [candidate({ saleId: OTHER_SALE_ID, recordId: 'detail_other', orderNo: 'XSD-20261001-0007' })];
    },
    resolvePendingCandidate: () => ({ status: 'none' }),
    async storePendingCandidates() {},
  };
};

const returnParse = () => normalizeSalesResult({
  intent: 'return',
  action: 'return',
  item_no: '1366-33',
  color: '黑',
  size: 36,
  diff_amount: -230,
  settlement: '现金',
  restock_state: '门盒',
});

const makeHarness = ({ lookup = makeLookup() } = {}) => {
  const { client, replies } = makeClient();
  const executed = [];
  const service = new LarkMvpService({
    client,
    gateway: { table: () => ({}), listAll: async () => [], validateTables: async () => [] },
    posting: {},
    recognizer: { parseSalesText: async () => returnParse() },
    store: tempStore('after-sales-thread-lark-'),
    botOpenId: TEST_BOT_OPEN_ID,
    salesGroupThreads: new SalesGroupThreadLocator({ store: tempStore('after-sales-thread-map-') }),
    groupPurchaseFlow: { handleGroupPurchaseMessage: async () => ({ resolved: false, reason: 'stub' }) },
    saleLookup: lookup,
    // 执行器换成一个记录型的桩：这里只验证"接线 + 回复回话题"，执行器本身由
    // afterSalesService.test.js 覆盖（含回写原单「销售状态」）。
    afterSales: { execute: async (input) => { executed.push(input); return { masterRecordId: 'master_1' }; } },
  });
  service.acknowledgeMessage = async () => undefined;
  return { service, replies, lookup, executed };
};

const groupEvent = (overrides = {}) => ({
  sender: { sender_id: { open_id: overrides.senderOpenId || 'ou_sender' } },
  message: {
    message_id: overrides.messageId || 'om_return_1',
    chat_id: CHAT_ID,
    chat_type: 'group',
    message_type: 'text',
    create_time: '1000',
    content: JSON.stringify({ text: overrides.text || '' }),
    // 主群那条路要求 @；话题里免 @（传 `mentions: []` + `threadId`）。
    mentions: overrides.mentions === undefined
      ? [{ key: '@_user_1', id: TEST_BOT_OPEN_ID, name: '测试机器人' }]
      : overrides.mentions,
    thread_id: overrides.threadId,
  },
});

const flushSalesTasks = async (service, openId = 'ou_sender') => {
  await new Promise((resolve) => setImmediate(resolve));
  await service.enqueueForSender(openId, async () => undefined);
};

const bindThread = async (service, threadId) => service.salesGroupThreads.rememberSaleThread({
  salesEntryRecordId: SALE_ID, taskId: 'sale_orig', messageId: 'om_orig',
  threadId, chatId: CHAT_ID, senderOpenId: 'ou_sender',
});

const interactiveReplies = (replies) => replies.filter((item) => item.data.msg_type === 'interactive');

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ 话题里说退货 → 售后链路，卡片回到那个话题，且绑定到话题对应的那笔销售
// ═══════════════════════════════════════════════════════════════════════════

test('话题里说「退那双 1366-33」→ 售后确认卡片回复到**同一个话题**，且绑定话题那笔销售', async () => {
  const { service, replies, lookup } = makeHarness();
  await bindThread(service, 'omt_sale_as');

  const accepted = await service.acceptMessage(groupEvent({
    messageId: 'om_return_in_thread', threadId: 'omt_sale_as', text: '退那双 1366-33',
  }));
  assert.equal(accepted.handled, true);
  assert.equal(accepted.mode, 'thread');
  await flushSalesTasks(service);

  // ① 上下文：候选查询**限定在话题对应的那笔销售**上（同一笔的售后）
  assert.equal(lookup.calls.length, 1);
  assert.equal(lookup.calls[0].salesEntryRecordId, SALE_ID);
  assert.equal(lookup.calls[0].itemNo, '1366-33');

  // ② 回复：确认卡片是**回复到话题**（reply_in_thread），回在她那条消息下
  const cards = interactiveReplies(replies);
  assert.equal(cards.length, 1, '要发出售后确认卡片');
  assert.equal(cards[0].path.message_id, 'om_return_in_thread');
  assert.equal(cards[0].data.reply_in_thread, true);

  // ③ 卡片绑的是话题那笔销售（不是别的单子的候选）
  const task = await service.store.get(accepted.sales.taskId);
  assert.equal(task.sales_entry_record_id, SALE_ID);
  assert.equal(task.after_sales_plan.original_sales_entry_record_id, SALE_ID);
  assert.equal(task.after_sales_plan.source, 'thread_sale');
});

test('话题里点确认 → 结果卡片也回到**同一个话题**（更新不了原卡时的兜底也回话题）', async () => {
  const { service, replies, executed } = makeHarness();
  await bindThread(service, 'omt_sale_confirm');

  const accepted = await service.acceptMessage(groupEvent({
    messageId: 'om_return_confirm', threadId: 'omt_sale_confirm', text: '退那双 1366-33',
  }));
  await flushSalesTasks(service);
  const before = interactiveReplies(replies).length;
  assert.equal(before, 1);

  const outcome = await service.handleCardAction({
    operator: { operator_id: { open_id: 'ou_sender' } },
    action: { value: { action: AFTER_SALES_CARD_ACTIONS.CONFIRM, draft_id: accepted.sales.taskId } },
  });
  assert.equal(outcome.toast.type, 'success');
  assert.equal(executed.length, 1, '点确认才调执行器');
  assert.equal(executed[0].originalSalesEntryRecordId, SALE_ID, '执行的是话题那笔销售');

  // 假 client 没有 patch → 结果卡片只能"另发一张"，那张也必须回到同一个话题
  const cards = interactiveReplies(replies);
  assert.equal(cards.length, before + 1);
  assert.equal(cards[cards.length - 1].path.message_id, 'om_return_confirm');
  assert.equal(cards[cards.length - 1].data.reply_in_thread, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ 主群新说一笔（= 没有"已定位到的销售"）→ 同一套售后编排的另一档
//    （2026-10-07 ⓐ：原来这两条拿**私聊**当入口，已迁到**群聊真入口**）
// ═══════════════════════════════════════════════════════════════════════════

test('主群 @ 机器人说「退那双 1366-33」→ 确认卡片**回复进话题**；候选不限定某笔销售', async () => {
  const { service, replies, lookup } = makeHarness();

  const accepted = await service.acceptMessage(groupEvent({ messageId: 'om_main_return', text: '退那双 1366-33' }));
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.mode, 'new', '主群里新说一笔 → 不是在某个话题里续接');
  await flushSalesTasks(service);

  // 主群新开一笔时**没有**"已定位到的那笔销售"（`sales_entry_record_id` 为空串），
  // 所以候选查询**不限定**在某一笔上 —— 与原来私聊那条路同一语义。
  const task = await service.store.get(accepted.sales.taskId);
  assert.equal(task.chat_type, 'group');
  assert.equal(task.sales_entry_record_id, '');
  assert.equal(lookup.calls.length, 1);
  assert.equal(lookup.calls[0].salesEntryRecordId, '');

  // 回复一律回到**她那条消息的话题**（`reply_in_thread`）—— 群聊没有"私聊那条落点"了。
  const cards = interactiveReplies(replies);
  assert.equal(cards.length, 1, '要发出售后确认卡片');
  assert.equal(cards[0].path.message_id, 'om_main_return');
  assert.equal(cards[0].data.reply_in_thread, true, '群聊的回复一律回到那条话题');
});

test('主群 @ 机器人说「换那双 1366-33」→ 缺信息时的追问**回复进话题**（不是另发一条私聊）', async () => {
  // 换货缺"换成哪一双" → 走 ask() → 文字端口。
  const { service, replies } = makeHarness();
  const parse = () => normalizeSalesResult({
    intent: 'exchange', action: 'exchange', item_no: '1366-33', color: '黑', size: 36, settlement: '现金',
  });
  service.recognizer.parseSalesText = async () => parse();

  await service.acceptMessage(groupEvent({ messageId: 'om_main_exchange', text: '换那双 1366-33' }));
  await flushSalesTasks(service);

  const ask = replies.find((item) => item.data.msg_type === 'text');
  assert.ok(ask, '缺信息时要回一句问她');
  // ⚠️ 群聊的文字走 `im.message.reply` + `reply_in_thread: true`（回到那条话题），
  //    **不是**主动发一条新消息（`create`）—— 私聊那条落点已经删掉了。
  assert.equal(ask.direct, undefined, '不是 create（主动发新消息）');
  assert.equal(ask.path.message_id, 'om_main_exchange');
  assert.equal(ask.data.reply_in_thread, true);
});
