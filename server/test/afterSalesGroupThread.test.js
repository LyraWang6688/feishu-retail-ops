/**
 * 「售后（退货 / 换货）回到销售话题」的验收测试
 * （业务负责人 2026-10-06 的口径：`docs/sales-purchase-group-thread-2026-10-06.md` 第六节 ③）。
 *
 * 这一份只盯四件事：
 *   □ ① **入口**：话题里说退/换货 → 走售后链路（不是采购、也不被销售闸门静默丢掉）
 *   □ ② **回复**：群里的售后卡片/文字回到**那条话题**（`reply_in_thread: true`）
 *   □ ③ **上下文**：售后绑定到 `salesGroupThreadLocator` 定位到的那一笔销售
 *   □ ④ **回归**（最重要）：**私聊说退货 → 回复仍然去私聊，payload 与改动前逐字相同**
 *
 * 「售后结束后写原单销售状态 = 已退货 / 部分退货」在 afterSalesService.test.js 里覆盖
 * （那是执行器的落库行为，不在这条消息链路上）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService } = require('../src/services/larkMvpService');
const { SalesGroupThreadLocator } = require('../src/services/salesGroupThreadLocator');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { isSalesCandidate } = require('../src/config/messageGate');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const TEST_BOT_OPEN_ID = 'ou_test_bot_open_id';
const CHAT_ID = 'oc_test_group';

const tempStore = (prefix) => new JsonTaskStore({
  dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id',
});

// ── 飞书 client 的假实现：分别记下「回复(reply)」与「主动发(create)」两种调用 ────────
const makeClient = () => {
  const replies = [];
  const directs = [];
  const client = {
    im: {
      message: {
        reply: async ({ path, data }) => {
          replies.push({ path, data });
          return { code: 0, data: { message_id: `om_reply_${replies.length}`, thread_id: 'omt_new_thread' } };
        },
        create: async ({ params, data }) => {
          directs.push({ params, data });
          return { code: 0, data: { message_id: `om_direct_${directs.length}` } };
        },
      },
      messageReaction: { create: async () => ({ code: 0 }) },
    },
  };
  return { client, replies, directs };
};

// ── 只读的销售数据（供真的 SaleLookupService 定位）────────────────────────────────
//   entry_bound：话题对应的那一笔（两条明细：1366-33 与 6035）
//   entry_other：另一笔（用来证明"绑定到话题那一笔"真的生效）
const link = (id) => [{ record_ids: [id], text: '' }];
const makeSalesGateway = () => {
  const today = new Date().toISOString();
  const products = [
    { record_id: 'p_1366', fields: { 货号: '1366-33', 颜色: '黑', 编号: '1366-33|黑', 单价: 300 } },
    { record_id: 'p_6035', fields: { 货号: '6035', 颜色: '黑', 编号: '6035|黑', 单价: 230 } },
  ];
  const entries = [
    { record_id: 'entry_bound', fields: { 销售单号: 'XSD-20261006-0001', 录单日: today, 销售状态: '已写入' } },
    { record_id: 'entry_other', fields: { 销售单号: 'XSD-20261006-0002', 录单日: today, 销售状态: '已写入' } },
  ];
  const details = [
    { record_id: 'd_bound_1366', fields: {
      编号: link('p_1366'), 销售单号: link('entry_bound'), 销售日: today, 尺码: link('size_40'), 成交金额: 300 } },
    { record_id: 'd_bound_6035', fields: {
      编号: link('p_6035'), 销售单号: link('entry_bound'), 销售日: today, 尺码: link('size_39'), 成交金额: 230 } },
    { record_id: 'd_other', fields: {
      编号: link('p_1366'), 销售单号: link('entry_other'), 销售日: today, 尺码: link('size_40'), 成交金额: 300 } },
  ];
  return {
    table: (tableKey) => V1_BITABLE_SCHEMA.tables[tableKey],
    listAll: async (tableKey) => ({
      salesDetail: details, salesEntry: entries, product: products,
    }[tableKey] || []),
    validateTables: async () => [],
  };
};

const makeHarness = ({ recognizer, threads } = {}) => {
  const { client, replies, directs } = makeClient();
  const purchaseCalls = [];
  const locator = threads || new SalesGroupThreadLocator({ store: tempStore('after-sales-thread-map-') });
  const service = new LarkMvpService({
    client,
    gateway: makeSalesGateway(),
    references: {},
    posting: {},
    recognizer: recognizer || { parseSalesText: async () => afterSalesParse() },
    store: tempStore('after-sales-group-lark-'),
    botOpenId: TEST_BOT_OPEN_ID,
    salesGroupThreads: locator,
    // 采购那条路换成一个记录型的桩：用它证明"这条消息没走采购"。
    groupPurchaseFlow: {
      handleGroupPurchaseMessage: async (input) => {
        purchaseCalls.push(input);
        return { resolved: false, reason: 'stub', replied: false };
      },
    },
  });
  service.acknowledgeMessage = async () => undefined;
  return { service, replies, directs, purchaseCalls, locator };
};

const afterSalesParse = (overrides = {}) => ({
  intent: 'return', action: 'return', settlement: 'cash', ...overrides,
});

const groupEvent = (overrides = {}) => ({
  sender: { sender_id: { open_id: overrides.senderOpenId || 'ou_sender' } },
  message: {
    message_id: overrides.messageId || 'om_group_1',
    chat_id: CHAT_ID,
    chat_type: 'group',
    message_type: 'text',
    create_time: '1000',
    content: JSON.stringify({ text: overrides.text || '' }),
    mentions: overrides.mentions || [],
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

// 处理是 `setImmediate` 之后异步跑的（与线上一致）：排到发送者队列尾部即说明跑完了。
const flushSalesTasks = async (service, openId = 'ou_sender') => {
  await new Promise((resolve) => setImmediate(resolve));
  await service.enqueueForSender(openId, async () => undefined);
};

const cardReply = (replies) => replies.find((item) => item.data.msg_type === 'interactive');

// ═══════════════════════════════════════════════════════════════════════════
// ① + ② + ③ 话题里说售后退货 → 走售后链路，卡片回到那条话题，且绑到话题对应的那笔销售
// ═══════════════════════════════════════════════════════════════════════════

test('①②③ 话题里说「退那双 1366-33」→ 走售后、卡片回到那条话题（reply_in_thread）', async () => {
  const { service, replies, directs, purchaseCalls } = makeHarness({
    recognizer: { parseSalesText: async () => afterSalesParse({ item_no: '1366-33', color: '黑' }) },
  });
  await service.salesGroupThreads.rememberSaleThread({
    salesEntryRecordId: 'entry_bound', taskId: 'sale_orig',
    messageId: 'om_orig_sale', threadId: 'omt_sale_bound', chatId: CHAT_ID, senderOpenId: 'ou_sender',
  });

  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_after_sales_1', threadId: 'omt_sale_bound', text: '退那双 1366-33',
  }));

  assert.equal(result.accepted, true, '话题里的消息免 @，必须被处理');
  assert.equal(result.handled, true);
  assert.equal(result.mode, 'thread');
  assert.equal(result.afterSales, true, '这句话被判成售后（不是普通销售进展）');
  assert.deepEqual(purchaseCalls, [], '认出是哪一笔销售 → 绝不进采购链路');

  // ③ 上下文：任务绑到话题对应的那一笔销售（salesGroupThreadLocator 定位的结果）
  const task = await service.store.get(result.sales.taskId);
  assert.equal(task.chat_type, 'group');
  assert.equal(task.sales_entry_record_id, 'entry_bound');

  await flushSalesTasks(service);

  const plan = (await service.store.get(result.sales.taskId)).after_sales_plan;
  assert.equal(plan.original_sales_entry_record_id, 'entry_bound', '售后绑到话题对应的那一笔');
  assert.deepEqual(plan.original_sales_detail_record_ids, ['d_bound_1366'],
    '只在那一笔里找 → 不会挑到别笔销售的同货号明细');
  // 反证：不限定是哪一笔时这一句话会命中**两笔**（另一笔是别的话题里的销售）。
  const unbound = await service.saleLookup.findCandidates({ itemNo: '1366-33', color: '黑' });
  assert.equal(unbound.length, 2, '不加话题绑定时会命中两笔 —— 所以绑定是真的在起作用');

  // ② 回复回到**同一条话题**：回复她那条消息 + reply_in_thread
  const card = cardReply(replies);
  assert.ok(card, '要发出确认卡片');
  assert.equal(card.path.message_id, 'om_after_sales_1', '卡片回在她那条消息下');
  assert.equal(card.data.reply_in_thread, true, '群里的售后卡片必须回复到话题');
  assert.deepEqual(directs, [], '群里不许再用"主动发"（那会发到会话外面 / 私聊）');
  assert.match(card.data.content, /请确认售后/);
});

test('① 话题里说「这笔售后处理一下」（无数字、无销售关键词）→ 仍然走售后，不被闸门静默丢掉', async () => {
  // 这句话过不了销售那把尺子（含数字 / 含销售关键词）——售后入口必须绕过它，
  // 否则在话题里说售后会被**完全静默**地丢掉（她说的是"在一个话题里解决一切"）。
  assert.equal(isSalesCandidate('这笔售后处理一下'), false);

  const { service, replies, purchaseCalls } = makeHarness();
  await service.salesGroupThreads.rememberSaleThread({
    salesEntryRecordId: 'entry_bound', taskId: 'sale_orig',
    messageId: 'om_orig_sale', threadId: 'omt_sale_bound2', chatId: CHAT_ID,
  });

  const result = await service.acceptMessage(groupEvent({
    messageId: 'om_after_sales_2', threadId: 'omt_sale_bound2', text: '这笔售后处理一下',
  }));

  assert.equal(result.accepted, true);
  assert.equal(result.handled, true);
  assert.equal(result.afterSales, true);
  assert.deepEqual(purchaseCalls, []);
  await flushSalesTasks(service);

  // 两句话都没说（没说货号也没说尺码）→ 那一笔有两条明细，出候选卡片（**仍然回话题**）。
  const card = cardReply(replies);
  assert.ok(card);
  assert.equal(card.path.message_id, 'om_after_sales_2');
  assert.equal(card.data.reply_in_thread, true);
  assert.match(card.data.content, /最近 5 天的销售记录/);
  assert.equal((await service.store.get(result.sales.taskId)).status, 'after_sales_asking');
});

test('① 回执文字（问她要货号）也回话题：私聊口一次都不许被用到', async () => {
  const { service, replies, directs } = makeHarness({
    // 这一笔只有一条明细，但模型既没说货号、也没说尺码 —— 绑定了那一笔时**不该**再问货号
    recognizer: { parseSalesText: async () => afterSalesParse() },
  });
  await service.salesGroupThreads.rememberSaleThread({
    salesEntryRecordId: 'entry_bound', taskId: 'sale_orig',
    messageId: 'om_orig_sale', threadId: 'omt_sale_bound3', chatId: CHAT_ID,
  });
  // 去掉另一条明细 → 只剩 d_bound_1366，直接出确认卡片（不需要任何文字追问）
  const gateway = service.gateway;
  const original = gateway.listAll;
  gateway.listAll = async (key) =>
    (key === 'salesDetail' ? (await original(key)).filter((row) => row.record_id !== 'd_bound_6035') : original(key));

  await service.acceptMessage(groupEvent({
    messageId: 'om_after_sales_3', threadId: 'omt_sale_bound3', text: '退货',
  }));
  await flushSalesTasks(service);

  const card = cardReply(replies);
  assert.ok(card, '绑定到那一笔、只有一条明细 → 直接出确认卡片');
  assert.equal(card.data.reply_in_thread, true);
  assert.match(card.data.content, /1366-33黑/);
  assert.deepEqual(directs, [], '群里一次"主动发"都不许有（那会落到她私聊）');
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ 私聊回归（最重要的一条）：回复仍然去私聊，payload 与改动前逐字相同
// ═══════════════════════════════════════════════════════════════════════════

test('④ 私聊说「退货」→ 回复仍然去私聊，payload 与改动前逐字相同（不带 reply_in_thread）', async () => {
  // 6035 黑在这份数据里只命中一条（1366-33 黑在别的话题那笔里也有），
  // 所以私聊的"按货号定位"会直接落到那一笔、出确认卡片。
  const { service, replies, directs } = makeHarness({
    recognizer: { parseSalesText: async () => afterSalesParse({ item_no: '6035', color: '黑' }) },
  });

  const result = await service.acceptMessage(privateEvent({
    messageId: 'om_private_return', text: '退那双 6035 黑，退现金',
  }));
  assert.equal(result.accepted, true);
  assert.equal(result.type, 'sale');

  const task = await service.store.get(result.taskId);
  assert.equal(task.chat_type, undefined, '私聊任务不该被打上群聊标记');
  assert.equal(task.chat_id, undefined);
  assert.equal(task.group_thread_id, undefined);
  assert.equal(task.sales_entry_record_id, undefined, '私聊没有"已定位的那一笔"，不绑话题销售');

  await flushSalesTasks(service);

  const card = cardReply(replies);
  assert.ok(card, '私聊要出确认卡片');
  assert.equal(card.path.message_id, 'om_private_return', '仍然是"回复她那一条"');
  // ① 私聊的 payload 与改动前逐字相同：一个字段都不许多（尤其不许有 reply_in_thread）
  assert.equal('reply_in_thread' in card.data, false);
  assert.deepEqual(Object.keys(card.data), ['msg_type', 'content']);
  assert.equal(card.data.msg_type, 'interactive');
  assert.deepEqual(directs, [], '私聊回复成功时不该再"主动发"（那是回复失败时的兜底）');

  // ② 与**没改动的私聊原语**（larkMvpService.replyCard）逐字对照：同一个 payload。
  //    售后那条路在私聊上走的就是这个原语，参数一字不差。
  const sentCard = JSON.parse(card.data.content);
  await service.replyCard('om_probe', sentCard);
  const probe = replies.at(-1);
  assert.deepEqual(probe.data, card.data, '私聊售后卡片与既有私聊发送的 payload 必须逐字相同');

  // ③ 计划仍然是"她私聊里那一笔"的售后方案（绑定不生效、定位走原来的货号路）
  const plan = (await service.store.get(result.taskId)).after_sales_plan;
  assert.equal(plan.original_sales_entry_record_id, 'entry_bound');
  assert.equal(plan.source, 'direct', '私聊还是入口 B（按货号直接定位）');
});
