const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { SampleReplacementService } = require('../src/services/sampleReplacementService');

/** 群销售那条任务：补样品提醒要跟着它回到**那个话题**。 */
const groupChannelTask = {
  task_id: 'sale_group_1', type: 'sale', chat_type: 'group', chat_id: 'oc_sales',
  message_id: 'om_her_sale', sender_open_id: 'ou_seller', sales_entry_record_id: 'entry_1',
};

test('sample reminder is still sent (with a retry hint) when candidate lookup fails after stock deduction', async () => {
  const taskStore = new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sample-recovery-')),
    idField: 'task_id' });
  let lookups = 0;
  const inventory = { sampleReplacementCandidates: async () => {
    lookups += 1;
    if (lookups === 1) throw new Error('尺码关联异常');
    return [{ size: 40, doorBoxCount: 1, sampleCount: 0, warehouseCount: 0 }];
  } };
  const sentCards = [];
  const sentTargets = [];
  const updatedCards = [];
  const service = new SampleReplacementService({
    gateway: { get: async () => ({ fields: { 货号: 'TEST-1' } }),
      table: () => ({ fields: { number: '货号' } }) },
    inventory, store: taskStore,
    // ⭐ 渠道感知出口：只收「任务 + 卡片」——它不认识 open_id（私聊链路已移除）。
    sendCardToTask: async (task, card) => { sentTargets.push(task); sentCards.push(card); return 'message_1'; },
    updateCard: async (_task, _event, card) => { updatedCards.push(card); return true; },
  });
  const replacement = { salesDetailRecordId: 'detail_1', productRecordId: 'product_1',
    consumedLiveRecordIds: ['sold_sample'] };
  await service.notifySampleReplacements({ sampleReplacements: [replacement] }, 'operator_1',
    { channelTask: groupChannelTask });
  assert.equal(sentCards.length, 1);
  assert.match(sentCards[0].elements[0].content, /可选尺码暂时无法读取.*刷新重试/);
  assert.equal(sentTargets[0].task_id, 'sale_group_1', '群销售 → 提醒跟着**那条销售任务**回它的话题');
  const taskId = sentCards[0].elements.at(-1).actions[0].value.draft_id;
  assert.equal((await taskStore.get(taskId)).status, 'pending');
  assert.equal((await taskStore.get(taskId)).notice_sent, true);
  // ⛔ 2026-10-28：这一段原先还点卡片上的「刷新可选尺码」（`handleCardAction`）。
  //   卡片按钮回调已随「没有旧卡片」整体删除 ⇒ 那半条用例退场；
  //   **提醒本身**（卡片内容、渠道任务、notice_sent）的判据一字未动。
});

// ─────────────────────────────────────────────────────────────────────────────
// ② 「把私聊专属的切出来」：补样品这条路的**发送出口**是"任务感知的端口"
//
// 目标形态（业务负责人 2026-10-06：「后续就不走私聊了，你私聊的要切除出来」）：
//   service 只交"这是哪个任务"，**去哪发**由注入方（`larkMvpService` 的适配器）决定。
//
// 🔴 2026-10-07「私聊链路移除」（业务负责人拍板的 ⓐ：代码里一行私聊都不留）：
//   本 service 里那两个 **open_id 发送器（`sendCard` / `sendText`）已整体删除**，
//   缺省出口**不再回落私聊** —— 没有群上下文 = **没有去处**：只记一条
//   `lark.private_chat.send_skipped`、返 `null`。
//   见 docs/private-chat-removal-decision-2026-10-07.md。
// ─────────────────────────────────────────────────────────────────────────────

const seedCompletedTask = (taskStore, taskId, senderOpenId) => taskStore.create({
  task_id: taskId, type: 'sample_replacement', status: 'completed',
  sender_open_id: senderOpenId, product_number: 'TEST-1', result: { size: 40 },
});

const sampleGateway = { get: async () => ({ fields: {} }), table: () => ({ fields: {} }) };

test('② 卡片更新失败的兜底走**任务感知**出口：注入 sendCardToTask 时按任务发', async () => {
  const taskStore = new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sample-port-')),
    idField: 'task_id' });
  await seedCompletedTask(taskStore, 'sample_port_1', 'ou_seller');

  const taskAware = [];
  const service = new SampleReplacementService({
    gateway: sampleGateway, store: taskStore,
    updateCard: async () => false, // 卡片改不动 → 走兜底补发
    sendCardToTask: async (task, card) => { taskAware.push({ task, card }); return 'om_task_aware'; },
  });

  // ⭐ 2026-10-28：入口从「点卡片按钮」换成**直接调 publishCard**（它就是这个兜底的实现）——
  //   卡片回调已删除；这条判据的本意（"卡片改不动 ⇒ 兜底补发必须走任务感知端口"）一字未变。
  const published = await service.publishCard(
    await taskStore.get('sample_port_1'), {}, { header: {} }, { stage: 'test' },
  );

  assert.equal(published, true);
  assert.equal(taskAware.length, 1, '兜底必须走任务感知端口');
  assert.equal(taskAware[0].task.task_id, 'sample_port_1', '端口拿到的必须是**任务**，不是裸 open_id');
  assert.equal((await taskStore.get('sample_port_1')).card_message_id, 'om_task_aware');
});

test('② 没注入端口（没有群上下文）→ **一条消息都不发**，只记 skip；返 false 不报"已补发"', async () => {
  const taskStore = new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sample-port-default-')),
    idField: 'task_id' });
  await seedCompletedTask(taskStore, 'sample_port_2', 'ou_seller');

  const service = new SampleReplacementService({
    gateway: sampleGateway, store: taskStore,
    updateCard: async () => false,
  });

  const published = await service.publishCard(
    await taskStore.get('sample_port_2'), {}, { header: {} }, { stage: 'test' },
  );
  assert.equal(published, false, '没发出去就不许报成功');

  // ⚠️ 旧行为是"悄悄发给 task.sender_open_id"；现在没有那条路了 —— 什么都不发。
  assert.equal((await taskStore.get('sample_port_2')).card_message_id, undefined,
    '没有去处 → 不许写 card_message_id（没发出去就不算发过）');
});
