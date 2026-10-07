/**
 * ④「采购到货同步回话题」的**接线**验收：飞书发送适配器。
 *
 * 采购单 / 图是发到群里的（`PURCHASE_CHAT_ID`），后续对话**必须留在同一个话题**里。
 * 判据只有一条：`thread_id` 有值 → 带 `reply_in_thread: true`；没有 → 与改动前逐字相同。
 *
 * 这里钉的是"谁决定发哪里"这条边界：
 *   · service（采购定位 / 到货核对）只把 `threadId` 当**上下文**交上来；
 *   · 飞书语义（`reply_in_thread`）只在 `larkMvpService` 的适配器里出现。
 */

// ⭐ 2026-10-07 ⓐ「私聊链路移除」：原来这里有一条「私聊与改动前逐字相同」的用例
//    （补样品出口的私聊分支）。私聊**发送出口已整体删除**，那条用例已改成
//    「**没有群上下文的任务 → 不发**」（见下面 ③ 那条）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService } = require('../src/services/larkMvpService');
const { GroupPurchaseFlowService } = require('../src/services/groupPurchaseFlowService');
const { SalesGroupThreadLocator } = require('../src/services/salesGroupThreadLocator');

const makeService = () => {
  const sent = [];
  const client = {
    im: {
      message: {
        reply: async ({ path: replyPath, data }) => {
          sent.push({ path: replyPath, data });
          return { code: 0, data: { message_id: `om_${sent.length}`, thread_id: 'omt_thread' } };
        },
        create: async ({ data }) => {
          sent.push({ path: { message_id: '' }, data, direct: true });
          return { code: 0, data: { message_id: `om_direct_${sent.length}` } };
        },
      },
      messageReaction: { create: async () => ({ code: 0 }) },
    },
  };
  const service = new LarkMvpService({
    client,
    gateway: { table: () => ({}), listAll: async () => [], validateTables: async () => [] },
    posting: {},
    recognizer: {},
    store: new JsonTaskStore({
      dir: fs.mkdtempSync(path.join(os.tmpdir(), 'thread-reply-routing-')), idField: 'task_id',
    }),
    botOpenId: 'ou_test_bot_open_id',
    // 「话题 ↔ 那笔销售」的映射指向临时目录：别让用例往仓库的
    // server/data/sales_group_threads/ 里写东西（群任务回话题时会记一条映射）。
    salesGroupThreads: new SalesGroupThreadLocator({
      store: new JsonTaskStore({
        dir: fs.mkdtempSync(path.join(os.tmpdir(), 'thread-reply-sales-thread-')), idField: 'task_id',
      }),
    }),
  });
  return { service, sent };
};

test('④ 话题里的采购回复：带 threadId → reply_in_thread；不带 → 与改动前逐字相同', async () => {
  const { service, sent } = makeService();

  // ① 话题里（threadId 有值）→ 回到那个话题
  await service.replyPurchaseText('om_in_topic', '我没认出来', { threadId: 'omt_purchase' });
  assert.equal(sent[0].path.message_id, 'om_in_topic');
  assert.equal(sent[0].data.reply_in_thread, true);

  await service.replyPurchaseCard('om_in_topic', { header: {} }, { threadId: 'omt_purchase' });
  assert.equal(sent[1].path.message_id, 'om_in_topic');
  assert.equal(sent[1].data.reply_in_thread, true);

  // ② 主群 @ 进来（threadId 为空）→ 一个字段都不多
  await service.replyPurchaseText('om_main_group', '我没认出来', {});
  assert.equal(sent[2].path.message_id, 'om_main_group');
  assert.equal(sent[2].data.reply_in_thread, undefined);

  await service.replyPurchaseCard('om_main_group', { header: {} });
  assert.equal(sent[3].path.message_id, 'om_main_group');
  assert.equal(sent[3].data.reply_in_thread, undefined);
});

test('④ 采购分派：话题里「认不出」的回复把 threadId 交给适配器（回到同一个话题）', async () => {
  const calls = [];
  const flow = new GroupPurchaseFlowService({
    locator: { resolve: async () => ({ status: 'not_found', source: 'thread_id' }) },
    replyText: async (messageId, content, options) => { calls.push({ messageId, content, options }); return 'om_1'; },
  });

  const result = await flow.handleGroupPurchaseMessage({
    messageId: 'om_purchase_unknown', text: '这批你看下', threadId: 'omt_purchase', senderOpenId: 'ou_1',
  });

  assert.equal(result.resolved, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.threadId, 'omt_purchase', '话题里的回复必须把话题上下文交上去');
});

test('④ 采购分派：主群 @ 进来（没有 threadId）不伪造话题上下文', async () => {
  const calls = [];
  const flow = new GroupPurchaseFlowService({
    locator: { resolve: async () => ({ status: 'ambiguous', source: 'none' }) },
    replyText: async (messageId, content, options) => { calls.push({ messageId, content, options }); return 'om_1'; },
  });

  await flow.handleGroupPurchaseMessage({
    messageId: 'om_main_group', text: '这批你看下', threadId: '', senderOpenId: 'ou_1',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.threadId, '');
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 2026-10-06「私聊切除」③：把 SampleReplacementService 的两个**新端口接上**
//    （`sendCardToTask` / `sendTextToTask`，PR #148 的同一套接法）。
//    ⚠️ 接线之前这两个端口**没有生产注入方** → 服务只有"缺省 = 改动前私聊"这一条路。
//    这里钉的就是：接上之后 **群任务回话题**、**私聊逐字不变**。
//    `saleLookupService` 的渠道感知兜底（②）也在同一处接线，一并锁住。
// ─────────────────────────────────────────────────────────────────────────────

test('③ 补样品 / 销售查询的渠道感知出口已接上（不是默认值）', () => {
  const { service } = makeService();
  assert.equal(typeof service.sampleReplacements.sendCardToTask, 'function');
  assert.equal(typeof service.sampleReplacements.sendTextToTask, 'function');
  assert.equal(typeof service.saleLookup.sendCardToTask, 'function');
  // 默认端口会 `sendCard(task.sender_open_id)`；接上之后群任务必须走 `sendTaskCard`
  //（同一个函数引用 = 真的接线了，而不是又一个"缺省回落私聊"的壳）。
  assert.equal(service.sampleReplacements.sendCardToTask.toString().includes('sendTaskCard'), true);
  assert.equal(service.saleLookup.sendCardToTask.toString().includes('sendTaskCard'), true);
});

test('③ 补样品出口：群任务回话题（reply_in_thread）；没有群上下文的任务**不发**', async () => {
  const { service, sent } = makeService();
  const groupTask = {
    task_id: 't_group', type: 'sample_replacement', chat_type: 'group',
    chat_id: 'oc_sales', message_id: 'om_in_group', sender_open_id: 'ou_1',
  };

  // 群：卡片回到**那个话题**（回复她那条消息 + `reply_in_thread: true`）。
  await service.sampleReplacements.sendCardToTask(groupTask, { header: {} });
  assert.equal(sent[0].path.message_id, 'om_in_group');
  assert.equal(sent[0].data.reply_in_thread, true);

  await service.sampleReplacements.sendTextToTask(groupTask, '已收到补样品操作，正在处理，请稍候。');
  assert.equal(sent[1].path.message_id, 'om_in_group');
  assert.equal(sent[1].data.reply_in_thread, true);

  // ⚠️ 没有群上下文的任务（**原来的私聊任务**）：私聊出口已随 ⓐ 删除 → **不发**，
  //    只记一条 `lark.private_chat.removed` 并返回 `null`。
  //    不是"reply"、更不是"create 一条主动消息"—— 一条远端调用都不许多。
  const orphanTask = { task_id: 't_no_group', type: 'sample_replacement', sender_open_id: 'ou_2' };
  assert.equal(await service.sampleReplacements.sendCardToTask(orphanTask, { header: {} }), null);
  assert.equal(await service.sampleReplacements.sendTextToTask(orphanTask, '已收到补样品操作，正在处理，请稍候。'), null);
  assert.equal(sent.length, 2, '没有群上下文的任务一条消息都不发');
});
